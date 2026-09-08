// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createUpdateNetwork, resolveUpdateProxy } from '../../../apps/desktop/src/updateNetwork';

describe('desktop update proxy', () => {
  it('reads application config and gives explicit environment settings precedence', () => {
    expect(resolveUpdateProxy({ url: 'http://127.0.0.1:7890' }, {}).settings).toMatchObject({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' });
    for (const key of ['PILOTDECK_PROXY', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
      expect(resolveUpdateProxy({ url: 'http://config:80' }, { [key]: 'http://env:8080' }).settings.proxyRules).toBe('http://env:8080');
    }
    expect(resolveUpdateProxy(undefined, {}).settings).toEqual({ mode: 'system' });
  });
  it('merges bypasses and preserves local Squirrel traffic', () => {
    const { settings } = resolveUpdateProxy({ url: 'http://proxy:8080', noProxy: '.example.com' }, { NO_PROXY: 'internal' });
    expect(settings.proxyBypassRules).toBe('internal;example.com;*.example.com;localhost;127.0.0.1;[::1]');
  });
  it('refreshes the shared updater session only when config changes', async () => {
    let config: { url: string } | undefined = { url: 'http://proxy:8080' };
    const session = { setProxy: vi.fn(), closeAllConnections: vi.fn(), clearAuthCache: vi.fn(), fetch: vi.fn() };
    const request = vi.fn(async () => "{}");
    const network = createUpdateNetwork(session, () => config, {}, () => ({ request }));
    await network.prepare(); await network.prepare();
    expect(session.setProxy).toHaveBeenCalledTimes(1);
    expect(session.setProxy.mock.invocationCallOrder[0]).toBeLessThan(session.closeAllConnections.mock.invocationCallOrder[0]);
    await network.fetch('https://api.github.com/repos/owner/repo/releases');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api.github.com', path: '/repos/owner/repo/releases' }), expect.anything());
    config = undefined; await network.prepare();
    expect(session.setProxy).toHaveBeenLastCalledWith({ mode: 'system' });
  });
  it('only provides credentials to the configured proxy challenge', async () => {
    const session = { setProxy: vi.fn(), closeAllConnections: vi.fn(), clearAuthCache: vi.fn(), fetch: vi.fn() };
    const network = createUpdateNetwork(session, () => 'http://user:p%40ss@proxy:8080', {});
    await network.prepare();
    expect(session.setProxy).toHaveBeenCalledWith(expect.objectContaining({ proxyRules: 'http://proxy:8080' }));
    expect(network.credentialsFor({ isProxy: true, host: 'proxy', port: 8080 })).toMatchObject({ username: 'user', password: 'p@ss' });
    expect(network.credentialsFor({ isProxy: false, host: 'proxy', port: 8080 })).toBeNull();
    expect(network.credentialsFor({ isProxy: true, host: 'other', port: 8080 })).toBeNull();
  });
  it('surfaces proxy initialization errors instead of silently fetching directly', async () => {
    const session = { setProxy: vi.fn().mockRejectedValue(new Error('invalid proxy')), closeAllConnections: vi.fn(), clearAuthCache: vi.fn(), fetch: vi.fn() };
    const network = createUpdateNetwork(session, () => 'http://proxy:8080', {});
    await expect(network.prepare()).rejects.toThrow('invalid proxy');
    expect(session.fetch).not.toHaveBeenCalled();
  });
  it('aborts discovery requests when the release timeout signal fires', async () => {
    const abortRequest = vi.fn();
    const request = vi.fn((_options, token) => token.createPromise((_resolve, _reject, onCancel) => onCancel(abortRequest)));
    const session = { setProxy: vi.fn(), closeAllConnections: vi.fn(), clearAuthCache: vi.fn() };
    const network = createUpdateNetwork(session, () => undefined, {}, () => ({ request }));
    const abort = new AbortController();
    const fetching = network.fetch('https://api.github.com/releases', { signal: abort.signal });
    abort.abort();
    await expect(fetching).rejects.toThrow();
    expect(abortRequest).toHaveBeenCalledTimes(1);
    await expect(network.fetch('https://api.github.com/releases', { signal: abort.signal })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

});
