import { IS_PLATFORM } from '../../../constants/config';
import { authenticatedFetch } from '../../../utils/api';

export type AttachmentUploadStatus =
  | 'created'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type AttachmentUploadRecord = {
  uploadId: string;
  status: AttachmentUploadStatus;
  totalBytes: number;
  uploadedBytes: number;
  percent: number;
  expiresAt?: string;
  attachments?: Array<{
    attachmentId: string;
    name: string;
    relativePath: string;
    bytes?: number;
    mimeType?: string;
  }>;
  errorCode?: string;
  errorMessage?: string;
};

export type AttachmentUploadResult = {
  uploadId: string;
  attachmentIds: string[];
  attachments: NonNullable<AttachmentUploadRecord['attachments']>;
};

type UploadFetcher = typeof authenticatedFetch;

type UploadAttachmentBatchOptions = {
  projectKey: string;
  files: File[];
  signal: AbortSignal;
  fetcher?: UploadFetcher;
  idempotencyKey?: string;
  onCreated?: (uploadId: string) => void;
  onStatus?: (record: AttachmentUploadRecord) => void;
};

const TERMINAL_UPLOAD_STATUSES = new Set<AttachmentUploadStatus>([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uploadError(record: Partial<AttachmentUploadRecord>, fallback: string): Error {
  const details = record as Partial<AttachmentUploadRecord> & { code?: string; message?: string };
  const error = new Error(details.errorMessage || details.message || fallback);
  error.name = details.errorCode || details.code || 'AttachmentUploadError';
  return error;
}

async function readJson(response: Response): Promise<Record<string, any>> {
  return response.json().catch(() => ({}));
}

function applyAuthHeaders(xhr: XMLHttpRequest): void {
  const token = localStorage.getItem('auth-token');
  if (!IS_PLATFORM && token) {
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  }
}

function postFormDataWithProgress({
  url,
  formData,
  signal,
  knownTotalBytes = 0,
  onProgress,
}: {
  url: string;
  formData: FormData;
  signal: AbortSignal;
  knownTotalBytes?: number;
  onProgress: (percent: number, uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ ok: boolean; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    applyAuthHeaders(xhr);

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : knownTotalBytes;
      if (total <= 0) return;
      const rawPercent = Math.round((event.loaded / total) * 10000) / 100;
      const percent = event.loaded >= total || rawPercent >= 99.5
        ? 100
        : Math.min(99, rawPercent);
      onProgress(percent, event.loaded, total);
    };
    // Bytes have left the browser. Do not wait for the server JSON response
    // (hashing / metadata drain) before showing 100%.
    xhr.upload.onload = () => {
      onProgress(100, knownTotalBytes, knownTotalBytes);
    };

    xhr.onload = () => {
      const refreshedToken = xhr.getResponseHeader('X-Refreshed-Token');
      if (refreshedToken) {
        localStorage.setItem('auth-token', refreshedToken);
      }
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        body = {};
      }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        body,
      });
    };
    xhr.onerror = () => reject(new Error('Failed to upload attachments'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

    if (signal.aborted) {
      xhr.abort();
      return;
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(formData);
  });
}

async function readSse(
  response: Response,
  signal: AbortSignal,
  onStatus?: (record: AttachmentUploadRecord) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const record = JSON.parse(data) as AttachmentUploadRecord;
    onStatus?.(record);
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      blocks.forEach(processBlock);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}

export async function cancelAttachmentUpload(
  uploadId: string,
  fetcher: UploadFetcher = authenticatedFetch,
): Promise<void> {
  const response = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    suppressServerErrorToast: true,
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    const result = await readJson(response);
    throw uploadError(result, 'Failed to cancel upload');
  }
}

export async function uploadAttachmentBatch({
  projectKey,
  files,
  signal,
  fetcher = authenticatedFetch,
  idempotencyKey = randomId(),
  onCreated,
  onStatus,
}: UploadAttachmentBatchOptions): Promise<AttachmentUploadResult> {
  const manifest = files.map((file, index) => ({
    clientFileId: `file-${index}-${randomId()}`,
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  }));

  const createResponse = await fetcher('/api/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ projectKey, files: manifest }),
    signal,
    suppressServerErrorToast: true,
  });
  const created = await readJson(createResponse);
  if (!createResponse.ok || typeof created.uploadId !== 'string') {
    throw uploadError(created.error || created, 'Failed to create upload');
  }

  const uploadId = created.uploadId;
  onCreated?.(uploadId);

  let eventsTask: Promise<void> | undefined;
  try {
    const eventsResponse = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}/events`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
      suppressServerErrorToast: true,
    });
    if (eventsResponse.ok) {
      eventsTask = readSse(eventsResponse, signal, (record) => {
        if (
          record.status === 'completed'
          || record.status === 'failed'
          || record.status === 'cancelled'
          || record.status === 'expired'
        ) {
          onStatus?.(record);
        }
      });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('Upload progress stream unavailable; final status will still be verified.', error);
  }

  const formData = new FormData();
  files.forEach((file, index) => {
    formData.append(`files[${manifest[index].clientFileId}]`, file, file.name);
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const contentResponse = await postFormDataWithProgress({
    url: `/api/uploads/${encodeURIComponent(uploadId)}/content`,
    formData,
    signal,
    knownTotalBytes: totalBytes,
    onProgress: (percent, uploadedBytes, uploadedTotal) => {
      onStatus?.({
        uploadId,
        status: 'uploading',
        uploadedBytes,
        totalBytes: uploadedTotal || totalBytes,
        percent,
      });
    },
  });
  if (!contentResponse.ok) {
    throw uploadError(contentResponse.body.error || contentResponse.body, 'Failed to upload attachments');
  }
  onStatus?.({
    uploadId,
    status: 'completed',
    uploadedBytes: totalBytes,
    totalBytes,
    percent: 100,
    attachments: contentResponse.body.attachments,
  });

  const statusResponse = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'GET',
    signal,
    suppressServerErrorToast: true,
  });
  const finalRecord = await readJson(statusResponse) as AttachmentUploadRecord;
  if (!statusResponse.ok) {
    throw uploadError(finalRecord, 'Failed to verify upload status');
  }
  if (finalRecord.status === 'completed') {
    onStatus?.({ ...finalRecord, percent: 100, status: 'completed' });
  } else {
    onStatus?.(finalRecord);
  }

  if (eventsTask) {
    void eventsTask.catch((error) => {
      if (!signal.aborted) {
        console.warn('Upload progress stream ended unexpectedly.', error);
      }
    });
  }

  if (finalRecord.status !== 'completed') {
    const fallback = TERMINAL_UPLOAD_STATUSES.has(finalRecord.status)
      ? `Upload ${finalRecord.status}`
      : 'Upload did not complete';
    throw uploadError(finalRecord, fallback);
  }

  const attachments = Array.isArray(finalRecord.attachments) ? finalRecord.attachments : [];
  return {
    uploadId,
    attachmentIds: attachments.map((attachment) => attachment.attachmentId),
    attachments,
  };
}
