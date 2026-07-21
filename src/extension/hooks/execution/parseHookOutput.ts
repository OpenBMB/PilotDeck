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
    modelRequestPatch: parseModelRequestPatch(record.modelRequestPatch),
    artifactContracts: parseArtifactContracts(record.artifactContracts),
    dynamicContext: parseDynamicContext(record.dynamicContext),
  };
}

function parseDynamicContext(value: unknown): PilotDeckHookSpecificOutput["dynamicContext"] {
  if (!Array.isArray(value)) return undefined;
  const entries = value.slice(0, 64).flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string") return [];
    const id = item.id.trim().slice(0, 128);
    const content = item.content.trim();
    if (!id || !content) return [];
    const priority: "critical" | "high" | "normal" | "low" | undefined = item.priority === "critical" || item.priority === "high"
      || item.priority === "normal" || item.priority === "low"
      ? item.priority
      : undefined;
    const ttlMs = typeof item.ttlMs === "number" && Number.isFinite(item.ttlMs) && item.ttlMs > 0
      ? Math.min(Math.floor(item.ttlMs), 24 * 60 * 60 * 1_000)
      : undefined;
    return [{ id, content, priority, ttlMs }];
  });
  return entries.length > 0 ? entries : undefined;
}

function parseArtifactContracts(value: unknown): PilotDeckHookSpecificOutput["artifactContracts"] {
  if (!Array.isArray(value)) return undefined;
  const contracts = value.slice(0, 32).flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.path !== "string") return [];
    return [{
      id: item.id,
      path: item.path,
      required: typeof item.required === "boolean" ? item.required : undefined,
      validatorIds: Array.isArray(item.validatorIds) ? item.validatorIds.filter((entry): entry is string => typeof entry === "string") : undefined,
      expectedExtensions: Array.isArray(item.expectedExtensions) ? item.expectedExtensions.filter((entry): entry is string => typeof entry === "string") : undefined,
      options: isRecord(item.options) ? item.options : undefined,
      domainId: typeof item.domainId === "string" ? item.domainId : undefined,
    }];
  });
  return contracts.length > 0 ? contracts : undefined;
}

function parseModelRequestPatch(value: unknown): PilotDeckHookSpecificOutput["modelRequestPatch"] {
  if (!isRecord(value)) return undefined;
  const patch: NonNullable<PilotDeckHookSpecificOutput["modelRequestPatch"]> = {};
  if (typeof value.provider === "string" && value.provider.trim().length > 0) patch.provider = value.provider;
  if (typeof value.model === "string" && value.model.trim().length > 0) patch.model = value.model;
  if (typeof value.maxOutputTokens === "number" && Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens > 0) {
    patch.maxOutputTokens = value.maxOutputTokens;
  }
  if (typeof value.temperature === "number" && Number.isFinite(value.temperature)) patch.temperature = value.temperature;
  if (isRecord(value.metadata)) patch.metadata = value.metadata;
  return Object.keys(patch).length > 0 ? patch : undefined;
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
