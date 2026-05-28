import { safeJsonParse } from '../../../lib/utils.js';
import type { ChatMessage, PilotDeckPermissionSuggestion, PermissionGrantResult } from '../types/types.js';
import {
  PILOTDECK_SETTINGS_KEY,
  getPilotDeckSettings,
  safeLocalStorage,
  savePilotDeckPermissionSettings,
} from './chatStorage';

export function buildPilotDeckToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  if (!toolName) return null;
  if (toolName !== 'Bash' && toolName !== 'bash') return toolName;

  const parsed = safeJsonParse(toolInput);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return 'bash';

  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return toolName;

  if (tokens[0] === 'git' && tokens[1]) {
    return `bash:${tokens[0]} ${tokens[1]}:*`;
  }
  return `bash:${tokens[0]}:*`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// Backend `PilotDeckToolErrorCode` values that map to "user can fix this by
// granting a permission rule". Anything else (e.g. `tool_execution_failed`,
// `file_not_found`, `tool_timeout`) is a real failure unrelated to ACL state,
// and surfacing the "Add to Allowed Tools" CTA for those cases is actively
// misleading — clicking it adds the rule, but the next retry still fails
// because the original error was not about permissions.
const PERMISSION_ERROR_CODES = new Set<string>([
  'permission_denied',
  'permission_required',
  'permission_cancelled',
]);

export function isPlanModeToolDeny(message: ChatMessage | null | undefined): boolean {
  if (!message?.toolResult?.isError) return false;
  const content = typeof message.toolResult.content === 'string'
    ? message.toolResult.content
    : '';
  return /plan mode denies side-effecting tool\b/i.test(content);
}

export function getPilotDeckPermissionSuggestion(
  message: ChatMessage | null | undefined,
  _provider: string,
): PilotDeckPermissionSuggestion | null {
  // migration every provider routes tool calls through the same gateway
  // PermissionContext, so the "Permission added" affordance is useful
  // regardless of which model is selected.
  if (!message?.toolResult?.isError) return null;
  if (isPlanModeToolDeny(message)) return null;

  // Only offer the rule-grant affordance for genuine permission failures.
  // For historical / replayed messages without an `errorCode` we fall back to
  // the legacy behaviour (showing the suggestion) so users on older
  // transcripts still see it.
  const errorCode = message.toolResult.errorCode;
  if (errorCode && !PERMISSION_ERROR_CODES.has(errorCode)) return null;

  const toolName = message?.toolName;
  const entry = buildPilotDeckToolPermissionEntry(toolName, message.toolInput);
  if (!entry) return null;

  const settings = getPilotDeckSettings();
  const isAllowed = settings.allowedTools.includes(entry);
  return { toolName: toolName || 'UnknownTool', entry, isAllowed };
}

export function grantPilotDeckToolPermission(entry: string | null): PermissionGrantResult {
  if (!entry) return { success: false };

  const settings = getPilotDeckSettings();
  const alreadyAllowed = settings.allowedTools.includes(entry);
  const nextAllowed = alreadyAllowed ? settings.allowedTools : [...settings.allowedTools, entry];
  const nextDisallowed = settings.disallowedTools.filter((tool) => tool !== entry);
  const updatedSettings = {
    ...settings,
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
    lastUpdated: new Date().toISOString(),
  };

  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(updatedSettings));
  savePilotDeckPermissionSettings({
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
  }).catch((error) => {
    console.error('Failed to persist granted permission to backend:', error);
  });
  return { success: true, alreadyAllowed, updatedSettings };
}
