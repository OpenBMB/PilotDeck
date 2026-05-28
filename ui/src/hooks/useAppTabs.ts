import { useMemo } from 'react';
import {
  BarChart3,
  ClipboardCheck,
  Database,
  Folder,
  GitBranch,
  MessageSquare,
  Radio,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type { AppTab } from '../types/app';
import { usePlugins } from '../contexts/PluginsContext';

export type BuiltInAppTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

export type PluginAppTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

export type AppTabDefinition = BuiltInAppTab | PluginAppTab;

// Ordering here drives both the legacy PillBar and the new V2 Sidebar global
// tools group. Keep the order stable so users relearn nothing when V2 ships.
export const BASE_APP_TABS: BuiltInAppTab[] = [
  { kind: 'builtin', id: 'chat',      labelKey: 'tabs.chat',     icon: MessageSquare },
  { kind: 'builtin', id: 'always-on', labelKey: 'tabs.alwaysOn', icon: Radio },
  { kind: 'builtin', id: 'shell',     labelKey: 'tabs.shell',    icon: Terminal },
  { kind: 'builtin', id: 'files',     labelKey: 'tabs.files',    icon: Folder },
  { kind: 'builtin', id: 'git',       labelKey: 'tabs.git',      icon: GitBranch },
  { kind: 'builtin', id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
];

export const TASKS_APP_TAB: BuiltInAppTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

export const MEMORY_APP_TAB: BuiltInAppTab = {
  kind: 'builtin',
  id: 'memory',
  labelKey: 'tabs.memory',
  icon: Database,
};

// IDs that V2 Sidebar renders under the "global tools" group. Plugins + the
// legacy Files/Shell/Git tabs live elsewhere in V2 (right panel / project
// landing) and are intentionally excluded here.
export const GLOBAL_TOOL_TAB_IDS = new Set<AppTab>([
  'memory',
  'always-on',
  'tasks',
  'dashboard',
]);

export type UseAppTabsOptions = {
  shouldShowTasksTab: boolean;
};

export type UseAppTabsResult = {
  tabs: AppTabDefinition[];
  builtInTabs: BuiltInAppTab[];
  pluginTabs: PluginAppTab[];
  globalToolTabs: BuiltInAppTab[];
};

export function useAppTabs({ shouldShowTasksTab }: UseAppTabsOptions): UseAppTabsResult {
  const { plugins } = usePlugins();

  return useMemo(() => {
    const builtInTabs: BuiltInAppTab[] = shouldShowTasksTab
      ? [...BASE_APP_TABS, TASKS_APP_TAB, MEMORY_APP_TAB]
      : [...BASE_APP_TABS, MEMORY_APP_TAB];

    const pluginTabs: PluginAppTab[] = plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({
        kind: 'plugin',
        id: `plugin:${plugin.name}` as AppTab,
        label: plugin.displayName,
        pluginName: plugin.name,
        iconFile: plugin.icon,
      }));

    const globalToolTabs = builtInTabs.filter((tab) => GLOBAL_TOOL_TAB_IDS.has(tab.id));

    return {
      tabs: [...builtInTabs, ...pluginTabs],
      builtInTabs,
      pluginTabs,
      globalToolTabs,
    };
  }, [plugins, shouldShowTasksTab]);
}
