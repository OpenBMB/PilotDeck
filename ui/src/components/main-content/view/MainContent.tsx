import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Database,
  FileText,
  Radio,
  type LucideIcon,
} from "lucide-react";
import ChatInterfaceV2 from "../../chat-v2/ChatInterfaceV2";
import PluginTabContent from "../../plugins/view/PluginTabContent";
import { cn } from "../../../lib/utils.js";
import type { MainContentProps } from "../types/types";
import { useTaskMaster } from "../../../contexts/TaskMasterContext";
import { useTasksSettings } from "../../../contexts/TasksSettingsContext";
import { useUiPreferences } from "../../../hooks/useUiPreferences";
import { useEditorSidebar } from "../../code-editor/hooks/useEditorSidebar";
import EditorSidebar from "../../code-editor/view/EditorSidebar";
import type { CodeEditorDiffInfo } from "../../code-editor/types/types";
import type {
  AlwaysOnSessionTarget,
  AppTab,
  Project,
  ProjectSession,
} from "../../../types/app";
import { isReadOnlySession } from "../../../types/app";
import { api } from "../../../utils/api";
import { isExternalFileDrag } from "../../../utils/externalFileDrop";
import MainContentStateView from "./subcomponents/MainContentStateView";
import ConversationSwitcher from "./subcomponents/ConversationSwitcher";
import ErrorBoundary from "./ErrorBoundary";
import ToolSidePanel from "./subcomponents/ToolSidePanel";

const AlwaysOnV2 = React.lazy(() => import("../../main-content-v2/AlwaysOnV2"));
const CronV2 = React.lazy(() => import("../../main-content-v2/CronV2"));
const FilesV2 = React.lazy(() => import("../../main-content-v2/FilesV2"));
const ShellV2 = React.lazy(() => import("../../main-content-v2/ShellV2"));
const GitV2 = React.lazy(() => import("../../main-content-v2/GitV2"));
const DashboardV2 = React.lazy(
  () => import("../../main-content-v2/DashboardV2"),
);
const TasksV2 = React.lazy(() => import("../../main-content-v2/TasksV2"));
const MemoryPanel = React.lazy(() => import("./memory/MemoryPanel"));
const SkillsV2 = React.lazy(() => import("../../main-content-v2/SkillsV2"));

function TabSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
    </div>
  );
}

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

type MainContentToast = { kind: "error" | "info"; text: string } | null;

const FILES_ASSISTANT_DEFAULT_WIDTH = 380;
const FILES_ASSISTANT_MIN_WIDTH = 320;
const FILES_ASSISTANT_MAX_WIDTH = 480;
const FILES_ASSISTANT_HORIZONTAL_MIN_WIDTH = 520;
const FILES_ASSISTANT_HORIZONTAL_MAX_WIDTH = 800;
const FILES_ARTIFACT_MIN_WIDTH = 480;
const FILES_PANEL_RAIL_WIDTH = 40;
const FILES_PANEL_SPLITTER_HEIGHT = 1;
const FILES_PANEL_SPLITTER_WIDTH = 1;
const FILES_PANEL_SECTION_MIN_HEIGHT = 330;
const FILES_PANEL_SECTION_MIN_WIDTH = 220;
const FILES_PANEL_LAYOUT_STORAGE_KEY = "pilotdeck:files-panel-layout";
const FILES_PANEL_ORDER_STORAGE_KEY = "pilotdeck:files-panel-order";

type FilesDockPanel = "explorer" | "assistant";
type FilesPanelLayout = "vertical" | "horizontal";
type FilesPanelOrder = "explorer-first" | "assistant-first";
type FilesDockEdge = "top" | "right" | "bottom" | "left";

function readStoredFilesPanelLayout(): FilesPanelLayout {
  try {
    return localStorage.getItem(FILES_PANEL_LAYOUT_STORAGE_KEY) === "horizontal"
      ? "horizontal"
      : "vertical";
  } catch {
    return "vertical";
  }
}

function readStoredFilesPanelOrder(): FilesPanelOrder {
  try {
    return localStorage.getItem(FILES_PANEL_ORDER_STORAGE_KEY) ===
      "assistant-first"
      ? "assistant-first"
      : "explorer-first";
  } catch {
    return "explorer-first";
  }
}

function resolveFilesDockEdge(
  event: { clientX: number; clientY: number },
  rect: DOMRect,
  fromHeader: boolean,
): FilesDockEdge | null {
  const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
  if (fromHeader) {
    if (x < 0.28) return "left";
    if (x > 0.72) return "right";
    return null;
  }
  const distLeft = event.clientX - rect.left;
  const distRight = rect.right - event.clientX;
  const distTop = event.clientY - rect.top;
  const distBottom = rect.bottom - event.clientY;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distLeft) return "left";
  if (min === distRight) return "right";
  if (min === distTop) return "top";
  return "bottom";
}

function dockArrangementFromDrop(
  source: FilesDockPanel,
  edge: FilesDockEdge,
): { layout: FilesPanelLayout; order: FilesPanelOrder } {
  const layout: FilesPanelLayout =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const sourceFirst = edge === "top" || edge === "left";
  const explorerFirst = source === "explorer" ? sourceFirst : !sourceFirst;
  return {
    layout,
    order: explorerFirst ? "explorer-first" : "assistant-first",
  };
}
const FILES_NARROW_BREAKPOINT = 1040;
const FILES_ASSISTANT_STORAGE_KEY = "pilotdeck:files-assistant-width";
const TOOL_PANEL_STORAGE_KEY = "pilotdeck:dashboard-panel-width";
const TOOL_PANEL_DEFAULT_WIDTH = 480;
const TOOL_PANEL_MIN_WIDTH = 360;
const TOOL_PANEL_MAX_WIDTH = 720;
const TOOL_PANEL_MAX_LAYOUT_RATIO = 0.48;

type DashboardPanelTab = Extract<AppTab, "dashboard" | "memory" | "always-on">;

const DASHBOARD_PANEL_TABS = new Set<AppTab>([
  "dashboard",
  "memory",
  "always-on",
]);
const DASHBOARD_PANEL_META: Record<
  DashboardPanelTab,
  { labelKey: string; icon: LucideIcon }
