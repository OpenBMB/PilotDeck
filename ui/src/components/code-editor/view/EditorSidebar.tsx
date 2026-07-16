import { useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeEditorTab } from '../types/types';
import CodeEditor from './CodeEditor';
import CodeEditorTabBar from './subcomponents/CodeEditorTabBar';

type EditorSidebarProps = {
  editorTabs: CodeEditorTab[];
  activeEditorTabId: string | null;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  hasManualWidth: boolean;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabDirtyChange: (tabId: string, dirty: boolean) => void;
  onToggleEditorExpand: () => void;
  onPreviewFileOpen?: (filePath: string) => void;
  onGoBack?: () => void;
  projectPath?: string;
  fillSpace?: boolean;
  workspaceMode?: boolean;
};

// Keep enough of the Files split visible so the editor cannot cover the chat
// and file tree when CodeMirror reports wide virtualized content.
const MIN_LEFT_CONTENT_WIDTH = 420;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;
const AUTO_EDITOR_WIDTH_RATIO = 0.5;

export default function EditorSidebar({
  editorTabs,
  activeEditorTabId,
  isMobile,
  editorExpanded,
  editorWidth,
  hasManualWidth,
  resizeHandleRef,
  onResizeStart,
  onTabSelect,
  onTabClose,
  onTabDirtyChange,
  onToggleEditorExpand,
  onPreviewFileOpen,
  onGoBack,
  projectPath,
  fillSpace,
  workspaceMode = false,
}: EditorSidebarProps) {
  const { t } = useTranslation('codeEditor');
  const [poppedOut, setPoppedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [effectiveWidth, setEffectiveWidth] = useState(editorWidth);
  const activeEditorTab = editorTabs.find((tab) => tab.id === activeEditorTabId) ?? null;
  const editingFile = activeEditorTab?.fileStack.at(-1) ?? null;

  // Adjust editor width when container size changes to ensure buttons are always visible.
  // In the Files tab's default mode, this intentionally produces a stable
  // measured width rather than letting the editor's content influence flex
  // sizing while CodeMirror virtualizes long lines during scroll.
  useEffect(() => {
    if (!editingFile || isMobile || poppedOut || workspaceMode) return;

    const updateWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      const containerWidth = parentElement.clientWidth;

      // Calculate maximum allowed editor width
      const maxEditorWidth = containerWidth - MIN_LEFT_CONTENT_WIDTH;

      if (maxEditorWidth < MIN_EDITOR_WIDTH) {
        // Not enough space - pop out the editor so user can still see everything
        setPoppedOut(true);
      } else {
        const requestedWidth = fillSpace && !hasManualWidth && !editorExpanded
          ? Math.min(editorWidth, Math.floor(containerWidth * AUTO_EDITOR_WIDTH_RATIO))
          : editorWidth;
        setEffectiveWidth(Math.min(requestedWidth, maxEditorWidth));
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);

    // Also use ResizeObserver for more accurate detection
    const resizeObserver = new ResizeObserver(updateWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, [editingFile, fillSpace, hasManualWidth, isMobile, poppedOut, editorExpanded, editorWidth, workspaceMode]);

  if (!editingFile || !activeEditorTabId) {
    return null;
  }

  const requestCloseTab = (tabId: string) => {
    const tab = editorTabs.find((candidate) => candidate.id === tabId);
    const file = tab?.fileStack.at(-1);
    if (!tab || !file) return;
    if (tab.dirty && !window.confirm(t('tabs.unsavedConfirm', { fileName: file.name }))) {
      return;
    }
    if (editorTabs.length === 1) {
      setPoppedOut(false);
    }
    onTabClose(tabId);
  };

  const tabBar = (
    <CodeEditorTabBar
      tabs={editorTabs}
      activeTabId={activeEditorTabId}
      onSelect={onTabSelect}
      onClose={requestCloseTab}
      labels={{
        tabList: t('tabs.tabList'),
        closeTab: (fileName) => t('tabs.closeTab', { fileName }),
        modified: t('tabs.modified'),
      }}
      reserveToolbarSpace={workspaceMode}
    />
  );

  const editors = editorTabs.map((tab) => {
    const file = tab.fileStack.at(-1);
    if (!file) return null;
    const active = tab.id === activeEditorTabId;
    const canGoBack = tab.fileStack.length > 1;
    const parentFile = canGoBack ? tab.fileStack.at(-2) ?? null : null;

    return (
      <div
        key={tab.id}
        role="tabpanel"
        id={`code-editor-panel-${tab.id}`}
        aria-labelledby={`code-editor-tab-${tab.id}`}
        aria-hidden={!active}
        className={active ? 'h-full min-h-0 w-full' : 'hidden'}
      >
        <CodeEditor
          file={file}
          projectPath={projectPath}
          onPreviewFileOpen={onPreviewFileOpen}
          canGoBack={canGoBack}
          parentFileName={parentFile?.name ?? null}
          onGoBack={active ? onGoBack : undefined}
          onClose={() => requestCloseTab(tab.id)}
          isSidebar={workspaceMode || (!isMobile && !poppedOut)}
          isExpanded={editorExpanded}
          onToggleExpand={onToggleEditorExpand}
          onPopOut={() => setPoppedOut(true)}
          headerPrefix={active ? tabBar : null}
          compactHeader={workspaceMode}
          isActive={active}
          onDirtyChange={(dirty) => onTabDirtyChange(tab.id, dirty)}
        />
      </div>
    );
  });

  if (isMobile || poppedOut) {
    return <>{editors}</>;
  }

  const useAutoFilesWidth = fillSpace && !hasManualWidth && !editorExpanded;
  const containerClassName = editorExpanded || workspaceMode
    ? 'flex h-full min-w-0 flex-1 basis-0'
    : 'flex h-full min-w-0 flex-shrink-0';
  const containerStyle = editorExpanded || workspaceMode
    ? undefined
    : {
        width: useAutoFilesWidth
          ? `min(${editorWidth}px, ${AUTO_EDITOR_WIDTH_RATIO * 100}%, calc(100% - ${MIN_LEFT_CONTENT_WIDTH}px))`
          : `${effectiveWidth}px`,
        minWidth: `${MIN_EDITOR_WIDTH}px`,
      };

  return (
    <div ref={containerRef} className={containerClassName} style={containerStyle}>
      {!editorExpanded && !workspaceMode && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative z-10 w-px flex-shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
          <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-neutral-600" />
        </div>
      )}

      <div
        className={workspaceMode
          ? 'h-full min-w-0 flex-1 overflow-hidden'
          : 'h-full min-w-0 flex-1 overflow-hidden border-l border-neutral-200 dark:border-neutral-800'}
      >
        {editors}
      </div>
    </div>
  );
}
