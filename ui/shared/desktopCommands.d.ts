/** Desktop bridge contract; declaration-only so Web builds need no Electron sources. */
export type DesktopCommand =
  | 'new-conversation' | 'new-project' | 'settings' | 'check-updates' | 'find'
  | 'toggle-sidebar' | 'chat' | 'files' | 'skills' | 'scheduled-tasks';
export type DesktopMenuState = {
  ready: boolean;
  blocked: boolean;
  canNewConversation: boolean;
  hasProject: boolean;
  canFind: boolean;
  sidebarVisible: boolean;
};
