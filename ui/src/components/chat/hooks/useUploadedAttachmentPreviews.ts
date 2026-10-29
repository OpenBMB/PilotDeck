import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { ChatAttachment } from '../types/types';
import { cachedUploadedPreview, rememberUploadedPreview, uploadedPreviewKey } from '../utils/uploadedAttachmentPreview';

export function useUploadedAttachmentPreviews(attachments: ChatAttachment[], hasCanonicalImages = false): ChatAttachment[] {
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const missing = attachments.filter(attachment => !hasCanonicalImages && attachment.uploadId && attachment.attachmentId
    && attachment.mimeType?.startsWith('image/') && !attachment.previewData);
  // Identity, not a parent render or a new token, controls request lifetime.
  const requestKey = JSON.stringify(missing.map(({ uploadId, attachmentId }) => [uploadId, attachmentId]));
  useEffect(() => {
    const controller = new AbortController();
    const identities: [string, string][] = JSON.parse(requestKey);
    // Bound concurrent disk verification, base64 transfer and image decoding.
    let next = 0;
    const worker = async () => {
      while (next < identities.length && !controller.signal.aborted) {
        const [uploadId, attachmentId] = identities[next++];
        if (cachedUploadedPreview({ name: '', uploadId, attachmentId })) continue;
        try {
          const response = await authenticatedFetch(`/api/uploads/${encodeURIComponent(uploadId)}/attachments/${encodeURIComponent(attachmentId)}/preview`, {
            signal: controller.signal, suppressServerErrorToast: true,
          });
          if (!response.ok) continue;
          const { data } = await response.json();
          if (controller.signal.aborted || typeof data !== 'string' || !data.startsWith('data:image/')) continue;
          const attachment = { name: '', uploadId, attachmentId, previewData: data };
          rememberUploadedPreview(attachment);
          setLoaded(previous => ({ ...previous, [uploadedPreviewKey(attachment)]: data }));
        } catch { /* Failed/expired previews retain the ordinary attachment card. */ }
      }
    };
    for (let index = 0; index < Math.min(4, identities.length); index++) void worker();
    return () => controller.abort();
  }, [requestKey]);
  return useMemo(() => attachments.map(attachment => {
    const previewData = cachedUploadedPreview(attachment) || loaded[uploadedPreviewKey(attachment)];
    return previewData ? { ...attachment, previewData } : attachment;
  }), [attachments, loaded]);
}
