import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { AgentPermissionDenial } from "../../agent/protocol/result.js";

export function checkpointRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} checkpoint must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} checkpoint must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function checkpointArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} checkpoint must be an array.`);
  }
  return value;
}

export function checkpointStringArray(value: unknown, label: string): string[] {
  const values = checkpointArray(value, label);
  if (!values.every((item) => typeof item === "string")) {
    throw new TypeError(`${label} checkpoint must contain only strings.`);
  }
  return [...values] as string[];
}

export function checkpointInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} checkpoint must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

export function checkpointJsonSnapshot<Value>(value: Value, label: string): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${label} checkpoint is not JSON serializable.`);
  }
  return JSON.parse(serialized) as unknown;
}

export function checkpointTranscriptEntry<Type extends AgentTranscriptEntry["type"]>(
  value: unknown,
  types: readonly Type[],
  label: string,
): AgentTranscriptEntry & { type: Type } {
  const entry = checkpointRecord(value, label);
  if (
    !types.includes(entry.type as Type) ||
    typeof entry.sessionId !== "string" ||
    typeof entry.turnId !== "string" ||
    !Number.isSafeInteger(entry.sequence) ||
    (entry.sequence as number) <= 0 ||
    typeof entry.createdAt !== "string"
  ) {
    throw new TypeError(`${label} checkpoint contains an invalid transcript entry.`);
  }
  validateTranscriptEntryPayload(entry, label);
  return structuredClone(entry) as AgentTranscriptEntry & { type: Type };
}

export function checkpointTranscriptEntries<Type extends AgentTranscriptEntry["type"]>(
  value: unknown,
  types: readonly Type[],
  label: string,
): Array<AgentTranscriptEntry & { type: Type }> {
  return checkpointArray(value, label).map((entry, index) =>
    checkpointTranscriptEntry(entry, types, `${label}[${index}]`));
}

export function checkpointOptionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : structuredClone(checkpointRecord(value, label));
}

export function checkpointCanonicalUsage(value: unknown, label: string): CanonicalUsage {
  const record = checkpointRecord(value, label);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "nativeCost",
  ]) {
    const field = record[key];
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field) || field < 0)) {
      throw new TypeError(`${label}.${key} checkpoint must be a finite non-negative number.`);
    }
  }
  return structuredClone(record) as CanonicalUsage;
}

export function checkpointPermissionDenials(
  value: unknown,
  label: string,
): AgentPermissionDenial[] {
  return checkpointArray(value, label).map((item, index) => {
    const denial = checkpointRecord(item, `${label}[${index}]`);
    if (
      typeof denial.toolName !== "string" ||
      typeof denial.toolCallId !== "string" ||
      (denial.errorCode !== undefined && typeof denial.errorCode !== "string")
    ) {
      throw new TypeError(`${label}[${index}] checkpoint is invalid.`);
    }
    return structuredClone(denial) as AgentPermissionDenial;
  });
}

