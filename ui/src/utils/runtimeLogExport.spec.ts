// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { saveRuntimeLogs } from './runtimeLogExport';
const { fetchLogs } = vi.hoisted(() => ({ fetchLogs: vi.fn() }));
vi.mock('./api', () => ({ authenticatedFetch: fetchLogs }));
afterEach(() => { delete window.pilotdeckDesktop; delete (window as any).showSaveFilePicker; vi.clearAllMocks(); });
it('does not request logs or claim success when a browser save dialog is canceled', async () => {
  (window as any).showSaveFilePicker = vi.fn().mockRejectedValue(Object.assign(new Error('Canceled'), { name: 'AbortError' }));
  expect(await saveRuntimeLogs()).toEqual({ canceled: true }); expect(fetchLogs).not.toHaveBeenCalled();
});
it('writes the authenticated log response to the user-selected browser destination', async () => {
  const output = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }, blob = new Blob(['sanitized logs']);
  (window as any).showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(output) });
  fetchLogs.mockResolvedValue({ ok: true, blob: async () => blob });
  expect(await saveRuntimeLogs()).toEqual({ canceled: false }); expect(output.write).toHaveBeenCalledWith(blob); expect(output.close).toHaveBeenCalledOnce();
});
