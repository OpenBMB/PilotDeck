import { File, FileSpreadsheet, FileText, Scan, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import {
  getContentReferenceSummary,
  normalizeContentReference,
  type ContentReference,
} from '../../types/contentReference';
import type { DocumentSelectionReference } from '../../types/documentSelection';

type DocumentReferenceFileMeta = {
  label: string;
  Icon: LucideIcon;
  className: string;
};

function getFileExtension(fileName: string): string {
  const cleanName = fileName.split(/[?#]/)[0] || fileName;
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : '';
  return (extension || '').toLowerCase();
}

function getDocumentReferenceFileMeta(fileName: string): DocumentReferenceFileMeta {
  const extension = getFileExtension(fileName);
  if (extension === 'pdf') {
    return {
      label: 'PDF',
      Icon: FileText,
      className: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300',
    };
  }
  if (['doc', 'docx', 'odt'].includes(extension)) {
    return {
      label: 'DOC',
      Icon: FileText,
      className: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
    };
  }
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(extension)) {
    return {
      label: 'XLS',
      Icon: FileSpreadsheet,
      className: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
    };
  }
  if (['ppt', 'pptx', 'odp'].includes(extension)) {
    return {
      label: 'PPT',
      Icon: FileText,
      className: 'bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300',
    };
  }
  return {
    label: extension ? extension.slice(0, 3).toUpperCase() : 'FILE',
    Icon: File,
    className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  };
}

type DocumentReferenceChipProps = {
  reference: ContentReference | DocumentSelectionReference;
  className?: string;
  summaryLength?: number;
  removeLabel?: string;
  openLabel?: string;
  onOpen?: () => void;
  onRemove?: () => void;
};

export default function DocumentReferenceChip({
  reference,
  className,
  summaryLength = 80,
  removeLabel,
  openLabel,
  onOpen,
  onRemove,
}: DocumentReferenceChipProps) {
  const { t } = useTranslation('codeEditor');
  const normalized = normalizeContentReference(reference);
  if (!normalized) return null;
  const meta = getDocumentReferenceFileMeta(normalized.source.fileName);
  const ReferenceIcon = meta.Icon;
  const summary = getContentReferenceSummary(
    normalized,
    summaryLength,
    t('contentReference.regionSummary'),
  );
  const location = normalized.selectionMode === 'text'
    ? normalized.locator.pageNumbers?.length
      ? t('contentReference.locations.page', {
        numbers: normalized.locator.pageNumbers.join(', '),
      })
      : normalized.locator.slideNumbers?.length
        ? t('contentReference.locations.slide', {
          numbers: normalized.locator.slideNumbers.join(', '),
        })
        : null
    : normalized.selectionMode === 'cells'
      ? normalized.locator.sheetName
      : normalized.locator.pageNumber
        ? t('contentReference.locations.page', {
          numbers: normalized.locator.pageNumber,
        })
        : normalized.locator.slideNumber
          ? t('contentReference.locations.slide', {
            numbers: normalized.locator.slideNumber,
          })
          : normalized.locator.sheetName || null;
  const title = [
    normalized.source.fileName,
    location,
    summary,
  ].filter(Boolean).join('\n');

  return (
    <div
      className={cn(
        'flex h-8 min-w-0 max-w-full items-center rounded-lg bg-neutral-100 text-left text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300',
        className,
      )}
      title={title}
    >
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left disabled:cursor-default"
        title={onOpen ? openLabel || title : title}
        aria-label={onOpen ? openLabel || title : title}
      >
        <span
          className={cn(
            'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-semibold leading-none',
            meta.className,
          )}
        >
          {normalized.selectionMode === 'region'
            ? <Scan className="h-3 w-3" strokeWidth={2} />
            : <ReferenceIcon className="h-3 w-3" strokeWidth={2} />}
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] leading-5">
          &quot;{summary}&quot;
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          title={removeLabel}
          aria-label={removeLabel}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
