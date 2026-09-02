import type { SettingsMenuKey } from "../types";
import aboutIcon from "../assets/nav/about.svg?raw";
import advancedIcon from "../assets/nav/advanced.svg?raw";
import agentMemoryIcon from "../assets/nav/agent-memory.svg?raw";
import agentModelIcon from "../assets/nav/agent-model.svg?raw";
import agentResidentIcon from "../assets/nav/agent-resident.svg?raw";
import agentRouteIcon from "../assets/nav/agent-route.svg?raw";
import agentScheduleIcon from "../assets/nav/agent-schedule.svg?raw";
import agentSearchIcon from "../assets/nav/agent-search.svg?raw";
import backIcon from "../assets/nav/back.svg?raw";
import configIcon from "../assets/nav/config.svg?raw";
import generalIcon from "../assets/nav/general.svg?raw";
import integrationsIcon from "../assets/nav/integrations.svg?raw";
import localReadyIcon from "../assets/nav/local-ready.svg?raw";
import mcpIcon from "../assets/nav/mcp.svg?raw";
import modelPoolIcon from "../assets/nav/model-pool.svg?raw";
import officeIcon from "../assets/nav/office.svg?raw";
import privacyIcon from "../assets/nav/privacy.svg?raw";

export const SETTINGS_BACK_ICON = backIcon;
export const SETTINGS_CONFIG_ICON = configIcon;
export const SETTINGS_LOCAL_READY_ICON = localReadyIcon;

export const SETTINGS_NAV_ICONS: Partial<Record<SettingsMenuKey, string>> = {
  general: generalIcon,
  modelPool: modelPoolIcon,
  agentModel: agentModelIcon,
  agentRoute: agentRouteIcon,
  agentMemory: agentMemoryIcon,
  agentResident: agentResidentIcon,
  agentSearch: agentSearchIcon,
  agentSchedule: agentScheduleIcon,
  integrations: integrationsIcon,
  mcpServers: mcpIcon,
  officePreview: officeIcon,
  privacy: privacyIcon,
  advanced: advancedIcon,
  about: aboutIcon,
};
