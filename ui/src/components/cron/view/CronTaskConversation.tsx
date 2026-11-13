import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, SetStateAction } from 'react';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { CronJobOverview, Project, ProjectSession } from '../../../types/app';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useSessionWatch } from '../../../hooks/useSessionWatch';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useChatSessionState } from '../../chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../../chat/hooks/useChatRealtimeHandlers';
import { buildReconnectStatusMessage } from '../../chat/utils/reconnectRecovery';
import type { PendingPermissionRequest } from '../../chat/types/types';
import MessagesPane from '../../chat/view/MessagesPane';
import { ChatHistorySearchControllerProvider } from '../../chat/view/ChatHistorySearchController';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';

const ignoreInput: Dispatch<SetStateAction<string>> = () => {};

/** Scheduling adds ownership and controls; messages use the ordinary chat pipeline. */
export default function CronTaskConversation({ job, projects }: { job: CronJobOverview; projects: Project[] }) {
  const { t } = useTranslation('alwaysOn');
  const { ws, sendMessage } = useWebSocket();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { preferences } = useUiPreferences();
  const project = useMemo<Project>(() => projects.find(item => item.fullPath === job.projectKey || item.name === job.projectKey)
    || { name: job.projectKey || 'general', fullPath: job.projectKey || '', displayName: job.projectKey?.split(/[\\/]/).at(-1) || 'General' }, [projects, job.projectKey]);
  const session = useMemo<ProjectSession>(() => ({ id: job.sessionKey || `cron:${job.id}`, provider: 'pilotdeck', title: job.name }), [job.id, job.sessionKey, job.name]);
  const pendingViewSessionRef = useRef<{ sessionId: string | null; startedAt: number } | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const resetStreamingState = useCallback(() => {}, []);
  const sessionStore = useSessionStore();
  const processingSessions = useMemo(() => new Set(job.status === 'running' ? [session.id] : []), [job.status, session.id]);
  const state = useChatSessionState({ selectedProject: project, selectedSession: session, ws, sendMessage,
    autoScrollToBottom: preferences.autoScrollToBottom, eventDriven: true, processingSessions,
    resetStreamingState, pendingViewSessionRef, sessionStore });
  useSessionWatch({ sessionId: session.id, ws, sendMessage });
  const reconnect = useCallback(() => {
    void state.refreshSessionMessages();
    const message = buildReconnectStatusMessage(session.id, state.activeRunId);
    if (message) sendMessage(message);
  }, [state.refreshSessionMessages, state.activeRunId, session.id, sendMessage]);
  useChatRealtimeHandlers({ sessionScope: 'task', provider: 'pilotdeck', selectedProject: project, selectedSession: session,
    currentSessionId: state.currentSessionId, setCurrentSessionId: state.setCurrentSessionId,
    setIsLoading: state.setIsLoading, setSessionRuntimeState: state.setSessionRuntimeState,
    activeRunId: state.activeRunId, setActiveRunId: state.setActiveRunId,
    setCanAbortSession: state.setCanAbortSession, setIsAborting: state.setIsAborting,
    setClaudeStatus: state.setClaudeStatus, setPilotDeckStatus: state.setPilotDeckStatus,
    setTokenBudget: state.setTokenBudget, setPendingPermissionRequests, pendingViewSessionRef,
    onWebSocketReconnect: reconnect, sessionStore });

  // Only reconcile history when a run changed while this session was not watched.
  // Live frames and the shared store handle the currently displayed run.
  const completedRun = useRef(new Map<string, string>());
  useEffect(() => {
    const finished = job.lastRun?.finishedAt;
    if (!finished) return;
    const previous = completedRun.current.get(session.id);
    completedRun.current.set(session.id, finished);
    if (previous && previous !== finished) void state.refreshSessionMessages();
  }, [session.id, job.lastRun?.finishedAt, state.refreshSessionMessages]);

  const workspace = job.lastRun?.workspaceCwd || job.workspaceCwd || project.fullPath;
  const editorProject = useMemo(() => ({ ...project, name: `cron-task:${job.id}`, fullPath: workspace }), [project, workspace, job.id]);
  const editor = useEditorSidebar({ selectedProject: editorProject, isMobile });
  return <ChatHistorySearchControllerProvider>
    <div className="cron-conversation flex min-h-0 min-w-0 flex-1 overflow-hidden" data-task-conversation={session.id}>
      <div className="pd-chat-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-neutral-950">
        <MessagesPane scrollContainerRef={state.scrollContainerRef} allowReply={false}
          emptyState={<div className="cron-workspace-empty h-full">
            <h2>{t(job.status === 'running' ? 'cron.workspace.runningHint' : 'cron.workspace.noSavedRuns')}</h2>
          </div>} showReturnToLatest={state.chatMessages.length > 0 && state.canReturnToLatest}
          onResumeScroll={state.scrollToBottom} onPauseScroll={state.pauseScrollFollowing}
          isLoadingSessionMessages={state.isLoadingSessionMessages} sessionLoadError={state.sessionLoadError}
          onRetrySessionLoad={state.retrySessionMessages} chatMessages={state.chatMessages} activityMessages={state.activityMessages}
          visibleMessages={state.visibleMessages} visibleMessageCount={state.visibleMessageCount}
          isLoadingMoreMessages={state.isLoadingMoreMessages} historyLoadError={state.historyLoadError}
          hasMoreMessages={state.hasMoreMessages} totalMessages={state.totalMessages}
          loadEarlierMessages={state.loadEarlierMessages} loadAllMessages={state.loadAllMessages}
          allMessagesLoaded={state.allMessagesLoaded} isLoadingAllMessages={state.isLoadingAllMessages}
          provider="pilotdeck" selectedProject={project} selectedSession={session} createDiff={state.createDiff}
          onFileOpen={(path, diff) => editor.handleFileOpen(path, diff as Parameters<typeof editor.handleFileOpen>[1])}
          autoExpandTools={preferences.autoExpandTools} showThinking={preferences.showThinking}
          inlineThinking={preferences.inlineThinking} setInput={ignoreInput}
          isAssistantWorking={job.status === 'running' || state.isLoading} pendingPermissionRequests={pendingPermissionRequests}
          sessionRuntimeState={state.sessionRuntimeState} activeRunId={state.activeRunId}
          workingStatus={state.claudeStatus || state.pilotDeckStatus} sessionStore={sessionStore} />
      </div>
      <EditorSidebar editorTabs={editor.editorTabs} activeEditorTabId={editor.activeEditorTabId} isMobile={isMobile}
        editorExpanded={editor.editorExpanded} editorWidth={editor.editorWidth} hasManualWidth={editor.hasManualWidth}
        resizeHandleRef={editor.resizeHandleRef} onResizeStart={editor.handleResizeStart} onTabSelect={editor.handleTabSelect}
        onTabClose={editor.handleTabClose} onTabsClose={editor.handleTabsClose} onTabDirtyChange={editor.handleTabDirtyChange}
        onToggleEditorExpand={editor.handleToggleEditorExpand} onPreviewFileOpen={editor.handlePreviewFileOpen}
        onGoBack={editor.canGoBack ? editor.handleFileGoBack : undefined} projectPath={editorProject.fullPath} />
    </div>
  </ChatHistorySearchControllerProvider>;
}
