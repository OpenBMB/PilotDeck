// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { uploadAttachmentBatch } from './attachmentUpload';
import { postFormDataWithProgress } from '../../../utils/uploadFormData';
vi.mock('../../../utils/uploadFormData', () => ({ postFormDataWithProgress: vi.fn() }));

describe('upload manifest correlation', () => {
  it.each([false, true])('orders same-name attachments by client ID and rejects missing metadata (missing=%s)', async missing => {
    let manifest: any[] = [];
    const fetcher = vi.fn(async (url: string, options: any) => {
      if (url === '/api/uploads') {
        manifest = JSON.parse(options.body).files;
        return { ok: true, json: async () => ({ uploadId: 'batch' }) };
      }
      if (url.endsWith('/events')) return { ok: false };
      return { ok: true, json: async () => ({ status: 'completed', attachments:
        manifest.slice(missing ? 1 : 0).map(file => ({ attachmentId: file.clientFileId, name: file.name, relativePath: file.relativePath })).reverse() }) };
    });
    vi.mocked(postFormDataWithProgress).mockResolvedValue({ ok: true, body: {}, status: 200 });
    const result = uploadAttachmentBatch({ projectKey: '/project', signal: new AbortController().signal,
      files: Array.from({ length: 3 }, () => new File(['x'], 'image.png', { type: 'image/png' })), fetcher: fetcher as any });
    if (missing) await expect(result).rejects.toThrow('without attachment metadata');
    else {
      const uploaded = await result;
      expect(uploaded.attachmentIds).toEqual(manifest.map(file => file.clientFileId));
      expect(new Set(uploaded.attachmentIds).size).toBe(3);
    }
  });
});
