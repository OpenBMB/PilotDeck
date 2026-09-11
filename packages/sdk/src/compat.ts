import type { PilotDeckResolvedSettings } from "./types.js";

/**
 * Public Claude hook event names. The tuple is informational; the Gateway
 * still validates which events have a native PilotDeck lifecycle emitter.
 */
export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification",
  "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch",
  "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
  "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove",
  "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
] as const;

/**
 * Claude's trust-tier helper has no PilotDeck equivalent because PilotDeck
 * does not expose a Claude-style `permissions.defaultMode` settings cascade.
 * Returning a deep clone preserves the useful pure-helper contract without
 * inventing a security decision or mutating the Gateway-owned snapshot.
 */
export function filterEscalatingDefaultMode(resolved: PilotDeckResolvedSettings): Record<string, unknown> {
  return structuredClone(resolved.config);
}
