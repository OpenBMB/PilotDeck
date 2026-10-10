import type { SettingsMenuKey } from "../types";
import aboutIcon from "../assets/nav/about.svg?raw";
import advancedIcon from "../assets/nav/advanced.svg?raw";
import agentMemoryIcon from "../assets/nav/agent-memory.svg?raw";
import agentResidentIcon from "../assets/nav/agent-resident.svg?raw";
import agentRouteIcon from "../assets/nav/agent-route.svg?raw";
import agentScheduleIcon from "../assets/nav/agent-schedule.svg?raw";
import agentSearchIcon from "../assets/nav/agent-search.svg?raw";
import backIcon from "../assets/nav/back.svg?raw";
import configIcon from "../assets/nav/config.svg?raw";
import computerControlIcon from "../assets/nav/computer-control.svg?raw";
import generalIcon from "../assets/nav/general.svg?raw";
import integrationsIcon from "../assets/nav/integrations.svg?raw";
import mcpIcon from "../assets/nav/mcp.svg?raw";
import modelPoolIcon from "../assets/nav/model-pool.svg?raw";
import officeIcon from "../assets/nav/office.svg?raw";
import privacyIcon from "../assets/nav/privacy.svg?raw";

export const SETTINGS_BACK_ICON = backIcon;
export const SETTINGS_CONFIG_ICON = configIcon;

export const SETTINGS_NAV_ICONS: Partial<Record<SettingsMenuKey, string>> = {
  general: generalIcon,
  appearance: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor"/></svg>',
  modelPool: modelPoolIcon,
  agentRoute: agentRouteIcon,
  agentMemory: agentMemoryIcon,
  agentResident: agentResidentIcon,
  agentSearch: agentSearchIcon,
  agentSchedule: agentScheduleIcon,
  integrations: integrationsIcon,
  mcpServers: mcpIcon,
  officePreview: officeIcon,
  computerUse: computerControlIcon,
  privacy: privacyIcon,
  advanced: advancedIcon,
  about: aboutIcon,
};
