import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom';
import { Loader2, Trash2 } from 'lucide-react';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import Settings from '../settings/view/Settings';
import ProjectCreationWizard from '../project-creation-wizard';
import { normalizeProjectForSettings, type SettingsProject } from '../../lib/projectSettings';
import {
  sessionDisplayTitle,
  setSessionCustomTitle,
} from '../../lib/customNames';
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
  type AppTab,
  type Project,
  type ProjectSession,
  type SessionProvider,
} from '../../types/app';
import { api } from '../../utils/api';
import { resolveMarkdownFileHref } from '../chat/utils/resolveMarkdownFileHref';
import SidebarV2 from './SidebarV2';
import MainAreaV2 from './MainAreaV2';
import { ConnectionBanner } from '../ui/ConnectionBanner';

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

type DeleteSessionTarget = {
  project: Project;
  session: ProjectSession;
};

const SettingsComponent = Settings as unknown as (props: TypedSettingsProps) => JSX.Element;

const UNREAD_IGNORED_MESSAGE_TYPES = new Set([
  'websocket-reconnected',
  'pending-permissions-response',
  'session-status',
]);

const UNREAD_IGNORED_MESSAGE_KINDS = new Set([
  'session_created',
  'status',
  'stream_end',
]);

const getSessionIdFromMessage = (message: unknown): string | null => {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as {
    sessionId?: unknown;
    session_id?: unknown;
    newSessionId?: unknown;
    actualSessionId?: unknown;
  };
  const value =
    candidate.sessionId ??
    candidate.session_id ??
    candidate.actualSessionId ??
    candidate.newSessionId;
  return typeof value === 'string' && value.trim() ? value : null;
};

const isUnreadWorthyMessage = (message: unknown): boolean => {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { kind?: unknown; type?: unknown };

  if (typeof candidate.kind === 'string') {
    return !UNREAD_IGNORED_MESSAGE_KINDS.has(candidate.kind);
  }

  if (typeof candidate.type === 'string') {
    return !UNREAD_IGNORED_MESSAGE_TYPES.has(candidate.type);
  }

  return false;
};

