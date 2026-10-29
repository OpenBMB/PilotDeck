import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { attachmentPreviewKind } from '../../utils/attachmentPreviewKind';
import { useAttachmentImagePreview } from '../../hooks/useAttachmentImagePreview';
import './attachmentPreview.css';

const TEXT_LIMIT = 256 * 1024;
const DOCUMENT_LIMIT = 20 * 1024 * 1024;
const PdfPreview = lazy(() => import('../../../code-editor/view/subcomponents/PdfDocumentPreview'));
const DocxPreview = lazy(() => import('../../../code-editor/view/subcomponents/DocxBuiltinPreview'));
const PptxPreview = lazy(() => import('../../../code-editor/view/subcomponents/PptxBuiltinPreview'));
const SpreadsheetPreview = lazy(() => import('./AttachmentSpreadsheetPreview'));

function FileContent({ file, url }: { file: File; url: string }) {
  const { t } = useTranslation('chat');
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const kind = attachmentPreviewKind(file);
  const image = useAttachmentImagePreview(kind === 'image' ? file : null, 4096);
  useEffect(() => {
    if (kind !== 'text') return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.onerror = () => setFailed(true);
    reader.readAsText(file.slice(0, TEXT_LIMIT));
    return () => { if (reader.readyState === FileReader.LOADING) reader.abort(); };
  }, [file, kind]);
  const unavailable = <p className="m-auto p-6 text-center text-sm text-neutral-500">{t(failed ? 'attachmentPreview.failed' : 'attachmentPreview.unsupported')}</p>;
  if (failed || image?.failed) return <p className="m-auto p-6 text-sm text-neutral-500">{t('attachmentPreview.failed')}</p>;
  if (['pdf', 'docx', 'pptx', 'xlsx'].includes(kind)) {
    if (file.size > DOCUMENT_LIMIT) return <p className="m-auto p-6 text-sm">{t('attachmentPreview.tooLarge')}</p>;
    return <ErrorBoundary fallback={unavailable}><Suspense fallback={<p className="m-auto p-4">{t('attachmentPreview.loading')}</p>}>
      <div className="h-full w-full min-w-0" data-document-preview>
        {kind === 'pdf' && <PdfPreview blob={file} fileName={file.name} filePath="" viewKey={url} source="pdf" allowReferences={false} />}
        {kind === 'docx' && <DocxPreview blob={file} fileName={file.name} filePath="" allowReferences={false} onError={fail} />}
        {kind === 'pptx' && <PptxPreview blob={file} fileName={file.name} filePath="" allowReferences={false} onError={fail} />}
        {kind === 'xlsx' && <SpreadsheetPreview file={file} onError={fail} />}
      </div>
    </Suspense></ErrorBoundary>;
  }
  if (kind === 'image') return <figure className="flex h-full min-h-0 w-full flex-col gap-2">
    <img src={image?.url} alt={file.name} onError={() => setFailed(true)} className="mx-auto min-h-0 max-w-full flex-1 object-contain" />
    <figcaption className="shrink-0 text-center text-xs text-neutral-500">{t('attachmentPreview.imageNote')}</figcaption>
  </figure>;
  if (kind === 'audio') return <audio controls src={url} onError={() => setFailed(true)} className="m-auto max-w-full" />;
  if (kind === 'video') return <video controls src={url} onError={() => setFailed(true)} className="m-auto max-h-full max-w-full" />;
  if (kind === 'text') return <div className="w-full overflow-auto p-4">
    {file.size > TEXT_LIMIT && <p className="mb-3 text-sm text-amber-600">{t('attachmentPreview.truncated')}</p>}
    <pre className="whitespace-pre-wrap break-words text-sm">{text ?? t('attachmentPreview.loading')}</pre>
  </div>;
  return unavailable;
}

/** Local draft bytes stay in the browser; previewing never uploads a second copy. */
export default function AttachmentPreview({ files, initialFile, onClose }: {
  files: File[]; initialFile: File; onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  const [selected, setSelected] = useState(initialFile);
  const [resource, setResource] = useState<{ file: File; url: string; downloadUrl: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const index = Math.max(0, files.indexOf(selected));
  const file = files[index];
  const move = (delta: number) => setSelected(files[(index + delta + files.length) % files.length]);

  useEffect(() => {
    if (!file) { onClose(); return; }
    // Original bytes are downloadable, but never an active same-origin document.
    const downloadUrl = URL.createObjectURL(file.slice(0, file.size, 'application/octet-stream'));
    const kind = attachmentPreviewKind(file);
    const url = kind === 'audio' || kind === 'video' ? URL.createObjectURL(file) : downloadUrl;
    setResource({ file, url, downloadUrl });
    return () => { URL.revokeObjectURL(downloadUrl); if (url !== downloadUrl) URL.revokeObjectURL(url); };
  }, [file, onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => { document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus(); };
  }, []);

  if (!file) return null;
  // The chat's capture-phase Escape handler yields to registered modal overlays.
  return createPortal(<div data-modal-overlay className="attachment-preview-viewport z-[2147483647] flex items-center justify-center bg-black/75 p-3 sm:p-8"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('attachmentPreview.title')}
      className="flex h-[85vh] max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white text-neutral-900 shadow-2xl dark:bg-neutral-900 dark:text-neutral-100"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        // Media controls and PDF viewers keep their own arrow-key behavior.
        if (event.target instanceof HTMLElement && !event.target.closest('audio, video, [data-document-preview], input, textarea, select') && files.length > 1) {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1); }
        }
        if (event.key === 'Tab') {
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('*') ?? []).filter(element => element.matches('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), audio[controls], video[controls], object, [tabindex="0"]'));
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-700">
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={file.name}>{file.name}</div>
          <div className="text-xs text-neutral-500">{(file.size / 1024).toFixed(1)} KB · {index + 1} / {files.length}</div></div>
        {resource?.file === file && <a href={resource.downloadUrl} download={file.name} className="rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label={t('attachmentPreview.download')}><Download size={18} /></a>}
        <button ref={closeRef} type="button" onClick={onClose} className="rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label={t('attachmentPreview.close')}><X size={20} /></button>
      </header>
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {files.length > 1 && <button type="button" onClick={() => move(-1)} aria-label={t('attachmentPreview.previous')} className="self-center rounded-full p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"><ChevronLeft /></button>}
        <div className="flex min-w-0 flex-1 overflow-auto">{resource?.file === file && <FileContent key={resource.url} file={file} url={resource.url} />}</div>
        {files.length > 1 && <button type="button" onClick={() => move(1)} aria-label={t('attachmentPreview.next')} className="self-center rounded-full p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"><ChevronRight /></button>}
      </div>
    </div>
  </div>, document.body);
}
