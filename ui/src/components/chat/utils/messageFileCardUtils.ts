import type { ChatAttachment } from '../types/types';

const TRANSIENT_UPLOAD_PATH = /(?:^|\/)\.tmp\/chat-uploads\//;

export function isTransientUploadAttachment(attachment: ChatAttachment): boolean {
  if (attachment.uploadId || attachment.attachmentId) return true;
  const candidate = String(attachment.path || attachment.filePath || '').replace(/\\/g, '/');
  return TRANSIENT_UPLOAD_PATH.test(candidate);
}