// V2 shell. Reuses the same data hooks as legacy AppContent so chat, discovery,
// auth, and project plumbing keep working unchanged — V2 just reorganizes the
// outer chrome (sidebar + breadcrumb header per prototype/shadcn.html).
export default function AppShellV2() {
  const navigate = useNavigate();
  // Match the four V2 URL shapes and hoist params up. A single wildcard route
  // owns this shell so state survives every URL transition.
  const matchProjectChat = useMatch('/p/:projectName/c/:sessionId');
  const matchProject = useMatch('/p/:projectName');
  const matchLegacySession = useMatch('/session/:sessionId');
  const projectNameParam =
    matchProjectChat?.params.projectName ?? matchProject?.params.projectName ?? undefined;
  const sessionId =
    matchProjectChat?.params.sessionId ?? matchLegacySession?.params.sessionId ?? undefined;
  useTranslation('common');

  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const { ws, sendMessage, latestMessage, isConnected, subscribe } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    setActiveTab,
    setSelectedSession,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleDeselectProject,
    handleResetProjectSessionPreview,
    setSelectedProject,
    loadMoreSessions,
    loadingMoreProjectIds,
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  const misroutedFileFromUrl = useMemo(() => {
    if (!sessionId) return null;
    const filePath = resolveMarkdownFileHref(`/session/${sessionId}`);
    if (!filePath) return null;
    if (isLoadingProjects) return filePath;
    const hasMatchingSession = sidebarSharedProps.projects.some((project) =>
      (project.sessions ?? []).some((session) => session.id === sessionId),
    );
    return hasMatchingSession ? null : filePath;
  }, [sessionId, isLoadingProjects, sidebarSharedProps.projects]);

  const handleMisroutedFileUrlHandled = useCallback(() => {
    const target = selectedProject
      ? `/p/${encodeURIComponent(selectedProject.name)}`
      : '/';
    navigate(target, { replace: true });
  }, [navigate, selectedProject]);

  // Sync URL projectName -> selectedProject for deep links like /p/:projectName.
  // When the URL also carries a session id (/p/.../c/:sessionId or
  // /session/:sessionId) we let useProjectsState own the resolution because
  // it sets BOTH the project and the session in one effect, avoiding a race
  // where this hook would clear the session via handleProjectSelect.
  useEffect(() => {
    if (!projectNameParam) return;
    if (sessionId) return;
    if (selectedProject?.name === projectNameParam) return;
    const target = sidebarSharedProps.projects.find((p) => p.name === projectNameParam);
    if (target) {
      handleProjectSelect(target);
      // handleProjectSelect unconditionally navigates to '/' — put the URL back.
      navigate(`/p/${encodeURIComponent(projectNameParam)}`, { replace: true });
    }
  }, [
    projectNameParam,
    sessionId,
    selectedProject?.name,
    sidebarSharedProps.projects,
    handleProjectSelect,
    navigate,
  ]);

  // Default selection: prefer a project named "general" so the project-centric
  // sidebar always has something useful surfaced. Falls back to the first
  // project when "general" is missing. Runs only when there's no URL hint and
  // no current selection — never overrides user navigation.
  const didDefaultProjectRef = useRef(false);
  useEffect(() => {
    if (didDefaultProjectRef.current) return;
    if (isLoadingProjects) return;
    if (selectedProject) {
      didDefaultProjectRef.current = true;
      return;
    }
    if (projectNameParam || sessionId) {
      didDefaultProjectRef.current = true;
      return;
    }
    if (sidebarSharedProps.projects.length === 0) return;
    const general = sidebarSharedProps.projects.find(
      (p) => p.name === 'general' || p.displayName === 'general',
    );
    const target = general ?? sidebarSharedProps.projects[0];
    handleProjectSelect(target);
    navigate(`/p/${encodeURIComponent(target.name)}`, { replace: true });
    didDefaultProjectRef.current = true;
  }, [
    isLoadingProjects,
    selectedProject,
    projectNameParam,
    sessionId,
    sidebarSharedProps.projects,
    handleProjectSelect,
    navigate,
  ]);

  useEffect(() => {
    window.refreshProjects = refreshProjectsSilently;
    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    window.openSettings = openSettings;
    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  // Resolve a project by name (exact match first, then case-insensitive on
  // both the directory name and the user-facing displayName, then a relaxed
  // case-insensitive substring) and select it via the same handler the
  // sidebar uses, so the chat slash command `/switch-project xxx` can hop
  // between projects without a manual click.
  const switchProject = useCallback(
    (projectName: string): boolean => {
      const trimmed = (projectName ?? '').trim();
      if (!trimmed) return false;

      const list = sidebarSharedProps.projects;
      const exact = list.find((p) => p.name === trimmed);
      const ciExact =
        exact ??
        list.find(
          (p) =>
            p.name.toLowerCase() === trimmed.toLowerCase() ||
            (p.displayName ?? '').toLowerCase() === trimmed.toLowerCase(),
        );
      const fuzzy =
        ciExact ??
        list.find(
          (p) =>
            p.name.toLowerCase().includes(trimmed.toLowerCase()) ||
            (p.displayName ?? '').toLowerCase().includes(trimmed.toLowerCase()),
        );
      const target = fuzzy;
      if (!target) return false;

      handleProjectSelect(target);
      navigate(`/p/${encodeURIComponent(target.name)}`);
      return true;
    },
    [handleProjectSelect, navigate, sidebarSharedProps.projects],
  );

  useEffect(() => {
    window.switchProject = switchProject;
    return () => {
      if (window.switchProject === switchProject) {
        delete window.switchProject;
      }
    };
  }, [switchProject]);

  useEffect(() => {
    const selectedSessionId = selectedSession?.id;
    if (!selectedSessionId) return;

    setUnreadSessionIds((previous) => {
      if (!previous.has(selectedSessionId)) return previous;
      const next = new Set(previous);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSession?.id]);

  useEffect(() => {
    return subscribe((message) => {
      if (!isUnreadWorthyMessage(message)) return;

      const messageSessionId = getSessionIdFromMessage(message);
      if (!messageSessionId || messageSessionId === selectedSession?.id) return;

      setUnreadSessionIds((previous) => {
        if (previous.has(messageSessionId)) return previous;
        const next = new Set(previous);
        next.add(messageSessionId);
        return next;
      });
    });
  }, [selectedSession?.id, subscribe]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') return;

      // Provider hint from notifications is no longer stored; all sessions
      // go through the unified pilotdeck gateway.

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }
      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;
    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id,
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  const onShowSettings = useCallback(() => setShowSettings(true), [setShowSettings]);
  const onCloseSettings = useCallback(() => setShowSettings(false), [setShowSettings]);
  const onMenuClick = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const onCollapseSidebar = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
    } else {
      setDesktopSidebarOpen(false);
    }
  }, [isMobile, setSidebarOpen]);
  const onOpenDesktopSidebar = useCallback(() => setDesktopSidebarOpen(true), []);

  // Project creation wizard (local existing / new local / github clone). The
  // sidebar's Projects-section "+" opens this; row-level "+" is for new sessions.
  const [showNewProject, setShowNewProject] = useState(false);
  const handleOpenNewProject = useCallback(() => setShowNewProject(true), []);
  const handleCloseNewProject = useCallback(() => setShowNewProject(false), []);
  const handleProjectCreated = useCallback((project?: Record<string, unknown>) => {
    setShowNewProject(false);
    void refreshProjectsSilently();

    // Auto-jump into the new project's empty new-conversation screen so the
    // user doesn't accidentally keep chatting under the previously selected
    // project (typically "general") after closing the wizard. The wizard
    // hands back the freshly created project from POST /create-workspace
    // (and the clone SSE complete event), which is the same `{ name,
    // displayName, fullPath, path }` shape as the sidebar list entries.
    const projectName = typeof project?.name === 'string' ? project.name : '';
    if (!projectName) return;
    const newProject = project as Project;
    handleNewSession(newProject);
    navigate(`/p/${encodeURIComponent(projectName)}`);
    setActiveTab('chat');
  }, [handleNewSession, navigate, refreshProjectsSilently, setActiveTab]);

  // Project deletion (V2): hover-revealed trash button on each row -> confirm dialog
  // -> DELETE /api/projects/:name (force=true). Reuses the shared cleanup callback
  // from useProjectsState to clear selection + redirect when the deleted project
  // was active.
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleRequestDeleteProject = useCallback((project: Project) => {
    setDeleteError(null);
    setDeleteTarget(project);
  }, []);
  const handleCancelDelete = useCallback(() => {
    if (isDeletingProject) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [isDeletingProject]);
	  const handleConfirmDelete = useCallback(async () => {
	    if (!deleteTarget) return;
	    const target = deleteTarget;
    setIsDeletingProject(true);
    setDeleteError(null);
    try {
      const response = await api.deleteProject(target.name, true);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (HTTP ${response.status})`);
      }
      sidebarSharedProps.onProjectDelete?.(target.name);
      await refreshProjectsSilently();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setIsDeletingProject(false);
	    }
	  }, [deleteTarget, refreshProjectsSilently, sidebarSharedProps]);

	  const [deleteSessionTarget, setDeleteSessionTarget] = useState<DeleteSessionTarget | null>(null);
	  const [isDeletingSession, setIsDeletingSession] = useState(false);
	  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
	  const handleRequestDeleteSession = useCallback(
	    (project: Project, session: ProjectSession) => {
	      setDeleteSessionError(null);
	      setDeleteSessionTarget({ project, session });
	    },
	    [],
	  );
	  const handleCancelDeleteSession = useCallback(() => {
	    if (isDeletingSession) return;
	    setDeleteSessionTarget(null);
	    setDeleteSessionError(null);
	  }, [isDeletingSession]);
	  const handleConfirmDeleteSession = useCallback(async () => {
	    if (!deleteSessionTarget) return;

	    const { project, session } = deleteSessionTarget;
	    setIsDeletingSession(true);
	    setDeleteSessionError(null);

	    try {
	      const response = isBackgroundTaskSession(session)
	        ? await api.deleteSession(project.name, session.id, getSessionRequestParams(session))
	        : await api.deleteSession(project.name, session.id);

	      if (!response.ok) {
	        const body = (await response.json().catch(() => ({}))) as { error?: string };
	        throw new Error(body.error || `Failed (HTTP ${response.status})`);
	      }

	      sidebarSharedProps.onSessionDelete?.(session.id);
	      setUnreadSessionIds((previous) => {
	        if (!previous.has(session.id)) return previous;
	        const next = new Set(previous);
	        next.delete(session.id);
	        return next;
	      });
	      setSessionCustomTitle(session.id, null);
	      await refreshProjectsSilently();
	      setDeleteSessionTarget(null);
	    } catch (err) {
	      setDeleteSessionError(err instanceof Error ? err.message : 'Failed to delete conversation');
	    } finally {
	      setIsDeletingSession(false);
	    }
	  }, [deleteSessionTarget, refreshProjectsSilently, sidebarSharedProps]);

  const handleSelectProject = useCallback(
    (project: Project) => {
      handleProjectSelect(project);
      navigate(`/p/${encodeURIComponent(project.name)}`);
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [handleProjectSelect, isMobile, navigate, setSidebarOpen],
  );

  const handleSelectSession = useCallback(
    (project: Project, sessId: string, fallbackSession?: ProjectSession) => {
      setUnreadSessionIds((previous) => {
        if (!previous.has(sessId)) return previous;
        const next = new Set(previous);
        next.delete(sessId);
        return next;
      });
      if (project.name !== selectedProject?.name) {
        handleProjectSelect(project);
      }
      const target = (project.sessions ?? []).find((s) => s.id === sessId);
      if (target) {
        handleSessionSelect(fallbackSession ? { ...target, ...fallbackSession } : target);
      } else if (fallbackSession) {
        handleSessionSelect(fallbackSession);
      } else {
        navigate(`/session/${sessId}`);
      }
      setActiveTab('chat');
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [
      handleProjectSelect,
      handleSessionSelect,
      isMobile,
      navigate,
      selectedProject?.name,
      setActiveTab,
      setSidebarOpen,
    ],
  );

  const handleSelectTab = useCallback(
    (tab: AppTab) => {
      // `home` is retained only for old persisted state / links. The Agent
      // surface now owns both the welcome/new-session state and transcripts.
      if (tab === 'home') {
        setSelectedSession(null);
        const target = selectedProject
          ? `/p/${encodeURIComponent(selectedProject.name)}`
          : '/';
        if (window.location.pathname !== target) {
          navigate(target);
        }
        setActiveTab('chat');
        return;
      }
      setActiveTab(tab);
    },
    [navigate, selectedProject, setActiveTab, setSelectedSession],
  );

  const handleStartNewSession = useCallback(
    (project: Project | null) => {
      if (project) {
        handleNewSession(project);
        navigate(`/p/${encodeURIComponent(project.name)}`);
        setActiveTab('chat');
        if (isMobile) {
          setSidebarOpen(false);
        }
      } else if (selectedProject) {
        handleNewSession(selectedProject);
        setActiveTab('chat');
        if (isMobile) {
          setSidebarOpen(false);
        }
      } else {
        // No project context yet — land on /, MainContent's empty state
        // will prompt the user to create or pick a project.
        navigate('/');
      }
    },
    [handleNewSession, isMobile, navigate, selectedProject, setActiveTab, setSidebarOpen],
  );

  // Wrap the two session-lifecycle callbacks coming out of useSessionProtection
  // so they also reconcile the optimistic placeholder rows in the sidebar:
  //  · `session_created` → swap `new-session-*` in projects.sessions for the
  //    real id in-place (no flicker).
  //  · `complete` / `error` → drop any leftover `new-session-*` placeholder
  //    that was never replaced (agent never emitted session_created).
  const handleReplaceTemporarySession = useCallback(
    (realSessionId?: string | null) => {
      replaceTemporarySession(realSessionId);
      if (realSessionId) replaceOptimisticInProjects(realSessionId);
    },
    [replaceTemporarySession, replaceOptimisticInProjects],
  );

  const handleSessionInactive = useCallback(
    (sessionId?: string | null) => {
      markSessionAsInactive(sessionId);
      if (sessionId) dropOptimisticInProjects(sessionId);
    },
    [markSessionAsInactive, dropOptimisticInProjects],
  );

  const sidebar = (
    <SidebarV2
      projects={sidebarSharedProps.projects}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={activeTab}
      isLoading={isLoadingProjects}
      processingSessions={processingSessions}
      unreadSessionIds={unreadSessionIds}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
	      onStartNewSession={handleStartNewSession}
	      onCreateProject={handleOpenNewProject}
	      onRequestDeleteProject={handleRequestDeleteProject}
	      onRequestDeleteSession={handleRequestDeleteSession}
	      onShowSettings={onShowSettings}
	      onDeselectProject={handleDeselectProject}
	      onResetProjectSessionPreview={handleResetProjectSessionPreview}
	      onCollapse={onCollapseSidebar}
	      onLoadMoreSessions={loadMoreSessions}
	      loadingMoreProjectIds={loadingMoreProjectIds}
	    />
  );

  return (
    <div className="ui-v2 fixed inset-0 flex flex-col bg-white font-sans text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
      {!isMobile ? (
        desktopSidebarOpen ? sidebar : null
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-opacity duration-150 ease-out ${
            sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
          }`}
        >
          <button
            type="button"
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
          <div
            className={`relative h-full w-[min(92vw,26rem)] transform transition-transform duration-150 ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {sidebar}
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <MainAreaV2
          projects={sidebarSharedProps.projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={handleSelectTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={onMenuClick}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={handleSessionInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          onSessionActivityBump={bumpSessionActivity}
          processingSessions={processingSessions}
          onReplaceTemporarySession={handleReplaceTemporarySession}
          onNavigateToSession={(sid: string) => {
            setSelectedSession((prev) => prev?.id === sid ? prev : { id: sid } as ProjectSession);
            navigate(`/session/${sid}`);
          }}
          onStartNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onShowSettings={onShowSettings}
          onSelectProjectByName={(name: string) => {
            const target = sidebarSharedProps.projects.find((p) => p.name === name);
            if (target) {
              setSelectedProject(target);
              setSelectedSession(null);
              setActiveTab('dashboard');
              navigate(`/p/${encodeURIComponent(target.name)}`);
            }
          }}
          isSidebarCollapsed={!isMobile && !desktopSidebarOpen}
          onOpenSidebar={onOpenDesktopSidebar}
          externalMessageUpdate={externalMessageUpdate}
          misroutedFileFromUrl={misroutedFileFromUrl}
          onMisroutedFileUrlHandled={handleMisroutedFileUrlHandled}
        />
      </main>

      {sidebarSharedProps.showSettings
        ? ReactDOM.createPortal(
            <SettingsComponent
              isOpen={sidebarSharedProps.showSettings}
              onClose={onCloseSettings}
              projects={sidebarSharedProps.projects.map(normalizeProjectForSettings)}
              initialTab={sidebarSharedProps.settingsInitialTab || 'appearance'}
            />,
            document.body,
          )
        : null}

      {showNewProject
        ? ReactDOM.createPortal(
            <ProjectCreationWizard
              onClose={handleCloseNewProject}
              onProjectCreated={handleProjectCreated}
            />,
            document.body,
          )
        : null}

	      {deleteTarget
	        ? ReactDOM.createPortal(
	            <DeleteProjectDialog
              project={deleteTarget}
              isDeleting={isDeletingProject}
              error={deleteError}
              onCancel={handleCancelDelete}
              onConfirm={handleConfirmDelete}
            />,
	            document.body,
	          )
	        : null}

	      {deleteSessionTarget
	        ? ReactDOM.createPortal(
	            <DeleteSessionDialog
	              target={deleteSessionTarget}
	              isDeleting={isDeletingSession}
	              error={deleteSessionError}
	              onCancel={handleCancelDeleteSession}
	              onConfirm={handleConfirmDeleteSession}
	            />,
	            document.body,
	          )
	        : null}
	    </div>
	    </div>
	  );
	}

type DeleteProjectDialogProps = {
  project: Project;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

function DeleteProjectDialog({
  project,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: DeleteProjectDialogProps) {
  const sessionCount = project.sessions?.length ?? 0;
  const displayName = project.displayName || project.name;

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">Delete project?</h3>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              <span className="font-mono text-xs">{displayName}</span>
            </p>
          </div>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-sm text-foreground">
            This removes the project from PilotDeck and deletes its session metadata.
            {sessionCount > 0 ? (
              <>
                {' '}
                <span className="font-medium">
                  {sessionCount} session{sessionCount === 1 ? '' : 's'}
                </span>{' '}
                will also be removed.
              </>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            Files on disk are <span className="font-medium text-foreground">not</span> deleted —
            only PilotDeck&apos;s reference to them.
          </p>
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" strokeWidth={1.75} />}
            {isDeleting ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  );
}

type DeleteSessionDialogProps = {
  target: DeleteSessionTarget;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

function DeleteSessionDialog({
  target,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: DeleteSessionDialogProps) {
  const projectName = target.project.displayName || target.project.name;
  const sessionTitle = sessionDisplayTitle(target.session);

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">Delete conversation?</h3>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {sessionTitle}
            </p>
          </div>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-sm text-foreground">
            This removes the conversation from <span className="font-medium">{projectName}</span>.
          </p>
          
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" strokeWidth={1.75} />}
            {isDeleting ? 'Deleting…' : 'Delete conversation'}
          </button>
        </div>
      </div>
    </div>
  );
}
