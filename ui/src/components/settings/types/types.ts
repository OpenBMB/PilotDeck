import type { Dispatch, SetStateAction } from 'react';

// Settings was trimmed down from the original multi-tab layout. The
// 'permissions' tab was re-added because the chat surface emits
// "Open settings" links from tool-permission prompts and we need somewhere
// for those to land. The agents/git/api/tasks/notifications/plugins/router/
// about tabs and their MCP form modals stay removed — see git history if
// you ever need to recover the multi-provider surface.
export type SettingsMainTab = 'appearance' | 'permissions' | 'config';

export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type CodeEditorSettingsState = {
  theme: 'dark' | 'light';
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
