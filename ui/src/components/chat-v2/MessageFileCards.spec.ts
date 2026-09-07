import { describe, expect, it } from 'vitest';
import { isTransientUploadAttachment } from './messageFileCardUtils';

describe('uploaded attachment workspace actions', () => {
  it('recognizes optimistic browser uploads by their stable upload identity', () => {
    expect(isTransientUploadAttachment({
      name: 'report.pdf',
      path: 'report.pdf',
      uploadId: 'upload-1',
      attachmentId: 'attachment-1',
    })).toBe(true);
  });

  it('recognizes replayed uploads by their transient storage path', () => {
    expect(isTransientUploadAttachment({
      name: 'report.pdf',
      path: '/workspace/demo/.tmp/chat-uploads/upload-1/files/attachment-1',
    })).toBe(true);
  });

  it('keeps ordinary workspace files actionable', () => {
    expect(isTransientUploadAttachment({
      name: 'report.pdf',
      path: 'docs/report.pdf',
    })).toBe(false);
  });
});
