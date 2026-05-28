import { ChevronsLeftRight, ChevronsRightLeft, Code2, Download, Eye, Maximize2, Minimize2, Save, X } from 'lucide-react';
import type { CodeEditorFile } from '../../types/types';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  isMarkdownFile: boolean;
  markdownPreview: boolean;
  saving: boolean;
  saveSuccess: boolean;
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
  onToggleMarkdownPreview,
  onDownload,
  onSave,
  onToggleFullscreen,
  onClose,
  labels,
}: CodeEditorHeaderProps) {
  const saveTitle = saveSuccess ? labels.saved : saving ? labels.saving : labels.save;

  const iconBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex min-w-0 flex-1 shrink items-center gap-2">
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
          >
            {markdownPreview ? (
              <Code2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </button>
        )}

        <button type="button" onClick={onDownload} className={iconBtn} title={labels.download}>
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
        >
          {saveSuccess ? (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
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

        <button type="button" onClick={onClose} className={iconBtn} title={labels.close}>
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
