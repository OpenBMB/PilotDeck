import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpOAuthManager } from '../../../src/mcp/oauth/manager.js';

const resource = 'https://mcp.example.test/tools';
const issuer = 'https://auth.example.test';
function fixture() {
  let refreshes = 0;
  let revocations = 0;
  let registration: Record<string, unknown> = {};
  let lastTokenRequest = new URLSearchParams();
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    if (url === resource) return new Response('', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resource}/metadata"` } });
    if (url === `${resource}/metadata`) return json({ resource, authorization_servers: [issuer], scopes_supported: ['mcp:tools'] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url === `${issuer}/register`) {
      registration = JSON.parse(String(init?.body));
      return json({ ...registration, client_id: 'public-client' });
    }
    if (url === `${issuer}/token`) {
      lastTokenRequest = new URLSearchParams(String(init?.body));
      if (lastTokenRequest.get('grant_type') === 'refresh_token') {
        assert.equal(lastTokenRequest.get('refresh_token'), 'refresh-original'); refreshes++;
      } else {
        assert.equal(lastTokenRequest.get('code'), 'callback-code');
        assert.ok(lastTokenRequest.get('code_verifier'));
      }
      return json({ access_token: refreshes ? 'access-new' : 'access-original', refresh_token: refreshes ? 'refresh-rotated' : 'refresh-original', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url === `${issuer}/revoke`) { revocations++; return new Response('', { status: 200 }); }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  return { fetchMock, get refreshes() { return refreshes; }, get revocations() { return revocations; }, get registration() { return registration; } };
}

test('browser PKCE/state, private persistence, concurrent refresh, restart, disconnect', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-oauth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixtureServer = fixture();
  const manager = new McpOAuthManager(home, fixtureServer.fetchMock);
  const id = await manager.create(resource);
  t.after(() => manager.cancel(id, resource).catch(() => {}));
  const start = await manager.begin(id, resource);
  assert.equal(start.status, 'pending');
  const login = new URL(start.authorizationUrl!);
  assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(login.searchParams.get('code_challenge'));
  assert.equal(fixtureServer.registration.client_name, 'PilotDeck');
  const callback = new URL(login.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'callback-code');
  callback.searchParams.set('state', 'bad-state');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal((await manager.status(id, resource)).status, 'pending');
  callback.searchParams.set('state', login.searchParams.get('state')!);
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await manager.status(id, resource)).status, 'authorized');
  const directory = join(home, 'credentials', 'mcp-oauth');
  const files = (await readdir(directory)).filter(file => !file.endsWith('.lock'));
  assert.equal(files.length, 1);
  assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(await manager.status(id, resource)).includes('access-original'), false);
  const restarted = new McpOAuthManager(home, fixtureServer.fetchMock);
  const send: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    return new Response('', { status: new Headers(init?.headers).get('Authorization') === 'Bearer access-new' ? 200 : 401 });
  };
  const clients = [manager, restarted].map(instance => instance.authenticatedFetch(id, resource, send));
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => clients[i % 2]!(resource)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(fixtureServer.refreshes, 1);
  assert.equal((await restarted.store.read(id))?.tokens?.refresh_token, 'refresh-rotated');
  await assert.rejects(() => clients[0]!('https://other.example.test/tools'), /target changed/);
  await assert.rejects(() => restarted.authenticatedFetch(id, 'https://other.example.test/tools', send)('https://other.example.test/tools'), /Authorize/);
  assert.equal((await restarted.disconnect(id, resource)).revoked, true);
  assert.equal(fixtureServer.revocations, 1);
  await assert.rejects(() => clients[0]!(resource), /Authorize/);
});

test('cancel closes pending login and rejects insecure remote endpoints', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-oauth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manager = new McpOAuthManager(home, fixture().fetchMock);
  await assert.rejects(() => manager.create('http://remote.example.test/mcp'), /HTTPS/);
  const id = await manager.create(resource);
  const start = await manager.begin(id, resource);
  const callback = new URL(new URL(start.authorizationUrl!).searchParams.get('redirect_uri')!);
  await manager.cancel(id, resource);
  assert.equal((await manager.status(id, resource)).status, 'needs-auth');
  assert.equal((await manager.store.read(id))?.verifier, undefined);
  await assert.rejects(() => fetch(callback));
});
