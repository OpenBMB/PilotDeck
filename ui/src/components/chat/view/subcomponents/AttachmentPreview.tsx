import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { attachmentPreviewKind } from '../../utils/attachmentPreviewKind';

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
  useEffect(() => {
    if (kind !== 'text') return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.onerror = () => setFailed(true);
    reader.readAsText(file.slice(0, TEXT_LIMIT));
    return () => { if (reader.readyState === FileReader.LOADING) reader.abort(); };
  }, [file, kind]);
  const unavailable = <p className="m-auto p-6 text-center text-sm text-neutral-500">{t(failed ? 'attachmentPreview.failed' : 'attachmentPreview.unsupported')}</p>;
  if (failed) return unavailable;
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
  if (kind === 'image') return <img src={url} alt={file.name} onError={() => setFailed(true)} className="m-auto max-h-full max-w-full object-contain" />;
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
  const [resource, setResource] = useState<{ file: File; url: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const index = Math.max(0, files.indexOf(selected));
  const file = files[index];
  const move = (delta: number) => setSelected(files[(index + delta + files.length) % files.length]);

  useEffect(() => {
    if (!file) { onClose(); return; }
    // Force PDF MIME even when the OS did not supply one.
    const blob = attachmentPreviewKind(file) === 'pdf' ? file.slice(0, file.size, 'application/pdf') : file;
    const url = URL.createObjectURL(blob);
    setResource({ file, url });
    return () => URL.revokeObjectURL(url);
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
  return createPortal(<div data-modal-overlay className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/75 p-3 sm:p-8"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('attachmentPreview.title')}
      className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white text-neutral-900 shadow-2xl dark:bg-neutral-900 dark:text-neutral-100"
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
      <header className="flex items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-700">
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={file.name}>{file.name}</div>
          <div className="text-xs text-neutral-500">{(file.size / 1024).toFixed(1)} KB · {index + 1} / {files.length}</div></div>
        {resource?.file === file && <a href={resource.url} download={file.name} className="rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label={t('attachmentPreview.download')}><Download size={18} /></a>}
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
