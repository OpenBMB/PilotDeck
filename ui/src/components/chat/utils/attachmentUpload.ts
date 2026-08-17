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
  onStatus?.(created as AttachmentUploadRecord);

  let eventsTask: Promise<void> | undefined;
  try {
    const eventsResponse = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}/events`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
      suppressServerErrorToast: true,
    });
    if (eventsResponse.ok) {
      eventsTask = readSse(eventsResponse, signal, onStatus);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('Upload progress stream unavailable; final status will still be verified.', error);
  }

  const formData = new FormData();
  files.forEach((file, index) => {
    formData.append(`files[${manifest[index].clientFileId}]`, file, file.name);
  });
  const contentResponse = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}/content`, {
    method: 'POST',
    body: formData,
    signal,
    suppressServerErrorToast: true,
  });
  const contentResult = await readJson(contentResponse);
  if (!contentResponse.ok) {
    throw uploadError(contentResult.error || contentResult, 'Failed to upload attachments');
  }
  onStatus?.(contentResult as AttachmentUploadRecord);

  const statusResponse = await fetcher(`/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'GET',
    signal,
    suppressServerErrorToast: true,
  });
  const finalRecord = await readJson(statusResponse) as AttachmentUploadRecord;
  if (!statusResponse.ok) {
    throw uploadError(finalRecord, 'Failed to verify upload status');
  }
  onStatus?.(finalRecord);

  if (eventsTask) {
    await eventsTask.catch((error) => {
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
