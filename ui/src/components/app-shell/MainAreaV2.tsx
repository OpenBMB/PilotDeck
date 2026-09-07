import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Database,
  Folder,
  PanelLeftOpen,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import type {
  AlwaysOnDashboardEvent,
  AlwaysOnDashboardEventsResponse,
  AlwaysOnSubTab,
  AppTab,
  Project,
  ProjectSession,
} from '../../types/app';
import MainContent from '../main-content/view/MainContent';
import {
  ChatHistorySearchControllerProvider,
  useChatHistorySearchController,
} from '../chat-v2/ChatHistorySearchController';
import ChatHistorySearchBar from '../chat-v2/ChatHistorySearchBar';
import type { MainContentProps } from '../main-content/types/types';
import { cn } from '../../lib/utils.js';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';
import { isImeEnterEvent } from '../../utils/ime';
import { api } from '../../utils/api';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import { isGeneralProject } from './appShellSelection';

const CronV2 = lazy(() => import('../main-content-v2/CronV2'));
const SkillsV2 = lazy(() => import('../main-content-v2/SkillsV2'));

function DedicatedWorkspacePage({
  title,
  isSidebarCollapsed,
  onOpenSidebar,
  children,
}: {
  title: string;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed ? (
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex-1">
          <h1 className="min-w-0 truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50">
            {title}
          </h1>
        </div>
      </header>
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
    </div>
  );
}

function ScheduledTasksArea({
  isSidebarCollapsed,
  onOpenSidebar,
}: {
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DedicatedWorkspacePage
      title={t('sidebar:quickActions.scheduledTasks', { defaultValue: 'Scheduled Tasks' })}
      isSidebarCollapsed={isSidebarCollapsed}
      onOpenSidebar={onOpenSidebar}
    >
      <Suspense fallback={<PageFallback />}>
        <CronV2 />
      </Suspense>
    </DedicatedWorkspacePage>
  );
}

function SkillsArea({
  isSidebarCollapsed,
  onOpenSidebar,
  selectedProject,
  projects,
}: {
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  selectedProject: Project | null;
  projects: Project[];
}) {
  const { t } = useTranslation();

  return (
    <DedicatedWorkspacePage
      title={t('sidebar:quickActions.skills', { defaultValue: 'Skills' })}
      isSidebarCollapsed={isSidebarCollapsed}
      onOpenSidebar={onOpenSidebar}
    >
      <Suspense fallback={<PageFallback />}>
        <SkillsV2 selectedProject={selectedProject} projects={projects} />
      </Suspense>
    </DedicatedWorkspacePage>
  );
}

type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };

// Chat is the shell's default surface rather than a visible destination.
// Files is the only primary work mode; the remaining management dashboards
// live behind the compact overflow trigger and open beside the conversation.
const FILES_TAB: Tab = { id: 'files', labelKey: 'tabs.files', icon: Folder };
const DASHBOARD_TABS: Tab[] = [
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory',    labelKey: 'tabs.memory',    icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn',  icon: Radio },
];

const ACTIVE_TOOL_BUTTON_CLASS =
  'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-950/70 dark:text-blue-200 dark:hover:bg-blue-900/70';

const ALWAYS_ON_EVENT_BADGE_POLL_INTERVAL_MS = 15_000;
const ALWAYS_ON_LAST_VIEWED_MARKER_KEY = 'pilotdeck:always-on-last-viewed-marker';
const ALWAYS_ON_EVENT_BADGE_LIMIT = 200;

const BADGE_EVENT_PHASES = new Set<AlwaysOnDashboardEvent['phase']>([
  'plan_produced',
  'report_produced',
]);

const getBadgeEventMarker = (events: AlwaysOnDashboardEvent[]): string | null => {
  const latestBadgeEvent = events
    .filter((event) => BADGE_EVENT_PHASES.has(event.phase))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];

  return latestBadgeEvent ? `${latestBadgeEvent.timestamp}:${latestBadgeEvent.eventId}` : null;
};

// V2 main shell: breadcrumb on the left, tool switcher on the right, and the
// active tool's content below. The sidebar stays focused on projects+sessions.
type MainAreaV2Props = MainContentProps & {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
};

