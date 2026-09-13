export const PILOTDECK_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  /**
   * @todo Notification — no semantic "user notification" scenario yet.
   * `broadcastNotification` is currently infrastructure-only (config reload).
   * Wire once Always-On task_notification or Feishu adapter matures.
   */
  "Notification",
  "UserPromptSubmit",
  "PreModelRequest",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "ConfigChange",
  "InstructionsLoaded",
  /**
   * @todo CwdChanged — only meaningful in Always-On workspace switching;
   * regular sessions have a fixed cwd. Wire once in-session cwd switching
   * is supported.
   */
  "CwdChanged",
  /** SDK FileChanged hooks are dispatched after successful native file writes. */
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "Elicitation",
  "ElicitationResult",
] as const;

export const PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS = [
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
] as const;

export type PilotDeckHookEvent = (typeof PILOTDECK_HOOK_EVENTS)[number];
export type PilotDeckNotApplicableLegacyHookEvent =
  (typeof PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS)[number];

export function isPilotDeckHookEvent(value: string): value is PilotDeckHookEvent {
  return (PILOTDECK_HOOK_EVENTS as readonly string[]).includes(value);
}
