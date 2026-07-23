import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Box,
  Clock,
  Database,
  Folder,
  MoreHorizontal,
  PanelLeftOpen,
  Radio,
  Search,
  Sparkles,
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

type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };

// Chat is the shell's default surface rather than a visible destination.
// Files is the only primary work mode; the remaining management dashboards
// live behind the compact overflow trigger and open beside the conversation.
const FILES_TAB: Tab = { id: 'files', labelKey: 'tabs.files', icon: Folder };
const DASHBOARD_TABS: Tab[] = [
  { id: 'skills',    labelKey: 'tabs.skills',    icon: Sparkles },
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory',    labelKey: 'tabs.memory',    icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn',  icon: Radio },
  { id: 'cron',      labelKey: 'tabs.cron',      icon: Clock },
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

  useEffect(() => {
    if (activeTab === 'home') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

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
  const displayActiveTab = activeTab === 'home' ? 'chat' : activeTab;
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
    ? projectDisplayName(selectedProject)
    : t('navigation.home', { defaultValue: 'Home' });
  const headerTitle =
    sessionSummary || (displayActiveTab === FILES_TAB.id ? tabLabel || projectName : projectName);
  const isRenamingSessionTitle = Boolean(
    selectedSession && renamingSessionId === selectedSession.id,
  );
  const ActiveDashboardIcon = activeDashboardTab?.icon;
  const alwaysOnUnread = Boolean(
    latestAlwaysOnEventMarker &&
    activeTab !== 'always-on' &&
    latestAlwaysOnEventMarker !== lastViewedAlwaysOnEventMarker,
  );

  useEffect(() => {
    if (chatHistorySearch.isOpen && displayActiveTab !== 'chat') {
      setDashboardMenuOpen(false);
      setActiveTab('chat');
    }
  }, [chatHistorySearch.isOpen, displayActiveTab, setActiveTab]);

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
      {/* Header: session title left, tool switcher right. */}
      <header className="relative z-[80] flex h-14 shrink-0 items-center overflow-visible border-b border-neutral-100 bg-white px-6 dark:border-neutral-900 dark:bg-neutral-950">
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
        <div className="flex min-w-0 flex-1 flex-col justify-center">
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
            <div
              className={cn(
                'min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50',
                selectedSession && 'cursor-text',
              )}
              title={headerTitle}
              onDoubleClick={selectedSession ? beginSessionTitleRename : undefined}
            >
              {headerTitle}
            </div>
          )}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">
            <Box className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 max-w-[24rem] truncate" title={projectName}>
              {projectName}
            </span>
          </div>
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

        <div className="ml-4 flex h-9 shrink-0 items-center gap-1" aria-label="Tools">
          <button
            type="button"
            aria-label={t('chatSearch.open', { defaultValue: 'Search current conversation' }) as string}
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
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              chatHistorySearch.isOpen
                ? ACTIVE_TOOL_BUTTON_CLASS
                : chatHistorySearch.available
                  ? 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                  : 'cursor-not-allowed text-neutral-300 dark:text-neutral-700',
            )}
          >
            <Search className="h-4 w-4" strokeWidth={1.9} />
          </button>

          <button
            type="button"
            aria-pressed={displayActiveTab === 'files'}
            onClick={() => {
              setDashboardMenuOpen(false);
              chatHistorySearch.closeSearch();
              setActiveTab(displayActiveTab === 'files' ? 'chat' : 'files');
            }}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
              displayActiveTab === 'files'
                ? cn('font-medium', ACTIVE_TOOL_BUTTON_CLASS)
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
            )}
          >
            <Folder className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t(FILES_TAB.labelKey)}</span>
          </button>

          <div ref={dashboardMenuRef} className="relative">
            {activeDashboardTab && ActiveDashboardIcon ? (
              <button
                type="button"
                aria-pressed="true"
                title={t('dashboardSwitcher.closeActive', {
                  defaultValue: 'Close {{tool}} dashboard',
                  tool: t(activeDashboardTab.labelKey),
                }) as string}
                onClick={() => {
                  setActiveTab('chat');
                  window.requestAnimationFrame(() => dashboardMenuButtonRef.current?.focus());
                }}
                className={cn(
                  'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
                  ACTIVE_TOOL_BUTTON_CLASS,
                )}
              >
                <ActiveDashboardIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t(activeDashboardTab.labelKey)}</span>
                {alwaysOnUnread && activeDashboardTab.id !== 'always-on' ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-600 ring-2 ring-blue-100 dark:bg-blue-400 dark:ring-blue-950"
                  />
                ) : null}
              </button>
            ) : (
              <button
                ref={dashboardMenuButtonRef}
                type="button"
                aria-label={t('dashboardSwitcher.open', { defaultValue: 'Open dashboards menu' }) as string}
                aria-haspopup="menu"
                aria-expanded={dashboardMenuOpen}
                onClick={() => setDashboardMenuOpen((open) => !open)}
                className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.9} />
                {alwaysOnUnread ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-neutral-950"
                  />
                ) : null}
              </button>
            )}

            {dashboardMenuOpen && !activeDashboardTab ? (
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
        </div>
      </header>

      {/* Body */}
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <MainContent
          {...props}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={setAlwaysOnSubTab}
        />
      </div>
    </div>
  );
}

export default function MainAreaV2(props: MainAreaV2Props) {
  return (
    <ChatHistorySearchControllerProvider>
      <MainAreaV2Content {...props} />
    </ChatHistorySearchControllerProvider>
  );
}
