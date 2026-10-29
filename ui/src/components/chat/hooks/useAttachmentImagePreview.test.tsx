// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rasterizeAttachmentImage } from '../utils/rasterizeAttachmentImage';
import { useAttachmentImagePreview } from './useAttachmentImagePreview';

vi.mock('../utils/rasterizeAttachmentImage', () => ({ rasterizeAttachmentImage: vi.fn() }));
beforeEach(() => {
  vi.mocked(rasterizeAttachmentImage).mockReset();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:encoded-pixels'), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('never publishes a stale result after replacement or unmount, and releases the selected URL', async () => {
  const jobs: Array<{ resolve: (blob: Blob) => void; signal: AbortSignal }> = [];
  vi.mocked(rasterizeAttachmentImage).mockImplementation((_file, _size, signal) => new Promise(resolve => { jobs.push({ resolve, signal }); }));
  const first = new File(['one'], 'same.svg');
  const second = new File(['two'], 'same.svg');
  const view = renderHook(({ file }) => useAttachmentImagePreview(file, 256), { initialProps: { file: first } });
  view.rerender({ file: second });
  expect(jobs[0].signal.aborted).toBe(true);
  const png = new Blob(['pixels'], { type: 'image/png' });
  await act(async () => jobs[0].resolve(png));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await act(async () => jobs[1].resolve(png));
  expect(URL.createObjectURL).toHaveBeenCalledWith(png);
  expect(view.result.current?.file).toBe(second);
  view.rerender({ file: first });
  expect(view.result.current).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:encoded-pixels');
  view.unmount();
  expect(jobs[2].signal.aborted).toBe(true);
  await act(async () => jobs[2].resolve(png));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});

it('shows decode failure without falling back to a raw document URL', async () => {
  vi.mocked(rasterizeAttachmentImage).mockRejectedValue(new Error('decoder failed'));
  const file = new File(['<script>bad</script>'], 'fake.png', { type: 'text/html' });
  const view = renderHook(() => useAttachmentImagePreview(file, 256));
  await waitFor(() => expect(view.result.current?.failed).toBe(true));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
