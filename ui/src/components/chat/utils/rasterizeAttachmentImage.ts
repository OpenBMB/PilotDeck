const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
const EXTENSION_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const pending: Array<() => void> = [];
let active = 0;

/** Decode at most two files at once. Queued/active work belongs to its mounted viewer. */
export function rasterizeAttachmentImage(file: File, maxEdge: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = pending.indexOf(start);
      if (index >= 0) pending.splice(index, 1);
      reject(new DOMException('Preview cancelled', 'AbortError'));
    };
    const start = () => {
      signal.removeEventListener('abort', abort);
      active++;
      decode(file, maxEdge, signal).then(resolve, reject).finally(() => { active--; pending.shift()?.(); });
    };
    if (signal.aborted) { abort(); return; }
    if (active < 2) start();
    else { pending.push(start); signal.addEventListener('abort', abort, { once: true }); }
  });
}

function decode(file: File, maxEdge: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const mime = IMAGE_TYPES.has(file.type) ? file.type : EXTENSION_TYPES[file.name.split('.').pop()?.toLowerCase() || ''];
    if (!mime || file.size > 32 * 1024 * 1024 || !Number.isFinite(maxEdge) || maxEdge < 1 || maxEdge > 4096) {
      reject(new Error('Unsupported or oversized preview')); return;
    }
    const reader = new FileReader();
    const image = new Image();
    const canvas = document.createElement('canvas');
    let settled = false;
    const finish = (error?: Error, blob?: Blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reader.onload = reader.onerror = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      canvas.width = canvas.height = 0;
      if (error) reject(error); else resolve(blob!);
    };
    const abort = () => finish(new DOMException('Preview cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Preview decode timed out')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    reader.onerror = () => finish(new Error('Cannot read image'));
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        const chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
        // Only this detached image decoder sees the original bytes. A data URL
        // has an opaque origin; never create a same-origin blob URL for raw SVG/HTML.
        image.src = `data:${mime};base64,${btoa(chunks.join(''))}`;
      } catch { finish(new Error('Cannot decode image')); }
    };
    image.onerror = () => finish(new Error('Cannot decode image'));
    image.onload = () => {
      try {
        const { naturalWidth: width, naturalHeight: height } = image;
        if (!width || !height || width * height > 64 * 1024 * 1024) throw new Error('Image dimensions exceed preview limits');
        const scale = Math.min(1, maxEdge / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image rendering unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        // The public preview contains encoded pixels, never the source markup,
        // scripts, foreignObject content or its original document MIME type.
        canvas.toBlob(blob => {
          if (!blob || blob.type !== 'image/png') finish(new Error('Cannot encode preview'));
          else finish(undefined, blob);
        }, 'image/png');
      } catch (error) { finish(error instanceof Error ? error : new Error('Cannot render image')); }
    };
    try { reader.readAsArrayBuffer(file); }
    catch { finish(new Error('Cannot read image')); }
  });
}
