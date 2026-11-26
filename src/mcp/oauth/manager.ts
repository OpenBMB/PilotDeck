import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { auth, extractWWWAuthenticateParams, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthStore } from './store.js';

export type OAuthCredential = {
  resources: string[];
  entry: string;
  /** Optional issuer pin for explicitly configured multi-resource grants. */
  expectedIssuer?: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
};
type Pending = { server: Server; state: string; status: 'pending' | 'authorized' | 'failed' | 'cancelled'; timer: NodeJS.Timeout };

export function requireSecureUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('MCP OAuth requires HTTPS (HTTP is allowed only on loopback).');
  }
  return url;
}

/** Local desktop/single-user host. UI and gateway serialize mutations using the same store lock. */
export class McpOAuthManager {
  readonly store: OAuthStore<OAuthCredential>;
  private readonly pending = new Map<string, Pending>();
  private readonly fetchOAuth: typeof fetch;
  constructor(home: string, fetchImpl: typeof fetch = fetch) {
    this.store = new OAuthStore(home);
    this.fetchOAuth = async (input, init) => {
      requireSecureUrl(String(input instanceof Request ? input.url : input));
      return fetchImpl(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) });
    };
  }
  async create(resource: string): Promise<string> {
    requireSecureUrl(resource);
    const id = randomUUID();
    await this.store.write(id, { resources: [resource], entry: resource, redirectUrl: '' });
    return id;
  }
  private async credential(id: string, resource: string): Promise<OAuthCredential> {
    const record = await this.store.read(id);
    if (!record || !record.resources.includes(resource)) throw new UnauthorizedError('Authorize this MCP server in Settings.');
    return record;
  }
  private provider(id: string, record: OAuthCredential, redirect: (url: URL) => void, state?: string): OAuthClientProvider {
    const save = () => this.store.write(id, record);
    return {
      redirectUrl: record.redirectUrl,
      clientMetadata: { client_name: 'PilotDeck', redirect_uris: [record.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      state: () => state ?? randomUUID(),
      clientInformation: () => record.client,
      saveClientInformation: async client => { record.client = client; await save(); },
      tokens: () => record.tokens,
      saveTokens: async tokens => { record.tokens = tokens; delete record.verifier; await save(); },
      saveCodeVerifier: async verifier => { record.verifier = verifier; await save(); },
      codeVerifier: () => { if (!record.verifier) throw new Error('Authorization expired. Retry.'); return record.verifier; },
      redirectToAuthorization: redirect,
      discoveryState: () => record.discovery,
      saveDiscoveryState: async discovery => {
        if (record.expectedIssuer && (discovery.authorizationServerUrl !== record.expectedIssuer || discovery.authorizationServerMetadata?.issuer !== record.expectedIssuer)) {
          throw new Error('OAuth issuer changed. Reauthorize the configured grant.');
        }
        record.discovery = discovery; await save();
      },
      validateResourceURL: async (target, resource) => {
        if (String(target) !== record.entry || (resource && resource !== record.entry)) throw new Error('OAuth resource metadata does not match the configured server.');
        return new URL(record.entry);
      },
      invalidateCredentials: async scope => {
        if (scope === 'all' || scope === 'client') delete record.client;
        if (scope === 'all' || scope === 'tokens') delete record.tokens;
        if (scope === 'all' || scope === 'verifier') delete record.verifier;
        if (scope === 'all' || scope === 'discovery') delete record.discovery;
        await save();
      },
    };
  }
  async status(id: string, resource: string) {
    const record = await this.credential(id, resource);
    const pending = this.pending.get(id)?.status;
    return { resourceCount: record.resources.length, status: record.tokens ? 'authorized' : pending && pending !== 'authorized' ? pending : 'needs-auth' };
  }
  async begin(id: string, resource: string): Promise<{ authorizationUrl?: string; status: string }> {
    return this.store.locked(id, async () => {
      const record = await this.credential(id, resource);
      if (record.tokens) return { status: 'authorized' };
      this.closePending(id);
      // A new ephemeral callback port needs a matching DCR registration.
      delete record.client; delete record.tokens; delete record.verifier;
      const state = randomUUID();
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', record.redirectUrl);
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const actual = Buffer.from(url.searchParams.get('state') ?? '');
        const expected = Buffer.from(state);
        const pending = this.pending.get(id);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || pending?.status !== 'pending') {
          res.writeHead(400).end('Invalid or expired OAuth state.'); return;
        }
        // Consume the callback before the asynchronous token exchange (no replay).
        pending.status = 'failed';
        void this.store.locked(id, async () => {
          const current = await this.credential(id, resource);
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) throw new Error('Authorization denied.');
          await auth(this.provider(id, current, () => { throw new Error('Unexpected redirect'); }), { serverUrl: current.entry, authorizationCode: code, fetchFn: this.fetchOAuth });
          pending.status = 'authorized';
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end('Authorization completed. Return to PilotDeck. 授权完成，请返回 PilotDeck。');
        }).catch(() => { res.writeHead(400).end('Authorization failed. Return to PilotDeck and retry.'); }).finally(() => this.closePending(id, false));
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); throw new Error('Cannot start callback listener'); }
      record.redirectUrl = `http://127.0.0.1:${address.port}/callback`;
      const timer = setTimeout(() => { const p = this.pending.get(id); if (p) p.status = 'cancelled'; this.closePending(id, false); }, 5 * 60_000);
      timer.unref();
      this.pending.set(id, { server, state, status: 'pending', timer });
      try {
        let authorizationUrl: string | undefined;
        const challenge = await this.fetchOAuth(record.entry, { method: 'GET' });
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(challenge);
        await challenge.body?.cancel();
        delete record.discovery;
        const result = await auth(this.provider(id, record, url => { requireSecureUrl(url.href); authorizationUrl = url.href; }, state), { serverUrl: record.entry, resourceMetadataUrl, scope, fetchFn: this.fetchOAuth });
        if (result === 'AUTHORIZED') this.closePending(id);
        return { status: result === 'AUTHORIZED' ? 'authorized' : 'pending', authorizationUrl };
      } catch { this.closePending(id); throw new Error('Cannot start MCP OAuth. Check server discovery / dynamic client registration and retry.'); }
    });
  }
  private closePending(id: string, remove = true) {
    const pending = this.pending.get(id);
    if (pending) { clearTimeout(pending.timer); pending.server.close(); if (remove) this.pending.delete(id); }
  }
  async cancel(id: string, resource: string) {
    await this.store.locked(id, async () => {
      const record = await this.credential(id, resource);
      this.closePending(id); delete record.verifier; await this.store.write(id, record);
    });
  }
  /** Never sends an OAuth credential to a redirect or an unbound resource. */
  authenticatedFetch(id: string, resource: string, send: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target !== resource) throw new Error('MCP OAuth target changed. Reconfigure and authorize the new server.');
      let record = await this.credential(id, resource);
      const token = record.tokens?.access_token;
      if (!token) throw new UnauthorizedError('Authorize this MCP server in Settings.');
      const request = (accessToken: string) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('Authorization', `Bearer ${accessToken}`);
        return send(input, { ...init, headers, redirect: 'error' });
      };
      const response = await request(token);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      const nextToken = await this.store.locked(id, async () => {
        record = await this.credential(id, resource);
        if (record.tokens?.access_token !== token) {
          if (!record.tokens) throw new UnauthorizedError('MCP authorization was disconnected.');
          return record.tokens.access_token;
        }
        if (!record.tokens?.refresh_token) throw new UnauthorizedError('MCP authorization expired. Authorize again in Settings.');
        const result = await auth(this.provider(id, record, () => { throw new UnauthorizedError('Authorize again in Settings.'); }), { serverUrl: record.entry, fetchFn: this.fetchOAuth }).catch(() => { throw new UnauthorizedError('MCP OAuth refresh failed. Authorize again in Settings.'); });
        if (result !== 'AUTHORIZED' || !record.tokens) throw new UnauthorizedError();
        return record.tokens.access_token;
      });
      return request(nextToken);
    };
  }
  async disconnect(id: string, resource: string): Promise<{ revoked: boolean }> {
    return this.store.locked(id, async () => {
      const record = await this.credential(id, resource);
      this.closePending(id);
      let revoked = false;
      try {
        const metadata = record.discovery?.authorizationServerMetadata;
        const endpoint = metadata && 'revocation_endpoint' in metadata && typeof metadata.revocation_endpoint === 'string' ? metadata.revocation_endpoint : undefined;
        if (endpoint && record.tokens?.refresh_token && record.client) {
          const response = await this.fetchOAuth(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: record.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: record.client.client_id }) });
          revoked = response.ok; await response.body?.cancel();
        }
      } catch { revoked = false; } finally { delete record.tokens; delete record.verifier; await this.store.write(id, record); }
      return { revoked };
    });
  }
}
