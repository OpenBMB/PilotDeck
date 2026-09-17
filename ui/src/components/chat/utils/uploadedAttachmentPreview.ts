import type { ChatAttachment } from '../types/types';

// Browser-local cache only. Reloads and cache misses use the upload HTTP API.
const previews = new Map<string, string>();
const MAX_PREVIEW_CHARACTERS = 16 * 1024 * 1024;
let previewCharacters = 0;

export function uploadedPreviewKey(attachment: Pick<ChatAttachment, 'uploadId' | 'attachmentId'>): string {
  return JSON.stringify([attachment.uploadId, attachment.attachmentId]);
}

export function rememberUploadedPreview(attachment: ChatAttachment): void {
  const data = attachment.previewData;
  if (!attachment.uploadId || !attachment.attachmentId || !data?.startsWith('data:image/')) return;
  const key = uploadedPreviewKey(attachment);
  const previous = previews.get(key);
  if (previous) { previews.delete(key); previewCharacters -= previous.length; }
  if (data.length > MAX_PREVIEW_CHARACTERS) return;
  previews.set(key, data);
  previewCharacters += data.length;
  while (previewCharacters > MAX_PREVIEW_CHARACTERS) {
    const oldest = previews.keys().next().value!;
    previewCharacters -= previews.get(oldest)!.length;
    previews.delete(oldest);
  }
}

export function cachedUploadedPreview(attachment: ChatAttachment): string | undefined {
  return attachment.previewData || previews.get(uploadedPreviewKey(attachment));
}

export function attachmentDisplayMetadata(attachment: ChatAttachment): ChatAttachment {
  const { previewData: _previewData, ...metadata } = attachment;
  return metadata;
}
