import { useAuth } from '../auth/context/AuthContext';
import { SessionViewReadyContext, useSessionIndicators } from './useSessionIndicators';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import Settings from '../settings/Settings';
import CreateWorkspaceModal from '../onboarding/view/subcomponents/CreateWorkspaceModal';
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
import { useRejectExternalFileDropOutsideTargets } from '../../utils/externalFileDrop';
import { resolveMarkdownFileHref } from '../chat/utils/resolveMarkdownFileHref';
import type { SessionNavigationOptions } from '../main-content/types/types';
import { getSettingsPathFromTab } from '../settings/navigation';
import { ConnectionBanner } from '../ui/ConnectionBanner';
import SidebarV2 from './SidebarV2';
import MainAreaV2 from './MainAreaV2';
import {
  chooseDefaultProject,
  resolveHomeNewConversationProject,
} from './appShellSelection';
import {
  getDedicatedTabPath,
  SCHEDULED_TASKS_PATH,
  SETTINGS_PATH,
  SKILLS_PATH,
} from './appRoutes';

type TypedSettingsProps = {
  onClose: () => void;
  projects: SettingsProject[];
  section?: string;
};

type DeleteSessionTarget = {
  project: Project;
  session: ProjectSession;
};

const SettingsComponent = Settings as unknown as (props: TypedSettingsProps) => JSX.Element;

