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
  uploadProgress?: number;
  error?: string;
}

const ImageAttachment = ({ file, onRemove, uploadProgress, error }: ImageAttachmentProps) => {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const isImage = file.type.startsWith('image/');
  const removeLabel = `Remove attachment ${file.name}`;

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

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
      {uploadProgress !== undefined && uploadProgress < 100 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-xs text-white">{uploadProgress}%</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={removeLabel}
        title={removeLabel}
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

export default ImageAttachment;
