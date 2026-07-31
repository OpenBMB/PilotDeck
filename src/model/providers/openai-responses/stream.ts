import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";
import {
  appendThinkingBlockText,
  clearThinkingBlock,
  clearThinkingBlocks,
  createThinkingBlockTracker,
  type ThinkingBlockTracker,
} from "../../streaming/thinkingBlock.js";

type ToolCallState = Partial<CanonicalToolCall> & {
  argumentsBuffer?: string;
  itemId?: string;
  outputIndex?: number;
};

export type OpenAIResponsesStreamState = {
  started: boolean;
  streamSyntheticId: string;
  responseId?: string;
  toolCalls: Map<string, ToolCallState>;
  completedToolCallKeys: Set<string>;
  usedToolCallIds: Set<string>;
  sawToolCall: boolean;
  thinkingBlocks: ThinkingBlockTracker;
};

export function createOpenAIResponsesStreamState(): OpenAIResponsesStreamState {
  return {
    started: false,
    streamSyntheticId: `stream_${randomUUID().slice(0, 12)}`,
    toolCalls: new Map(),
    completedToolCallKeys: new Set(),
    usedToolCallIds: new Set(),
    sawToolCall: false,
    thinkingBlocks: createThinkingBlockTracker(),
  };
}

export function normalizeOpenAIResponsesStreamEvent(
  raw: unknown,
  state: OpenAIResponsesStreamState = createOpenAIResponsesStreamState(),
): CanonicalModelEvent[] {
  const event = asRecord(raw);
  const type = typeof event.type === "string" ? event.type : "";
  const events: CanonicalModelEvent[] = [];
  const response = asRecord(event.response);
  const responseId = readNonEmptyString(response.id) ?? readNonEmptyString(event.response_id);
  if (responseId && !state.responseId) {
    state.responseId = responseId;
  }

  if ((type === "response.created" || type === "response.in_progress") && !state.started) {
    state.started = true;
    events.push({ type: "message_start", role: "assistant", raw });
  }

  if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0) {
    ensureStarted(events, state, raw);
    clearThinkingBlocks(state.thinkingBlocks);
    events.push({ type: "text_delta", text: event.delta, raw });
  }

  if (isReasoningDelta(type) && typeof event.delta === "string" && event.delta.length > 0) {
    ensureStarted(events, state, raw);
    events.push(...emitThinkingDelta(event, state, event.delta, raw));
  }

  if (type === "response.output_item.added") {
    clearThinkingBlocks(state.thinkingBlocks);
    events.push(...handleOutputItemAdded(event, state, raw));
  }

  if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
    ensureStarted(events, state, raw);
    clearThinkingBlocks(state.thinkingBlocks);
    const toolCall = ensureToolCall(event, state);
    toolCall.argumentsBuffer = `${toolCall.argumentsBuffer ?? ""}${event.delta}`;
    events.push({ type: "tool_call_delta", id: toolCall.id ?? "", delta: event.delta, raw });
  }

  if (type === "response.function_call_arguments.done") {
    ensureStarted(events, state, raw);
    clearThinkingBlocks(state.thinkingBlocks);
    if (isCompletedToolCall(event, state)) {
      return events;
    }
    const toolCall = ensureToolCall(event, state);
    if (typeof event.arguments === "string") {
      toolCall.argumentsBuffer = event.arguments;
    }
    events.push(finishToolCall(toolCall, raw));
    completeToolCall(event, state);
  }

  if (type === "response.output_item.done") {
    const item = asRecord(event.item);
    if (item.type === "function_call") {
      ensureStarted(events, state, raw);
      clearThinkingBlocks(state.thinkingBlocks);
      if (isCompletedToolCall({ ...event, item }, state)) {
        return events;
      }
      const toolCall = ensureToolCall({ ...event, item }, state);
      if (typeof item.arguments === "string") {
        toolCall.argumentsBuffer = item.arguments;
      }
      events.push(finishToolCall(toolCall, raw));
      completeToolCall({ ...event, item }, state);
    }
  }

  if (type === "response.completed") {
    ensureStarted(events, state, raw);
    clearThinkingBlocks(state.thinkingBlocks);
    const usage = normalizeOpenAIUsage(response.usage);
    if (usage) {
      events.push({ type: "usage", usage, raw });
    }
    for (const [key, toolCall] of state.toolCalls.entries()) {
      events.push(finishToolCall(toolCall, raw));
      state.toolCalls.delete(key);
    }
    events.push({ type: "message_end", finishReason: state.sawToolCall ? "tool_call" : "stop", raw });
  }

  if (type === "response.incomplete") {
    ensureStarted(events, state, raw);
    clearThinkingBlocks(state.thinkingBlocks);
    events.push({ type: "message_end", finishReason: "length", raw });
  }

  if (type === "response.failed" || type === "error") {
    if (type === "response.failed") {
      ensureStarted(events, state, raw);
    }
    clearThinkingBlocks(state.thinkingBlocks);
    const responseError = asRecord(response.error);
    const eventError = asRecord(event.error);
    const error = Object.keys(responseError).length > 0 ? responseError : eventError;
    events.push({
      type: "error",
      error: {
        provider: "openai-responses",
        protocol: "openai-responses",
        code: readNonEmptyString(error.code) ?? "provider_error",
        message: readNonEmptyString(error.message) ?? "OpenAI Responses request failed.",
        retryable: false,
        raw,
      },
    });
    if (type === "response.failed") {
      events.push({ type: "message_end", finishReason: "error", raw });
    }
  }

  return events;
}