// V2 shell. Reuses the same data hooks as legacy AppContent so chat, discovery,
// auth, and project plumbing keep working unchanged — V2 just reorganizes the
// outer chrome (sidebar + breadcrumb header per prototype/shadcn.html).
export default function AppShellV2() {
  useRejectExternalFileDropOutsideTargets();
  const navigate = useNavigate();
  // Match the V2 URL shapes and hoist params up. A single wildcard route
  // owns this shell so state survives every URL transition.
  const matchProjectChat = useMatch('/p/:projectName/c/:sessionId');
  const matchProject = useMatch('/p/:projectName');
  const matchLegacySession = useMatch('/session/:sessionId');
  const matchScheduledTasks = useMatch(SCHEDULED_TASKS_PATH);
  const matchSkills = useMatch(SKILLS_PATH);
  const matchSettingsIndex = useMatch({ path: SETTINGS_PATH, end: true });
  const matchSettingsSection = useMatch(`${SETTINGS_PATH}/:section`);
  const isSettingsRoute = Boolean(matchSettingsIndex || matchSettingsSection);
  const settingsSection = matchSettingsSection?.params.section;
  const dedicatedTab = matchSkills
    ? 'skills' as const
    : matchScheduledTasks
      ? 'cron' as const
      : null;
  const isDedicatedRoute = dedicatedTab !== null || isSettingsRoute;
  const projectNameParam =
    matchProjectChat?.params.projectName ?? matchProject?.params.projectName ?? undefined;
  const sessionId =
    matchProjectChat?.params.sessionId ?? matchLegacySession?.params.sessionId ?? undefined;
  const { t } = useTranslation('common');

  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const { ws, sendMessage, latestMessage, isConnected, subscribe } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const { user } = useAuth();
  const [readySessionId, setReadySessionId] = useState<string | null>(null);

  const {
    activeSessions,
    processingSessions: localProcessingSessions,
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
    refreshProjectsSilently,
    addCreatedProject,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleDeselectProject,
    handleResetProjectSessionPreview,
    setSelectedProject,
    draftSessionProjectName,
    loadMoreSessions,
    loadingMoreProjectIds,
    bumpSessionActivity,
    replaceOptimisticInProjects,
    dropOptimisticInProjects,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    subscribe,
    isMobile,
    activeSessions,
  });
  const workspaceTab = activeTab === 'cron' || activeTab === 'skills' ? 'chat' : activeTab;
  const shellActiveTab = dedicatedTab ?? workspaceTab;
  const { processingSessions: remoteProcessingSessions, unreadSessionIds, markRead, acknowledge, selectSession: acknowledgeNavigation } = useSessionIndicators({
    scope: String(user?.id ?? 'local'),
    viewedSessionId: !isSettingsRoute && shellActiveTab === 'chat' && selectedSession?.id === readySessionId ? readySessionId : null,
    subscribe, sendMessage, isConnected,
  });
  // Composer callbacks cover the interval before the server sees a new send.
  const processingSessions = useMemo(() => new Set([...localProcessingSessions, ...remoteProcessingSessions]), [localProcessingSessions, remoteProcessingSessions]);
  useEffect(() => subscribe(message => {
    if (message?.type === 'session-activity' && !message.activity?.processing) markSessionAsNotProcessing(message.activity?.sessionId);
    if (message?.type === 'session-activity-snapshot' && Array.isArray(message.activities)) {
      const running = new Set(message.activities.filter((item: any) => item.processing).map((item: any) => item.sessionId));
      for (const id of localProcessingSessions) if (!running.has(id)) markSessionAsNotProcessing(id);
    }
  }), [subscribe, localProcessingSessions, markSessionAsNotProcessing]);



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

  // Default selection: use General as the canonical conversation context.
  // Explicit project/session URLs still own selection and are never overridden.
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
    const target = chooseDefaultProject(sidebarSharedProps.projects);
    if (!target) return;
    if (isDedicatedRoute) {
      setSelectedProject(target);
      didDefaultProjectRef.current = true;
      return;
    }
    handleProjectSelect(target);
    navigate(`/p/${encodeURIComponent(target.name)}`, { replace: true });
    didDefaultProjectRef.current = true;
  }, [
    isLoadingProjects,
    selectedProject,
    projectNameParam,
    sessionId,
    isDedicatedRoute,
    sidebarSharedProps.projects,
    handleProjectSelect,
    navigate,
    setSelectedProject,
  ]);

  useEffect(() => {
    window.refreshProjects = refreshProjectsSilently;
    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  const openSettingsPage = useCallback(
    (tab = 'appearance') => {
      navigate(getSettingsPathFromTab(tab));
    },
    [navigate],
  );

  useEffect(() => {
    window.openSettings = openSettingsPage;
    return () => {
      if (window.openSettings === openSettingsPage) {
        delete window.openSettings;
      }
    };
  }, [openSettingsPage]);

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

  const onShowSettings = useCallback(() => {
    navigate(SETTINGS_PATH);
  }, [navigate]);
  const onCloseSettings = useCallback(() => {
    const target = selectedSession
      ? `/session/${selectedSession.id}`
      : selectedProject
        ? `/p/${encodeURIComponent(selectedProject.name)}`
        : '/';
    navigate(target);
  }, [navigate, selectedProject, selectedSession]);
  const onMenuClick = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const onCollapseSidebar = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
    } else {
      setDesktopSidebarOpen(false);
    }
  }, [isMobile, setSidebarOpen]);
  const onOpenDesktopSidebar = useCallback(() => {
    setDesktopSidebarOpen(true);
  }, []);

  useEffect(() => {
    if (!isMobile && activeTab === 'files') {
      setDesktopSidebarOpen(true);
    }
  }, [activeTab, isMobile]);

  // Create-workspace dialog (same form as onboarding's last step). The
  // sidebar's Projects-section "+" opens this; row-level "+" is for new sessions.
  const [showNewProject, setShowNewProject] = useState(false);
  const handleOpenNewProject = useCallback(() => setShowNewProject(true), []);
  const handleCloseNewProject = useCallback(() => setShowNewProject(false), []);
  const handleProjectCreated = useCallback((project?: Record<string, unknown>) => {
    setShowNewProject(false);

    // Auto-jump into the new project's empty new-conversation screen so the
    // user doesn't accidentally keep chatting under the previously selected
    // project (typically "general") after closing the wizard. The wizard
    // hands back the freshly created project from POST /create-workspace
    // (and the clone SSE complete event), which is the same `{ name,
    // displayName, fullPath, path }` shape as the sidebar list entries.
    const projectName = typeof project?.name === 'string' ? project.name : '';
    if (!projectName) {
      void refreshProjectsSilently();
      return;
    }
    const newProject = project as Project;
    addCreatedProject(newProject);
    handleNewSession(newProject);
    navigate(`/p/${encodeURIComponent(projectName)}`);
    setActiveTab('chat');
  }, [addCreatedProject, handleNewSession, navigate, refreshProjectsSilently, setActiveTab]);

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
        throw new Error(body.error || t('uiText.httpFailed', { status: response.status }));
      }
      sidebarSharedProps.onProjectDelete?.(target.name);
      await refreshProjectsSilently();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('uiText.deleteProjectFailed'));
    } finally {
      setIsDeletingProject(false);
	    }
	  }, [deleteTarget, refreshProjectsSilently, sidebarSharedProps, t]);

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
	        throw new Error(body.error || t('uiText.httpFailed', { status: response.status }));
	      }

	      sidebarSharedProps.onSessionDelete?.(session.id);
	      markRead(session.id);
	      setSessionCustomTitle(session.id, null);
	      await refreshProjectsSilently();
	      setDeleteSessionTarget(null);
	    } catch (err) {
	      setDeleteSessionError(err instanceof Error ? err.message : t('uiText.deleteSessionFailed'));
	    } finally {
	      setIsDeletingSession(false);
	    }
	  }, [deleteSessionTarget, refreshProjectsSilently, sidebarSharedProps, t, markRead]);

  const handleSelectProject = useCallback(
    (project: Project) => {
      handleProjectSelect(project);
      navigate(`/p/${encodeURIComponent(project.name)}`);
    },
    [handleProjectSelect, navigate],
  );

  const handleSelectSession = useCallback(
    (
      project: Project,
      sessId: string,
      fallbackSession?: ProjectSession,
      options?: SessionNavigationOptions,
    ) => {
      acknowledgeNavigation(sessId);
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
      if (!options?.preserveActiveTab) {
        setActiveTab('chat');
      }
    },
    [handleProjectSelect, handleSessionSelect, navigate, selectedProject?.name, setActiveTab, acknowledgeNavigation],
  );

  const workspacePath = selectedSession
    ? `/session/${selectedSession.id}`
    : selectedProject
      ? `/p/${encodeURIComponent(selectedProject.name)}`
      : '/';

  const handleSelectTab = useCallback(
    (tab: AppTab) => {
      const dedicatedPath = getDedicatedTabPath(tab);
      if (dedicatedPath) {
        if (dedicatedTab !== tab) {
          navigate(dedicatedPath);
        }
        return;
      }
      // `home` is retained only for old persisted state / links. The Agent
      // surface now owns both the welcome/new-session state and transcripts.
      if (tab === 'home') {
        acknowledgeNavigation(null);
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
      if (isDedicatedRoute) {
        navigate(workspacePath);
      }
      setActiveTab(tab);
    },
    [
      dedicatedTab,
      isDedicatedRoute,
      navigate,
      selectedProject,
      setActiveTab,
      setSelectedSession,
      workspacePath,
      acknowledgeNavigation,
    ],
  );

  const handleStartNewSession = useCallback(
    (project: Project, options?: SessionNavigationOptions) => {
      didDefaultProjectRef.current = true;
      acknowledgeNavigation(null);
      handleNewSession(project);
      navigate(`/p/${encodeURIComponent(project.name)}`);
      setActiveTab(options?.preserveActiveTab ? 'files' : 'chat');
    },
    [handleNewSession, navigate, setActiveTab, acknowledgeNavigation],
  );

  const handleHomeNewConversation = useCallback(() => {
    const draftProject = resolveHomeNewConversationProject({
      selectedProject,
      selectedSession,
      projectNameParam,
      projects: sidebarSharedProps.projects,
    });
    if (!draftProject) return;
    handleStartNewSession(draftProject);
  }, [
    handleStartNewSession,
    projectNameParam,
    selectedProject,
    selectedSession,
    sidebarSharedProps.projects,
  ]);

  const handleSessionActivityBump = useCallback(
    (projectName: string, sessionId: string, optimisticTitle?: string, inputId?: string) => {
      return bumpSessionActivity(projectName, sessionId, optimisticTitle, inputId);
    },
    [bumpSessionActivity],
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
      activeTab={shellActiveTab}
      isLoading={isLoadingProjects}
      loadError={sidebarSharedProps.loadError}
      onRetryLoad={sidebarSharedProps.onRetryLoad}
      isMobile={isMobile}
      processingSessions={processingSessions}
      unreadSessionIds={unreadSessionIds}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onStartNewSession={handleStartNewSession}
      onStartHomeNewConversation={handleHomeNewConversation}
      onCreateProject={handleOpenNewProject}
      pendingDraftProjectName={draftSessionProjectName}
	      onRequestDeleteProject={handleRequestDeleteProject}
	      onRequestDeleteSession={handleRequestDeleteSession}
	      onSelectTab={handleSelectTab}
	      onShowSettings={onShowSettings}
	      onDeselectProject={handleDeselectProject}
	      onResetProjectSessionPreview={handleResetProjectSessionPreview}
	      onCollapse={onCollapseSidebar}
	      onLoadMoreSessions={loadMoreSessions}
	      loadingMoreProjectIds={loadingMoreProjectIds}
	    />
  );

  return (
    <SessionViewReadyContext.Provider value={setReadySessionId}>
    <div className="app-root ui-v2 fixed inset-0 flex flex-col font-sans text-neutral-900 dark:text-neutral-100">
      <ConnectionBanner />
      {isSettingsRoute ? (
        <SettingsComponent
          onClose={onCloseSettings}
          projects={sidebarSharedProps.projects.map(normalizeProjectForSettings)}
          section={settingsSection}
        />
      ) : null}
      <div
        className={`app-shell min-h-0 flex-1 ${
          !isMobile && desktopSidebarOpen ? '' : 'sidebar-hidden'
        }${isSettingsRoute ? ' hidden' : ''}`}
        aria-hidden={isSettingsRoute}
      >
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
            aria-label={t("uiText.closeSidebar")}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform transition-transform duration-150 ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {sidebar}
          </div>
        </div>
      )}

      <main
        onClickCapture={acknowledge}
        onKeyDownCapture={acknowledge}
        onInputCapture={acknowledge}
        onWheelCapture={acknowledge}
        onTouchMoveCapture={acknowledge}
        className="app-main flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950"
      >
        <MainAreaV2
          projects={sidebarSharedProps.projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={shellActiveTab}
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
          onSessionActivityBump={handleSessionActivityBump}
          processingSessions={processingSessions}
          unreadSessionIds={unreadSessionIds}
          onReplaceTemporarySession={handleReplaceTemporarySession}
          onNavigateToSession={(sid: string) => {
            setSelectedSession((prev) => prev?.id === sid ? prev : { id: sid } as ProjectSession);
            navigate(`/session/${sid}`);
          }}
          onStartNewSession={handleStartNewSession}
          onCreateProject={handleOpenNewProject}
          onSelectWorkspace={handleStartNewSession}
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
      </div>

      {showNewProject
        ? ReactDOM.createPortal(
            <CreateWorkspaceModal
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
    </SessionViewReadyContext.Provider>
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

  const { t } = useTranslation('common');
  return (
    <ConfirmDialog title={t('confirmDialog.deleteProjectTitle')} destructive busy={isDeleting} error={error}
      confirmLabel={t('confirmDialog.deleteProject')} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="mb-3 break-all font-medium text-foreground">{displayName}</p>
      <p>{t('confirmDialog.deleteProjectBody')}</p>
      {sessionCount > 0 && <p className="mt-2">{t('confirmDialog.deleteSessions', { count: sessionCount })}</p>}
      <p className="mt-3 text-xs">{t('confirmDialog.keepFiles')}</p>
    </ConfirmDialog>
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

  const { t } = useTranslation('common');
  return (
    <ConfirmDialog title={t('confirmDialog.deleteSessionTitle')} destructive busy={isDeleting} error={error}
      confirmLabel={t('confirmDialog.deleteSession')} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="mb-3 break-words font-medium text-foreground">{sessionTitle}</p>
      <p>{t('confirmDialog.deleteSessionBody', { project: projectName })}</p>
    </ConfirmDialog>
  );
}
