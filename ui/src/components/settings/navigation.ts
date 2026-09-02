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

export function mapInitialTabToMenuKey(
  tab: string | undefined,
): SettingsMenuKey {
  const normalized = String(tab || "");
  const configSections: Record<string, SettingsMenuKey> = {
    models: "modelPool",
    agents: "agentModel",
    memory: "agentMemory",
    tools: "agentSearch",
    webSearch: "agentSearch",
    router: "agentRoute",
    gateway: "integrations",
    officePreview: "officePreview",
    customEnv: "advanced",
    alwaysOn: "agentResident",
    cron: "agentSchedule",
    advanced: "advanced",
  };

  if (normalized in KEY_BY_PAGE_SLUG) {
    return KEY_BY_PAGE_SLUG[normalized];
  }

  const [base, section] = normalized.split(":", 2);
  switch (base) {
    case "permissions":
      return "privacy";
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
  return KEY_BY_PAGE_SLUG[section] ?? mapInitialTabToMenuKey(section);
}

export function getSettingsPathFromTab(tab?: string): string {
  return getSettingsPath(mapInitialTabToMenuKey(tab));
}