function handleOutputItemAdded(
  event: Record<string, unknown>,
  state: OpenAIResponsesStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  const item = asRecord(event.item);
  if (item.type !== "function_call") {
    return [];
  }

  const events: CanonicalModelEvent[] = [];
  ensureStarted(events, state, raw);
  const key = toolCallKey(event, item);
  const existing = state.toolCalls.get(key);
  if (existing) {
    return events;
  }
  const toolCall: ToolCallState = {
    id: chooseToolCallId(state, readNonEmptyString(item.call_id) ?? readNonEmptyString(item.id)),
    name: readNonEmptyString(item.name) ?? "",
    itemId: readNonEmptyString(item.id),
    outputIndex: readNumber(event.output_index),
    argumentsBuffer: typeof item.arguments === "string" ? item.arguments : "",
  };
  state.sawToolCall = true;
  state.toolCalls.set(key, toolCall);
  events.push({
    type: "tool_call_start",
    id: toolCall.id ?? "call_missing",
    name: toolCall.name ?? "",
    raw,
  });
  return events;
}

function ensureToolCall(event: Record<string, unknown>, state: OpenAIResponsesStreamState): ToolCallState {
  const item = asRecord(event.item);
  const key = toolCallKey(event, item);
  let toolCall = state.toolCalls.get(key);
  if (!toolCall) {
    toolCall = {
      id: chooseToolCallId(state, readNonEmptyString(event.call_id) ?? readNonEmptyString(item.call_id)),
      name: readNonEmptyString(item.name) ?? "",
      itemId: readNonEmptyString(item.id) ?? readNonEmptyString(event.item_id),
      outputIndex: readNumber(event.output_index),
      argumentsBuffer: "",
    };
    state.sawToolCall = true;
    state.toolCalls.set(key, toolCall);
  }
  return toolCall;
}

