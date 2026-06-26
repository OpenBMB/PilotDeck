import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Bot,
  Database,
  Folder,
  PanelLeftOpen,
  Radio,
  Settings as SettingsIcon,
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
import { useAppearanceProfile } from '../../contexts/AppearanceProfileContext';

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
    isMobile,
    onMenuClick,
    onShowSettings,
    isSidebarCollapsed,
    onOpenSidebar,
  } = props;
  const [alwaysOnSubTab, setAlwaysOnSubTab] = useState<AlwaysOnSubTab>('dashboard');
  const [latestAlwaysOnEventMarker, setLatestAlwaysOnEventMarker] = useState<string | null>(null);
  const [lastViewedAlwaysOnEventMarker, setLastViewedAlwaysOnEventMarker] = useState<string | null>(
    () => localStorage.getItem(ALWAYS_ON_LAST_VIEWED_MARKER_KEY),
  );
  const { activeProfile } = useAppearanceProfile();
  const compactTools = activeProfile.layout === 'compactTools';
  const spaciousLayout = activeProfile.layout === 'spacious';

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

  // Breadcrumb: "ProjectName / Tab" with optional session summary appended in
  // mono. Falls back to "Home" when no project is selected so the breadcrumb
  // never collapses to "/". Project + session strings flow through the
  // customNames overlay so user renames in the sidebar reflect here too.
  const displayActiveTab = activeTab === 'home' ? 'chat' : activeTab;
  const tabLabelKey = TABS.find((tab) => tab.id === displayActiveTab)?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';
  const alwaysOnUnread = Boolean(
    latestAlwaysOnEventMarker &&
    activeTab !== 'always-on' &&
    latestAlwaysOnEventMarker !== lastViewedAlwaysOnEventMarker,
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* Header: breadcrumb left, tool switcher right. */}
      <header className={cn(
        'flex shrink-0 items-center',
        spaciousLayout ? 'h-14 px-7' : compactTools ? 'h-11 px-4' : 'h-12 px-6',
      )}>
        {isMobile ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t('sidebar:actions.menu', { defaultValue: 'Open menu' }) as string}
            title={t('sidebar:actions.menu', { defaultValue: 'Open menu' }) as string}
            className="mr-3 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
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
        <div className={cn('flex min-w-0 flex-1 items-center text-[13px]', compactTools ? 'gap-1.5' : 'gap-2')}>
          <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
            {selectedProject ? projectDisplayName(selectedProject) : t('navigation.home', { defaultValue: 'Home' })}
          </span>
          <span className="shrink-0 text-neutral-400/60 dark:text-neutral-500/60">/</span>
          <span className="shrink-0 font-medium">{tabLabel}</span>
          {sessionSummary ? (
            <span
              className={cn(
                'ml-2 min-w-0 truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400',
                compactTools ? 'max-w-[16rem]' : spaciousLayout ? 'max-w-[36rem]' : 'max-w-[28rem]',
              )}
              title={sessionSummary}
            >
              {sessionSummary}
            </span>
          ) : null}
        </div>

        <div
          role="tablist"
          aria-label="Tools"
          className={cn(
            'scrollbar-thin flex shrink-0 items-center overflow-x-auto',
            compactTools ? 'ml-2 h-8 max-w-[58%] gap-0.5' : spaciousLayout ? 'ml-5 h-10 max-w-[74%] gap-1.5' : 'ml-4 h-9 max-w-[70%] gap-1',
          )}
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
                aria-label={t(tab.labelKey) as string}
                title={t(tab.labelKey) as string}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative inline-flex shrink-0 items-center rounded-md text-[13px] transition-colors',
                  compactTools ? 'h-8 w-8 justify-center px-0' : spaciousLayout ? 'h-9 gap-2 px-3' : 'h-8 gap-1.5 px-2.5',
                  isActive
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span className={cn(compactTools ? 'sr-only' : undefined)}>
                  {t(tab.labelKey)}
                </span>
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
        {isMobile ? (
          <button
            type="button"
            onClick={onShowSettings}
            aria-label={t('sidebar:actions.openSettings', { defaultValue: 'Open settings' }) as string}
            title={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
            className="ml-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
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
