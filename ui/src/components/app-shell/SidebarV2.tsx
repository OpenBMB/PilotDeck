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
  Folder,
  MessageSquarePlus,
  Pencil,
  GitBranch,
  Trash2,
} from 'lucide-react';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { isImeEnterEvent } from '../../utils/ime';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setProjectCustomName,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import { compareProjectsBySidebarOrder } from './appShellSelection';

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
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

type CompactRecentItem =
  | { kind: 'project'; project: Project; lastActivity: number }
  | { kind: 'session'; project: Project; flat: FlatSession; lastActivity: number };

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

type SessionIndicatorStatus = 'processing' | 'unread' | 'idle';

export type SidebarV2Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  isMobile?: boolean;
  processingSessions?: Set<string>;
  unreadSessionIds?: Set<string>;
  onSelectProject: (project: Project) => void;
  onSelectSession: (project: Project, sessionId: string) => void;
  onStartNewSession: (project: Project) => void;
  onStartHomeNewConversation?: () => void;
  pendingDraftProjectName?: string | null;
  onRequestDeleteProject: (project: Project) => void;
  onRequestDeleteSession: (project: Project, session: ProjectSession) => void;
  onSelectTab?: (tab: AppTab) => void;
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

function SectionHeading({
  title,
  expanded,
  expandLabel,
  collapseLabel,
  actionLabel,
  onAction,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  expandLabel: string;
  collapseLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  onToggle: () => void;
}) {
  const toggleLabel = expanded ? collapseLabel : expandLabel;
  return (
    <div className="tree-heading shrink-0">
      <span>{title}</span>
      <div className="tree-heading-actions">
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            aria-label={actionLabel}
            title={actionLabel}
          >
            <MessageSquarePlus aria-hidden="true" className="icon" size={15} strokeWidth={1.8} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <svg
            aria-hidden="true"
            className={cn('icon transition-transform', !expanded && '-rotate-90')}
            fill="none"
            height="15"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="15"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function SidebarV2({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  isLoading,
  loadError = null,
  onRetryLoad,
  isMobile = false,
  processingSessions,
  unreadSessionIds,
  onSelectProject,
  onSelectSession,
  onStartNewSession,
  onStartHomeNewConversation,
  pendingDraftProjectName = null,
  onRequestDeleteProject,
  onRequestDeleteSession,
  onSelectTab,
  onShowSettings,
  onLoadMoreSessions,
  loadingMoreProjectIds,
}: SidebarV2Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useCustomNamesVersion();
  const safeProjects = useMemo(() => (Array.isArray(projects) ? projects : []), [projects]);

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const [collapsedSessionProjects, setCollapsedSessionProjects] = useState<Set<string>>(new Set());
  const [draftSessionProjectName, setDraftSessionProjectName] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarRootRef = useRef<HTMLElement | null>(null);

  const [conversationsExpanded, setConversationsExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const projectsConversationsSplitRef = useRef<HTMLDivElement | null>(null);
  const SIDEBAR_SPLITTER_HEIGHT = 1;
  const SIDEBAR_SECTION_MIN_HEIGHT = 120;
  const SIDEBAR_SPLIT_STORAGE_KEY = 'sidebar-v2-projects-conversations-split';
  const [projectsSplitRatio, setProjectsSplitRatio] = useState(() => {
    if (typeof window === 'undefined') return 0.5;
    try {
      const stored = Number(window.localStorage.getItem(SIDEBAR_SPLIT_STORAGE_KEY));
      return Number.isFinite(stored) && stored > 0.15 && stored < 0.85 ? stored : 0.5;
    } catch {
      return 0.5;
    }
  });
  const [projectsSplitResizing, setProjectsSplitResizing] = useState(false);

  // Resizable sidebar width — clamped to a sensible range and persisted across
  // reloads. Drag-handle on the right edge mutates this on the fly.
  const SIDEBAR_MIN_WIDTH = 76;
  const SIDEBAR_COMPACT_THRESHOLD = 173;
  const SIDEBAR_MAX_WIDTH = 360;
  const SIDEBAR_DEFAULT_WIDTH = 220;
  const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-v2-width';
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    // 248 was the previous default; treat it as unset so the narrower start width applies.
    if (!Number.isFinite(parsed) || parsed === 248) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  });
  const [isResizing, setIsResizing] = useState(false);
  const isCompact = !isMobile && sidebarWidth <= SIDEBAR_COMPACT_THRESHOLD;

  useEffect(() => {
    if (isMobile) return;
    const appShell = sidebarRootRef.current?.closest<HTMLElement>('.app-shell');
    appShell?.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  }, [isMobile, sidebarWidth]);

  const expandCompactSidebar = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {
      // localStorage may be unavailable.
    }
  }, []);

  const clampProjectsSplitRatio = useCallback((ratio: number) => {
    const height = projectsConversationsSplitRef.current?.getBoundingClientRect().height ?? 0;
    const availableHeight = Math.max(1, height - SIDEBAR_SPLITTER_HEIGHT);
    const minRatio = Math.min(0.5, SIDEBAR_SECTION_MIN_HEIGHT / availableHeight);
    const maxRatio = Math.max(0.5, 1 - minRatio);
    return Math.min(Math.max(ratio, minRatio), maxRatio);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SPLIT_STORAGE_KEY, String(projectsSplitRatio));
    } catch {
      // Split remains usable when persistent storage is unavailable.
    }
  }, [projectsSplitRatio]);

  useEffect(() => {
    if (!projectsSplitResizing) return undefined;

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const panel = projectsConversationsSplitRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const pointerRatio = (event.clientY - rect.top)
        / Math.max(1, rect.height - SIDEBAR_SPLITTER_HEIGHT);
      setProjectsSplitRatio(clampProjectsSplitRatio(pointerRatio));
    };
    const handleMouseUp = () => setProjectsSplitResizing(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampProjectsSplitRatio, projectsSplitResizing]);

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

  const otherProjects = useMemo(() => {
    // `general` lives in Conversations, so it is excluded from this list
    // and from the lastActivity comparison. Remaining projects follow the
    // projects API `lastActivity` descending (most recently updated first).
    const remaining = safeProjects.filter((project) => project !== generalProject);
    return [...remaining].sort(compareProjectsBySidebarOrder);
  }, [safeProjects, generalProject]);

  const compactRecentItems = useMemo<CompactRecentItem[]>(() => {
    const items: CompactRecentItem[] = otherProjects.map((project) => ({
      kind: 'project',
      project,
      lastActivity: projectLastActivity(project),
    }));

    let latestSession: CompactRecentItem | null = null;
    for (const project of safeProjects) {
      for (const flat of collectSessionsForProject(project)) {
        if (!latestSession || flat.lastActivity > latestSession.lastActivity) {
          latestSession = {
            kind: 'session',
            project,
            flat,
            lastActivity: flat.lastActivity,
          };
        }
      }
    }
    if (latestSession) items.push(latestSession);

    return items
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 12);
  }, [otherProjects, safeProjects]);

  const navToProject = useCallback(
    (name: string) => navigate(`/p/${encodeURIComponent(name)}`),
    [navigate],
  );

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
      onSelectProject(project);
      toggleProjectExpanded(project);
    },
    [onSelectProject, renamingProject, toggleProjectExpanded],
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
    (event: MouseEvent | undefined, project: Project) => {
      event?.stopPropagation();
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
      (draftSessionProjectName === project.name || pendingDraftProjectName === project.name) &&
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
    const containerClass = options.flat ? 'tree-list chat-tree-list' : 'project-children';
    const sessionTree = buildSessionTree(sessions);
    const sessionTitleById = new Map(
      allSessions.map(({ sessionId, session }) => [sessionId, sessionDisplayTitle(session)]),
    );

    const renderSessionTreeNode = (
      node: SessionTreeNode,
      depth: number,
      isForkChild: boolean,
    ): ReactNode => {
      const { session, sessionId } = node.flat;
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
        <div
          key={sessionId}
          className={depth > 0 ? 'ml-4 border-l border-neutral-200 pl-2 dark:border-neutral-800' : undefined}
        >
          <div
            onContextMenu={(event) =>
              isOptimisticRow ? undefined : openSessionContextMenu(event, project, session)
            }
            className="group/session relative w-full"
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
                  options.flat
                    ? 'tree-row chat-row'
                    : 'project-conversation',
                  isSessionActive && 'active',
                  isOptimisticRow && 'cursor-default',
                )}
              >
                {options.flat ? (
                  <svg aria-hidden="true" className="icon" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
                    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
                  </svg>
                ) : (
                  <span
                    aria-label={indicatorLabel}
                    title={indicatorLabel}
                    className="conversation-dot"
                  />
                )}
                <div className="min-w-0">
                  <div
                    className={cn(
                      'flex min-w-0 items-center gap-1 truncate font-normal',
                      isOptimisticRow && 'italic text-neutral-600 dark:text-neutral-300',
                    )}
                  >
                    {isForkChild ? (
                      <GitBranch className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={2} />
                    ) : null}
                    <span className="truncate">{sessionDisplayTitle(session)}</span>
                  </div>
                  {isOptimisticRow || isForkChild ? (
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {isOptimisticRow
                        ? t('sidebar:sessions.sending', { defaultValue: 'Sending…' })
                        : t('sidebar:sessions.forkedFrom', {
                            parent: parentTitle || session.parentSessionId || '',
                            defaultValue: `forked from ${parentTitle || session.parentSessionId || 'parent'}`,
                          })}
                    </div>
                  ) : null}
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
            className="block w-full rounded-md bg-neutral-200/70 px-2 py-1 text-left text-[14px] leading-5 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <div className="truncate font-normal">
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

    if (isCompact) {
      return (
        <button
          key={project.name}
          type="button"
          title={label as string}
          onClick={() => {
            onSelectProject(project);
            navToProject(project.name);
          }}
          onContextMenu={(event) => openProjectContextMenu(event, project, isGeneral)}
          className={cn('compact-project-entry', isSelected && 'active')}
        >
          <svg aria-hidden="true" className="icon" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M12 22V12" />
          </svg>
          <span>{label}</span>
        </button>
      );
    }

    return (
      <div key={project.name} className="project-tree-node">
        <div
          onContextMenu={(event) => openProjectContextMenu(event, project, isGeneral)}
          className={cn(
            'tree-row project-row group/project',
            isSelected && 'active',
          )}
        >
          {isRenaming && !isGeneral ? (
            <div className="col-span-4 flex h-full min-w-0 items-center gap-1.5">
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
              aria-expanded={isExpanded}
              className="project-expand-button"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400',
                  isExpanded && 'rotate-90',
                )}
                strokeWidth={1.75}
              />
              <svg
                aria-hidden="true"
                className={cn(
                  'icon block shrink-0',
                  isSelected
                    ? 'text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400',
                )}
                fill="none"
                height="16"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="16"
              >
                {isExpanded ? (
                  <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                ) : (
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                )}
              </svg>
              <span className="flex-1 truncate font-normal">{label}</span>
            </button>
          )}

          {!isRenaming ? (
            <div
              className={cn(
                'project-chat-icon transition-opacity',
                '[@media(hover:none)]:opacity-100',
                isSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/project:opacity-100 focus-within:opacity-100',
              )}
            >
              <button
                type="button"
                onClick={(event) => handleNewSession(event, project)}
                aria-label={t('sidebar:tooltips.newChatForProject', {
                  project: label,
                  defaultValue: `Start a new conversation in ${label}`,
                }) as string}
                title={t('sidebar:tooltips.newChatForProject', {
                  project: label,
                  defaultValue: `Start a new conversation in ${label}`,
                }) as string}
              >
                <MessageSquarePlus aria-hidden="true" className="icon" size={15} strokeWidth={1.8} />
              </button>
            </div>
          ) : null}
        </div>

        {isExpanded ? renderSessionRows(project) : null}
      </div>
    );
  };

  return (
    <>
      <aside
      ref={sidebarRootRef}
      data-sidebar-v2-root
      style={{ width: `${sidebarWidth}px` }}
      className={cn(
        // On mobile the parent wraps this aside in an overlay constrained
        // to 85vw, so force the inline width style off with !w-full there.
        'project-sidebar sidebar-shell relative h-full shrink-0 text-neutral-900 dark:text-neutral-100 max-md:!w-full',
        isCompact && 'compact',
      )}
    >
      {isCompact ? (
        <button
          type="button"
          aria-label={t('sidebar:tooltips.expandSidebar', { defaultValue: 'Expand project sidebar' }) as string}
          title={t('sidebar:tooltips.expandSidebar', { defaultValue: 'Expand project sidebar' }) as string}
          data-tooltip={t('sidebar:tooltips.expandSidebar', { defaultValue: 'Expand project sidebar' }) as string}
          className="compact-brand tooltip tooltip-right"
          onClick={expandCompactSidebar}
        >
          <img
            alt=""
            aria-hidden="true"
            className="brand-mark"
            src="/pilotdeck-p-mark-compact.png"
          />
        </button>
      ) : (
        <header className="sidebar-brand-row">
          <img
            alt="PILOTDECK"
            className="brand-lockup"
            src="/pilotdeck-logo-lockup-transparent.png"
          />
        </header>
      )}

      <nav
        className={isCompact ? 'compact-actions' : 'primary-actions'}
        aria-label={t('sidebar:quickActions.label', { defaultValue: 'Primary actions' }) as string}
      >
        <button
          className={cn('primary-action', isCompact && 'compact')}
          type="button"
          aria-label={t('sidebar:quickActions.newConversation', { defaultValue: '新对话' }) as string}
          title={t('sidebar:quickActions.newConversation', { defaultValue: '新对话' }) as string}
          onClick={() => onStartHomeNewConversation?.()}
        >
          <span className="primary-action-icon">
            <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
          </span>
          <span className="truncate">
            {t('sidebar:quickActions.newConversation', { defaultValue: '新对话' })}
          </span>
        </button>
        <button
          className={cn('primary-action', isCompact && 'compact', activeTab === 'skills' && 'active')}
          type="button"
          aria-pressed={activeTab === 'skills'}
          onClick={() => onSelectTab?.('skills')}
        >
          <span className="primary-action-icon">
            <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
            </svg>
          </span>
          <span className="truncate">
            {isCompact
              ? t('sidebar:quickActions.skillsCompact', { defaultValue: 'Skill Tools' })
              : t('sidebar:quickActions.skills', { defaultValue: 'Skills' })}
          </span>
        </button>
        <button
          className={cn('primary-action', isCompact && 'compact', activeTab === 'cron' && 'active')}
          type="button"
          aria-pressed={activeTab === 'cron'}
          onClick={() => onSelectTab?.('cron')}
        >
          <span className="primary-action-icon">
            <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
              <path d="M16 14v2.2l1.6 1" />
              <path d="M16 2v4" />
              <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
              <path d="M3 10h5" />
              <path d="M8 2v4" />
              <circle cx="16" cy="16" r="6" />
            </svg>
          </span>
          <span className="truncate">{t('sidebar:quickActions.scheduledTasks', { defaultValue: 'Scheduled Tasks' })}</span>
        </button>
      </nav>
      {isCompact ? <span className="compact-divider" /> : null}

      {isCompact ? (
        <nav
          className="recent-list"
          aria-label={t('sidebar:projects.recent', { defaultValue: 'Recently opened' }) as string}
        >
          {compactRecentItems.map((item) => {
            if (item.kind === 'project') return renderProjectGroup(item.project);

            const { project, flat } = item;
            const isActive =
              selectedProject?.name === project.name &&
              selectedSession?.id === flat.sessionId &&
              activeTab === 'chat';
            const title = sessionDisplayTitle(flat.session);
            return (
              <button
                key={`session-${flat.sessionId}`}
                type="button"
                title={title}
                onClick={() => handleSessionClick(project, flat.sessionId)}
                onContextMenu={(event) => openSessionContextMenu(event, project, flat.session)}
                className={cn('compact-project-entry compact-recent-conversation', isActive && 'active')}
              >
                <svg aria-hidden="true" className="icon" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
                  <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
                </svg>
                <span>{title}</span>
              </button>
            );
          })}
        </nav>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={projectsConversationsSplitRef}
          className="flex min-h-0 flex-1 flex-col"
        >
        <section
          className="tree-section flex min-h-0 flex-col border-t border-neutral-200/80 dark:border-neutral-800"
          style={
            !projectsExpanded
              ? { minHeight: 0, flex: '0 0 auto' }
              : conversationsExpanded
                ? {
                  height: `calc(${projectsSplitRatio * 100}% - ${
                    SIDEBAR_SPLITTER_HEIGHT * projectsSplitRatio
                  }px)`,
                  minHeight: SIDEBAR_SECTION_MIN_HEIGHT,
                  flex: '0 0 auto',
                }
                : { minHeight: 0, flex: '1 1 0%' }
          }
        >
          <SectionHeading
            title={t('sidebar:projects.title', { defaultValue: 'Projects' })}
            expanded={projectsExpanded}
            expandLabel={t('sidebar:projects.expand', { defaultValue: 'Expand projects' }) as string}
            collapseLabel={t('sidebar:projects.collapse', { defaultValue: 'Collapse projects' }) as string}
            onToggle={() => setProjectsExpanded((previous) => !previous)}
          />

          {projectsExpanded ? (
          <div className="tree-list project-tree-list dock-panel-scrollbar min-h-0 flex-1 overflow-y-auto">
            {isLoading && safeProjects.length === 0 ? (
              <div className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">
                {t('sidebar:sessions.loading', { defaultValue: 'Loading...' })}
              </div>
            ) : loadError && safeProjects.length === 0 ? (
              <div
                role="status"
                className="space-y-2 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
              >
                <p>
                  {t('sidebar:projects.loadError', {
                    defaultValue: 'Projects are temporarily unavailable. Your data has not been removed.',
                  })}
                </p>
                {onRetryLoad ? (
                  <button
                    type="button"
                    className="rounded border border-amber-300/80 px-2 py-1 font-medium hover:bg-amber-50 dark:border-amber-700 dark:hover:bg-amber-950/40"
                    onClick={onRetryLoad}
                  >
                    {t('sidebar:projects.retry', { defaultValue: 'Retry' })}
                  </button>
                ) : null}
              </div>
            ) : otherProjects.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('sidebar:projects.noProjects', { defaultValue: 'No projects found' })}
              </div>
            ) : (
              <div className="contents">
                {otherProjects.map((project) => renderProjectGroup(project))}
              </div>
            )}
          </div>
          ) : null}
        </section>

        {projectsExpanded && conversationsExpanded ? (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('sidebar:tooltips.resizeProjectsConversations', {
              defaultValue: 'Resize projects and conversations',
            }) as string}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(projectsSplitRatio * 100)}
            tabIndex={0}
            onMouseDown={(event) => {
              event.preventDefault();
              setProjectsSplitResizing(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setProjectsSplitRatio((ratio) => clampProjectsSplitRatio(ratio - 0.05));
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setProjectsSplitRatio((ratio) => clampProjectsSplitRatio(ratio + 0.05));
              } else if (event.key === 'Home') {
                event.preventDefault();
                setProjectsSplitRatio(clampProjectsSplitRatio(0));
              } else if (event.key === 'End') {
                event.preventDefault();
                setProjectsSplitRatio(clampProjectsSplitRatio(1));
              }
            }}
            className={cn('panel-splitter horizontal', projectsSplitResizing && 'active')}
          />
        ) : null}

          <section
            className={cn(
              'tree-section conversations flex min-h-0 flex-col',
              !conversationsExpanded && 'border-t border-neutral-200/80 dark:border-neutral-800',
            )}
            style={conversationsExpanded
              ? { minHeight: SIDEBAR_SECTION_MIN_HEIGHT, flex: '1 1 0%' }
              : { flex: '0 0 auto' }}
          >
          <SectionHeading
            title={t('sidebar:conversations.title', { defaultValue: 'Conversations' })}
            expanded={conversationsExpanded}
            expandLabel={t('sidebar:conversations.expand', { defaultValue: 'Expand conversations' }) as string}
            collapseLabel={t('sidebar:conversations.collapse', { defaultValue: 'Collapse conversations' }) as string}
            actionLabel={generalProject
              ? t('sidebar:tooltips.newGeneralChat', { defaultValue: 'Start a general conversation' }) as string
              : undefined}
            onAction={generalProject
              ? () => handleNewSession(undefined, generalProject)
              : undefined}
            onToggle={() => setConversationsExpanded((previous) => !previous)}
          />

          {conversationsExpanded ? (
            <div className="dock-panel-scrollbar min-h-0 flex-1 overflow-y-auto">
              {generalProject ? (
                renderSessionRows(generalProject, { flat: true })
              ) : (
                <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('sidebar:general.missing', {
                    defaultValue: 'No general workspace found',
                  })}
                </div>
              )}
            </div>
          ) : null}
          </section>
        </div>
      </div>
      )}

      <button
        type="button"
        onClick={onShowSettings}
        aria-label={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
        title={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
        data-tooltip={isCompact ? t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string : undefined}
        className={cn(
          'settings-entry',
          isCompact && 'icon-button tooltip tooltip-right compact-settings',
        )}
      >
        <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
          <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>{t('sidebar:actions.settings', { defaultValue: 'Settings' })}</span>
      </button>

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
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar:tooltips.resize', { defaultValue: 'Resize sidebar' }) as string}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          try {
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_DEFAULT_WIDTH));
          } catch {
            // ignore
          }
        }}
        className={cn('sidebar-resizer', isResizing && 'active')}
      >
        <span />
      </div>

      {/* While dragging, paint a fullscreen overlay so the cursor stays
          consistent and we don't accidentally select text in the main pane. */}
      {isResizing ? (
        <div
          className="fixed inset-0 z-[60] cursor-col-resize"
          style={{ userSelect: 'none' }}
        />
      ) : null}
    </>
  );
}