function validateTranscriptEntryPayload(entry: Record<string, unknown>, label: string): void {
  switch (entry.type) {
    case "accepted_input":
      checkpointCanonicalMessages(entry.messages, `${label}.messages`);
      return;
    case "assistant_message":
    case "tool_result_message":
    case "durable_message":
      checkpointCanonicalMessage(entry.message, `${label}.message`);
      return;
    case "context_snapshot":
      if (!Number.isSafeInteger(entry.step) || (entry.step as number) <= 0) {
        throw new TypeError(`${label}.step checkpoint is invalid.`);
      }
      checkpointArray(entry.contexts, `${label}.contexts`).forEach((context, index) => {
        const item = checkpointRecord(context, `${label}.contexts[${index}]`);
        if (typeof item.name !== "string" || typeof item.text !== "string") {
          throw new TypeError(`${label}.contexts[${index}] checkpoint is invalid.`);
        }
      });
      if (entry.runtimeContextMessages !== undefined) {
        checkpointCanonicalMessages(entry.runtimeContextMessages, `${label}.runtimeContextMessages`);
      }
      return;
    case "turn_result": {
      const result = checkpointRecord(entry.result, `${label}.result`);
      if (
        !["success", "error", "aborted", "max_turns"].includes(String(result.type)) ||
        typeof result.sessionId !== "string" ||
        typeof result.turnId !== "string" ||
        typeof result.stopReason !== "string" ||
        !Number.isSafeInteger(result.turns) ||
        (result.turns as number) < 0 ||
        typeof result.startedAt !== "string" ||
        typeof result.completedAt !== "string"
      ) {
        throw new TypeError(`${label}.result checkpoint is invalid.`);
      }
      checkpointCanonicalUsage(result.usage, `${label}.result.usage`);
      checkpointPermissionDenials(result.permissionDenials, `${label}.result.permissionDenials`);
      if (result.errors !== undefined) {
        checkpointArray(result.errors, `${label}.result.errors`).forEach((error, index) => {
          checkpointRecord(error, `${label}.result.errors[${index}]`);
        });
      }
      return;
    }
    case "control_boundary": {
      const boundary = checkpointRecord(entry.boundary, `${label}.boundary`);
      if (boundary.kind !== "compact" && boundary.kind !== "resume" && boundary.kind !== "manual") {
        throw new TypeError(`${label}.boundary checkpoint is invalid.`);
      }
      if (
        boundary.kind === "compact" &&
        boundary.subtype === "compact_boundary" &&
        boundary.snapshot !== undefined
      ) {
        const snapshot = checkpointRecord(boundary.snapshot, `${label}.boundary.snapshot`);
        if (snapshot.version !== 1) {
          throw new TypeError(`${label}.boundary.snapshot version is invalid.`);
        }
        checkpointCanonicalMessages(snapshot.messages, `${label}.boundary.snapshot.messages`);
      }
      if (
        boundary.kind === "compact" &&
        boundary.subtype === "compact_boundary" &&
        boundary.replacementMessages !== undefined
      ) {
        checkpointCanonicalMessages(boundary.replacementMessages, `${label}.boundary.replacementMessages`);
      }
      return;
    }
    case "subagent_started":
      requireFields(entry, label, ["subagentId", "subagentType", "promptPreview", "transcriptRelativePath"]);
      if (typeof entry.promptTruncated !== "boolean") {
        throw new TypeError(`${label}.promptTruncated checkpoint is invalid.`);
      }
      return;
    case "subagent_descriptor": {
      const descriptor = checkpointRecord(entry.descriptor, `${label}.descriptor`);
      const fields = descriptor.version === 1
        ? ["version", "mode", "provider", "definitionId"]
        : descriptor.version === 2
          ? [
              "version",
              "mode",
              "provider",
              "definitionId",
              "parentSessionId",
              "label",
              "agentProvider",
              "agentModel",
            ]
          : undefined;
      const mode = descriptor.version === 1 ? "one-shot" : "continuable";
      if (!fields || descriptor.mode !== mode || Object.keys(descriptor).some((field) => !fields.includes(field))) {
        throw new TypeError(`${label}.descriptor checkpoint is invalid.`);
      }
      requireNonEmptyFields(descriptor, `${label}.descriptor`, fields.slice(2));
      return;
    }
    case "subagent_completed":
      requireFields(entry, label, ["subagentId", "subagentType", "summaryPreview"]);
      if (
        typeof entry.summaryTruncated !== "boolean" ||
        !Number.isSafeInteger(entry.turns) ||
        !Number.isFinite(entry.durationMs)
      ) {
        throw new TypeError(`${label} checkpoint is invalid.`);
      }
      return;
    case "file_snapshot_recorded": {
      requireFields(entry, label, ["messageId", "timestamp"]);
      if (entry.snapshotKind !== "create" && entry.snapshotKind !== "update") {
        throw new TypeError(`${label}.snapshotKind checkpoint is invalid.`);
      }
      const backups = checkpointRecord(entry.trackedFileBackups, `${label}.trackedFileBackups`);
      for (const [path, value] of Object.entries(backups)) {
        const backup = checkpointRecord(value, `${label}.trackedFileBackups.${path}`);
        if (
          (backup.backupFileName !== null && typeof backup.backupFileName !== "string") ||
          !Number.isSafeInteger(backup.version) ||
          typeof backup.backupTime !== "string" ||
          (backup.mode !== undefined && !Number.isSafeInteger(backup.mode))
        ) {
          throw new TypeError(`${label}.trackedFileBackups.${path} checkpoint is invalid.`);
        }
      }
      return;
    }
    case "file_artifacts":
      checkpointArray(entry.artifacts, `${label}.artifacts`).forEach((artifact, index) => {
        const record = checkpointRecord(artifact, `${label}.artifacts[${index}]`);
        requireFields(record, `${label}.artifacts[${index}]`, ["id", "name", "path", "createdAt"]);
        if (
          (record.operation !== "created" && record.operation !== "updated") ||
          (record.source !== "tool" && record.source !== "workspace_diff") ||
          (record.status !== "complete" && record.status !== "incomplete") ||
          typeof record.size !== "number" ||
          typeof record.sha256 !== "string"
        ) {
          throw new TypeError(`${label}.artifacts[${index}] checkpoint is invalid.`);
        }
      });
      return;
    case "agent_status_message":
      requireFields(entry, label, ["event", "text"]);
      if (entry.kind !== "status" && entry.kind !== "error") {
        throw new TypeError(`${label}.kind checkpoint is invalid.`);
      }
      return;
    case "goal_changed": {
      if (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1) {
        throw new TypeError(`${label}.revision checkpoint is invalid.`);
      }
      if (entry.goal !== null) {
        const goal = checkpointRecord(entry.goal, `${label}.goal`);
        if (
          typeof goal.id !== "string" || typeof goal.objective !== "string"
          || goal.revision !== entry.revision
          || !["active", "paused", "blocked", "complete"].includes(String(goal.phase))
        ) {
          throw new TypeError(`${label}.goal checkpoint is invalid.`);
        }
      }
      return;
    }
    default:
      return;
  }
}

