export const DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB = 20;
export const DEFAULT_CHAT_MAX_ATTACHMENTS = 10;
export const ATTACHMENT_UPLOAD_LIMITS_CHANGED_EVENT = 'pilotdeck:attachment-upload-limits-changed';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const MAX_SAFE_ATTACHMENT_SIZE_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MEGABYTE);

export type AttachmentUploadLimits = {
  maxFileSizeMB: number;
  maxFileSizeBytes: number;
  maxAttachments: number;
};

export function isValidAttachmentSizeMB(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SAFE_ATTACHMENT_SIZE_MB;
}

export function normalizeAttachmentUploadLimits(value: unknown): AttachmentUploadLimits {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const maxFileSizeMB = isValidAttachmentSizeMB(source.maxFileSizeMB)
    ? source.maxFileSizeMB
    : DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB;
  const maxAttachments = Number.isSafeInteger(source.maxAttachments) && (source.maxAttachments as number) > 0
    ? source.maxAttachments as number
    : DEFAULT_CHAT_MAX_ATTACHMENTS;

  return {
    maxFileSizeMB,
    maxFileSizeBytes: maxFileSizeMB * BYTES_PER_MEGABYTE,
    maxAttachments,
  };
}

export const DEFAULT_ATTACHMENT_UPLOAD_LIMITS = normalizeAttachmentUploadLimits({});

export function isAttachmentWithinSizeLimit(
  file: Pick<File, 'size'>,
  limits: AttachmentUploadLimits,
): boolean {
  return typeof file.size === 'number'
    && Number.isFinite(file.size)
    && file.size >= 0
    && file.size <= limits.maxFileSizeBytes;
}

export function attachmentSizeLimitError(maxFileSizeMB: number): string {
  return `File too large (max ${maxFileSizeMB}MB)`;
}

export function dispatchAttachmentUploadLimitsChanged(limits: AttachmentUploadLimits): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ATTACHMENT_UPLOAD_LIMITS_CHANGED_EVENT, {
    detail: limits,
  }));
}
