import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Bot,
  Database,
  Folder,
  PanelLeftOpen,
  Radio,
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
import type { MainContentProps } from '../main-content/types/types';
import { cn } from '../../lib/utils.js';
import { projectDisplayName, sessionDisplayTitle, useCustomNamesVersion } from '../../lib/customNames';
import { api } from '../../utils/api';

type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };

// Order matches the primary work modes in the shell. The Agent tab owns both
// the new-session welcome state and existing conversation transcripts.
// Plugin tabs aren't surfaced in this static list.
//
// Shell + Source Control intentionally left out of the visible bar — both
// tools are still reachable via plugin tabs / programmatic activeTab if a
// future feature needs them, but they were noisy in the day-to-day flow.
const TABS: Tab[] = [
  { id: 'chat',      labelKey: 'tabs.chat',      icon: Bot },
  { id: 'files',     labelKey: 'tabs.files',     icon: Folder },
  { id: 'skills',    labelKey: 'tabs.skills',    icon: Sparkles },
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory',    labelKey: 'tabs.memory',    icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn',  icon: Radio },
];

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

export default function MainAreaV2(props: MainAreaV2Props) {
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

  useEffect(() => {
    if (activeTab === 'home') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

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
  const tabLabelKey = TABS.find((tab) => tab.id === displayActiveTab)?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const projectName = selectedProject
    ? projectDisplayName(selectedProject)
    : t('navigation.home', { defaultValue: 'Home' });
  const headerTitle = sessionSummary || tabLabel || projectName;
  const alwaysOnUnread = Boolean(
    latestAlwaysOnEventMarker &&
    activeTab !== 'always-on' &&
    latestAlwaysOnEventMarker !== lastViewedAlwaysOnEventMarker,
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* Header: session title left, tool switcher right. */}
      <header className="flex h-14 shrink-0 items-center px-6">
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
          <div
            className="min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50"
            title={headerTitle}
          >
            {headerTitle}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">
            <Folder className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 max-w-[24rem] truncate" title={projectName}>
              {projectName}
            </span>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Tools"
          className="scrollbar-thin ml-4 flex h-9 max-w-[52%] shrink-0 items-center gap-1 overflow-x-auto"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = displayActiveTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t(tab.labelKey)}</span>
                {tab.id === 'always-on' && alwaysOnUnread ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-neutral-950"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <MainContent
          {...props}
          alwaysOnSubTab={alwaysOnSubTab}
          onAlwaysOnSubTabChange={setAlwaysOnSubTab}
        />
      </div>
    </div>
  );
}