export function checkpointCanonicalMessages(value: unknown, label: string): CanonicalMessage[] {
  return checkpointArray(value, label).map((message, index) =>
    checkpointCanonicalMessage(message, `${label}[${index}]`));
}

function checkpointCanonicalMessage(value: unknown, label: string): CanonicalMessage {
  const message = checkpointRecord(value, label);
  if (message.role !== "user" && message.role !== "assistant") {
    throw new TypeError(`${label}.role checkpoint is invalid.`);
  }
  checkpointArray(message.content, `${label}.content`).forEach((block, index) => {
    const record = checkpointRecord(block, `${label}.content[${index}]`);
    if (typeof record.type !== "string") {
      throw new TypeError(`${label}.content[${index}].type checkpoint is invalid.`);
    }
    if (record.type === "tool_result") {
      checkpointArray(record.content, `${label}.content[${index}].content`);
    }
  });
  return structuredClone(message) as CanonicalMessage;
}

function requireFields(record: Record<string, unknown>, label: string, fields: readonly string[]): void {
  if (fields.some((field) => typeof record[field] !== "string")) {
    throw new TypeError(`${label} checkpoint is missing required string fields.`);
  }
}

function requireNonEmptyFields(
  record: Record<string, unknown>,
  label: string,
  fields: readonly string[],
): void {
  if (fields.some((field) => typeof record[field] !== "string" || record[field].trim().length === 0)) {
    throw new TypeError(`${label} checkpoint is missing required non-empty string fields.`);
  }
}
