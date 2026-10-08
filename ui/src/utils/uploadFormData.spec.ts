import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postFormDataWithProgress } from './uploadFormData';
vi.mock('../constants/config', () => ({ IS_PLATFORM: false }));
class FakeXhr {
  static latest: FakeXhr;
  upload: any = {};
  onload!: () => void;
  onerror!: () => void;
  onabort!: () => void;
  ontimeout!: () => void;
  status = 200;
  responseText = '{"success":true}';
  open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
  getResponseHeader = vi.fn(() => 'new-token');
  abort = vi.fn(() => this.onabort());
  constructor() { FakeXhr.latest = this; }
}
beforeEach(() => { vi.stubGlobal('XMLHttpRequest', FakeXhr); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('shared upload transport', () => {
  it('reports transfer progress, waits for response, and preserves auth refresh', async () => {
    localStorage.setItem('auth-token', 'token');
    const progress = vi.fn(); const transferred = vi.fn(); const complete = vi.fn();
    const controller = new AbortController();
    const result = postFormDataWithProgress({ url: '/upload', formData: new FormData(), signal: controller.signal, knownTotalBytes: 100, onProgress: progress, onTransferred: transferred });
    void result.then(complete);
    const xhr = FakeXhr.latest;
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer token');
    xhr.upload.onprogress({ lengthComputable: true, loaded: 36, total: 100 });
    expect(progress).toHaveBeenCalledWith(36, 36, 100);
    xhr.upload.onload();
    expect(transferred).toHaveBeenCalledOnce();
    await Promise.resolve(); expect(complete).not.toHaveBeenCalled();
    xhr.onload();
    expect(await result).toMatchObject({ ok: true, status: 200 });
    expect(localStorage.getItem('auth-token')).toBe('new-token');
    controller.abort(); expect(xhr.abort).not.toHaveBeenCalled();
  });
  it('rejects an already cancelled upload without starting a request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(postFormDataWithProgress({ url: '/upload', formData: new FormData(), signal: controller.signal, onProgress: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels an active request', async () => {
    const controller = new AbortController();
    const request = postFormDataWithProgress({ url: '/upload', formData: new FormData(), signal: controller.signal, onProgress: vi.fn() });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
