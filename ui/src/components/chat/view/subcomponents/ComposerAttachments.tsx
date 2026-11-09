import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ImageAttachment from './ImageAttachment';
import AttachmentPreview from './AttachmentPreview';

export default function ComposerAttachments({ files, uploading, errors, onRemove, onRetry }: {
  files: File[]; uploading: Map<File, number>; errors: Map<File | string, string>;
  onRemove: (index: number) => void; onRetry: (file: File) => void;
}) {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<File | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const railRef = useRef<HTMLDivElement>(null);
  const fileKeys = useRef(new WeakMap<File, number>());
  const nextKey = useRef(0);
  for (const file of files) {
    if (!fileKeys.current.has(file)) fileKeys.current.set(file, nextKey.current++);
  }
  const previousCount = useRef(files.length);
  const close = useCallback(() => setPreview(null), []);
  const updateEdges = useCallback(() => {
    const rail = railRef.current;
    if (rail) setEdges({ left: rail.scrollLeft > 1, right: rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    if (files.length > previousCount.current) rail.scrollLeft = rail.scrollWidth;
    previousCount.current = files.length;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [files, updateEdges]);
  const scroll = (direction: number) => railRef.current?.scrollBy({ left: direction * railRef.current.clientWidth * 0.8, behavior: 'smooth' });
  return <div className="w-full min-w-0">
    <div className="mb-1 text-xs text-neutral-500">{t('attachmentPreview.count', { count: files.length })}</div>
    <div className="flex min-w-0 items-center gap-1">
      {edges.left && <button type="button" onClick={() => scroll(-1)} aria-label={t('attachmentPreview.scrollPrevious')} className="shrink-0 rounded p-1"><ChevronLeft size={18} /></button>}
      <div ref={railRef} onScroll={updateEdges} className="flex min-w-0 flex-1 gap-3 overflow-x-auto px-2 py-3 [scrollbar-width:thin]">
        {files.map((file, index) => <div key={fileKeys.current.get(file)} className="shrink-0"><ImageAttachment file={file}
          onPreview={() => setPreview(file)} onRemove={() => onRemove(index)} onRetry={() => onRetry(file)}
          uploadProgress={uploading.get(file)} error={errors.get(file)} /></div>)}
      </div>
      {edges.right && <button type="button" onClick={() => scroll(1)} aria-label={t('attachmentPreview.scrollNext')} className="shrink-0 rounded p-1"><ChevronRight size={18} /></button>}
    </div>
    {preview && files.includes(preview) && <AttachmentPreview files={files} initialFile={preview} onClose={close} />}
  </div>;
}
