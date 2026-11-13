import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../plugins/staffdeck-sop/src/vendor/DistillPageHost';
import { staffDeckCopyClient, staffDeckKnowledgeClient, staffDeckSopManagementClient } from './clients';
import { staffDeckNotify } from './host-notify';
import i18n from 'i18next';
import en from '../../../i18n/locales/en/staffdeck.json';
import zh from '../../../i18n/locales/zh-CN/staffdeck.json';
vi.mock('../../../utils/api', () => ({ authenticatedFetch: (...args: any[]) => fetch(...args as [string, RequestInit]) }));
afterEach(() => vi.unstubAllGlobals());
describe('module transport contract', () => {
  it.each([
    [404, 'SOP_MANAGEMENT_UPSTREAM_FAILED', 'SOP draft not found.', 'SOP 草稿不存在。'],
    [401, 'SOP_MANAGEMENT_CREDENTIAL_INACTIVE', 'The StaffDeck account credential is inactive.', 'StaffDeck 账户凭据已失效。'],
    [412, 'SOP_MANAGEMENT_UPSTREAM_FAILED', 'The SOP draft changed since it was read.', 'SOP 草稿在读取后已发生变化。'],
  ])('localizes known system error %s without changing transport or retrying', async (status, code, message, translated) => {
    await i18n.init({ lng: 'zh-CN', resources: { en: { staffdeck: en }, 'zh-CN': { staffdeck: zh } } });
    const raw = JSON.stringify({ error: { code, message } });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(raw, { status })));
    vi.stubGlobal('fetch', fetch);
    await expect(staffDeckSopManagementClient.call('get_draft')).rejects.toMatchObject({ status, code, body: raw, message: translated });
    await i18n.changeLanguage('en');
    await expect(staffDeckSopManagementClient.call('get_draft')).rejects.toMatchObject({ status, code, body: raw, message });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves class, status, code and raw wire body without retry', async () => {
    const raw = JSON.stringify({ error: { code: 'CONFLICT', message: 'Original draft changed' } });
    const fetch = vi.fn().mockResolvedValue(new Response(raw, { status: 412 }));
    vi.stubGlobal('fetch', fetch);
    const error = await staffDeckSopManagementClient.call('replace_draft', {}).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 412, code: 'CONFLICT', body: raw, message: 'Original draft changed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves validation locations and rejects HTML with the original stable code', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ detail: [{ loc: ['body', 'content'], msg: 'Invalid graph' }], code: 'INVALID_SOP' }), { status: 422 }))
      .mockResolvedValueOnce(new Response('<html>upstream error</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    await expect(staffDeckSopManagementClient.call('create')).rejects.toMatchObject({ status: 422, code: 'INVALID_SOP', message: 'body.content: Invalid graph' });
    await expect(staffDeckSopManagementClient.call('create')).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it('propagates fetch cancellation with the identical signal and never turns it into success', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_path, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    vi.stubGlobal('fetch', fetch);
    const pending = staffDeckKnowledgeClient.call('list_bases', { agentId: 'target' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('forwards directory bootstrap cancellation through the actual copy request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_path, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    vi.stubGlobal('fetch', fetch);
    const pending = staffDeckCopyClient.call('list_agents', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects missing result envelopes instead of returning an invented empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(staffDeckKnowledgeClient.call('list_bases')).rejects.toThrow('result envelope');
  });
  it('emits visible host notifications with each original tone', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    for (const kind of ['success', 'warning', 'error', 'info'] as const) staffDeckNotify[kind](`message-${kind}`);
    expect(dispatchEvent.mock.calls.map(([event]) => event.detail)).toEqual(['success', 'warning', 'error', 'info'].map(kind => ({ kind, message: `message-${kind}` })));
  });
});
