import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChatInterfaceV2 from '../../chat-v2/ChatInterfaceV2';
import AlwaysOnV2 from '../../main-content-v2/AlwaysOnV2';
import FilesV2 from '../../main-content-v2/FilesV2';
import ShellV2 from '../../main-content-v2/ShellV2';
import GitV2 from '../../main-content-v2/GitV2';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import DashboardV2 from '../../main-content-v2/DashboardV2';
import TasksV2 from '../../main-content-v2/TasksV2';
import { cn } from '../../../lib/utils.js';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type {
  AlwaysOnSessionTarget,
  Project,
  ProjectSession,
} from '../../../types/app';
import { api } from '../../../utils/api';
import {
  clearAlwaysOnPresence,
  sendAlwaysOnPresence,
} from '../../../utils/alwaysOnPresence';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import MemoryPanel from './memory/MemoryPanel';
import SkillsV2 from '../../main-content-v2/SkillsV2';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

type MainContentToast = { kind: 'error' | 'info'; text: string } | null;

const FILES_CHAT_DEFAULT_WIDTH = 460;
const FILES_CHAT_MIN_WIDTH = 320;
const FILES_TREE_MIN_WIDTH = 280;
const FILES_TREE_ONLY_WIDTH = 300;

async function readJsonPayload<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
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
  onReplaceTemporarySession,
  onNavigateToSession,
  onStartNewSession,
  onSelectSession,
  onShowSettings,
  onSelectProjectByName,
  externalMessageUpdate,
}: MainContentProps) {
  const { i18n } = useTranslation();
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const lastUserMsgAtRef = useRef<string | null>(null);
  const [toast, setToast] = useState<MainContentToast>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const refreshProjectsSilently = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const trackedSendMessage = useCallback((message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      ['claude-command', 'cursor-command', 'codex-command', 'gemini-command','pilotdeck-command'].includes(
        String((message as { type?: unknown }).type),
      )
    ) {
      lastUserMsgAtRef.current = new Date().toISOString();
    }
    sendMessage(message);
  }, [sendMessage]);

  const publishPresence = useCallback(() => {
    const alwaysOnProjects = projects.filter(project =>
      project.alwaysOn?.discovery?.triggerEnabled === true
    );
    if (!selectedProject && alwaysOnProjects.length === 0) {
      return;
    }
    sendAlwaysOnPresence(sendMessage, {
      selectedProject,
      alwaysOnProjects,
      processingSessionIds: Array.from(processingSessions),
      lastUserMsgAt: lastUserMsgAtRef.current,
    });
  }, [processingSessions, projects, selectedProject, sendMessage]);

  useEffect(() => {
    const hasAlwaysOnProject = projects.some(project =>
      project.alwaysOn?.discovery?.triggerEnabled === true
    );
    if (!ws || (!selectedProject && !hasAlwaysOnProject)) {
      return undefined;
    }

    publishPresence();
    const timer = window.setInterval(publishPresence, 30000);
    return () => {
      window.clearInterval(timer);
      clearAlwaysOnPresence(sendMessage);
    };
  }, [projects, publishPresence, selectedProject, sendMessage, ws]);

  const applyAndLaunchCycle = useCallback(async (
    projectName: string,
    cycleId: string,
  ) => {
    const response = await api.applyWorkCycle(projectName, cycleId);
    const payload = await readJsonPayload<{ cycle?: { id: string }; sessionKey?: string; executionToken?: string; error?: { code: string; message: string } | string }>(response);
    if (!response.ok || !payload) {
      const errMsg = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
      throw new Error(errMsg || 'Failed to queue discovery plan apply');
    }
    if (payload.error) {
      const errMsg = typeof payload.error === 'string' ? payload.error : payload.error.message;
      throw new Error(errMsg);
    }

    refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  const flashToast = useCallback((toastValue: MainContentToast, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const getProjectSessions = useCallback((project: Project): ProjectSession[] =>
    project.sessions ?? [],
  []);

  const findSessionInProject = useCallback((project: Project, sessionId: string) => (
    getProjectSessions(project).find((session) => session.id === sessionId)
  ), [getProjectSessions]);

  const loadPilotDeckSession = useCallback(async (projectName: string, sessionId: string) => {
    const response = await api.sessions(projectName, Number.MAX_SAFE_INTEGER, 0);
    if (!response.ok) {
      return null;
    }
    const payload = await readJsonPayload<{ sessions?: ProjectSession[] }>(response);
    return payload?.sessions?.find((session) => session.id === sessionId) ?? null;
  }, []);

  const handleOpenAlwaysOnSession = useCallback(async (target: AlwaysOnSessionTarget) => {
    if (!selectedProject) {
      return;
    }

    const missingMessage = i18n.t('alwaysOn:sessionMissing', {
      defaultValue: 'This chat record no longer exists.',
    });

    if (target.kind === 'origin') {
      const lookupProjectName = target.projectName || selectedProject.name;
      const targetProject =
        target.projectName && target.projectName !== selectedProject.name
          ? projects.find((p) => p.name === target.projectName) ?? selectedProject
          : selectedProject;

      const existingSession =
        findSessionInProject(targetProject, target.sessionId) ??
        await loadPilotDeckSession(lookupProjectName, target.sessionId);

      if (!existingSession) {
        flashToast({ kind: 'error', text: missingMessage });
        return;
      }

      const fallbackSession: ProjectSession = {
        ...existingSession,
        __projectName: lookupProjectName,
      };

      setActiveTab('chat');
      if (onSelectSession) {
        onSelectSession(targetProject, target.sessionId, fallbackSession);
        return;
      }
      onNavigateToSession(target.sessionId);
      return;
    }

    const existingSession =
      findSessionInProject(selectedProject, target.sessionId) ??
      await loadPilotDeckSession(selectedProject.name, target.sessionId);

    if (!existingSession) {
      flashToast({ kind: 'error', text: missingMessage });
      return;
    }

    const fallbackSession: ProjectSession = {
      ...existingSession,
      id: target.sessionId,
      title: target.title || existingSession.title || existingSession.summary || target.summary,
      summary: target.summary || existingSession.summary || existingSession.title || target.title,
      lastActivity: target.lastActivity || existingSession.lastActivity,
      sessionKind: 'background_task',
      parentSessionId: target.parentSessionId,
      relativeTranscriptPath: target.relativeTranscriptPath,
      transcriptKey: target.transcriptKey || existingSession.transcriptKey,
      taskId: target.taskId || existingSession.taskId,
      taskStatus: target.taskStatus || existingSession.taskStatus,
      outputFile: target.outputFile || existingSession.outputFile,
      isReadOnly: true,
      __projectName: selectedProject.name,
    };

    setActiveTab('chat');
    if (onSelectSession) {
      onSelectSession(selectedProject, target.sessionId, fallbackSession);
      return;
    }
    onNavigateToSession(target.sessionId);
  }, [
    findSessionInProject,
    flashToast,
    i18n,
    loadPilotDeckSession,
    onNavigateToSession,
    onSelectSession,
    projects,
    selectedProject,
    setActiveTab,
  ]);

  const handleOpenExecutionSession = useCallback(
    (projectKey: string, runId: string, projectName?: string) => {
      const rawId = `always-on/execute:project=${projectKey}:run=${runId}`;
      const sessionId = rawId.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
      void handleOpenAlwaysOnSession({ kind: 'origin', sessionId, projectName });
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

  if (!selectedProject && activeTab !== 'dashboard') {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SplitBody
          projects={projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          shouldShowTasksTab={shouldShowTasksTab}
          tasksEnabled={tasksEnabled}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={trackedSendMessage}
          latestMessage={latestMessage}
          handleFileOpen={handleFileOpen}
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
          externalMessageUpdate={externalMessageUpdate}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          autoScrollToBottom={autoScrollToBottom}
          sendByCtrlEnter={sendByCtrlEnter}
          applyAndLaunchCycle={applyAndLaunchCycle}
          handleOpenExecutionSession={handleOpenExecutionSession}
          editorExpanded={editorExpanded}
          hasEditor={editingFile !== null}
          onSelectProjectByName={onSelectProjectByName}
        />

        {selectedProject && (
          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            projectPath={selectedProject.path}
            fillSpace={activeTab === 'files'}
          />
        )}
      </div>
      {toast ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg',
            toast.kind === 'error' && 'bg-red-600 text-white',
            toast.kind === 'info' && 'bg-neutral-800 text-white',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// V2 split body: the Agent surface owns both the new-session welcome state
// and existing transcripts. Files can pair with Agent in split view; focused
// tools such as Always-On, Dashboard, Tasks, and Memory render full-screen.
type SplitBodyProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: any;
  activeTab: string;
  shouldShowTasksTab: boolean;
  tasksEnabled: boolean;
  setActiveTab: (tab: any) => void;
  ws: any;
  sendMessage: any;
  latestMessage: any;
  handleFileOpen: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
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
  processingSessions: any;
  onReplaceTemporarySession: any;
  onNavigateToSession: (sessionId: string) => void;
  onShowSettings: any;
  externalMessageUpdate: any;
  autoExpandTools: any;
  showRawParameters: any;
  showThinking: any;
  autoScrollToBottom: any;
  sendByCtrlEnter: any;
  applyAndLaunchCycle: (projectName: string, cycleId: string) => Promise<void>;
  handleOpenExecutionSession: (projectKey: string, runId: string, projectName?: string) => void;
  editorExpanded: boolean;
  hasEditor: boolean;
  onSelectProjectByName?: (projectName: string) => void;
};

function SplitBody(props: SplitBodyProps) {
  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    shouldShowTasksTab,
    tasksEnabled,
    setActiveTab,
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
    onReplaceTemporarySession,
    onNavigateToSession,
    onShowSettings,
    externalMessageUpdate,
    autoExpandTools,
    showRawParameters,
    showThinking,
    autoScrollToBottom,
    sendByCtrlEnter,
    applyAndLaunchCycle,
    handleOpenExecutionSession,
    editorExpanded,
    hasEditor,
    onSelectProjectByName,
  } = props;

  // Render-mode taxonomy:
  //   - 'chat':    Agent surface. No session shows the welcome composer;
  //                existing sessions show the transcript.
  //   - 'split':   Files tab only. Chat on the left, file tree/editor on right.
  //   - 'tool':    Always-On / Dashboard / Memory / Tasks / Shell / Git /
  //                plugin tabs. Tool fills the whole main area, no chat
  //                alongside — matches the legacy single-pane layout users
  //                expect when they tab into a focused tool.
  //
  // Note: Shell + Git aren't surfaced in the V2 top tab bar (see TABS in
  // MainAreaV2.tsx) but plugins / programmatic activeTab values still hit
  // those code paths, so we keep them here as full-screen tool views.
  const isPlugin = typeof activeTab === 'string' && activeTab.startsWith('plugin:');
  const fullScreenToolTabs = new Set([
    'shell',
    'git',
    'always-on',
    'dashboard',
    'memory',
    'skills',
    'tasks',
  ]);
  const isFullScreenTool = fullScreenToolTabs.has(activeTab) || isPlugin;
  // Tasks tab is conditional — fall back to chat if the project hasn't
  // enabled it yet so we don't render a black hole.
  const renderTasksAsTool = activeTab === 'tasks' && shouldShowTasksTab;
  const isFiles = activeTab === 'files';
  const filesSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const [filesChatWidth, setFilesChatWidth] = useState(FILES_CHAT_DEFAULT_WIDTH);
  const [isFilesSplitResizing, setIsFilesSplitResizing] = useState(false);

  const clampFilesChatWidth = useCallback((width: number, containerWidth: number) => {
    const maxWidth = Math.max(FILES_CHAT_MIN_WIDTH, containerWidth - FILES_TREE_MIN_WIDTH);
    return Math.min(Math.max(width, FILES_CHAT_MIN_WIDTH), maxWidth);
  }, []);

  useEffect(() => {
    if (!isFiles) return;
    const container = filesSplitContainerRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (hasEditor) {
      setFilesChatWidth(FILES_CHAT_DEFAULT_WIDTH);
    } else {
      setFilesChatWidth(Math.max(FILES_CHAT_MIN_WIDTH, containerWidth - FILES_TREE_ONLY_WIDTH));
    }
  }, [hasEditor, isFiles]);

  const handleFilesSplitResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!isFiles) {
      return;
    }

    setIsFilesSplitResizing(true);
    event.preventDefault();
  }, [isFiles]);

  useEffect(() => {
    if (!isFilesSplitResizing) {
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = filesSplitContainerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      setFilesChatWidth(clampFilesChatWidth(event.clientX - rect.left, rect.width));
    };

    const handleMouseUp = () => {
      setIsFilesSplitResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampFilesChatWidth, isFilesSplitResizing]);

  const renderTool = () => {
    if (activeTab === 'shell') {
      return (
        <ShellV2
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isActive
        />
      );
    }
    if (activeTab === 'git') {
      return <GitV2 selectedProject={selectedProject} onFileOpen={handleFileOpen} />;
    }
    if (activeTab === 'always-on') {
      return (
        <AlwaysOnV2
          selectedProject={selectedProject}
          onApplyWorkCycle={applyAndLaunchCycle}
          onOpenExecutionSession={handleOpenExecutionSession}
        />
      );
    }
    if (activeTab === 'dashboard') return <DashboardV2 projectFilter={selectedProject?.name} projectFullPath={selectedProject?.fullPath} onSelectProject={onSelectProjectByName} />;
    if (activeTab === 'memory') return <MemoryPanel selectedProject={selectedProject} />;
    if (activeTab === 'skills') return <SkillsV2 selectedProject={selectedProject} projects={projects} />;
    if (renderTasksAsTool) return <TasksV2 isVisible />;
    if (isPlugin) {
      return (
        <PluginTabContent
          pluginName={activeTab.replace('plugin:', '')}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
        />
      );
    }
    return null;
  };

  const showFullScreenTool = isFullScreenTool && (activeTab !== 'tasks' || shouldShowTasksTab);
  const showChat = !showFullScreenTool;

  return (
    <div
      ref={isFiles && showChat ? filesSplitContainerRef : undefined}
      className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', editorExpanded && 'hidden')}
    >
      {/* Full-screen tool surface (Memory, Dashboard, Always-On, etc.) */}
      {showFullScreenTool && (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
          {renderTool()}
        </div>
      )}

      {/* Agent surface — kept mounted even when a full-screen tool is active
          so that the session store, WebSocket subscriptions, and streaming
          state survive tab switches. Hidden via CSS to avoid layout cost. */}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          showChat
            ? (isFiles ? 'flex-shrink-0' : 'flex-1')
            : 'invisible absolute h-0 w-0 overflow-hidden',
        )}
        style={showChat && isFiles
          ? {
              minWidth: `${FILES_CHAT_MIN_WIDTH}px`,
              width: `min(${filesChatWidth}px, calc(100% - ${FILES_TREE_MIN_WIDTH}px))`,
            }
          : undefined}
        aria-hidden={!showChat}
      >
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
            autoScrollToBottom={autoScrollToBottom}
            sendByCtrlEnter={sendByCtrlEnter}
            externalMessageUpdate={externalMessageUpdate}
            onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
            forceWelcome={false}
            onExitWelcome={() => setActiveTab('chat')}
          />
        </ErrorBoundary>
      </div>

      {/* Right half — only mounted when the user is on Files (chat-paired
          file tree + editor). */}
      {isFiles && showChat ? (
        <>
          <div
            onMouseDown={handleFilesSplitResizeStart}
            className="group relative z-10 w-px flex-shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600"
            title="Drag to resize"
          >
            <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-neutral-600" />
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            style={{ minWidth: `${FILES_TREE_MIN_WIDTH}px` }}
          >
            <FilesV2
              key={selectedProject?.name ?? ''}
              selectedProject={selectedProject}
              onFileOpen={handleFileOpen}
              onClose={() => setActiveTab('chat')}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

export default React.memo(MainContent);