function MainAreaV2Content(props: MainAreaV2Props) {
  const { t } = useTranslation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    isSidebarCollapsed,
    onOpenSidebar,
  } = props;
  const [alwaysOnSubTab, setAlwaysOnSubTab] = useState<AlwaysOnSubTab>('dashboard');
  const [latestAlwaysOnEventMarker, setLatestAlwaysOnEventMarker] = useState<string | null>(null);
  const [lastViewedAlwaysOnEventMarker, setLastViewedAlwaysOnEventMarker] = useState<string | null>(
    () => localStorage.getItem(ALWAYS_ON_LAST_VIEWED_MARKER_KEY),
  );
  const [dashboardMenuOpen, setDashboardMenuOpen] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const dashboardMenuRef = useRef<HTMLDivElement | null>(null);
  const dashboardMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const sessionTitleInputRef = useRef<HTMLInputElement | null>(null);
  const chatHistorySearch = useChatHistorySearchController();
  const generalConversation = Boolean(selectedProject && isGeneralProject(selectedProject));
  const projectFilesEnabled = Boolean(
    selectedProject
    && !generalConversation
    && selectedProject.capabilities?.files !== false,
  );
  const projectExploreEnabled = Boolean(
    selectedProject
    && !generalConversation
    && selectedProject.capabilities?.explore !== false,
  );
  const activeTabIsUnavailable =
    (activeTab === 'files' && !projectFilesEnabled)
    || (DASHBOARD_TABS.some((tab) => tab.id === activeTab) && !projectExploreEnabled);
  const displayActiveTab = activeTab === 'home' || activeTabIsUnavailable ? 'chat' : activeTab;

  useEffect(() => {
    if (activeTab === 'home' || activeTabIsUnavailable) {
      setActiveTab('chat');
    }
  }, [activeTab, activeTabIsUnavailable, setActiveTab]);

  useEffect(() => {
    if (!projectExploreEnabled) {
      setDashboardMenuOpen(false);
    }
  }, [projectExploreEnabled]);

  useEffect(() => {
    if (!dashboardMenuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!dashboardMenuRef.current?.contains(event.target as Node)) {
        setDashboardMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDashboardMenuOpen(false);
        dashboardMenuButtonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dashboardMenuOpen]);

  useEffect(() => {
    let cancelled = false;

    const refreshAlwaysOnEventMarker = async () => {
      try {
        const response = await api.alwaysOnDashboardEvents(ALWAYS_ON_EVENT_BADGE_LIMIT);
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as AlwaysOnDashboardEventsResponse;

        if (!cancelled) {
          const marker = Array.isArray(payload.events) ? getBadgeEventMarker(payload.events) : null;
          setLatestAlwaysOnEventMarker(marker);

          if (marker && !localStorage.getItem(ALWAYS_ON_LAST_VIEWED_MARKER_KEY)) {
            setLastViewedAlwaysOnEventMarker(marker);
            localStorage.setItem(ALWAYS_ON_LAST_VIEWED_MARKER_KEY, marker);
          }
        }
      } catch {
        // Keep the previous marker when the lightweight notification poll fails.
      }
    };

    void refreshAlwaysOnEventMarker();
    const timer = window.setInterval(() => {
      void refreshAlwaysOnEventMarker();
    }, ALWAYS_ON_EVENT_BADGE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'always-on' && latestAlwaysOnEventMarker) {
      setLastViewedAlwaysOnEventMarker(latestAlwaysOnEventMarker);
      localStorage.setItem(ALWAYS_ON_LAST_VIEWED_MARKER_KEY, latestAlwaysOnEventMarker);
    }
  }, [activeTab, latestAlwaysOnEventMarker]);

  // Re-render breadcrumb when the user renames a project/session via the
  // sidebar overlay (subscribes to localStorage + custom event).
  useCustomNamesVersion();

  // Header title: session title first, project context second. Project +
  // session strings flow through the customNames overlay so user renames in
  // the sidebar reflect here too.
  const activeDashboardTab = DASHBOARD_TABS.find((tab) => tab.id === displayActiveTab) ?? null;
  const tabLabelKey = displayActiveTab === FILES_TAB.id
    ? FILES_TAB.labelKey
    : activeDashboardTab?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const projectName = selectedProject
    ? isGeneralProject(selectedProject)
      ? t('sidebar:general.name', { defaultValue: 'General conversation' })
      : projectDisplayName(selectedProject)
    : t('sidebar:general.name', { defaultValue: 'General conversation' });
  const headerTitle =
    sessionSummary || (displayActiveTab === FILES_TAB.id ? tabLabel || projectName : projectName);
  const isRenamingSessionTitle = Boolean(
    selectedSession && renamingSessionId === selectedSession.id,
  );
  const alwaysOnUnread = Boolean(
    latestAlwaysOnEventMarker &&
    activeTab !== 'always-on' &&
    latestAlwaysOnEventMarker !== lastViewedAlwaysOnEventMarker,
  );

  useEffect(() => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!isRenamingSessionTitle) return;
    sessionTitleInputRef.current?.focus();
    sessionTitleInputRef.current?.select();
  }, [isRenamingSessionTitle]);

  const beginSessionTitleRename = () => {
    if (!selectedSession) return;
    setRenamingSessionId(selectedSession.id);
    setSessionTitleDraft(sessionDisplayTitle(selectedSession));
  };

  const commitSessionTitleRename = () => {
    if (!renamingSessionId) return;
    setSessionCustomTitle(renamingSessionId, sessionTitleDraft);
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  const cancelSessionTitleRename = () => {
    setRenamingSessionId(null);
    setSessionTitleDraft('');
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed ? (
          // Just the "expand sidebar" affordance — the PilotDeck logo lives
          // in the sidebar header, so showing a duplicate badge here when
          // the sidebar is collapsed feels redundant.
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
            className="mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="workspace-title flex-1">
          {isRenamingSessionTitle ? (
            <input
              ref={sessionTitleInputRef}
              value={sessionTitleDraft}
              onChange={(event) => setSessionTitleDraft(event.target.value)}
              onBlur={commitSessionTitleRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (isImeEnterEvent(event)) return;
                  event.preventDefault();
                  commitSessionTitleRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelSessionTitleRename();
                }
              }}
              aria-label={t('sidebar:sessions.renameSession', { defaultValue: 'Rename Session' }) as string}
              className="h-6 min-w-0 max-w-[34rem] rounded border border-neutral-300 bg-white px-1.5 text-[15px] font-semibold leading-5 text-neutral-950 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
            />
          ) : (
            <h1
              className={cn(
                'min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50',
                selectedSession && 'cursor-text',
              )}
              title={headerTitle}
              onDoubleClick={selectedSession ? beginSessionTitleRename : undefined}
            >
              {headerTitle}
            </h1>
          )}
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">
            <svg aria-hidden="true" className="icon" fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="13">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
              <path d="M8 10v4" />
              <path d="M12 10v2" />
              <path d="M16 10v6" />
            </svg>
            <span className="min-w-0 max-w-[24rem] truncate" title={projectName}>
              {projectName}
            </span>
          </span>
        </div>

        {chatHistorySearch.isOpen && chatHistorySearch.presentation ? (
          <div className="ml-4 w-[min(360px,36vw)] min-w-[240px] shrink">
            <ChatHistorySearchBar
              {...chatHistorySearch.presentation}
              onClose={chatHistorySearch.closeSearch}
              placement="header"
            />
          </div>
        ) : null}

        <div className="workspace-actions ml-4 h-9 shrink-0" aria-label="Tools">
          <button
            type="button"
            aria-label={t('chatSearch.open', { defaultValue: 'Search current conversation' }) as string}
            data-tooltip={t('chatSearch.open', { defaultValue: 'Search current conversation' }) as string}
            aria-pressed={chatHistorySearch.isOpen}
            disabled={!chatHistorySearch.available}
            title={t('chatSearch.openShortcut', {
              defaultValue: 'Search current conversation (Ctrl/⌘+F)',
            }) as string}
            onClick={() => {
              setDashboardMenuOpen(false);
              if (chatHistorySearch.isOpen) {
                chatHistorySearch.closeSearch();
                return;
              }
              if (displayActiveTab !== 'chat') setActiveTab('chat');
              chatHistorySearch.openSearch();
            }}
            className={cn(
              'icon-button tooltip tooltip-bottom',
              chatHistorySearch.isOpen
                ? ACTIVE_TOOL_BUTTON_CLASS
                : chatHistorySearch.available
                  ? ''
                  : 'cursor-not-allowed text-neutral-300 dark:text-neutral-700',
            )}
          >
            <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
              <path d="m21 21-4.34-4.34" />
              <circle cx="11" cy="11" r="8" />
            </svg>
          </button>

          {projectFilesEnabled ? (
            <button
              type="button"
              aria-pressed={displayActiveTab === 'files'}
              onClick={() => {
                setDashboardMenuOpen(false);
                chatHistorySearch.closeSearch();
                setActiveTab(displayActiveTab === 'files' ? 'chat' : 'files');
              }}
              className={cn(
                'file-entry',
                displayActiveTab === 'files' && 'font-medium',
              )}
            >
              <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
                <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
              </svg>
              <span>{t(FILES_TAB.labelKey)}</span>
            </button>
          ) : null}

          {projectExploreEnabled ? (
            <div ref={dashboardMenuRef} className="relative">
              <button
                ref={dashboardMenuButtonRef}
                type="button"
                aria-label={t('dashboardSwitcher.open', { defaultValue: 'Open dashboards menu' }) as string}
                aria-haspopup="menu"
                aria-expanded={dashboardMenuOpen}
                data-tooltip={t('dashboardSwitcher.open', { defaultValue: 'Open dashboards menu' }) as string}
                onClick={() => setDashboardMenuOpen((open) => !open)}
                className="file-entry tooltip tooltip-bottom"
              >
                <svg aria-hidden="true" className="icon" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="18">
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                  <circle cx="5" cy="12" r="1" />
                </svg>
                <span>{t('dashboardSwitcher.explore', { defaultValue: 'Explore' })}</span>
                {alwaysOnUnread ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-neutral-950"
                  />
                ) : null}
              </button>

              {dashboardMenuOpen ? (
                <div
                  role="menu"
                  aria-label={t('dashboardSwitcher.menuLabel', { defaultValue: 'Dashboards' }) as string}
                  className="absolute right-0 top-10 z-[90] w-32 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/10 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {DASHBOARD_TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setDashboardMenuOpen(false);
                          chatHistorySearch.closeSearch();
                          setActiveTab(tab.id);
                        }}
                        className="relative flex h-9 w-full items-center justify-center gap-2 rounded-lg px-2 text-[13px] text-neutral-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 focus:outline-none dark:text-neutral-300 dark:hover:bg-blue-950/60 dark:hover:text-blue-200 dark:focus:bg-blue-950/60 dark:focus:text-blue-200"
                      >
                        <Icon className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                        <span>{t(tab.labelKey)}</span>
                        {tab.id === 'always-on' && alwaysOnUnread ? (
                          <span className="absolute right-2 h-2 w-2 rounded-full bg-blue-500" aria-label="Unread" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {/* Body */}
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <MainContent
          {...props}
          activeTab={displayActiveTab}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={setAlwaysOnSubTab}
        />
      </div>
    </div>
  );
}

export default function MainAreaV2(props: MainAreaV2Props) {
  if (props.activeTab === 'cron') {
    return (
      <ScheduledTasksArea
        isSidebarCollapsed={props.isSidebarCollapsed}
        onOpenSidebar={props.onOpenSidebar}
      />
    );
  }

  if (props.activeTab === 'skills') {
    return (
      <SkillsArea
        isSidebarCollapsed={props.isSidebarCollapsed}
        onOpenSidebar={props.onOpenSidebar}
        selectedProject={props.selectedProject}
        projects={props.projects}
      />
    );
  }

  const generalConversation = Boolean(
    props.selectedProject && isGeneralProject(props.selectedProject),
  );
  const fileScope = props.activeTab === 'files'
    && !generalConversation
    && props.selectedProject?.capabilities?.files !== false;

  return (
    <FindShortcutProvider activeScope={fileScope ? 'file' : 'chat'}>
      <ChatHistorySearchControllerProvider>
        <MainAreaV2Content {...props} />
      </ChatHistorySearchControllerProvider>
    </FindShortcutProvider>
  );
}
