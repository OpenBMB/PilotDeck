import { useEffect, useState } from 'react';
import { rasterizeAttachmentImage } from '../utils/rasterizeAttachmentImage';

export function useAttachmentImagePreview(file: File | null, maxEdge: number) {
  const [result, setResult] = useState<{ file: File; maxEdge: number; url?: string; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    let url: string | undefined;
    void rasterizeAttachmentImage(file, maxEdge, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setResult({ file, maxEdge, url });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ file, maxEdge, failed: true });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file, maxEdge]);
  return result?.file === file && result.maxEdge === maxEdge ? result : null;
}
