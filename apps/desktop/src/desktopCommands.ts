import type { DesktopCommand, DesktopMenuState } from '../../../ui/shared/desktopCommands';
/** Shared, allowlisted desktop actions. No renderer-supplied URLs or script. */
export const desktopCommands = [
  'new-conversation', 'new-project', 'settings', 'check-updates', 'find',
  'toggle-sidebar', 'chat', 'files', 'skills', 'scheduled-tasks',
] as const;
export type { DesktopCommand, DesktopMenuState } from '../../../ui/shared/desktopCommands';
export const emptyMenuState: DesktopMenuState = {
  ready: false, blocked: false, canNewConversation: false,
  hasProject: false, canFind: false, sidebarVisible: false,
};
export function normalizeMenuState(value: unknown): DesktopMenuState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(emptyMenuState).map(key => [key, record[key] === true])) as DesktopMenuState;
}
export function commandEnabled(command: DesktopCommand, state: DesktopMenuState): boolean {
  if (!desktopCommands.includes(command)) return false;
  if (!state.ready || state.blocked) return false;
  if (command === 'new-conversation') return state.canNewConversation;
  if (command === 'files') return state.hasProject;
  if (command === 'find') return state.canFind;
  return true;
}
