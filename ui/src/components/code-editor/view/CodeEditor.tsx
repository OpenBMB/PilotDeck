import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api';
import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';
import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadError from './subcomponents/CodeEditorLoadError';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
  onPreviewFileOpen?: (filePath: string) => void;
  canGoBack?: boolean;
  parentFileName?: string | null;
  onGoBack?: () => void;
  headerPrefix?: ReactNode;
  compactHeader?: boolean;
  isActive?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
  onPreviewFileOpen,
  canGoBack = false,
  parentFileName = null,
  onGoBack,
  headerPrefix,
  compactHeader = false,
  isActive = true,
  onDirtyChange,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState(false);

  const {
    isDarkMode,
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    loadError,
    reload,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    isDirty,
    projectName,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    setShowDiff(Boolean(file.diffInfo));
  }, [file.diffInfo]);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isHtmlFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  useEffect(() => {
    setMarkdownPreview(false);
    setHtmlPreview(false);
  }, [file.path]);

  const htmlPreviewUrl = useMemo(() => {
    if (!isHtmlFile || !projectName) return null;
    return api.projectPreviewUrl(projectName, file.path, projectPath);
  }, [file.path, isHtmlFile, projectName, projectPath]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut: compactHeader ? null : onPopOut,
        onToggleExpand: compactHeader ? null : onToggleExpand,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
      })
    ),
    [compactHeader, file, isExpanded, isSidebar, onPopOut, onToggleExpand, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...getLanguageExtensions(file.name),
      ...toolbarPanelExtension,
    ];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    allExtensions.push(...minimapExtension);

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    file.name,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose,
    onGoBack,
    canGoBack,
    dependency: content,
    enabled: isActive,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
        headerPrefix={headerPrefix}
      />
    );
  }

  if (loadError) {
    return (
      <CodeEditorLoadError
        file={file}
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        errorMessage={loadError}
        onRetry={reload}
        onClose={onClose}
        headerPrefix={headerPrefix}
        labels={{
          title: t('loadError.title'),
          description: t('loadError.description', { fileName: file.name }),
          retry: t('loadError.retry'),
          close: t('actions.close'),
        }}
      />
    );
  }

  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        projectName={projectName}
        isSidebar={isSidebar}
        compactHeader={compactHeader}
        isFullscreen={isFullscreen}
        isExpanded={isExpanded}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        onToggleExpand={onToggleExpand}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
        headerPrefix={headerPrefix}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/40 md:backdrop-blur-sm md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-white dark:bg-neutral-950 flex flex-col w-full h-full'
    : `bg-white dark:bg-neutral-950 flex flex-col w-full h-full md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800${
      isFullscreen
        ? ' md:w-full md:h-full md:rounded-none md:border-0'
        : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh] md:shadow-xl'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <div className="relative flex-shrink-0">
            {headerPrefix}
            <CodeEditorHeader
              file={file}
              isSidebar={isSidebar}
              isFullscreen={isFullscreen}
              isMarkdownFile={isMarkdownFile}
              isHtmlFile={isHtmlFile}
              markdownPreview={markdownPreview}
              htmlPreview={htmlPreview}
              saving={saving}
              saveSuccess={saveSuccess}
              isExpanded={isExpanded}
              onToggleExpand={onToggleExpand}
              canGoBack={canGoBack}
              parentFileName={parentFileName}
              onGoBack={onGoBack}
              onToggleMarkdownPreview={() => {
                if (isHtmlFile) {
                  setHtmlPreview((previous) => !previous);
                } else {
                  setMarkdownPreview((previous) => !previous);
                }
              }}
              onDownload={handleDownload}
              onSave={handleSave}
              onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
              onClose={onClose}
              showClose={!headerPrefix}
              compact={compactHeader}
              labels={{
                showingChanges: t('header.showingChanges'),
                editMarkdown: t('actions.editMarkdown'),
                previewMarkdown: t('actions.previewMarkdown'),
                editHtml: t('actions.editHtml'),
                previewHtml: t('actions.previewHtml'),
                download: t('actions.download'),
                save: t('actions.save'),
                saving: t('actions.saving'),
                saved: t('actions.saved'),
                fullscreen: t('actions.fullscreen'),
                exitFullscreen: t('actions.exitFullscreen'),
                expand: t('actions.expand', { defaultValue: 'Expand to full width' }),
                collapse: t('actions.collapse', { defaultValue: 'Collapse to split view' }),
                close: t('actions.close'),
                goBack: t('actions.goBack'),
              }}
            />
          </div>

          {saveError && (
            <div className="border-b border-red-200/60 bg-red-50 px-4 py-1.5 text-xxs text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
              {saveError}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              htmlPreview={htmlPreview}
              isHtmlFile={isHtmlFile}
              htmlPreviewUrl={htmlPreviewUrl}
              fileName={file.name}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
              baseFilePath={file.path}
              onFileOpen={onPreviewFileOpen}
            />
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>
    </>
  );
}
