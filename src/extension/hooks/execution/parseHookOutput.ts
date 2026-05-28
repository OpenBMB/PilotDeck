import type { PilotDeckHookOutput, PilotDeckHookSpecificOutput } from "../protocol/output.js";

export function parseHookOutput(stdout: string): PilotDeckHookOutput {
  const parsed = parseFirstJsonLine(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { type: "sync" };
  }

  const record = parsed as Record<string, unknown>;
  if (record.async === true) {
    return { type: "async", raw: parsed };
  }

  return {
    type: "sync",
    continue: booleanOrUndefined(record.continue),
    suppressOutput: booleanOrUndefined(record.suppressOutput),
    stopReason: stringOrUndefined(record.stopReason),
    decision: record.decision === "approve" || record.decision === "block" ? record.decision : undefined,
    reason: stringOrUndefined(record.reason),
    systemMessage: stringOrUndefined(record.systemMessage),
    specific: parseSpecificOutput(record.hookSpecificOutput),
    raw: parsed,
  };
}

function parseFirstJsonLine(stdout: string): unknown | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseSpecificOutput(value: unknown): PilotDeckHookSpecificOutput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.hookEventName !== "string") {
    return undefined;
  }

  return {
    hookEventName: record.hookEventName,
    additionalContext: stringOrUndefined(record.additionalContext),
    initialUserMessage: stringOrUndefined(record.initialUserMessage),
    watchPaths: Array.isArray(record.watchPaths)
      ? record.watchPaths.filter((item): item is string => typeof item === "string")
      : undefined,
    permissionDecision: parsePermissionDecision(record.permissionDecision),
    permissionDecisionReason: stringOrUndefined(record.permissionDecisionReason),
    updatedInput: isRecord(record.updatedInput) ? record.updatedInput : undefined,
    updatedMCPToolOutput: record.updatedMCPToolOutput,
    decision: parsePermissionRequestDecision(record.decision),
    retry: booleanOrUndefined(record.retry),
    worktreePath: stringOrUndefined(record.worktreePath),
  };
}

function parsePermissionDecision(value: unknown): PilotDeckHookSpecificOutput["permissionDecision"] {
  return value === "allow" || value === "deny" || value === "ask" || value === "passthrough" ? value : undefined;
}

function parsePermissionRequestDecision(value: unknown): PilotDeckHookSpecificOutput["decision"] {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: isRecord(value.updatedInput) ? value.updatedInput : undefined,
      updatedPermissions: Array.isArray(value.updatedPermissions) ? value.updatedPermissions : undefined,
    };
  }
  if (value.behavior === "deny") {
    return {
      behavior: "deny",
      message: stringOrUndefined(value.message),
      interrupt: booleanOrUndefined(value.interrupt),
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
