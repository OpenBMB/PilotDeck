// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientRequestContext, clientRequestHeaders, rememberRequestUser, rememberRequestHeadersMode, withClientRequestContext } from './requestContext';
import { authenticatedFetch } from './api';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); rememberRequestHeadersMode('full'); });

describe('first-party request context', () => {
  it('learns runtime opt-out from its own server without rebuilding the UI', () => {
    rememberRequestUser('/api/auth/status', new Response('{}', { headers: { 'x-pilotdeck-request-headers-mode': 'off' } }));
    expect(clientRequestHeaders('/api/projects')).toEqual({});
    expect(withClientRequestContext({ type: 'ping' })).toEqual({ type: 'ping' });
    rememberRequestHeadersMode('basic');
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-device-id']).toBeUndefined();
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-version']).toBeTruthy();
  });
  it('echoes learned project IDs only for the matching project', () => {
    rememberRequestUser('/api/test?projectName=alpha', new Response('{}', { headers: { 'x-pilotdeck-project-id': 'b'.repeat(32) } }));
    expect(clientRequestHeaders('/api/test?projectName=alpha')['x-pilotdeck-project-id']).toBe('b'.repeat(32));
    expect(clientRequestHeaders('/api/test?projectName=beta')['x-pilotdeck-project-id']).toBeUndefined();
    localStorage.setItem('auth-token', 'another-user');
    expect(clientRequestHeaders('/api/test?projectName=alpha')['x-pilotdeck-project-id']).toBeUndefined();
  });
  it('keeps a device across requests but gives each request a new ID', () => {
    const a = clientRequestContext();
    const b = clientRequestContext();
    expect(a.deviceId).toBeTruthy();
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.requestId).not.toBe(b.requestId);
    expect(localStorage.getItem('pilotdeck-device-id')).toBe(a.deviceId);
  });
  it('does not send diagnostics to external URLs or static resources', () => {
    expect(clientRequestHeaders('https://unrelated.example/api/models')).toEqual({});
    expect(clientRequestHeaders('//unrelated.example/api/models')).toEqual({});
    expect(clientRequestHeaders('/logo.svg')).toEqual({});
  });
  it('takes the session from each request, never the globally selected chat', () => {
    const a = crypto.randomUUID(); const b = crypto.randomUUID();
    expect(clientRequestHeaders(`/api/sessions/${a}/messages`)['x-pilotdeck-session-id']).toBe(a);
    expect(clientRequestHeaders('/api/foo', JSON.stringify({ sessionId: b }))['x-pilotdeck-session-id']).toBe(b);
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-session-id']).toBeUndefined();
    expect(JSON.stringify(clientRequestHeaders('/api/foo', JSON.stringify({ sessionId: 'private-user', projectPath: '/private/customer' })))).not.toMatch(/private|customer/);
  });
  it('works on LAN HTTP and when localStorage is blocked', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(42) });
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try { expect(clientRequestContext().requestId).toMatch(/^[0-9a-f-]{36}$/); } finally { spy.mockRestore(); }
  });
  it('only reuses the server-issued user identity for the same login', () => {
    localStorage.setItem('auth-token', 'alice');
    rememberRequestUser('/api/auth/user', new Response('{}', { headers: { 'x-pilotdeck-user-id': 'a'.repeat(32) } }));
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-user-id']).toBe('a'.repeat(32));
    localStorage.setItem('auth-token', 'bob');
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-user-id']).toBeUndefined();
  });
  it('merges Headers and tuple options without changing auth or multipart boundaries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await authenticatedFetch('/api/test', { headers: new Headers({ Authorization: 'Bearer explicit', 'X-Custom': 'yes' }), body: new FormData() });
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer explicit');
    expect(headers.get('x-custom')).toBe('yes');
    expect(headers.get('x-pilotdeck-request-id')).toBeTruthy();
    expect(headers.has('content-type')).toBe(false);
  });
  it('puts diagnostics in WebSocket frames without mutating queued commands', () => {
    const message = { type: 'queue-input', item: { options: { sessionId: 'original' } } };
    const frame = withClientRequestContext(message);
    expect(frame.requestContext.deviceId).toBeTruthy();
    expect(frame.item).toBe(message.item);
    expect(message).not.toHaveProperty('requestContext');
  });
  it('ignores a previous login response that arrives after switching users', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    localStorage.setItem('auth-token', 'old-user');
    const pending = authenticatedFetch('/api/projects');
    localStorage.setItem('auth-token', 'new-user');
    finish(new Response('{}', { headers: { 'x-pilotdeck-user-id': 'c'.repeat(32), 'X-Refreshed-Token': 'old-user-refreshed' } }));
    await pending;
    expect(localStorage.getItem('auth-token')).toBe('new-user');
    expect(clientRequestHeaders('/api/projects')['x-pilotdeck-user-id']).toBeUndefined();
  });
});
