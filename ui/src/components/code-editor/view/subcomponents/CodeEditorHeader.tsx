import { ArrowLeft, Check, ChevronsLeftRight, ChevronsRightLeft, Code2, Download, Eye, Maximize2, Minimize2, Save, X } from 'lucide-react';
import type { CodeEditorFile } from '../../types/types';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  isMarkdownFile: boolean;
  markdownPreview: boolean;
  saving: boolean;
  saveSuccess: boolean;
  canGoBack?: boolean;
  parentFileName?: string | null;
  onGoBack?: (() => void) | null;
  // Only relevant in sidebar (split-pane) mode: lets the user toggle between
  // a left-tree+right-editor split and a full-width editor that occupies the
  // whole main area. Both must be defined for the toggle to render — when
  // they're omitted (e.g. modal mode) the slot is skipped.
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onToggleMarkdownPreview: () => void;
  onDownload: () => void;
  onSave: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  showClose?: boolean;
  compact?: boolean;
  labels: {
    showingChanges: string;
    editMarkdown: string;
    previewMarkdown: string;
    download: string;
    save: string;
    saving: string;
    saved: string;
    fullscreen: string;
    exitFullscreen: string;
    expand: string;
    collapse: string;
    close: string;
    goBack: string;
  };
};

export default function CodeEditorHeader({
  file,
  isSidebar,
  isFullscreen,
  isMarkdownFile,
  markdownPreview,
  saving,
  saveSuccess,
  isExpanded = false,
  onToggleExpand = null,
  canGoBack = false,
  parentFileName = null,
  onGoBack = null,
  onToggleMarkdownPreview,
  onDownload,
  onSave,
  onToggleFullscreen,
  onClose,
  showClose = true,
  compact = false,
  labels,
}: CodeEditorHeaderProps) {
  const saveTitle = saveSuccess ? labels.saved : saving ? labels.saving : labels.save;

  const iconBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

  return (
    <div
      className={compact
        ? 'absolute right-2 top-1 z-10 flex h-8 items-center rounded-md bg-neutral-50 pl-2 dark:bg-neutral-900'
        : 'flex min-w-0 flex-shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950'}
    >
      {!compact ? (
        <div className="flex min-w-0 flex-1 shrink items-center gap-2">
        {canGoBack && onGoBack ? (
          <button
            type="button"
            onClick={onGoBack}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            title={parentFileName ? `${labels.goBack}: ${parentFileName}` : labels.goBack}
            aria-label={labels.goBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            {parentFileName ? (
              <span className="max-w-[7rem] truncate text-xxs">{parentFileName}</span>
            ) : null}
          </button>
        ) : null}
        <div className="min-w-0 shrink">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
              {file.name}
            </h3>
            {file.diffInfo && (
              <span className="shrink-0 whitespace-nowrap rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-xxs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                {labels.showingChanges}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
            {file.path}
          </p>
        </div>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-0.5">
        {isMarkdownFile && (
          <button
            type="button"
            onClick={onToggleMarkdownPreview}
            className={
              markdownPreview
                ? 'flex h-7 w-7 items-center justify-center rounded-md bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                : iconBtn
            }
            title={markdownPreview ? labels.editMarkdown : labels.previewMarkdown}
            aria-label={markdownPreview ? labels.editMarkdown : labels.previewMarkdown}
          >
            {markdownPreview ? (
              <Code2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </button>
        )}

        <button type="button" onClick={onDownload} className={iconBtn} title={labels.download} aria-label={labels.download}>
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={
            saveSuccess
              ? 'flex h-7 w-7 items-center justify-center rounded-md bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : `${iconBtn} disabled:opacity-50`
          }
          title={saveTitle}
          aria-label={saveTitle}
        >
          {saveSuccess ? (
            <Check className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </button>

        {!isSidebar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconBtn}
            title={isFullscreen ? labels.exitFullscreen : labels.fullscreen}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </button>
        )}

        {isSidebar && onToggleExpand ? (
          <button
            type="button"
            onClick={onToggleExpand}
            className={iconBtn}
            title={isExpanded ? labels.collapse : labels.expand}
            aria-label={isExpanded ? labels.collapse : labels.expand}
          >
            {isExpanded ? (
              <ChevronsRightLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronsLeftRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </button>
        ) : null}

        {showClose ? (
          <button type="button" onClick={onClose} className={iconBtn} title={labels.close}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
