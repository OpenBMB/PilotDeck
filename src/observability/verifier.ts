import type { ObservationEvent, ObservationRecorderStats } from "./protocol.js";

export type ObservationIntegrityStatus = "complete" | "partial" | "invalid";

export type ObservationIntegrityReport = {
  schemaVersion: "o1";
  status: ObservationIntegrityStatus;
  eventCount: number;
  checks: {
    schema: boolean;
    uniqueEventIds: boolean;
    monotonicSequence: boolean;
    modelRequestsPaired: boolean;
    toolCallsPaired: boolean;
    turnsPaired: boolean;
    secretBearingKeysAbsent: boolean;
    recorderHealthy: boolean;
  };
  omissions: Array<{ code: string; scope?: string }>;
  recorder: ObservationRecorderStats;
};

const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "password",
  "refreshtoken",
  "secret",
  "token",
]);

export function verifyObservationEvents(
  events: readonly ObservationEvent[],
  recorder: ObservationRecorderStats,
): ObservationIntegrityReport {
  const omissions: ObservationIntegrityReport["omissions"] = [];
  const ids = new Set<string>();
  let uniqueEventIds = true;
  let monotonicSequence = true;
  let previousSequence = 0;
  let schema = true;

  for (const event of events) {
    if (event.schemaVersion !== "1.0" || typeof event.eventId !== "string") schema = false;
    if (ids.has(event.eventId)) uniqueEventIds = false;
    ids.add(event.eventId);
    if (event.sequence <= previousSequence) monotonicSequence = false;
    previousSequence = event.sequence;
  }

  const sentRequests = valuesByPayload(events, "model.request.sent", "requestId");
  const terminalRequests = [
    ...valuesByPayload(events, "model.response.received", "requestId"),
    ...valuesByPayload(events, "model.request.failed", "requestId"),
  ];
  const modelRequestsPaired = exactlyPaired(sentRequests, terminalRequests, omissions, {
    duplicateStart: "model_request_id_duplicate",
    missingTerminal: "model_request_terminal_missing",
    duplicateTerminal: "model_request_terminal_duplicate",
    missingStart: "model_request_start_missing",
  });

  const toolStarts = valuesByPayload(events, "tool.call.started", "toolCallId");
  const toolTerminals = valuesByPayload(events, "tool.call.completed", "toolCallId");
  const toolCallsPaired = exactlyPaired(toolStarts, toolTerminals, omissions, {
    duplicateStart: "tool_call_id_duplicate",
    missingTerminal: "tool_call_terminal_missing",
    duplicateTerminal: "tool_call_terminal_duplicate",
    missingStart: "tool_call_start_missing",
  });

  const turnStarts = keysForTurns(events, "turn.started");
  const turnTerminals = new Set([
    ...keysForTurns(events, "turn.completed"),
    ...keysForTurns(events, "turn.failed"),
  ]);
  const turnsPaired = allResolved(turnStarts, turnTerminals, omissions, "turn_terminal_missing");
  const secretBearingKeysAbsent = !events.some((event) => containsSecretBearingKey(event));
  if (!secretBearingKeysAbsent) omissions.push({ code: "secret_bearing_key_persisted" });
  const recorderHealthy = recorder.droppedEvents === 0 && recorder.writeErrors.length === 0;
  if (recorder.droppedEvents > 0) omissions.push({ code: "observation_gap" });
  if (recorder.writeErrors.length > 0) omissions.push({ code: "recorder_write_failed" });

  const checks = {
    schema,
    uniqueEventIds,
    monotonicSequence,
    modelRequestsPaired,
    toolCallsPaired,
    turnsPaired,
    secretBearingKeysAbsent,
    recorderHealthy,
  };
  const invalid = !schema || !uniqueEventIds || !monotonicSequence || !secretBearingKeysAbsent;
  const partial = !modelRequestsPaired || !toolCallsPaired || !turnsPaired || !recorderHealthy;
  return {
    schemaVersion: "o1",
    status: invalid ? "invalid" : partial ? "partial" : "complete",
    eventCount: events.length,
    checks,
    omissions,
    recorder,
  };
}

function valuesByPayload(events: readonly ObservationEvent[], type: string, field: string): string[] {
  const values: string[] = [];
  for (const event of events) {
    const value = event.type === type ? event.payload[field] : undefined;
    if (typeof value === "string") values.push(value);
  }
  return values;
}

function exactlyPaired(
  starts: readonly string[],
  terminals: readonly string[],
  omissions: ObservationIntegrityReport["omissions"],
  codes: {
    duplicateStart: string;
    missingTerminal: string;
    duplicateTerminal: string;
    missingStart: string;
  },
): boolean {
  const startCounts = countValues(starts);
  const terminalCounts = countValues(terminals);
  let paired = true;
  for (const [value, startCount] of startCounts) {
    if (startCount !== 1) {
      paired = false;
      omissions.push({ code: codes.duplicateStart, scope: value });
    }
    const terminalCount = terminalCounts.get(value) ?? 0;
    if (terminalCount === 0) {
      paired = false;
      omissions.push({ code: codes.missingTerminal, scope: value });
    } else if (terminalCount !== 1) {
      paired = false;
      omissions.push({ code: codes.duplicateTerminal, scope: value });
    }
  }
  for (const value of terminalCounts.keys()) {
    if (!startCounts.has(value)) {
      paired = false;
      omissions.push({ code: codes.missingStart, scope: value });
    }
  }
  return paired;
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function keysForTurns(events: readonly ObservationEvent[], type: string): Set<string> {
  return new Set(events
    .filter((event) => event.type === type && event.turnId)
    .map((event) => `${event.sessionId}:${event.turnId}`));
}

function allResolved(
  started: Set<string>,
  completed: Set<string>,
  omissions: ObservationIntegrityReport["omissions"],
  code: string,
): boolean {
  let resolved = true;
  for (const value of started) {
    if (!completed.has(value)) {
      resolved = false;
      omissions.push({ code, scope: value });
    }
  }
  return resolved;
}

function containsSecretBearingKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretBearingKey);
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) return true;
    if (containsSecretBearingKey(entry)) return true;
  }
  return false;
}
