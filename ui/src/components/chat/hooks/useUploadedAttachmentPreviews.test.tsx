// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import { useUploadedAttachmentPreviews } from './useUploadedAttachmentPreviews';
vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('bounds preview concurrency, retains source order, and aborts in-flight loads when canonical images arrive', async () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ name: 'image.png', uploadId: 'bounded', attachmentId: String(index), mimeType: 'image/png' }));
  const finish: Array<() => void> = [];
  vi.mocked(authenticatedFetch).mockImplementation((_url, _options) => new Promise(resolve => finish.push(() => resolve({ ok: true, json: async () => ({ data: 'data:image/png;base64,YQ==' }) } as Response))));
  const { result, rerender } = renderHook(({ confirmed }) => useUploadedAttachmentPreviews(files, confirmed), { initialProps: { confirmed: false } });
  expect(authenticatedFetch).toHaveBeenCalledTimes(4);
  await act(async () => finish[2]());
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(5));
  expect(result.current.map(file => file.attachmentId)).toEqual(files.map(file => file.attachmentId));
  expect(result.current[2].previewData).toBeTruthy();
  rerender({ confirmed: true });
  expect((vi.mocked(authenticatedFetch).mock.calls[0][1] as RequestInit)?.signal?.aborted).toBe(true);
  await act(async () => finish.forEach(resolve => resolve()));
  expect(authenticatedFetch).toHaveBeenCalledTimes(5);
});
