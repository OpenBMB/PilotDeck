import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_UPLOAD_LIMITS,
  isAttachmentWithinSizeLimit,
  isValidAttachmentSizeMB,
  normalizeAttachmentUploadLimits,
} from './attachmentUploadLimits';

describe('attachment upload limits', () => {
  it('defaults to 20MB and permits a file at the configured boundary', () => {
    expect(DEFAULT_ATTACHMENT_UPLOAD_LIMITS.maxFileSizeMB).toBe(20);
    expect(isAttachmentWithinSizeLimit(
      { size: 20 * 1024 * 1024 },
      DEFAULT_ATTACHMENT_UPLOAD_LIMITS,
    )).toBe(true);
  });

  it('uses a 100MB value returned by the settings API', () => {
    const limits = normalizeAttachmentUploadLimits({ maxFileSizeMB: 100, maxAttachments: 10 });

    expect(isAttachmentWithinSizeLimit({ size: 100 * 1024 * 1024 }, limits)).toBe(true);
    expect(isAttachmentWithinSizeLimit({ size: 100 * 1024 * 1024 + 1 }, limits)).toBe(false);
  });

  it('falls back to 20MB for invalid settings payloads', () => {
    expect(normalizeAttachmentUploadLimits({ maxFileSizeMB: 0 }).maxFileSizeMB).toBe(20);
    expect(normalizeAttachmentUploadLimits({ maxFileSizeMB: 1.5 }).maxFileSizeMB).toBe(20);
    expect(isValidAttachmentSizeMB(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