function finishToolCall(toolCall: ToolCallState, raw: unknown): CanonicalModelEvent {
  const rawArguments = toolCall.argumentsBuffer ?? "{}";
  let input: unknown;
  let wasRepaired = false;
  try {
    input = JSON.parse(rawArguments || "{}");
  } catch {
    try {
      input = JSON.parse(jsonrepair(rawArguments));
      wasRepaired = true;
      console.warn(
        `[openai-responses-stream] repaired invalid JSON for tool "${toolCall.name ?? "?"}" `
        + `(buf_len=${rawArguments.length})`,
      );
    } catch {
      throw new ModelProviderError({
        provider: "openai-responses",
        protocol: "openai-responses",
        code: "invalid_tool_arguments",
        message: "OpenAI Responses stream tool call arguments are not valid JSON.",
        retryable: true,
        raw,
      });
    }
  }

  return {
    type: "tool_call_end",
    toolCall: {
      id: toolCall.id ?? "call_missing",
      name: toolCall.name ?? "",
      input,
      raw,
    },
    wasRepaired,
    raw,
  };
}

function completeToolCall(event: Record<string, unknown>, state: OpenAIResponsesStreamState): void {
  const item = asRecord(event.item);
  const key = toolCallKey(event, item);
  state.completedToolCallKeys.add(key);
  state.toolCalls.delete(key);
}

function isCompletedToolCall(event: Record<string, unknown>, state: OpenAIResponsesStreamState): boolean {
  const item = asRecord(event.item);
  return state.completedToolCallKeys.has(toolCallKey(event, item));
}

function toolCallKey(event: Record<string, unknown>, item: Record<string, unknown>): string {
  return readNonEmptyString(event.item_id)
    ?? readNonEmptyString(item.id)
    ?? readNonEmptyString(event.call_id)
    ?? readNonEmptyString(item.call_id)
    ?? `index:${readNumber(event.output_index) ?? 0}`;
}

function ensureStarted(
  events: CanonicalModelEvent[],
  state: OpenAIResponsesStreamState,
  raw: unknown,
): void {
  if (state.started) {
    return;
  }
  state.started = true;
  events.push({ type: "message_start", role: "assistant", raw });
}

function isReasoningDelta(type: string): boolean {
  return type === "response.reasoning_summary_text.delta"
    || type === "response.reasoning_text.delta"
    || type === "response.reasoning.delta";
}

function emitThinkingDelta(
  event: Record<string, unknown>,
  state: OpenAIResponsesStreamState,
  text: string,
  raw: unknown,
): CanonicalModelEvent[] {
  const key = thinkingBlockKey(event, state);
  const identity = appendThinkingBlockText(
    state.thinkingBlocks,
    key,
    text,
    {
      blockId: readNonEmptyString(event.item_id) ?? readNonEmptyString(asRecord(event.item).id),
      blockSeq: readNumber(event.output_index) ?? readNumber(event.content_index) ?? readNumber(event.sequence_number),
      idPrefix: "openai-responses-thinking",
    },
  ).identity;

  return [{
    type: "thinking_delta",
    text,
    thinkingBlockId: identity.thinkingBlockId,
    thinkingBlockSeq: identity.thinkingBlockSeq,
    raw,
  }];
}

function thinkingBlockKey(event: Record<string, unknown>, state: OpenAIResponsesStreamState): string {
  const item = asRecord(event.item);
  const index = readNumber(event.output_index) ?? readNumber(event.content_index) ?? readNumber(event.sequence_number);
  return readNonEmptyString(event.item_id)
    ?? readNonEmptyString(item.id)
    ?? readNonEmptyString(event.call_id)
    ?? readNonEmptyString(item.call_id)
    ?? (index !== undefined ? `index:${index}` : undefined)
    ?? `response:${state.responseId ?? state.streamSyntheticId}`;
}

function chooseToolCallId(state: OpenAIResponsesStreamState, incomingId: string | undefined): string {
  const candidate = incomingId !== undefined && !state.usedToolCallIds.has(incomingId)
    ? incomingId
    : `call_${safeToolCallIdPart(state.responseId ?? state.streamSyntheticId)}_${state.usedToolCallIds.size}`;
  const id = nextUniqueToolCallId(candidate, state.usedToolCallIds);
  state.usedToolCallIds.add(id);
  return id;
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "response";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
