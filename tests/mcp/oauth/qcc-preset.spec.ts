import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpOAuthManager } from '../../../src/mcp/oauth/manager.js';
import { createQccPreset, QCC_ISSUER, QCC_RESOURCES } from '../../../src/mcp/presets/qcc.js';

const metadata = { issuer: QCC_ISSUER, authorization_endpoint: `${QCC_ISSUER}/oauth/authorize`, token_endpoint: `${QCC_ISSUER}/oauth/token`, revocation_endpoint: `${QCC_ISSUER}/oauth/revoke`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
function fakeDiscovery(mismatch = false): typeof fetch {
  return async (input) => {
    const url = String(input);
    const resource = QCC_RESOURCES.find(entry => url === entry.url || url === `${entry.url}/metadata`);
    if (resource && url === resource.url) return new Response('', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${url}/metadata"` } });
    if (resource) return Response.json({ resource: mismatch ? `${resource.url}/wrong` : resource.url, authorization_servers: [QCC_ISSUER], scopes_supported: ['mcp:tools'] });
    if (url === `${QCC_ISSUER}/.well-known/oauth-authorization-server`) return Response.json(metadata);
    throw new Error(`Unexpected request ${url}`);
  };
}
test('five-resource calls share refresh, survive restart and disconnect together', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-qcc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let refreshes = 0;
  let revoked = 0;
  const fetchOAuth: typeof fetch = async (input, init) => {
    if (String(input) === metadata.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('refresh_token'), 'original-refresh');
      assert.equal(body.get('resource'), QCC_RESOURCES[0]!.url);
      refreshes++;
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(input) === metadata.revocation_endpoint) { revoked++; return new Response('', { status: 200 }); }
    return fakeDiscovery()(input, init);
  };
  const manager = new McpOAuthManager(home, fetchOAuth);
  const preset = await createQccPreset(manager, {}, fakeDiscovery());
  assert.equal(Object.keys(preset).length, 5);
  const ids = new Set(Object.values(preset).map(value => value.oauth.credentialId));
  assert.equal(ids.size, 1);
  const id = [...ids][0]!;
  const record = (await manager.store.read(id))!;
  // Seed an authorized grant. The generic manager tests exercise the browser/code flow.
  record.tokens = { access_token: 'expired-access', refresh_token: 'original-refresh', token_type: 'Bearer' };
  record.client = { client_id: 'PilotDeck-test' };
  record.redirectUrl = 'http://127.0.0.1:12345/callback';
  record.discovery = { authorizationServerUrl: QCC_ISSUER, authorizationServerMetadata: metadata, resourceMetadata: { resource: record.entry, authorization_servers: [QCC_ISSUER] } };
  await manager.store.write(id, record);
  const restarted = new McpOAuthManager(home, fetchOAuth);
  const called = new Set<string>();
  const send: typeof fetch = async (input, init) => {
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer rotated-access') return new Response('', { status: 401 });
    assert.equal(JSON.parse(String(init?.body)).method, 'tools/call');
    called.add(String(input));
    return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'fixture result' }] } });
  };
  await Promise.all(QCC_RESOURCES.map(async ({ url }, index) => {
    const response = await (index % 2 ? manager : restarted).authenticatedFetch(id, url, send)(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_tool', arguments: {} } }) });
    assert.equal(response.status, 200);
  }));
  assert.equal(called.size, 5);
  assert.equal(refreshes, 1);
  assert.equal((await restarted.status(id, QCC_RESOURCES[4]!.url)).status, 'authorized');
  assert.equal((await manager.store.read(id))?.tokens?.refresh_token, 'rotated-refresh');
  const outside = `${QCC_ISSUER}/mcp/not-authorized/stream`;
  await assert.rejects(() => manager.authenticatedFetch(id, outside, send)(outside), /Authorize/);
  assert.equal((await restarted.disconnect(id, QCC_RESOURCES[3]!.url)).revoked, true);
  assert.equal(revoked, 1);
  for (const { url } of QCC_RESOURCES) {
    assert.equal((await manager.status(id, url)).status, 'needs-auth');
    await assert.rejects(() => manager.authenticatedFetch(id, url, send)(url), /Authorize/);
  }
});

test('preset rejects resource mismatch and never overwrites existing servers', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-qcc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manager = new McpOAuthManager(home);
  await assert.rejects(() => createQccPreset(manager, {}, fakeDiscovery(true)), /mismatch/);
  const existing = { 'qcc-company': { url: 'https://other.example.test/mcp' } };
  await assert.rejects(() => createQccPreset(manager, existing, fakeDiscovery()), /not overwritten/);
  assert.equal(existing['qcc-company'].url, 'https://other.example.test/mcp');
});
