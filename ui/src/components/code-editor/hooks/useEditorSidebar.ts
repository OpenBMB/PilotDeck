import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile, CodeEditorTab } from '../types/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

const buildEditorFile = (
  filePath: string,
  projectName: string | undefined,
  diffInfo: CodeEditorDiffInfo | null = null,
): CodeEditorFile => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() || filePath;
  return {
    name: fileName,
    path: normalizedPath,
    projectName,
    diffInfo,
  };
};

const currentFile = (tab: CodeEditorTab | undefined): CodeEditorFile | null => (
  tab?.fileStack.at(-1) ?? null
);

const isPathAtOrBelow = (candidatePath: string, parentPath: string): boolean => (
  candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)
);

type EditorTabsState = {
  tabs: CodeEditorTab[];
  activeTabId: string | null;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const [tabsState, setTabsState] = useState<EditorTabsState>({
    tabs: [],
    activeTabId: null,
  });
  const nextTabIdRef = useRef(0);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const activeEditorTab = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId) ?? null;
  const editingFile = currentFile(activeEditorTab ?? undefined);
  const canGoBack = (activeEditorTab?.fileStack.length ?? 0) > 1;
  const parentFile = canGoBack ? activeEditorTab?.fileStack.at(-2) ?? null : null;

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      const nextFile = buildEditorFile(filePath, selectedProject?.name, diffInfo);
      setTabsState((previous) => {
        const existing = previous.tabs.find((tab) => tab.fileStack[0]?.path === nextFile.path);
        if (existing) {
          const existingRoot = existing.fileStack[0];
          const shouldResetView = !existing.dirty && (
            currentFile(existing)?.path !== nextFile.path
            || Boolean(existingRoot?.diffInfo) !== Boolean(nextFile.diffInfo)
            || (nextFile.diffInfo !== null && existingRoot?.diffInfo !== nextFile.diffInfo)
          );
          return {
            tabs: shouldResetView
              ? previous.tabs.map((tab) => (
                tab.id === existing.id ? { ...tab, fileStack: [nextFile], dirty: false } : tab
              ))
              : previous.tabs,
            activeTabId: existing.id,
          };
        }

        const nextTab: CodeEditorTab = {
          id: `editor-tab-${nextTabIdRef.current++}`,
          fileStack: [nextFile],
          dirty: false,
        };
        return {
          tabs: [...previous.tabs, nextTab],
          activeTabId: nextTab.id,
        };
      });
    },
    [selectedProject?.name],
  );

  // Push onto the stack when following a markdown cross-reference inside preview.
  const handlePreviewFileOpen = useCallback(
    (filePath: string) => {
      const nextFile = buildEditorFile(filePath, selectedProject?.name);
      setTabsState((previous) => {
        if (!previous.activeTabId) return previous;
        return {
          ...previous,
          tabs: previous.tabs.map((tab) => {
            if (tab.id !== previous.activeTabId) return tab;
            const activeFile = currentFile(tab);
            if (activeFile?.path === nextFile.path) return tab;
            return {
              ...tab,
              fileStack: [...tab.fileStack, nextFile],
              dirty: false,
            };
          }),
        };
      });
    },
    [selectedProject?.name],
  );

  const handleFileGoBack = useCallback(() => {
    setTabsState((previous) => {
      if (!previous.activeTabId) return previous;
      return {
        ...previous,
        tabs: previous.tabs.map((tab) => (
          tab.id === previous.activeTabId && tab.fileStack.length > 1
            ? { ...tab, fileStack: tab.fileStack.slice(0, -1), dirty: false }
            : tab
        )),
      };
    });
  }, []);

  const handleTabSelect = useCallback((tabId: string) => {
    setTabsState((previous) => (
      previous.tabs.some((tab) => tab.id === tabId)
        ? { ...previous, activeTabId: tabId }
        : previous
    ));
  }, []);

  const handleTabClose = useCallback((tabId: string) => {
    setTabsState((previous) => {
      const closingIndex = previous.tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) return previous;

      const tabs = previous.tabs.filter((tab) => tab.id !== tabId);
      if (previous.activeTabId !== tabId) {
        return { ...previous, tabs };
      }

      const nextActiveTab = tabs[closingIndex] ?? tabs[closingIndex - 1] ?? null;
      return {
        tabs,
        activeTabId: nextActiveTab?.id ?? null,
      };
    });
  }, []);

  const handleTabDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setTabsState((previous) => {
      const tab = previous.tabs.find((candidate) => candidate.id === tabId);
      if (!tab || tab.dirty === dirty) return previous;
      return {
        ...previous,
        tabs: previous.tabs.map((candidate) => (
          candidate.id === tabId ? { ...candidate, dirty } : candidate
        )),
      };
    });
  }, []);

  const handleFileRename = useCallback((oldPath: string, newPath: string) => {
    setTabsState((previous) => ({
      ...previous,
      tabs: previous.tabs.map((tab) => ({
        ...tab,
        fileStack: tab.fileStack.map((file) => {
          if (!isPathAtOrBelow(file.path, oldPath)) return file;
          const path = `${newPath}${file.path.slice(oldPath.length)}`;
          const preserveDirtyBuffer = tab.dirty && currentFile(tab)?.path === file.path;
          return {
            ...file,
            path,
            name: path.split('/').pop() || file.name,
            renamedFromPath: preserveDirtyBuffer ? file.path : undefined,
          };
        }),
      })),
    }));
  }, []);

  const handleFileDelete = useCallback((deletedPath: string) => {
    setTabsState((previous) => {
      const tabs = previous.tabs.flatMap((tab) => {
        const rootFile = tab.fileStack[0];
        if (!rootFile || isPathAtOrBelow(rootFile.path, deletedPath)) return [];
        const fileStack = tab.fileStack.filter((file) => !isPathAtOrBelow(file.path, deletedPath));
        return [{ ...tab, fileStack, dirty: false }];
      });

      const activeStillExists = tabs.some((tab) => tab.id === previous.activeTabId);
      return {
        tabs,
        activeTabId: activeStillExists ? previous.activeTabId : tabs.at(-1)?.id ?? null,
      };
    });
  }, []);

  // Close all open file tabs when the user switches to a different project so
  // we don't carry a Project A file across into Project B's view. Switching
  // sessions within the same project keeps the editor open because
  // `selectedProject?.name` stays the same.
  useEffect(() => {
    setTabsState({ tabs: [], activeTabId: null });
    setEditorExpanded(false);
  }, [selectedProject?.name]);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    editorTabs: tabsState.tabs,
    activeEditorTabId: tabsState.activeTabId,
    activeFilePath: editingFile?.path ?? null,
    editingFile,
    canGoBack,
    parentFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handlePreviewFileOpen,
    handleFileGoBack,
    handleTabSelect,
    handleTabClose,
    handleTabDirtyChange,
    handleFileRename,
    handleFileDelete,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
