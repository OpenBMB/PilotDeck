import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsMainTab,
} from "./types";

export const SETTINGS_MAIN_TABS: SettingsMainTab[] = [
  "appearance",
  "permissions",
  "config",
  "mcp",
  "gateway",
];

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = "name";
export const DEFAULT_SAVE_STATUS = null;
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  theme: "dark",
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: "14",
};
