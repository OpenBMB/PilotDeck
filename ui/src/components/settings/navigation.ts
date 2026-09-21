import type { SettingsMenuKey } from "./types";

export const SETTINGS_BASE_PATH = "/settings";

const PAGE_SLUG_BY_KEY: Partial<Record<SettingsMenuKey, string>> = {
  general: "general",
  modelPool: "models",
  agentModel: "agent-model",
  agentRoute: "agent-route",
  agentMemory: "agent-memory",
  agentResident: "agent-resident",
  agentSearch: "agent-search",
  agentSchedule: "agent-schedule",
  integrations: "integrations",
  mcpServers: "mcp",
  officePreview: "office",
  privacy: "privacy",
  advanced: "advanced",
  about: "about",
};

const KEY_BY_PAGE_SLUG: Record<string, SettingsMenuKey> = Object.fromEntries(
  Object.entries(PAGE_SLUG_BY_KEY).flatMap(([key, slug]) =>
    slug ? [[slug, key as SettingsMenuKey]] : [],
  ),
);

// Keep existing deep links working while routing them to the selected module
// contribution. These are aliases, not a second hard-coded settings surface.
const LEGACY_MODULE_SECTION: Partial<Record<SettingsMenuKey, SettingsMenuKey>> = {
  modelPool: 'module:model-providers',
  agentModel: 'module:agent-model',
  agentRoute: 'module:agent-route',
  agentMemory: 'module:context-memory',
  agentResident: 'module:agent-resident',
  agentSearch: 'module:tools-search',
  agentSchedule: 'module:agent-schedule',
  integrations: 'module:integrations',
  mcpServers: 'module:mcp-servers',
  officePreview: 'module:office-preview',
  advanced: 'module:system-advanced',
  privacy: 'module:tools-permissions',
  about: 'module:system-updates',
};

export function mapInitialTabToMenuKey(
  tab: string | undefined,
): SettingsMenuKey {
  const normalized = String(tab || "");
  const configSections: Record<string, SettingsMenuKey> = {
    models: "module:model-providers",
    agents: "module:agent-model",
    memory: "module:context-memory",
    tools: "module:tools-search",
    webSearch: "module:tools-search",
    router: "module:agent-route",
    gateway: "module:integrations",
    officePreview: "module:office-preview",
    customEnv: "module:system-advanced",
    alwaysOn: "module:agent-resident",
    cron: "module:agent-schedule",
    advanced: "module:system-advanced",
  };

  if (normalized in KEY_BY_PAGE_SLUG) {
    return KEY_BY_PAGE_SLUG[normalized];
  }

  const [base, section] = normalized.split(":", 2);
  switch (base) {
    case "permissions":
      return "module:tools-permissions";
    case "mcp":
      return "mcpServers";
    case "gateway":
      return "integrations";
    case "config":
      return section ? (configSections[section] ?? "modelPool") : "modelPool";
    default:
      return "general";
  }
}

export function getSettingsPath(key: SettingsMenuKey = "general"): string {
  if (key.startsWith('module:')) return `${SETTINGS_BASE_PATH}/module/${encodeURIComponent(key.slice('module:'.length))}`;
  const slug = PAGE_SLUG_BY_KEY[key];
  if (!slug || slug === "general") {
    return SETTINGS_BASE_PATH;
  }
  return `${SETTINGS_BASE_PATH}/${slug}`;
}

export function mapSettingsSectionToMenuKey(
  section: string | undefined,
): SettingsMenuKey {
  if (!section) return "general";
  if (section.startsWith('module/')) return `module:${decodeURIComponent(section.slice('module/'.length))}`;
  const key = KEY_BY_PAGE_SLUG[section] ?? mapInitialTabToMenuKey(section);
  return LEGACY_MODULE_SECTION[key] ?? key;
}

export function getSettingsPathFromTab(tab?: string): string {
  return getSettingsPath(mapInitialTabToMenuKey(tab));
}