> = {
  dashboard: { labelKey: "tabs.dashboard", icon: BarChart3 },
  memory: { labelKey: "tabs.memory", icon: Database },
  "always-on": { labelKey: "tabs.alwaysOn", icon: Radio },
};

function readStoredFilesAssistantWidth(): number {
  try {
    const stored = Number(localStorage.getItem(FILES_ASSISTANT_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? Math.min(
          Math.max(stored, FILES_ASSISTANT_MIN_WIDTH),
          FILES_ASSISTANT_MAX_WIDTH,
        )
      : FILES_ASSISTANT_DEFAULT_WIDTH;
  } catch {
    return FILES_ASSISTANT_DEFAULT_WIDTH;
  }
}

function readStoredToolPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TOOL_PANEL_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? stored
      : TOOL_PANEL_DEFAULT_WIDTH;
  } catch {
    return TOOL_PANEL_DEFAULT_WIDTH;
  }
}

async function readJsonPayload<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function MainContent({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  alwaysOnSubTab = "dashboard",
  onAlwaysOnSubTabChange,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  unreadSessionIds,
  onReplaceTemporarySession,
  onNavigateToSession,
  onStartNewSession,
  onCreateProject,
  onSelectWorkspace,
  workspaceBinding,
  onSelectSession,
  onShowSettings,
  onSelectProjectByName,
  externalMessageUpdate,
  misroutedFileFromUrl,
  onMisroutedFileUrlHandled,
}: MainContentProps) {
  const { i18n } = useTranslation();
  const { preferences } = useUiPreferences();
  const {
    autoExpandTools,
    showRawParameters,
    showThinking,
    inlineThinking,
    autoScrollToBottom,
    sendByCtrlEnter,
  } = preferences;

  const { currentProject, setCurrentProject } =
    useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } =
    useTasksSettings() as TasksSettingsContextValue;
  const [toast, setToast] = useState<MainContentToast>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editorTabs,
    activeEditorTabId,
    activeFilePath,
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handlePreviewFileOpen,
    handleFileGoBack,
    handleTabSelect,
    handleTabClose,
    handleTabsClose,
    handleTabDirtyChange,
    handleFileRename,
    handleFileDelete,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  const openFileInWorkspace = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      handleFileOpen(filePath, diffInfo);
      setActiveTab("files");
    },
    [handleFileOpen, setActiveTab],
  );

  const handledMisroutedFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!misroutedFileFromUrl || !selectedProject) return;
    if (handledMisroutedFileRef.current === misroutedFileFromUrl) return;
    handledMisroutedFileRef.current = misroutedFileFromUrl;
    openFileInWorkspace(misroutedFileFromUrl);
    onMisroutedFileUrlHandled?.();
  }, [
    misroutedFileFromUrl,
    selectedProject,
    openFileInWorkspace,
    onMisroutedFileUrlHandled,
  ]);

  useEffect(() => {
    if (!misroutedFileFromUrl) {
      handledMisroutedFileRef.current = null;
    }
  }, [misroutedFileFromUrl]);

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === "tasks") {
      setActiveTab("chat");
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const refreshProjectsSilently = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const applyAndLaunchCycle = useCallback(
    async (projectName: string, cycleId: string) => {
      const response = await api.applyWorkCycle(projectName, cycleId);
      const payload = await readJsonPayload<{
        cycle?: { id: string };
        sessionKey?: string;
        executionToken?: string;
        error?: { code: string; message: string } | string;
      }>(response);
      if (!response.ok || !payload) {
        const errMsg =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(errMsg || "Failed to queue discovery plan apply");
      }
      if (payload.error) {
        const errMsg =
          typeof payload.error === "string"
            ? payload.error
            : payload.error.message;
        throw new Error(errMsg);
      }

      refreshProjectsSilently();
    },
    [refreshProjectsSilently],
  );

  const flashToast = useCallback((toastValue: MainContentToast, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const getProjectSessions = useCallback(
    (project: Project): ProjectSession[] => project.sessions ?? [],
    [],
  );

  const findSessionInProject = useCallback(
    (project: Project, sessionId: string) =>
      getProjectSessions(project).find((session) => session.id === sessionId),
    [getProjectSessions],
  );

  const loadPilotDeckSession = useCallback(
    async (projectName: string, sessionId: string) => {
      const response = await api.sessions(
        projectName,
        Number.MAX_SAFE_INTEGER,
        0,
      );
      if (!response.ok) {
        return null;
      }
      const payload = await readJsonPayload<{ sessions?: ProjectSession[] }>(
        response,
      );
      return (
        payload?.sessions?.find((session) => session.id === sessionId) ?? null
      );
    },
    [],
  );

  const handleOpenAlwaysOnSession = useCallback(
    async (target: AlwaysOnSessionTarget) => {
      if (!selectedProject) {
        return;
      }

      const missingMessage = i18n.t("alwaysOn:sessionMissing", {
        defaultValue: "This chat record no longer exists.",
      });

      if (target.kind === "origin") {
        const lookupProjectName = target.projectName || selectedProject.name;
        const targetProject =
          target.projectName && target.projectName !== selectedProject.name
            ? (projects.find((p) => p.name === target.projectName) ??
              selectedProject)
            : selectedProject;

        const existingSession =
          findSessionInProject(targetProject, target.sessionId) ??
          (await loadPilotDeckSession(lookupProjectName, target.sessionId));

        if (!existingSession) {
          flashToast({ kind: "error", text: missingMessage });
          return;
        }

        const fallbackSession: ProjectSession = {
          ...existingSession,
          isReadOnly: true,
          __projectName: lookupProjectName,
        };

        setActiveTab("chat");
        if (onSelectSession) {
          onSelectSession(targetProject, target.sessionId, fallbackSession);
          return;
        }
        onNavigateToSession(target.sessionId);
        return;
      }

      const existingSession =
        findSessionInProject(selectedProject, target.sessionId) ??
        (await loadPilotDeckSession(selectedProject.name, target.sessionId));

      if (!existingSession) {
        flashToast({ kind: "error", text: missingMessage });
        return;
      }

      const fallbackSession: ProjectSession = {
        ...existingSession,
        id: target.sessionId,
        title:
          target.title ||
          existingSession.title ||
          existingSession.summary ||
          target.summary,
        summary:
          target.summary ||
          existingSession.summary ||
          existingSession.title ||
          target.title,
        lastActivity: target.lastActivity || existingSession.lastActivity,
        sessionKind: "background_task",
        parentSessionId: target.parentSessionId,
        relativeTranscriptPath: target.relativeTranscriptPath,
        transcriptKey: target.transcriptKey || existingSession.transcriptKey,
        taskId: target.taskId || existingSession.taskId,
        taskStatus: target.taskStatus || existingSession.taskStatus,
        outputFile: target.outputFile || existingSession.outputFile,
        isReadOnly: true,
        __projectName: selectedProject.name,
      };

      setActiveTab("chat");
      if (onSelectSession) {
        onSelectSession(selectedProject, target.sessionId, fallbackSession);
        return;
      }
      onNavigateToSession(target.sessionId);
    },
    [
      findSessionInProject,
      flashToast,
      i18n,
      loadPilotDeckSession,
      onNavigateToSession,
      onSelectSession,
      projects,
      selectedProject,
      setActiveTab,
    ],
  );

  const handleOpenExecutionSession = useCallback(
    (projectKey: string, runId: string, projectName?: string) => {
      const rawId = `always-on/execute:project=${projectKey}:run=${runId}`;
      const sessionId =
        rawId.replace(/[\\/]+/g, "-").replace(/^-+|-+$/g, "") || "session";
      void handleOpenAlwaysOnSession({
        kind: "origin",
        sessionId,
        projectName,
      });
    },
    [handleOpenAlwaysOnSession],
  );

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  if (!selectedProject && activeTab !== "dashboard" && activeTab !== "cron" && activeTab !== "chat") {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SplitBody
          projects={projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          shouldShowTasksTab={shouldShowTasksTab}
          tasksEnabled={tasksEnabled}
          setActiveTab={setActiveTab}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={onAlwaysOnSubTabChange}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          handleFileOpen={openFileInWorkspace}
          onInputFocusChange={onInputFocusChange}
          onSessionActive={onSessionActive}
          onSessionInactive={onSessionInactive}
          onSessionProcessing={onSessionProcessing}
          onSessionNotProcessing={onSessionNotProcessing}
          onSessionActivityBump={onSessionActivityBump}
          processingSessions={processingSessions}
          unreadSessionIds={unreadSessionIds}
          onReplaceTemporarySession={onReplaceTemporarySession}
          onNavigateToSession={onNavigateToSession}
          onStartNewSession={onStartNewSession}
          onCreateProject={onCreateProject}
          onSelectWorkspace={onSelectWorkspace}
          workspaceBinding={workspaceBinding}
          onSelectSession={onSelectSession}
          onShowSettings={onShowSettings}
          externalMessageUpdate={externalMessageUpdate}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          inlineThinking={inlineThinking}
          autoScrollToBottom={autoScrollToBottom}
          sendByCtrlEnter={sendByCtrlEnter}
          applyAndLaunchCycle={applyAndLaunchCycle}
          handleOpenExecutionSession={handleOpenExecutionSession}
          editorExpanded={editorExpanded}
          hasEditor={editingFile !== null}
          activeFilePath={activeFilePath}
          onFileRename={handleFileRename}
          onFileDelete={handleFileDelete}
          onSelectProjectByName={onSelectProjectByName}
          isMobile={isMobile}
          editorSidebarProps={{
            editorTabs,
            activeEditorTabId,
            isMobile,
            editorExpanded,
            editorWidth,
            hasManualWidth,
            resizeHandleRef,
            onResizeStart: handleResizeStart,
            onTabSelect: handleTabSelect,
            onTabClose: handleTabClose,
            onTabsClose: handleTabsClose,
            onTabDirtyChange: handleTabDirtyChange,
            onToggleEditorExpand: handleToggleEditorExpand,
            onPreviewFileOpen: handlePreviewFileOpen,
            onGoBack: handleFileGoBack,
            projectPath: selectedProject?.path,
          }}
        />
      </div>
      {toast ? (
        <div
          className={cn(
            "pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg",
            toast.kind === "error" && "bg-red-600 text-white",
            toast.kind === "info" && "bg-neutral-800 text-white",
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// V2 split body: chat is the persistent primary surface, Files is a dedicated
// workbench, and the management dashboards open in a resizable side panel.
type SplitBodyProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  shouldShowTasksTab: boolean;
  tasksEnabled: boolean;
  setActiveTab: (tab: any) => void;
  alwaysOnSubTab: MainContentProps["alwaysOnSubTab"];
  onAlwaysOnSubTabChange: MainContentProps["onAlwaysOnSubTabChange"];
  ws: any;
  sendMessage: any;
  latestMessage: any;
  handleFileOpen: (
    filePath: string,
    diffInfo?: CodeEditorDiffInfo | null,
  ) => void;
  onInputFocusChange: any;
  onSessionActive: any;
  onSessionInactive: any;
  onSessionProcessing: any;
  onSessionNotProcessing: any;
  onSessionActivityBump?: (
    projectName: string,
    sessionId: string,
    optimisticTitle?: string,
  ) => void;
  processingSessions: Set<string>;
  unreadSessionIds: Set<string>;
  onReplaceTemporarySession: any;
  onNavigateToSession: (sessionId: string) => void;
  onStartNewSession: MainContentProps["onStartNewSession"];
  onCreateProject?: MainContentProps["onCreateProject"];
  onSelectWorkspace?: MainContentProps["onSelectWorkspace"];
  workspaceBinding?: MainContentProps["workspaceBinding"];
  onSelectSession: MainContentProps["onSelectSession"];
  onShowSettings: any;
  externalMessageUpdate: any;
  autoExpandTools: any;
  showRawParameters: any;
  showThinking: any;
  inlineThinking: any;
  autoScrollToBottom: any;
  sendByCtrlEnter: any;
  applyAndLaunchCycle: (projectName: string, cycleId: string) => Promise<void>;
  handleOpenExecutionSession: (
    projectKey: string,
    runId: string,
    projectName?: string,
  ) => void;
  editorExpanded: boolean;
  hasEditor: boolean;
  activeFilePath: string | null;
  onFileRename: (oldPath: string, newPath: string) => void;
  onFileDelete: (deletedPath: string) => void;
  onSelectProjectByName?: (projectName: string) => void;
  isMobile: boolean;
  editorSidebarProps: React.ComponentProps<typeof EditorSidebar>;
};

function SplitBody(props: SplitBodyProps) {
  const { t } = useTranslation();
  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    shouldShowTasksTab,
    tasksEnabled,
    setActiveTab,
    alwaysOnSubTab = "dashboard",
    onAlwaysOnSubTabChange,
    ws,
    sendMessage,
    latestMessage,
    handleFileOpen,
    onInputFocusChange,
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onSessionActivityBump,
    processingSessions,
    unreadSessionIds,
    onReplaceTemporarySession,
    onNavigateToSession,
    onStartNewSession,
    onCreateProject,
    onSelectWorkspace,
    workspaceBinding,
    onSelectSession,
    onShowSettings,
    externalMessageUpdate,
    autoExpandTools,
    showRawParameters,
    showThinking,
    inlineThinking,
    autoScrollToBottom,
    sendByCtrlEnter,
    applyAndLaunchCycle,
    handleOpenExecutionSession,
    editorExpanded,
    hasEditor,
    activeFilePath,
    onFileRename,
    onFileDelete,
    onSelectProjectByName,
    isMobile,
    editorSidebarProps,
  } = props;

  // Shell, Git, Tasks, and plugin tabs retain their legacy full-screen mode.
  // Skills, Routing, Memory, and Always-On are auxiliary dashboards paired
  // with chat. Files stays a separate explorer + artifact + assistant mode.
  const isPlugin =
    typeof activeTab === "string" && activeTab.startsWith("plugin:");
  const fullScreenToolTabs = new Set(["shell", "git", "cron", "tasks"]);
  const isFullScreenTool = fullScreenToolTabs.has(activeTab) || isPlugin;
  const isDashboardPanel = DASHBOARD_PANEL_TABS.has(activeTab);
  const dashboardPanelTab = isDashboardPanel
    ? (activeTab as DashboardPanelTab)
    : null;
  // Tasks tab is conditional — fall back to chat if the project hasn't
  // enabled it yet so we don't render a black hole.
  const renderTasksAsTool = activeTab === "tasks" && shouldShowTasksTab;
  const isFiles = activeTab === "files";
  const filesSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const filesSidePanelRef = useRef<HTMLDivElement | null>(null);
  const dockDragSourceRef = useRef<FilesDockPanel | null>(null);
  const [filesAssistantWidth, setFilesAssistantWidth] = useState(
    readStoredFilesAssistantWidth,
  );
  const [filesResizeTarget, setFilesResizeTarget] = useState<
    "assistant" | null
  >(null);
  const [filesPanelSplitRatio, setFilesPanelSplitRatio] = useState(0.5);
  const [filesPanelSplitResizing, setFilesPanelSplitResizing] = useState(false);
  const [filesPanelLayout, setFilesPanelLayout] = useState<FilesPanelLayout>(
    readStoredFilesPanelLayout,
  );
  const [filesPanelOrder, setFilesPanelOrder] = useState<FilesPanelOrder>(
    readStoredFilesPanelOrder,
  );
  const [filesPanelDropPreview, setFilesPanelDropPreview] = useState<{
    panel: FilesDockPanel;
    edge: FilesDockEdge | "swap";
  } | null>(null);
  const [explorerCollapsed, setExplorerCollapsed] = useState(true);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [assistantOverlayOpen, setAssistantOverlayOpen] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [toolPanelWidth, setToolPanelWidth] = useState(
    readStoredToolPanelWidth,
  );
  const [toolPanelResizing, setToolPanelResizing] = useState(false);
  const isNarrowWorkbench =
    workbenchWidth > 0 && workbenchWidth < FILES_NARROW_BREAKPOINT;
  const toolPanelMaxWidth =
    workbenchWidth > 0
      ? Math.max(
          TOOL_PANEL_MIN_WIDTH,
          Math.min(
            TOOL_PANEL_MAX_WIDTH,
            workbenchWidth * TOOL_PANEL_MAX_LAYOUT_RATIO,
          ),
        )
      : TOOL_PANEL_MAX_WIDTH;

  useEffect(() => {
    if (!isFiles) return;
    setExplorerCollapsed(true);
    setAssistantCollapsed(false);
    setAssistantOverlayOpen(false);
  }, [isFiles]);

  useEffect(() => {
    const container = filesSplitContainerRef.current;
    if (!container) return undefined;

    const updateWidth = () =>
      setWorkbenchWidth(container.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setToolPanelWidth((width) =>
      Math.min(Math.max(width, TOOL_PANEL_MIN_WIDTH), toolPanelMaxWidth),
    );
  }, [toolPanelMaxWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(
        TOOL_PANEL_STORAGE_KEY,
        String(Math.round(toolPanelWidth)),
      );
    } catch {
      // The panel remains usable when localStorage is unavailable.
    }
  }, [toolPanelWidth]);

  useEffect(() => {
    if (!isNarrowWorkbench) setAssistantOverlayOpen(false);
  }, [isNarrowWorkbench]);

  useEffect(() => {
    try {
      localStorage.setItem(
        FILES_ASSISTANT_STORAGE_KEY,
        String(Math.round(filesAssistantWidth)),
      );
    } catch {
      // Resizing remains available when persistent storage is unavailable.
    }
  }, [filesAssistantWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(FILES_PANEL_LAYOUT_STORAGE_KEY, filesPanelLayout);
      localStorage.setItem(FILES_PANEL_ORDER_STORAGE_KEY, filesPanelOrder);
    } catch {
      // Layout remains usable when persistent storage is unavailable.
    }
  }, [filesPanelLayout, filesPanelOrder]);

  const dockedHorizontally =
    filesPanelLayout === "horizontal" &&
    !explorerCollapsed &&
    !assistantCollapsed &&
    !isNarrowWorkbench;

  const clampFilesAssistantWidth = useCallback(
    (width: number) => {
      const minWidth = dockedHorizontally
        ? FILES_ASSISTANT_HORIZONTAL_MIN_WIDTH
        : FILES_ASSISTANT_MIN_WIDTH;
      const layoutMax = dockedHorizontally
        ? FILES_ASSISTANT_HORIZONTAL_MAX_WIDTH
        : FILES_ASSISTANT_MAX_WIDTH;
      const availableWidth =
        workbenchWidth > 0
          ? workbenchWidth - FILES_PANEL_RAIL_WIDTH - FILES_ARTIFACT_MIN_WIDTH
          : layoutMax;
      const maxWidth = Math.max(minWidth, Math.min(layoutMax, availableWidth));
      return Math.min(Math.max(width, minWidth), maxWidth);
    },
    [dockedHorizontally, workbenchWidth],
  );

  const handleFilesAssistantResizeBy = useCallback(
    (delta: number) => {
      setFilesAssistantWidth((width) =>
        clampFilesAssistantWidth(width + delta),
      );
    },
    [clampFilesAssistantWidth],
  );

  useEffect(() => {
    setFilesAssistantWidth((width) => clampFilesAssistantWidth(width));
  }, [clampFilesAssistantWidth]);

  const handleFilesResizeStart = useCallback(
    (target: "assistant", event: React.MouseEvent<HTMLDivElement>) => {
      if (!isFiles) return;
      setFilesResizeTarget(target);
      event.preventDefault();
    },
    [isFiles],
  );

  useEffect(() => {
    if (!filesResizeTarget) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = filesSplitContainerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      setFilesAssistantWidth(
        clampFilesAssistantWidth(
          rect.right - event.clientX - FILES_PANEL_RAIL_WIDTH,
        ),
      );
    };

    const handleMouseUp = () => {
      setFilesResizeTarget(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampFilesAssistantWidth, filesResizeTarget]);

  const clampFilesPanelSplitRatio = useCallback(
    (ratio: number) => {
      const rect = filesSidePanelRef.current?.getBoundingClientRect();
      if (filesPanelLayout === "horizontal") {
        const availableWidth = Math.max(
          1,
          (rect?.width ?? 0) - FILES_PANEL_SPLITTER_WIDTH,
        );
        const minRatio = Math.min(
          0.5,
          FILES_PANEL_SECTION_MIN_WIDTH / availableWidth,
        );
        const maxRatio = Math.max(0.5, 1 - minRatio);
        return Math.min(Math.max(ratio, minRatio), maxRatio);
      }
      const availableHeight = Math.max(
        1,
        (rect?.height ?? 0) - FILES_PANEL_SPLITTER_HEIGHT,
      );
      const minRatio = Math.min(
        0.5,
        FILES_PANEL_SECTION_MIN_HEIGHT / availableHeight,
      );
      const maxRatio = Math.max(0.5, 1 - minRatio);
      return Math.min(Math.max(ratio, minRatio), maxRatio);
    },
    [filesPanelLayout],
  );

  useEffect(() => {
    if (!filesPanelSplitResizing) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const panel = filesSidePanelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const pointerRatio =
        filesPanelLayout === "horizontal"
          ? (event.clientX - rect.left) /
            Math.max(1, rect.width - FILES_PANEL_SPLITTER_WIDTH)
          : (event.clientY - rect.top) /
            Math.max(1, rect.height - FILES_PANEL_SPLITTER_HEIGHT);
      setFilesPanelSplitRatio(
        clampFilesPanelSplitRatio(
          filesPanelOrder === "explorer-first"
            ? pointerRatio
            : 1 - pointerRatio,
        ),
      );
    };
    const handleMouseUp = () => setFilesPanelSplitResizing(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor =
      filesPanelLayout === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    clampFilesPanelSplitRatio,
    filesPanelLayout,
    filesPanelOrder,
    filesPanelSplitResizing,
  ]);

  const clampToolPanelWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, TOOL_PANEL_MIN_WIDTH), toolPanelMaxWidth),
    [toolPanelMaxWidth],
  );

  const handleToolPanelResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!dashboardPanelTab || isMobile) return;
      event.preventDefault();
      setToolPanelResizing(true);
    },
    [dashboardPanelTab, isMobile],
  );

  const handleToolPanelResizeBy = useCallback(
    (delta: number) => {
      setToolPanelWidth((width) => clampToolPanelWidth(width + delta));
    },
    [clampToolPanelWidth],
  );

  useEffect(() => {
    if (!toolPanelResizing) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = filesSplitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setToolPanelWidth(clampToolPanelWidth(rect.right - event.clientX));
    };
    const handleMouseUp = () => setToolPanelResizing(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampToolPanelWidth, toolPanelResizing]);

  const renderTool = () => {
    if (activeTab === "shell") {
      return (
        <ShellV2
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isActive
        />
      );
    }
    if (activeTab === "git") {
      return (
        <GitV2 selectedProject={selectedProject} onFileOpen={handleFileOpen} />
      );
    }
    if (activeTab === "always-on") {
      return (
        <AlwaysOnV2
          selectedProject={selectedProject}
          subTab={alwaysOnSubTab}
          onSubTabChange={onAlwaysOnSubTabChange ?? (() => undefined)}
          onApplyWorkCycle={applyAndLaunchCycle}
          onOpenExecutionSession={handleOpenExecutionSession}
          compact
        />
      );
    }
    if (activeTab === "cron") return <CronV2 />;
    if (activeTab === "dashboard")
      return (
        <DashboardV2
          projectFilter={selectedProject?.name}
          projectFullPath={selectedProject?.fullPath}
          onSelectProject={onSelectProjectByName}
          compact
        />
      );
    if (activeTab === "memory")
      return <MemoryPanel selectedProject={selectedProject} />;
    if (activeTab === "skills")
      return (
        <SkillsV2
          selectedProject={selectedProject}
          projects={projects}
          compact
        />
      );
    if (renderTasksAsTool) return <TasksV2 isVisible />;
    if (isPlugin) {
      return (
        <PluginTabContent
          pluginName={activeTab.replace("plugin:", "")}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
        />
      );
    }
    return null;
  };

  const showFullScreenTool =
    isFullScreenTool && (activeTab !== "tasks" || shouldShowTasksTab);
  const showChat = !showFullScreenTool;
  const explorerVisible =
    isFiles &&
    showChat &&
    !editorExpanded &&
    !isMobile &&
    !explorerCollapsed &&
    (!isNarrowWorkbench || assistantOverlayOpen);
  const assistantVisible =
    isFiles &&
    showChat &&
    !editorExpanded &&
    !isMobile &&
    !assistantCollapsed &&
    (!isNarrowWorkbench || assistantOverlayOpen);
  const filesPanelVisible = explorerVisible || assistantVisible;
  const assistantIsOverlay = filesPanelVisible && isNarrowWorkbench;
  const stackedHorizontally =
    filesPanelLayout === "horizontal" &&
    explorerVisible &&
    assistantVisible &&
    !assistantIsOverlay;

  const toggleExplorer = () => {
    if (isNarrowWorkbench && !assistantOverlayOpen && !explorerCollapsed) {
      setAssistantOverlayOpen(true);
      return;
    }
    setExplorerCollapsed((collapsed) => {
      const next = !collapsed;
      if (!next && isNarrowWorkbench) setAssistantOverlayOpen(true);
      return next;
    });
  };

  const toggleAssistant = () => {
    if (isNarrowWorkbench && !assistantOverlayOpen && !assistantCollapsed) {
      setAssistantOverlayOpen(true);
      return;
    }
    setAssistantCollapsed((collapsed) => {
      const next = !collapsed;
      if (!next && isNarrowWorkbench) setAssistantOverlayOpen(true);
      return next;
    });
  };

  const handlePanelHeaderDragStart = (
    event: React.DragEvent<HTMLElement>,
    panel: FilesDockPanel,
  ) => {
    dockDragSourceRef.current = panel;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panel);
    const clearPreview = () => {
      dockDragSourceRef.current = null;
      setFilesPanelDropPreview(null);
    };
    window.addEventListener("dragend", clearPreview, { once: true });
  };

  const updateDropPreview = (
    event: React.DragEvent<HTMLElement>,
    target: FilesDockPanel,
    fromHeader: boolean,
  ) => {
    if (!dockDragSourceRef.current) return;
    if (isExternalFileDrag(event)) return;
    if (dockDragSourceRef.current === target) {
      setFilesPanelDropPreview(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const panelEl = event.currentTarget.closest("[data-files-dock-panel]");
    const rect = (
      panelEl instanceof HTMLElement ? panelEl : event.currentTarget
    ).getBoundingClientRect();
    const edge = resolveFilesDockEdge(event, rect, fromHeader);
    setFilesPanelDropPreview({ panel: target, edge: edge ?? "swap" });
  };

  const handlePanelHeaderDragOver = (
    event: React.DragEvent<HTMLElement>,
    target: FilesDockPanel,
  ) => {
    updateDropPreview(event, target, true);
  };

  const handlePanelBodyDragOver = (
    event: React.DragEvent<HTMLElement>,
    target: FilesDockPanel,
  ) => {
    updateDropPreview(event, target, false);
  };

  const handlePanelHeaderDrop = (
    event: React.DragEvent<HTMLElement>,
    target: FilesDockPanel,
    fromHeader = true,
  ) => {
    if (isExternalFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setFilesPanelDropPreview(null);
    const source =
      dockDragSourceRef.current || event.dataTransfer.getData("text/plain");
    dockDragSourceRef.current = null;
    if ((source !== "explorer" && source !== "assistant") || source === target)
      return;
    const panelEl = event.currentTarget.closest("[data-files-dock-panel]");
    const rect = (
      panelEl instanceof HTMLElement ? panelEl : event.currentTarget
    ).getBoundingClientRect();
    const edge = resolveFilesDockEdge(event, rect, fromHeader);
    if (!edge) {
      setFilesPanelLayout("vertical");
      setFilesPanelOrder((order) =>
        order === "explorer-first" ? "assistant-first" : "explorer-first",
      );
      return;
    }
    const next = dockArrangementFromDrop(source, edge);
    setFilesPanelLayout(next.layout);
    setFilesPanelOrder(next.order);
  };

  return (
    <div
      ref={filesSplitContainerRef}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {/* Legacy full-screen surfaces (Shell, Git, Tasks, plugin tabs). */}
      {showFullScreenTool && (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
          <Suspense fallback={<TabSkeleton />}>{renderTool()}</Suspense>
        </div>
      )}

      {/* Mobile keeps the existing full-width explorer flow. */}
      {isFiles && showChat && !editorExpanded && isMobile && !hasEditor ? (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-white dark:bg-neutral-950">
          <Suspense fallback={<TabSkeleton />}>
            <FilesV2
              key={selectedProject?.name ?? ""}
              selectedProject={selectedProject}
              onFileOpen={handleFileOpen}
              activeFilePath={activeFilePath}
              onFileRename={onFileRename}
              onFileDelete={onFileDelete}
              canAddToChat={!isReadOnlySession(selectedSession)}
            />
          </Suspense>
        </div>
      ) : null}

      {/* Artifact canvas — the visual center and primary surface in Files. */}
      {isFiles && showChat && (hasEditor || !isMobile) ? (
        <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-neutral-50/40 dark:bg-neutral-950">
          {hasEditor && selectedProject ? (
            <EditorSidebar {...editorSidebarProps} workspaceMode />
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-neutral-200 bg-white text-neutral-400 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
                <FileText className="h-5 w-5" strokeWidth={1.6} />
              </div>
              <p className="text-[14px] font-medium text-neutral-700 dark:text-neutral-300">
                {t("filesWorkbench.openFileTitle")}
              </p>
              <p className="mt-1 max-w-64 text-[12px] leading-5 text-neutral-400 dark:text-neutral-500">
                {t("filesWorkbench.openFileDescription")}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {/* Agent surface stays mounted so streaming state survives tab switches. */}
      <div
        ref={filesSidePanelRef}
        key="agent-surface"
        className={cn(
          "flex min-h-0 min-w-0 bg-white dark:bg-neutral-950",
          stackedHorizontally ? "flex-row" : "flex-col",
          !showChat && "invisible absolute h-0 w-0 overflow-hidden",
          showChat && !isFiles && "flex-1",
          filesPanelVisible &&
            !assistantIsOverlay &&
            "flex-shrink-0 border-l border-neutral-200 dark:border-neutral-800",
          assistantIsOverlay &&
            "absolute inset-y-0 right-[40px] z-40 border-l border-neutral-200 shadow-2xl dark:border-neutral-800",
          isFiles &&
            !filesPanelVisible &&
            "invisible absolute h-0 w-0 overflow-hidden",
        )}
        style={filesPanelVisible ? { width: filesAssistantWidth } : undefined}
        aria-hidden={!showChat || (isFiles && !filesPanelVisible)}
      >
        {isFiles && explorerVisible ? (
          <div
            data-files-dock-panel="explorer"
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
              assistantVisible ? "shrink-0" : "flex-1",
            )}
            style={{
              order: filesPanelOrder === "explorer-first" ? 0 : 2,
              ...(assistantVisible
                ? stackedHorizontally
                  ? {
                      width: `calc(${filesPanelSplitRatio * 100}% - ${
                        FILES_PANEL_SPLITTER_WIDTH * filesPanelSplitRatio
                      }px)`,
                      minWidth: FILES_PANEL_SECTION_MIN_WIDTH,
                      height: "100%",
                    }
                  : {
                      height: `calc(${filesPanelSplitRatio * 100}% - ${
                        FILES_PANEL_SPLITTER_HEIGHT * filesPanelSplitRatio
                      }px)`,
                      minHeight: FILES_PANEL_SECTION_MIN_HEIGHT,
                    }
                : {}),
            }}
            onDragOverCapture={
              assistantVisible
                ? (event) => handlePanelBodyDragOver(event, "explorer")
                : undefined
            }
            onDrop={
              assistantVisible
                ? (event) => handlePanelHeaderDrop(event, "explorer", false)
                : undefined
            }
          >
            {filesPanelDropPreview?.panel === "explorer" ? (
              <span
                aria-hidden="true"
                className={cn(
                  "files-dock-drop-preview",
                  filesPanelDropPreview.edge,
                )}
              />
            ) : null}
            <Suspense fallback={<TabSkeleton />}>
              <FilesV2
                key={selectedProject?.name ?? ""}
                selectedProject={selectedProject}
                onFileOpen={handleFileOpen}
                activeFilePath={activeFilePath}
                onFileRename={onFileRename}
                onFileDelete={onFileDelete}
                canAddToChat={!isReadOnlySession(selectedSession)}
                onHeaderDragStart={
                  assistantVisible
                    ? (event) => handlePanelHeaderDragStart(event, "explorer")
                    : undefined
                }
                onHeaderDragOver={
                  assistantVisible
                    ? (event) => handlePanelHeaderDragOver(event, "explorer")
                    : undefined
                }
                onHeaderDrop={
                  assistantVisible
                    ? (event) => handlePanelHeaderDrop(event, "explorer")
                    : undefined
                }
              />
            </Suspense>
          </div>
        ) : null}

        {isFiles && explorerVisible && assistantVisible ? (
          <div
            role="separator"
            aria-orientation={stackedHorizontally ? "vertical" : "horizontal"}
            aria-label={
              stackedHorizontally
                ? t("filesWorkbench.resizeHorizontalPanels", {
                    defaultValue: "Resize left and right panels",
                  })
                : t("filesWorkbench.resizeVerticalPanels", {
                    defaultValue: "Resize upper and lower panels",
                  })
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(filesPanelSplitRatio * 100)}
            tabIndex={0}
            onMouseDown={(event) => {
              event.preventDefault();
              setFilesPanelSplitResizing(true);
            }}
            onKeyDown={(event) => {
              const shrinkExplorer = stackedHorizontally
                ? event.key === "ArrowLeft"
                : event.key === "ArrowUp";
              const growExplorer = stackedHorizontally
                ? event.key === "ArrowRight"
                : event.key === "ArrowDown";
              if (shrinkExplorer) {
                event.preventDefault();
                setFilesPanelSplitRatio((ratio) =>
                  clampFilesPanelSplitRatio(
                    ratio +
                      (filesPanelOrder === "explorer-first" ? -0.05 : 0.05),
                  ),
                );
              } else if (growExplorer) {
                event.preventDefault();
                setFilesPanelSplitRatio((ratio) =>
                  clampFilesPanelSplitRatio(
                    ratio +
                      (filesPanelOrder === "explorer-first" ? 0.05 : -0.05),
                  ),
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                setFilesPanelSplitRatio(clampFilesPanelSplitRatio(0));
              } else if (event.key === "End") {
                event.preventDefault();
                setFilesPanelSplitRatio(clampFilesPanelSplitRatio(1));
              }
            }}
            className={cn(
              "panel-splitter",
              stackedHorizontally ? "vertical" : "horizontal",
              filesPanelSplitResizing && "active",
            )}
            style={{ order: 1 }}
          />
        ) : null}

        <div
          data-files-dock-panel="assistant"
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col",
            !isFiles && "flex-1",
            isFiles && assistantVisible && "flex-1 overflow-x-hidden",
            isFiles &&
              explorerVisible &&
              assistantVisible &&
              !stackedHorizontally &&
              "min-h-[330px]",
            isFiles &&
              explorerVisible &&
              assistantVisible &&
              stackedHorizontally &&
              "min-w-[220px]",
            isFiles &&
              !assistantVisible &&
              "invisible absolute h-0 w-0 overflow-hidden",
          )}
          style={{ order: filesPanelOrder === "explorer-first" ? 2 : 0 }}
          onDragOverCapture={
            isFiles && explorerVisible && assistantVisible
              ? (event) => handlePanelBodyDragOver(event, "assistant")
              : undefined
          }
          onDrop={
            isFiles && explorerVisible && assistantVisible
              ? (event) => handlePanelHeaderDrop(event, "assistant", false)
              : undefined
          }
        >
          {filesPanelDropPreview?.panel === "assistant" ? (
            <span
              aria-hidden="true"
              className={cn(
                "files-dock-drop-preview",
                filesPanelDropPreview.edge,
              )}
            />
          ) : null}
          {isFiles && assistantVisible ? (
            <header
              className="dock-panel-header chat"
              draggable={explorerVisible}
              onDragStart={
                explorerVisible
                  ? (event) => handlePanelHeaderDragStart(event, "assistant")
                  : undefined
              }
              onDragOver={
                explorerVisible
                  ? (event) => handlePanelHeaderDragOver(event, "assistant")
                  : undefined
              }
              onDrop={
                explorerVisible
                  ? (event) => handlePanelHeaderDrop(event, "assistant")
                  : undefined
              }
            >
              {selectedProject ? (
                <ConversationSwitcher
                  project={selectedProject}
                  selectedSession={selectedSession}
                  processingSessions={processingSessions}
                  unreadSessionIds={unreadSessionIds}
                  onSelectSession={(session) => {
                    if (onSelectSession) {
                      onSelectSession(selectedProject, session.id, session, {
                        preserveActiveTab: true,
                      });
                      return;
                    }
                    onNavigateToSession(session.id);
                  }}
                  onNewSession={() =>
                    onStartNewSession(selectedProject, {
                      preserveActiveTab: true,
                    })
                  }
                />
              ) : null}
            </header>
          ) : null}
          <ErrorBoundary showDetails>
            <ChatInterfaceV2
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              ws={ws}
              sendMessage={sendMessage}
              latestMessage={latestMessage}
              onFileOpen={handleFileOpen}
              onInputFocusChange={onInputFocusChange}
              onSessionActive={onSessionActive}
              onSessionInactive={onSessionInactive}
              onSessionProcessing={onSessionProcessing}
              onSessionNotProcessing={onSessionNotProcessing}
              onSessionActivityBump={onSessionActivityBump}
              processingSessions={processingSessions}
              onReplaceTemporarySession={onReplaceTemporarySession}
              onNavigateToSession={onNavigateToSession}
              onShowSettings={onShowSettings}
              autoExpandTools={autoExpandTools}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              inlineThinking={inlineThinking}
              autoScrollToBottom={autoScrollToBottom}
              sendByCtrlEnter={sendByCtrlEnter}
              externalMessageUpdate={externalMessageUpdate}
              onShowAllTasks={tasksEnabled ? () => setActiveTab("tasks") : null}
              forceWelcome={false}
              onExitWelcome={isFiles ? undefined : () => setActiveTab("chat")}
              compact={isFiles}
              projects={projects}
              onStartNewSession={onStartNewSession}
              onSelectWorkspace={onSelectWorkspace}
              workspaceBinding={workspaceBinding}
              onCreateProject={onCreateProject}
            />
          </ErrorBoundary>
        </div>
      </div>

      {dashboardPanelTab ? (
        <ToolSidePanel
          title={t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey)}
          icon={DASHBOARD_PANEL_META[dashboardPanelTab].icon}
          width={toolPanelWidth}
          minWidth={TOOL_PANEL_MIN_WIDTH}
          maxWidth={toolPanelMaxWidth}
          isMobile={isMobile}
          closeLabel={t("dashboardSwitcher.closePanel", {
            defaultValue: "Close {{tool}} dashboard",
            tool: t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey),
          })}
          resizeLabel={t("dashboardSwitcher.resizePanel", {
            defaultValue: "Resize {{tool}} dashboard",
            tool: t(DASHBOARD_PANEL_META[dashboardPanelTab].labelKey),
          })}
          onClose={() => setActiveTab("chat")}
          onResizeStart={handleToolPanelResizeStart}
          onResizeBy={handleToolPanelResizeBy}
        >
          <Suspense fallback={<TabSkeleton />}>{renderTool()}</Suspense>
        </ToolSidePanel>
      ) : null}

      {filesPanelVisible && !assistantIsOverlay ? (
        <div
          onMouseDown={(event) => handleFilesResizeStart("assistant", event)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              handleFilesAssistantResizeBy(16);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              handleFilesAssistantResizeBy(-16);
            } else if (event.key === "Home") {
              event.preventDefault();
              setFilesAssistantWidth(
                clampFilesAssistantWidth(FILES_ASSISTANT_MIN_WIDTH),
              );
            } else if (event.key === "End") {
              event.preventDefault();
              setFilesAssistantWidth(
                clampFilesAssistantWidth(FILES_ASSISTANT_MAX_WIDTH),
              );
            }
          }}
          className={cn(
            "files-panel-resizer",
            filesResizeTarget === "assistant" && "active",
          )}
          style={{ right: filesAssistantWidth + FILES_PANEL_RAIL_WIDTH }}
          title={t("filesWorkbench.resizeAssistant")}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("filesWorkbench.resizeAssistant")}
          aria-valuemin={FILES_ASSISTANT_MIN_WIDTH}
          aria-valuemax={FILES_ASSISTANT_MAX_WIDTH}
          aria-valuenow={Math.round(filesAssistantWidth)}
          tabIndex={0}
        >
          <span />
        </div>
      ) : null}

      {isFiles && showChat && !editorExpanded && !isMobile ? (
        <nav
          className="right-rail flex h-full w-[40px] flex-shrink-0 flex-col items-center gap-2 border-l border-neutral-200 bg-[#f7f5ff] px-1.5 py-3 dark:border-neutral-800 dark:bg-neutral-950"
          aria-label={t("filesWorkbench.panelControls", {
            defaultValue: "Workbench panels",
          })}
        >
          <button
            type="button"
            aria-label={t("filesWorkbench.fileDirectory", {
              defaultValue: "Files",
            })}
            aria-pressed={!explorerCollapsed}
            onClick={toggleExplorer}
            className={cn(!explorerCollapsed && "active")}
          >
            <span>
              {t("filesWorkbench.fileDirectory", { defaultValue: "Files" })}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("filesWorkbench.smartChat", {
              defaultValue: "Smart Chat",
            })}
            aria-pressed={!assistantCollapsed}
            onClick={toggleAssistant}
            className={cn(!assistantCollapsed && "active")}
          >
            <span>
              {t("filesWorkbench.smartChat", { defaultValue: "Smart Chat" })}
            </span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}

export default React.memo(MainContent);
