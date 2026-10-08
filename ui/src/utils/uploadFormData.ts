import { IS_PLATFORM } from '../constants/config';

/** Shared transport for chat and workspace uploads; completion awaits the HTTP response. */
export function postFormDataWithProgress({
  url, formData, signal, knownTotalBytes = 0, onProgress, onTransferred,
}: {
  url: string;
  formData: FormData;
  signal: AbortSignal;
  knownTotalBytes?: number;
  onProgress: (percent: number, uploadedBytes: number, totalBytes: number) => void;
  onTransferred?: () => void;
}): Promise<{ ok: boolean; status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : knownTotalBytes;
      if (total <= 0) return;
      const percent = Math.min(100, Math.round(event.loaded / total * 10000) / 100);
      onProgress(percent, Math.min(event.loaded, total), total);
    };
    xhr.upload.onload = () => {
      onProgress(100, knownTotalBytes, knownTotalBytes);
      onTransferred?.();
    };
    xhr.onload = () => {
      cleanup();
      const token = xhr.getResponseHeader('X-Refreshed-Token');
      if (token) localStorage.setItem('auth-token', token);
      let body: Record<string, any> = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* HTTP status still identifies failure. */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.onerror = () => { cleanup(); reject(Object.assign(new Error('Upload failed. Check your connection and retry.'), { code: 'UPLOAD_NETWORK_ERROR' })); };
    xhr.ontimeout = () => { cleanup(); reject(Object.assign(new Error('Upload timed out. Please retry.'), { code: 'UPLOAD_TIMEOUT' })); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload aborted', 'AbortError')); };
    xhr.open('POST', url);
    const token = localStorage.getItem('auth-token');
    if (!IS_PLATFORM && token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    signal.addEventListener('abort', abort, { once: true });
    try { xhr.send(formData); } catch (error) { cleanup(); reject(error); }
  });
}
