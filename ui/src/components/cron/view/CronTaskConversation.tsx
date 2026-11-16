import { useMemo, type ReactNode } from 'react';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { CronJobOverview, Project, ProjectSession } from '../../../types/app';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { ChatHistorySearchControllerProvider } from '../../chat/view/ChatHistorySearchController';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import ChatInterface from '../../chat/view/ChatInterface';

/** Scheduling adds ownership and controls; messages use the ordinary chat pipeline. */
export default function CronTaskConversation({ job, projects, emptyState }: { job: CronJobOverview; projects: Project[]; emptyState?: ReactNode }) {
  const { ws, sendMessage, subscribe } = useWebSocket();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { preferences } = useUiPreferences();
  const project = useMemo<Project>(() => projects.find(item => item.fullPath === job.projectKey || item.name === job.projectKey)
    || { name: job.projectKey || 'general', fullPath: job.projectKey || '', displayName: job.projectKey?.split(/[\\/]/).at(-1) || 'General' }, [projects, job.projectKey]);
  const session = useMemo<ProjectSession>(() => ({ id: job.sessionKey || `cron:${job.id}`, provider: 'pilotdeck', title: job.name }), [job.id, job.sessionKey, job.name]);
  const workspace = job.lastRun?.workspaceCwd || job.workspaceCwd || project.fullPath;
  const editorProject = useMemo(() => ({ ...project, name: `cron-task:${job.id}`, fullPath: workspace }), [project, workspace, job.id]);
  const editor = useEditorSidebar({ selectedProject: editorProject, isMobile });
  return <ChatHistorySearchControllerProvider>
    <div className="cron-conversation flex min-h-0 min-w-0 flex-1 overflow-hidden" data-task-conversation={session.id}>
      <div className="pd-chat-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-neutral-950">
        <ChatInterface selectedProject={project} selectedSession={session} projects={projects}
          ws={ws} sendMessage={sendMessage} subscribe={subscribe} sessionScope="task" emptyState={emptyState}
          autoScrollToBottom={preferences.autoScrollToBottom} sendByCtrlEnter={preferences.sendByCtrlEnter}
          autoExpandTools={preferences.autoExpandTools} showThinking={preferences.showThinking} inlineThinking={preferences.inlineThinking}
          onFileOpen={(path, diff) => editor.handleFileOpen(path, diff)} />
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
