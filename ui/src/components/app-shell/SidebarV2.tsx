import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  MessageSquarePlus,
  PanelLeftClose,
  Pencil,
  Plus,
  GitBranch,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { useAppearanceProfile } from '../../contexts/AppearanceProfileContext';
import { isImeEnterEvent } from '../../utils/ime';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setProjectCustomName,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import pilotdeckLogoDark from '../../assets/pilotdeck-wordmark-dark.png';
import pilotdeckLogoLight from '../../assets/pilotdeck-wordmark-light.png';

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

type ProjectSortOrder = 'name' | 'date';

// The Settings dialog persists `projectSortOrder` into the same
// `pilotdeck-settings` localStorage blob the chat surface uses. Up to
// this point nothing on the sidebar consumed it, so the dropdown
// changed nothing. We read it here and re-render whenever the Settings
// tab broadcasts a `pilotdeck-settings-changed` event.
const readProjectSortOrder = (): ProjectSortOrder => {
  if (typeof window === 'undefined') return 'name';
  const raw = window.localStorage.getItem('pilotdeck-settings');
  if (!raw) return 'name';
  try {
    const parsed = JSON.parse(raw) as { projectSortOrder?: unknown };
    return parsed.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const useProjectSortOrder = (): ProjectSortOrder => {
  const [order, setOrder] = useState<ProjectSortOrder>(() => readProjectSortOrder());
  useEffect(() => {
    const refresh = () => setOrder(readProjectSortOrder());
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'pilotdeck-settings') refresh();
    };
    window.addEventListener('pilotdeck-settings-changed', refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('pilotdeck-settings-changed', refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return order;
};

// "Most recent activity" for a project = the project summary timestamp when
// available, or the newest timestamp across previewed sessions. The summary
// matters because the sidebar only keeps a capped session preview.
const projectLastActivity = (project: Project): number => {
  let latest = Math.max(
    asTimestamp(project.lastActivity),
    asTimestamp(project.updated_at),
    asTimestamp(project.createdAt),
    asTimestamp(project.created_at),
  );
  const buckets: ProjectSession[][] = [
    Array.isArray(project.sessions) ? project.sessions : [],
  ];
  for (const list of buckets) {
    for (const session of list) {
      const ts = Math.max(
        asTimestamp(session.lastActivity),
        asTimestamp(session.updated_at),
        asTimestamp(session.createdAt),
        asTimestamp(session.created_at),
      );
      if (ts > latest) latest = ts;
    }
  }
  return latest;
};

type FlatSession = {
  session: ProjectSession;
  sessionId: string;
  lastActivity: number;
};

type SessionTreeNode = {
  flat: FlatSession;
  children: SessionTreeNode[];
};

const isForkChildSession = (session: ProjectSession, knownSessionIds: Set<string>): boolean =>
  Boolean(
    session.parentSessionId &&
    session.sessionKind !== 'background_task' &&
    knownSessionIds.has(session.parentSessionId),
  );

const buildSessionTree = (flatSessions: FlatSession[]): SessionTreeNode[] => {
  const knownSessionIds = new Set(flatSessions.map((item) => item.sessionId));
  const childrenByParent = new Map<string, FlatSession[]>();
  const roots: FlatSession[] = [];

  for (const item of flatSessions) {
    if (isForkChildSession(item.session, knownSessionIds)) {
      const parentId = item.session.parentSessionId as string;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(item);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(item);
    }
  }

  const toNode = (flat: FlatSession): SessionTreeNode => ({
    flat,
    children: (childrenByParent.get(flat.sessionId) ?? [])
      .sort((left, right) => right.lastActivity - left.lastActivity)
      .map(toNode),
  });

  return roots
    .sort((left, right) => right.lastActivity - left.lastActivity)
    .map(toNode);
};

const collectSessionsForProject = (project: Project): FlatSession[] => {
  const sessions = Array.isArray(project.sessions) ? project.sessions : [];
  return sessions
    .map((session) => ({
      session,
      sessionId: session.id,
      lastActivity: Math.max(
        asTimestamp(session.lastActivity),
        asTimestamp(session.updated_at),
        asTimestamp(session.createdAt),
        asTimestamp(session.created_at),
      ),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
};

const formatRelative = (ts: number, t: TFunction): string => {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('sidebar:time.justNow', { defaultValue: 'just now' });
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    if (minutes === 1) return t('sidebar:time.oneMinuteAgo', { defaultValue: '1 min ago' });
    return t('sidebar:time.minutesAgo', { count: minutes, defaultValue: `${minutes} mins ago` });
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours === 1) return t('sidebar:time.oneHourAgo', { defaultValue: '1 hour ago' });
    return t('sidebar:time.hoursAgo', { count: hours, defaultValue: `${hours} hours ago` });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return t('sidebar:time.oneDayAgo', { defaultValue: '1 day ago' });
  return t('sidebar:time.daysAgo', { count: days, defaultValue: `${days} days ago` });
};

type SessionIndicatorStatus = 'processing' | 'unread' | 'idle';

const SPINNER_DOTS = Array.from({ length: 8 }, (_, index) => index);

function SessionStatusIndicator({
  status,
  label,
}: {
  status: SessionIndicatorStatus;
  label: string;
}) {
  if (status === 'processing') {
    return (
      <span
        aria-label={label}
        title={label}
        className="relative block h-3 w-3 animate-spin"
      >
        {SPINNER_DOTS.map((dot) => (
          <span
            key={dot}
            className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full bg-neutral-500 dark:bg-neutral-300"
            style={{
              transform: `translate(-50%, -50%) rotate(${dot * 45}deg) translateY(-4px)`,
              opacity: 0.35 + dot * 0.08,
            }}
          />
        ))}
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        'block h-1.5 w-1.5 rounded-full',
        status === 'unread'
          ? 'bg-blue-500 dark:bg-blue-400'
          : 'bg-neutral-300 dark:bg-neutral-600',
      )}
    />
  );
}

export type SidebarV2Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  onSelectProject: (project: Project) => void;
  onSelectSession: (project: Project, sessionId: string) => void;
  onStartNewSession: (project: Project | null) => void;
  onCreateProject: () => void;
  onRequestDeleteProject: (project: Project) => void;
  onRequestDeleteSession: (project: Project, session: ProjectSession) => void;
  onShowSettings: () => void;
  onDeselectProject?: () => void;
  onResetProjectSessionPreview?: (projectName: string) => void;
  onCollapse?: () => void;
  onLoadMoreSessions?: (projectName: string) => void;
  loadingMoreProjectIds?: Set<string>;
};

type SidebarContextMenu =
  | {
      kind: 'project';
      project: Project;
      x: number;
      y: number;
    }
  | {
      kind: 'session';
      project: Project;
      session: ProjectSession;
      x: number;
      y: number;
    };

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 88;
const CONTEXT_MENU_MARGIN = 8;

const contextMenuPosition = (event: MouseEvent) => {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientY, maxY)),
  };
};

export default function SidebarV2({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  isLoading,
  processingSessions,
  unreadSessionIds,
  onSelectProject,
  onSelectSession,
  onStartNewSession,
  onCreateProject,
  onRequestDeleteProject,
  onRequestDeleteSession,
  onShowSettings,
  onDeselectProject,
  onResetProjectSessionPreview,
  onCollapse,
  onLoadMoreSessions,
  loadingMoreProjectIds,
}: SidebarV2Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeProfile } = useAppearanceProfile();
  useCustomNamesVersion();
  const safeProjects = Array.isArray(projects) ? projects : [];

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const [collapsedSessionProjects, setCollapsedSessionProjects] = useState<Set<string>>(new Set());
  const [draftSessionProjectName, setDraftSessionProjectName] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Segmented toggle between the Projects list and the General workspace.
  // Persisted across reloads so the user's preferred view sticks. Switching
  // is purely a visibility change — we don't reroute or alter selection so
  // the user can peek without losing their place in the active chat.
  const SIDEBAR_SECTION_STORAGE_KEY = 'sidebar-v2-active-section';
  type SidebarSection = 'projects' | 'general';
  const [activeSection, setActiveSection] = useState<SidebarSection>(() => {
    if (typeof window === 'undefined') return 'projects';
    const stored = window.localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY);
    return stored === 'general' ? 'general' : 'projects';
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SECTION_STORAGE_KEY, activeSection);
    } catch {
      // localStorage unavailable — fall back to in-memory state silently.
    }
  }, [activeSection]);

  // Resizable sidebar width — clamped to a sensible range and persisted across
  // reloads. Drag-handle on the right edge mutates this on the fly.
  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_MAX_WIDTH = 480;
  const SIDEBAR_DEFAULT_WIDTH = 248;
  const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-v2-width';
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  });
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizing(true);

    const onMove = (e: globalThis.MouseEvent) => {
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)),
      );
      setSidebarWidth(next);
    };

    const onUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist the latest width by reading back from state — wrapped in a
      // microtask so the latest setState has settled before we serialize.
      queueMicrotask(() => {
        try {
          // Read directly off the DOM element rather than chasing closure state
          // to avoid serializing a stale value.
          const aside = document.querySelector<HTMLElement>('aside[data-sidebar-v2-root]');
          const width = aside?.offsetWidth;
          if (width && Number.isFinite(width)) {
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
          }
        } catch {
          // localStorage may be unavailable in some environments — ignore.
        }
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  useEffect(() => {
    if ((renamingProject || renamingSession) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingProject, renamingSession]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const closeContextMenu = () => setContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!selectedProject?.name) return;
    setExpandedGroups((previous) => {
      if (previous.has(selectedProject.name)) return previous;
      const next = new Set(previous);
      next.add(selectedProject.name);
      return next;
    });
  }, [selectedProject?.name]);

  useEffect(() => {
    if (!draftSessionProjectName) return;
    if (!selectedProject || selectedSession || selectedProject.name !== draftSessionProjectName) {
      setDraftSessionProjectName(null);
    }
  }, [draftSessionProjectName, selectedProject, selectedSession]);

  const generalProject =
    safeProjects.find((project) => project.name === 'general' || project.displayName === 'general') ?? null;

  // Auto-flip the section toggle to match the active project when it changes
  // externally (e.g. /switch-project, deep-linking, default selection on
  // first load). Without this, navigating to a project on one section while
  // the sidebar is parked on the other leaves the new project invisible.
  // We only react to changes — if the user manually clicks the toggle we
  // never fight them mid-session.
  const previousSelectedProjectNameRef = useRef<string | null>(null);
  useEffect(() => {
    const currentName = selectedProject?.name ?? null;
    const previousName = previousSelectedProjectNameRef.current;
    previousSelectedProjectNameRef.current = currentName;
    if (!currentName) return;
    if (currentName === previousName) return;

    const nextSection: SidebarSection =
      generalProject && currentName === generalProject.name ? 'general' : 'projects';
    setActiveSection((current) => (current === nextSection ? current : nextSection));
  }, [selectedProject?.name, generalProject]);

  const projectSortOrder = useProjectSortOrder();
  const otherProjects = useMemo(() => {
    const remaining = safeProjects.filter((project) => project !== generalProject);
    if (projectSortOrder === 'date') {
      // Most recent first. Tie-break on display name so the order is stable
      // when two projects have no recorded activity (both 0).
      return [...remaining].sort((a, b) => {
        const diff = projectLastActivity(b) - projectLastActivity(a);
        if (diff !== 0) return diff;
        return projectDisplayName(a).localeCompare(projectDisplayName(b));
      });
    }
    return [...remaining].sort((a, b) =>
      projectDisplayName(a).localeCompare(projectDisplayName(b), undefined, { sensitivity: 'base' }),
    );
  }, [safeProjects, generalProject, projectSortOrder]);

  const allProjectGroupsExpanded = otherProjects.length > 0 && otherProjects.every((project) =>
    expandedGroups.has(project.name),
  );

  const navToProject = useCallback(
    (name: string) => navigate(`/p/${encodeURIComponent(name)}`),
    [navigate],
  );

  const handleGeneralSectionClick = useCallback(() => {
    setActiveSection('general');
    if (!generalProject) return;

    onResetProjectSessionPreview?.(generalProject.name);
    if (selectedProject?.name !== generalProject.name) {
      onSelectProject(generalProject);
    }
    navToProject(generalProject.name);
  }, [generalProject, navToProject, onResetProjectSessionPreview, onSelectProject, selectedProject?.name]);

  const handleProjectsSectionClick = useCallback(() => {
    if (generalProject) {
      onResetProjectSessionPreview?.(generalProject.name);
    }
    setActiveSection('projects');
  }, [generalProject, onResetProjectSessionPreview]);

  const toggleProjectExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(project.name)) {
        next.delete(project.name);
      } else {
        next.add(project.name);
      }
      return next;
    });
  }, []);

  const toggleAllProjectGroups = useCallback(() => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (allProjectGroupsExpanded) {
        otherProjects.forEach((project) => next.delete(project.name));
      } else {
        otherProjects.forEach((project) => next.add(project.name));
      }
      return next;
    });
  }, [allProjectGroupsExpanded, otherProjects]);

  const ensureExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      if (previous.has(project.name)) return previous;
      const next = new Set(previous);
      next.add(project.name);
      return next;
    });
  }, []);

  const handleProjectClick = useCallback(
    (project: Project) => {
      if (renamingProject === project.name) return;
      toggleProjectExpanded(project);
    },
    [renamingProject, toggleProjectExpanded],
  );

  const handleSessionClick = useCallback(
    (project: Project, sessionId: string) => {
      if (renamingSession === sessionId) return;
      setDraftSessionProjectName(null);
      onSelectSession(project, sessionId);
      ensureExpanded(project);
    },
    [ensureExpanded, onSelectSession, renamingSession],
  );

  const handleNewSession = useCallback(
    (event: MouseEvent, project: Project) => {
      event.stopPropagation();
      setDraftSessionProjectName(project.name);
      ensureExpanded(project);
      onStartNewSession(project);
      navToProject(project.name);
    },
    [ensureExpanded, navToProject, onStartNewSession],
  );

  const openProjectContextMenu = useCallback(
    (event: MouseEvent, project: Project, isGeneral: boolean) => {
      if (isGeneral || renamingProject === project.name) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'project',
        project,
        x: position.x,
        y: position.y,
      });
    },
    [renamingProject],
  );

  const openSessionContextMenu = useCallback(
    (event: MouseEvent, project: Project, session: ProjectSession) => {
      if (renamingSession === session.id) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'session',
        project,
        session,
        x: position.x,
        y: position.y,
      });
    },
    [renamingSession],
  );

  const beginRenameProject = useCallback((project: Project) => {
    setContextMenu(null);
    setRenamingSession(null);
    setRenamingProject(project.name);
    setRenameDraft(projectDisplayName(project));
  }, []);

  const beginRenameSession = useCallback((session: ProjectSession) => {
    setContextMenu(null);
    setRenamingProject(null);
    setRenamingSession(session.id);
    setRenameDraft(sessionDisplayTitle(session));
  }, []);

  const requestDeleteProject = useCallback(
    (project: Project) => {
      setContextMenu(null);
      onRequestDeleteProject(project);
    },
    [onRequestDeleteProject],
  );

  const requestDeleteSession = useCallback(
    (project: Project, session: ProjectSession) => {
      setContextMenu(null);
      onRequestDeleteSession(project, session);
    },
    [onRequestDeleteSession],
  );

  const handleContextRename = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      beginRenameProject(contextMenu.project);
    } else {
      beginRenameSession(contextMenu.session);
    }
  }, [beginRenameProject, beginRenameSession, contextMenu]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      requestDeleteProject(contextMenu.project);
    } else {
      requestDeleteSession(contextMenu.project, contextMenu.session);
    }
  }, [contextMenu, requestDeleteProject, requestDeleteSession]);

  const commitProjectRename = useCallback(() => {
    if (!renamingProject) return;
    setProjectCustomName(renamingProject, renameDraft);
    setRenamingProject(null);
    setRenameDraft('');
  }, [renamingProject, renameDraft]);

  const commitSessionRename = useCallback(() => {
    if (!renamingSession) return;
    setSessionCustomTitle(renamingSession, renameDraft);
    setRenamingSession(null);
    setRenameDraft('');
  }, [renamingSession, renameDraft]);

  const cancelRename = useCallback(() => {
    setRenamingProject(null);
    setRenamingSession(null);
    setRenameDraft('');
  }, []);

  const handleRenameKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, kind: 'project' | 'session') => {
      if (event.key === 'Enter') {
        if (isImeEnterEvent(event)) {
          return;
        }
        event.preventDefault();
        if (kind === 'project') commitProjectRename();
        else commitSessionRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitProjectRename, commitSessionRename],
  );

  const renderSessionRows = (
    project: Project,
    options: { flat?: boolean } = {},
  ) => {
    const COLLAPSED_SESSION_LIMIT = 5;
    const allSessions = collectSessionsForProject(project).slice(0, 500);
    const isCollapsed = collapsedSessionProjects.has(project.name);
    const sessions = isCollapsed ? allSessions.slice(0, COLLAPSED_SESSION_LIMIT) : allSessions;
    const hiddenLoadedCount = isCollapsed ? Math.max(0, allSessions.length - COLLAPSED_SESSION_LIMIT) : 0;
    // If `useProjectsState.bumpSessionActivity` has prepended an optimistic
    // `new-session-*` placeholder for this project, suppress the legacy
    // "+ New Session — not saved yet" draft button so we don't show two
    // stacked rows for the same in-flight session.
    const hasOptimisticSession = allSessions.some(({ session }) =>
      typeof session.id === 'string' && session.id.startsWith('new-session-'),
    );
    const showDraftSession =
      draftSessionProjectName === project.name &&
      selectedProject?.name === project.name &&
      activeTab === 'chat' &&
      !selectedSession &&
      !hasOptimisticSession;
    const hasMoreSessions = Boolean(project.sessionMeta?.hasMore);
    const isLoadingMore = Boolean(loadingMoreProjectIds?.has(project.name));
    const totalSessions =
      typeof project.sessionMeta?.total === 'number' ? project.sessionMeta.total : null;
    const remaining =
      totalSessions !== null ? Math.max(0, totalSessions - allSessions.length) : null;

    // `flat` mode is used by the General tab where sessions are rendered as a
    // top-level list (no folder ancestor), so the usual ml-6 indent would
    // leave a weird empty gutter on the left.
    const containerClass = options.flat ? 'space-y-0.5' : 'ml-6 space-y-0.5';
    const sessionTree = buildSessionTree(sessions);
    const sessionTitleById = new Map(
      allSessions.map(({ sessionId, session }) => [sessionId, sessionDisplayTitle(session)]),
    );

    const renderSessionTreeNode = (
      node: SessionTreeNode,
      depth: number,
      isForkChild: boolean,
    ): ReactNode => {
      const { session, sessionId, lastActivity } = node.flat;
      const isSessionActive =
        selectedProject?.name === project.name &&
        selectedSession?.id === sessionId &&
        activeTab === 'chat';
      const isSessionRenaming = renamingSession === sessionId;
      const isOptimisticRow =
        typeof sessionId === 'string' && sessionId.startsWith('new-session-');
      const indicatorStatus: SessionIndicatorStatus = isOptimisticRow
        ? 'processing'
        : processingSessions?.has(sessionId)
          ? 'processing'
          : unreadSessionIds?.has(sessionId)
            ? 'unread'
            : 'idle';
      const indicatorLabel =
        indicatorStatus === 'processing'
          ? t('sidebar:sessions.processing', { defaultValue: 'Agent is running' })
          : indicatorStatus === 'unread'
            ? t('sidebar:sessions.unread', { defaultValue: 'Unread messages' })
            : t('sidebar:sessions.idle', { defaultValue: 'No unread messages' });
      const parentTitle = session.parentSessionId
        ? sessionTitleById.get(session.parentSessionId)
        : undefined;

      return (
        <div key={sessionId} className={depth > 0 ? 'ml-4 border-l border-neutral-200 pl-2 dark:border-neutral-800' : undefined}>
          <div
            onContextMenu={(event) =>
              isOptimisticRow ? undefined : openSessionContextMenu(event, project, session)
            }
            className={cn(
              'group/session relative w-full rounded-md transition-colors',
              isSessionActive
                ? 'bg-neutral-200/70 dark:bg-neutral-800'
                : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            {isSessionRenaming ? (
              <div className="flex items-center px-2 py-1">
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitSessionRename}
                  onKeyDown={(event) => handleRenameKey(event, 'session')}
                  onClick={(event) => event.stopPropagation()}
                  placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                  className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={
                  isOptimisticRow
                    ? undefined
                    : () => handleSessionClick(project, sessionId)
                }
                disabled={isOptimisticRow}
                className={cn(
                  'flex w-full items-start gap-2 px-2 py-1 text-left',
                  isOptimisticRow && 'cursor-default',
                )}
              >
                <span className="flex h-[18px] w-3 shrink-0 items-center justify-center pt-[3px]">
                  <SessionStatusIndicator
                    status={indicatorStatus}
                    label={indicatorLabel}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'flex min-w-0 items-center gap-1 truncate text-[12.5px] text-neutral-900 dark:text-neutral-100',
                      isOptimisticRow && 'italic text-neutral-600 dark:text-neutral-300',
                    )}
                  >
                    {isForkChild ? (
                      <GitBranch className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={2} />
                    ) : null}
                    <span className="truncate">{sessionDisplayTitle(session)}</span>
                  </div>
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {isOptimisticRow
                      ? t('sidebar:sessions.sending', { defaultValue: 'Sending…' })
                      : isForkChild
                        ? t('sidebar:sessions.forkedFrom', {
                            parent: parentTitle || session.parentSessionId || '',
                            defaultValue: `forked from ${parentTitle || session.parentSessionId || 'parent'}`,
                          })
                        : formatRelative(lastActivity, t)}
                  </div>
                </div>
              </button>
            )}
          </div>
          {node.children.length > 0 ? (
            <div className="mt-0.5 space-y-0.5">
              {node.children.map((child) => renderSessionTreeNode(child, depth + 1, true))}
            </div>
          ) : null}
        </div>
      );
    };

    return (
      <div className={containerClass}>
        {showDraftSession ? (
          <button
            type="button"
            onClick={(event) => handleNewSession(event, project)}
            className="block w-full rounded-md bg-neutral-200/70 px-2 py-1 text-left text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <div className="truncate text-[12.5px]">
              {t('sidebar:sessions.newSession', { defaultValue: 'New Session' })}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('sidebar:sessions.unsaved', { defaultValue: 'Not saved yet' })}
            </div>
          </button>
        ) : null}

        {sessionTree.length > 0 ? (
          sessionTree.map((node) => renderSessionTreeNode(node, 0, false))
        ) : (
          <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('sidebar:sessions.noSessions', { defaultValue: 'No sessions yet' })}
          </div>
        )}

        {((isCollapsed && hiddenLoadedCount > 0) || (!isCollapsed && hasMoreSessions && onLoadMoreSessions)) ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (isLoadingMore) return;
              if (isCollapsed) {
                setCollapsedSessionProjects((prev) => {
                  const next = new Set(prev);
                  next.delete(project.name);
                  return next;
                });
              } else if (onLoadMoreSessions) {
                onLoadMoreSessions(project.name);
              }
            }}
            disabled={isLoadingMore}
            className={cn(
              'block w-full rounded-md px-2 py-1 text-left text-[11px] transition-colors',
              isLoadingMore
                ? 'text-neutral-400 dark:text-neutral-500'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
            )}
          >
            {isLoadingMore
              ? t('sidebar:sessions.loadingMore', { defaultValue: 'Loading more…' })
              : (() => {
                  const totalMore = hiddenLoadedCount + (remaining !== null && remaining > 0 ? remaining : 0);
                  return totalMore > 0
                    ? t('sidebar:sessions.showMoreCount', {
                        count: totalMore,
                        defaultValue: `Show more (${totalMore})`,
                      })
                    : t('sidebar:sessions.showMore', { defaultValue: 'Show more sessions' });
                })()}
          </button>
        ) : null}

        {!isCollapsed && allSessions.length > COLLAPSED_SESSION_LIMIT ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setCollapsedSessionProjects((prev) => {
                const next = new Set(prev);
                next.add(project.name);
                return next;
              });
            }}
            className="block w-full rounded-md px-2 py-1 text-left text-[11px] transition-colors text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {t('sidebar:sessions.showLess', { defaultValue: 'Show less' })}
          </button>
        ) : null}
      </div>
    );
  };

  const renderProjectGroup = (project: Project, options: { isGeneral?: boolean } = {}) => {
    const isGeneral = Boolean(options.isGeneral);
    const isSelected = project.name === selectedProject?.name;
    const isExpanded = expandedGroups.has(project.name);
    const isRenaming = renamingProject === project.name;
    const label = isGeneral
      ? t('sidebar:general.name', { defaultValue: 'General' })
      : projectDisplayName(project);

    return (
      <div key={project.name} className="space-y-0.5">
        <div
          onContextMenu={(event) => openProjectContextMenu(event, project, isGeneral)}
          className={cn(
            'group/project flex h-8 w-full items-center rounded-lg pr-1 text-[13px] transition-colors',
            isSelected
              ? 'bg-neutral-200/70 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
          )}
        >
          {isRenaming && !isGeneral ? (
            <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1">
              <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={commitProjectRename}
                onKeyDown={(event) => handleRenameKey(event, 'project')}
                onClick={(event) => event.stopPropagation()}
                placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleProjectClick(project)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-1.5 pr-1 text-left"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400',
                  isExpanded && 'rotate-90',
                )}
                strokeWidth={1.75}
              />
              <Folder
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  isSelected
                    ? 'text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400',
                )}
                strokeWidth={1.75}
              />
              <span className="flex-1 truncate">{label}</span>
            </button>
          )}

          {!isRenaming ? (
            <div
              className={cn(
                'ml-1 flex shrink-0 items-center gap-0.5 transition-opacity',
                '[@media(hover:none)]:opacity-100',
                isSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/project:opacity-100 focus-within:opacity-100',
              )}
            >
              <button
                type="button"
                onClick={(event) => handleNewSession(event, project)}
                aria-label={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                title={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-md',
                  'text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900',
                  'dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100',
                )}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </div>

        {isExpanded ? renderSessionRows(project) : null}
      </div>
    );
  };

  return (
    <aside
      data-sidebar-v2-root
      style={{ width: `${sidebarWidth}px` }}
      className={cn(
        // On mobile the parent wraps this aside in an overlay constrained
        // to 85vw, so force the inline width style off with !w-full there.
        'relative flex h-full shrink-0 flex-col max-md:!w-full',
        'bg-neutral-50 text-neutral-900',
        'dark:bg-neutral-900 dark:text-neutral-100',
        'border-r border-neutral-200 dark:border-neutral-800',
      )}
    >
      <div className="flex h-16 items-center justify-between pl-2 pr-4">
        <div className="flex min-w-0 shrink items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (onDeselectProject) {
                onDeselectProject();
              } else {
                navigate('/');
              }
            }}
            aria-label="PilotDeck"
            title={activeProfile.brandName || 'PilotDeck'}
            className="flex min-w-0 shrink items-center gap-2 rounded-md p-1 transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:focus-visible:ring-neutral-700"
          >
            <img
              src={activeProfile.logoLight || pilotdeckLogoLight}
              alt={activeProfile.brandName || 'PilotDeck'}
              onError={(event) => {
                event.currentTarget.src = pilotdeckLogoLight;
              }}
              className="h-7 w-auto max-w-[150px] select-none object-contain dark:hidden"
              draggable={false}
            />
            <img
              src={activeProfile.logoDark || pilotdeckLogoDark}
              alt={activeProfile.brandName || 'PilotDeck'}
              onError={(event) => {
                event.currentTarget.src = pilotdeckLogoDark;
              }}
              className="hidden h-7 w-auto max-w-[150px] select-none object-contain dark:block"
              draggable={false}
            />
          </button>
        </div>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('sidebar:tooltips.hideSidebar', { defaultValue: 'Hide sidebar' }) as string}
            title={t('sidebar:tooltips.hideSidebar', { defaultValue: 'Hide sidebar' }) as string}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      {/* Section toggle: a thin pill control sitting just above the scroll
          area, so it doesn't move while the list scrolls. Mirrors the look of
          familiar two-tab segmented controls (e.g. iOS, ProseMirror). */}
      <div className="px-3 pt-3 pb-1">
        <div
          role="tablist"
          aria-label={t('sidebar:sectionToggle.label', { defaultValue: 'Sidebar section' }) as string}
          className="flex w-full rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-900"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeSection === 'projects'}
            onClick={handleProjectsSectionClick}
            className={cn(
              'flex-1 rounded text-[12px] font-medium transition-colors',
              'h-7 leading-none',
              activeSection === 'projects'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200',
            )}
          >
            {t('sidebar:projects.title', { defaultValue: 'Projects' })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSection === 'general'}
            onClick={handleGeneralSectionClick}
            className={cn(
              'flex-1 rounded text-[12px] font-medium transition-colors',
              'h-7 leading-none',
              activeSection === 'general'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200',
            )}
          >
            {t('sidebar:general.title', { defaultValue: 'General' })}
          </button>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && safeProjects.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">
            {t('sidebar:sessions.loading', { defaultValue: 'Loading...' })}
          </div>
        ) : activeSection === 'projects' ? (
          <section className="pt-2">
            <div className="flex items-center px-3 pb-1">
              <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
                {t('sidebar:projects.title', { defaultValue: 'Projects' })}
              </span>
              <button
                type="button"
                onClick={toggleAllProjectGroups}
                disabled={otherProjects.length === 0}
                aria-label={
                  allProjectGroupsExpanded
                    ? t('sidebar:projects.collapseAll', { defaultValue: 'Collapse all projects' }) as string
                    : t('sidebar:projects.expandAll', { defaultValue: 'Expand all projects' }) as string
                }
                title={
                  allProjectGroupsExpanded
                    ? t('sidebar:projects.collapseAll', { defaultValue: 'Collapse all projects' }) as string
                    : t('sidebar:projects.expandAll', { defaultValue: 'Expand all projects' }) as string
                }
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                {allProjectGroupsExpanded ? (
                  <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} />
                ) : (
                  <ChevronsUpDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
              </button>
              <button
                type="button"
                onClick={onCreateProject}
                aria-label={t('sidebar:projects.newProject', { defaultValue: 'New Project' }) as string}
                title={t('sidebar:projects.newProject', { defaultValue: 'New Project' }) as string}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>

            {otherProjects.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('sidebar:projects.noProjects', { defaultValue: 'No projects found' })}
              </div>
            ) : (
              <div className="space-y-0.5">
                {otherProjects.map((project) => renderProjectGroup(project))}
              </div>
            )}
          </section>
        ) : (
          <section className="pt-2">
            {generalProject ? (
              <>
                <div className="flex items-center px-3 pb-1">
                  <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
                    {t('sidebar:general.title', { defaultValue: 'General' })}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => handleNewSession(event, generalProject)}
                    aria-label={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                    title={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
                <div className="px-1">
                  {renderSessionRows(generalProject, { flat: true })}
                </div>
              </>
            ) : (
              <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('sidebar:general.missing', {
                  defaultValue: 'No general workspace found',
                })}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={onShowSettings}
          aria-label={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          title={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          className="flex h-9 w-full items-center justify-start gap-2 rounded-lg px-6 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
          <span>{t('sidebar:actions.settings', { defaultValue: 'Settings' })}</span>
        </button>
      </div>

      {contextMenu ? (
        <div
          role="menu"
          aria-label={t('sidebar:contextMenu.label', { defaultValue: 'Context menu' }) as string}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg',
            'dark:border-neutral-700 dark:bg-neutral-900',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleContextRename}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
              'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <span>{t('sidebar:actions.rename', { defaultValue: 'Rename' })}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleContextDelete}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
              'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40',
            )}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>{t('sidebar:actions.delete', { defaultValue: 'Delete' })}</span>
          </button>
        </div>
      ) : null}

      {/* Drag handle for resizing the sidebar. Sits flush against the right
          border, 4px wide; expands hit area on hover and shows a faint accent
          while dragging. Hidden on mobile (the overlay sidebar isn't resizable). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar:tooltips.resize', { defaultValue: 'Resize sidebar' }) as string}
        title={t('sidebar:tooltips.resize', { defaultValue: 'Drag to resize' }) as string}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          try {
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
          } catch {
            // ignore
          }
        }}
        className={cn(
          'absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize select-none md:block',
          'transition-colors duration-150',
          isResizing
            ? 'bg-blue-500/60'
            : 'hover:bg-neutral-300/70 dark:hover:bg-neutral-700/70',
        )}
      />

      {/* While dragging, paint a fullscreen overlay so the cursor stays
          consistent and we don't accidentally select text in the main pane. */}
      {isResizing ? (
        <div
          className="fixed inset-0 z-[60] cursor-col-resize"
          style={{ userSelect: 'none' }}
        />
      ) : null}
    </aside>
  );
}
