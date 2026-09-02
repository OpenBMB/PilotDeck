import { useEffect, useState } from 'react';

const MIME_FRIENDLY_LABELS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/msword': 'DOC',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/x-tar': 'TAR',
  'application/gzip': 'GZ',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
  'application/json': 'JSON',
  'application/xml': 'XML',
};

function getFileTypeLabel(file: File): string {
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase() : undefined;
  if (ext && ext !== file.name.toUpperCase()) return ext;
  const friendly = MIME_FRIENDLY_LABELS[file.type.toLowerCase()];
  if (friendly) return friendly;
  if (file.type.includes('/')) {
    const sub = file.type.split('/').pop() || '';
    if (sub.length <= 10 && !sub.includes('.')) return sub.toUpperCase();
  }
  return 'FILE';
}

interface ImageAttachmentProps {
  file: File;
  onRemove: () => void;
  onRetry?: () => void;
  uploadProgress?: number;
  error?: string;
}

const ImageAttachment = ({
  file,
  onRemove,
  onRetry,
  uploadProgress,
  error,
}: ImageAttachmentProps) => {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const isImage = file.type.startsWith('image/');
  
  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  
  const isUploadComplete = uploadProgress !== undefined && uploadProgress >= 100 && !error;
  const showProgressOverlay = uploadProgress !== undefined && uploadProgress < 100 && !error;

  return (
    <div className="group relative">
      {isImage ? (
        <img src={preview} alt={file.name} className="h-20 w-20 rounded object-cover" />
      ) : (
        <div className="flex h-20 w-44 items-center gap-2 rounded border border-neutral-200 bg-white p-2 text-neutral-900 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13H7z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v5h5" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{file.name}</div>
            <div className="mt-0.5 text-[11px] uppercase text-neutral-500">
              {getFileTypeLabel(file)}
            </div>
          </div>
        </div>
      )}
      {showProgressOverlay ? (
        <div className="absolute inset-x-0 bottom-0 overflow-hidden rounded-b bg-black/55 px-2 pb-1.5 pt-1 text-white">
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
            <span>正在上传</span>
            <span className="tabular-nums">{Math.round(uploadProgress)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/30">
            <div
              className="h-full rounded-full bg-violet-300 transition-[width] duration-150"
              style={{ width: `${Math.max(0, Math.min(100, uploadProgress))}%` }}
            />
          </div>
        </div>
      ) : null}
      {isUploadComplete ? (
        <div
          className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
          title="上传完毕"
          aria-label="上传完毕"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      ) : null}
      {error ? (
        <>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-red-600/85 px-2 text-center text-white">
            <svg className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="line-clamp-2 text-[10px]" title={error}>{error}</span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded bg-white/95 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-white"
              >
                重试
              </button>
            ) : null}
          </div>
          <div role="alert" className="mt-1 max-w-44 text-xs leading-4 text-red-600 dark:text-red-400">
            {error}
          </div>
        </>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={uploadProgress !== undefined && uploadProgress < 100
          ? `取消上传 ${file.name}`
          : `删除附件 ${file.name}`}
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

export default ImageAttachment;
