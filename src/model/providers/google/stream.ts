import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import {
  normalizeGoogleFinishReason,
  normalizeGoogleUsage,
} from "./response.js";

type GoogleStreamToolCallState = {
  baseId: string;
  usedIds: Set<string>;
};

export type GoogleStreamState = {
  started: boolean;
  ended: boolean;
  toolCalls: GoogleStreamToolCallState;
};

export function createGoogleStreamState(): GoogleStreamState {
  return {
    started: false,
    ended: false,
    toolCalls: {
      baseId: "google_stream",
      usedIds: new Set(),
    },
  };
}

export function normalizeGoogleStreamEvent(
  raw: unknown,
  state: GoogleStreamState = createGoogleStreamState(),
): CanonicalModelEvent[] {
  const chunk = asRecord(raw);
  const events: CanonicalModelEvent[] = [];

  if (!state.started) {
    state.started = true;
    const responseId = readString(chunk.responseId);
    if (responseId) {
      state.toolCalls.baseId = safeToolCallIdPart(responseId);
    }
    events.push({ type: "message_start", role: "assistant", raw });
  }

  const usage = normalizeGoogleUsage(chunk.usageMetadata);
  if (usage) {
    events.push({ type: "usage", usage, raw });
  }

  for (const candidate of readCandidates(chunk)) {
    for (const part of readParts(candidate)) {
      events.push(...partEvents(part, state, raw));
    }

    if (candidate.finishReason) {
      state.ended = true;
      events.push({
        type: "message_end",
        finishReason: normalizeGoogleFinishReason(candidate.finishReason),
        raw,
      });
    }
  }

  return events;
}

function partEvents(part: unknown, state: GoogleStreamState, raw: unknown): CanonicalModelEvent[] {
  const record = asRecord(part);
  const text = readString(record.text);
  if (text !== undefined) {
    if (record.thought === true) {
      return [{ type: "thinking_delta", text, signature: readString(record.thoughtSignature), raw }];
    }
    return text.length > 0 ? [{ type: "text_delta", text, raw }] : [];
  }

  const functionCall = asRecord(record.functionCall);
  if (Object.keys(functionCall).length > 0) {
    const toolCall = toToolCall(functionCall, state.toolCalls, raw);
    const args = JSON.stringify(toolCall.input ?? {});
    return [
      { type: "tool_call_start", id: toolCall.id, name: toolCall.name, raw },
      ...(args.length > 0 ? [{ type: "tool_call_delta" as const, id: toolCall.id, delta: args, raw }] : []),
      { type: "tool_call_end", toolCall, raw },
    ];
  }

  return [];
}

function toToolCall(
  functionCall: Record<string, unknown>,
  state: GoogleStreamToolCallState,
  raw: unknown,
): CanonicalToolCall {
  return {
    id: chooseToolCallId(state, readString(functionCall.id)),
    name: readString(functionCall.name) ?? "",
    input: toToolInput(functionCall.args),
    raw,
  };
}

function toToolInput(args: unknown): unknown {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function chooseToolCallId(state: GoogleStreamToolCallState, incomingId: string | undefined): string {
  const candidate = incomingId ? safeToolCallIdPart(incomingId) : `call_${state.baseId}_${state.usedIds.size}`;
  const unique = nextUniqueToolCallId(candidate, state.usedIds);
  state.usedIds.add(unique);
  return unique;
}

function nextUniqueToolCallId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    return id;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function readCandidates(chunk: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(chunk.candidates) ? chunk.candidates.map(asRecord) : [];
}

function readParts(candidate: Record<string, unknown>): unknown[] {
  const content = asRecord(candidate.content);
  return Array.isArray(content.parts) ? content.parts : [];
}

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "google";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
