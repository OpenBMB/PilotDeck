import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";

export type ThinkFsmMode = "NORMAL" | "THINKING";

type OpenAIStreamToolCallState = Partial<CanonicalToolCall> & {
  argumentsBuffer?: string;
  choiceIndex: number;
  toolIndex: number;
};

export type OpenAIStreamState = {
  started: boolean;
  toolCalls: Map<string, OpenAIStreamToolCallState>;
  usedToolCallIds: Set<string>;
  streamSyntheticId: string;
  streamResponseId?: string;
  toolCallBaseId?: string;
  thinkFsm: ThinkFsmMode;
  tagBuffer: string;
  reasoningSnapshot: string;
};

export function createOpenAIStreamState(): OpenAIStreamState {
  return {
    started: false,
    toolCalls: new Map(),
    usedToolCallIds: new Set(),
    streamSyntheticId: `stream_${randomUUID().slice(0, 12)}`,
    thinkFsm: "NORMAL",
    tagBuffer: "",
    reasoningSnapshot: "",
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * FSM-based parser that splits `<think>...</think>` tags from streamed
 * `delta.content` into separate `thinking_delta` / `text_delta` events.
 * Handles tags split across multiple chunks via `state.tagBuffer`.
 *
 * FSM that splits reasoning tags from streamed content deltas.
 */
export function splitThinkContent(
  content: string,
  state: OpenAIStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];
  let current = state.tagBuffer + content;
  state.tagBuffer = "";

  while (current.length > 0) {
    if (state.thinkFsm === "NORMAL") {
      const idx = current.indexOf(THINK_OPEN);
      if (idx !== -1) {
        const before = current.substring(0, idx);
        if (before.length > 0) {
          events.push({ type: "text_delta", text: before, raw });
        }
        current = current.substring(idx + THINK_OPEN.length);
        state.thinkFsm = "THINKING";
      } else {
        // Check if the tail could be a partial `<think>` open tag
        const buffered = bufferPartialTag(current, THINK_OPEN);
        if (buffered > 0) {
          state.tagBuffer = current.substring(current.length - buffered);
          const safe = current.substring(0, current.length - buffered);
          if (safe.length > 0) {
            events.push({ type: "text_delta", text: safe, raw });
          }
        } else {
          events.push({ type: "text_delta", text: current, raw });
        }
        current = "";
      }
    } else {
      // THINKING state
      const idx = current.indexOf(THINK_CLOSE);
      if (idx !== -1) {
        const before = current.substring(0, idx);
        if (before.length > 0) {
          events.push({ type: "thinking_delta", text: before, raw });
        }
        current = current.substring(idx + THINK_CLOSE.length);
        state.thinkFsm = "NORMAL";
      } else {
        // Check if the tail could be a partial `</think>` close tag
        const buffered = bufferPartialTag(current, THINK_CLOSE);
        if (buffered > 0) {
          state.tagBuffer = current.substring(current.length - buffered);
          const safe = current.substring(0, current.length - buffered);
          if (safe.length > 0) {
            events.push({ type: "thinking_delta", text: safe, raw });
          }
        } else {
          events.push({ type: "thinking_delta", text: current, raw });
        }
        current = "";
      }
    }
  }

  return events;
}

/**
 * Returns the number of characters at the end of `text` that match a
 * prefix of `tag`. Used to detect partial tags split across chunks.
 */
function bufferPartialTag(text: string, tag: string): number {
  const maxCheck = Math.min(tag.length - 1, text.length);
  for (let i = maxCheck; i > 0; i--) {
    if (text.endsWith(tag.substring(0, i))) {
      return i;
    }
  }
  return 0;
}

export function normalizeOpenAIStreamEvent(
  raw: unknown,
  state: OpenAIStreamState = createOpenAIStreamState(),
): CanonicalModelEvent[] {
  const chunk = asRecord(raw);
  const events: CanonicalModelEvent[] = [];
  const responseId = readNonEmptyString(chunk.id);
  if (responseId !== undefined && state.streamResponseId === undefined) {
    state.streamResponseId = responseId;
  }

  if (!state.started) {
    state.started = true;
    events.push({ type: "message_start", role: "assistant", raw });
  }

  const usage = normalizeOpenAIUsage(chunk.usage);
  if (usage) {
    events.push({ type: "usage", usage, raw });
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (let choicePosition = 0; choicePosition < choices.length; choicePosition += 1) {
    const choice = choices[choicePosition];
    const choiceRecord = asRecord(choice);
    const choiceIndex = typeof choiceRecord.index === "number" ? choiceRecord.index : choicePosition;
    const delta = asRecord(choiceRecord.delta);

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push(...splitThinkContent(delta.content, state, raw));
    }

    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      const prev = state.reasoningSnapshot;
      let emit: string;
      if (reasoning.startsWith(prev)) {
        emit = reasoning.slice(prev.length);
        state.reasoningSnapshot = reasoning;
      } else {
        emit = reasoning;
        state.reasoningSnapshot = prev + reasoning;
      }
      if (emit.length > 0) {
        events.push({ type: "thinking_delta", text: emit, raw });
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      events.push(...toolCallEvents(delta.tool_calls, state, raw, choiceIndex));
    }

    if (choiceRecord.finish_reason) {
      const fr = normalizeOpenAIFinishReason(choiceRecord.finish_reason);
      events.push(...finishToolCalls(state, raw, fr, choiceIndex));
      events.push({ type: "message_end", finishReason: fr, raw });
    }
  }

  return events;
}

function toolCallEvents(
  deltas: unknown[],
  state: OpenAIStreamState,
  raw: unknown,
  choiceIndex: number,
): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];

  for (const delta of deltas) {
    const record = asRecord(delta);
    const toolIndex = typeof record.index === "number" ? record.index : 0;
    const key = streamToolCallKey(choiceIndex, toolIndex);
    const fn = asRecord(record.function);
    const hasExistingCall = state.toolCalls.has(key);
    const current = state.toolCalls.get(key) ?? { choiceIndex, toolIndex };

    const incomingId = readNonEmptyString(record.id);
    // Only adopt a non-empty name. Some providers send the real name in the
    // first chunk, then `function.name: ""` in later argument-only chunks;
    // overwriting with the empty string would emit a nameless tool call and
    // trigger a `tool_not_found: Tool "" does not exist` loop.
    const name = readNonEmptyString(fn.name);
    if (name !== undefined) {
      current.name = name;
    }

    if (!hasExistingCall) {
      current.id = chooseStreamToolCallId(state, incomingId, choiceIndex, toolIndex);
      state.toolCalls.set(key, current);
      events.push({
        type: "tool_call_start",
        id: current.id,
        name: current.name ?? "",
        raw,
      });
    }

    if (typeof fn.arguments === "string") {
      const currentId = current.id ?? chooseStreamToolCallId(state, undefined, choiceIndex, toolIndex);
      current.id = currentId;
      current.argumentsBuffer = `${current.argumentsBuffer ?? ""}${fn.arguments}`;
      events.push({
        type: "tool_call_delta",
        id: currentId,
        delta: fn.arguments,
        raw,
      });
    }

    state.toolCalls.set(key, current);
  }

  return events;
}

function finishToolCalls(
  state: OpenAIStreamState,
  raw: unknown,
  finishReason?: string,
  choiceIndex?: number,
): CanonicalModelEvent[] {
  const events: CanonicalModelEvent[] = [];
  const isTruncation = finishReason === "length";

  for (const [key, toolCall] of state.toolCalls.entries()) {
    if (choiceIndex !== undefined && toolCall.choiceIndex !== choiceIndex) {
      continue;
    }
    const rawArguments = toolCall.argumentsBuffer ?? "{}";
    let input: unknown;
    let wasRepaired = false;
    try {
      input = JSON.parse(rawArguments);
    } catch {
      try {
        const repaired = jsonrepair(rawArguments);
        input = JSON.parse(repaired);
        wasRepaired = true;
        console.warn(
          `[openai-stream] repaired invalid JSON for tool "${toolCall.name ?? "?"}" (buf_len=${rawArguments.length})`,
        );
      } catch {
        const preview = rawArguments.length > 500
          ? rawArguments.slice(0, 250) + "\n…[truncated]…\n" + rawArguments.slice(-250)
          : rawArguments;
        const code = isTruncation ? "max_output_reached" : "invalid_tool_arguments";
        console.error(
          `[openai-stream] ${code} for tool "${toolCall.name ?? "?"}" (index=${key}, `
          + `buf_len=${rawArguments.length}):\n${preview}`,
        );
        throw new ModelProviderError({
          provider: "openai",
          protocol: "openai",
          code,
          message: isTruncation
            ? "Output token limit reached — tool call arguments were truncated."
            : "OpenAI stream tool call arguments are not valid JSON.",
          retryable: true,
          raw,
        });
      }
    }

    // jsonrepair may silently produce truncated content values; when the
    // response was cut by max_tokens, treat repaired tool calls the same
    // as parse failures so the recovery loop retries with more tokens.
    if (wasRepaired && isTruncation) {
      console.warn(
        `[openai-stream] discarding repaired-but-truncated tool call "${toolCall.name ?? "?"}" (index=${key})`,
      );
      throw new ModelProviderError({
        provider: "openai",
        protocol: "openai",
        code: "max_output_reached",
        message: "Output token limit reached — repaired tool call arguments are likely incomplete.",
        retryable: true,
        raw,
      });
    }

    events.push({
      type: "tool_call_end",
      toolCall: {
        id: toolCall.id ?? chooseStreamToolCallId(state, undefined, toolCall.choiceIndex, toolCall.toolIndex),
        name: toolCall.name ?? "",
        input,
        raw,
      },
      wasRepaired,
      raw,
    });
    state.toolCalls.delete(key);
  }

  return events;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function streamToolCallKey(choiceIndex: number, toolIndex: number): string {
  return `${choiceIndex}:${toolIndex}`;
}

function chooseStreamToolCallId(
  state: OpenAIStreamState,
  incomingId: string | undefined,
  choiceIndex: number,
  toolIndex: number,
): string {
  const candidate = incomingId !== undefined && !state.usedToolCallIds.has(incomingId)
    ? incomingId
    : generateStreamToolCallId(state, choiceIndex, toolIndex);
  const id = nextUniqueToolCallId(candidate, state.usedToolCallIds);
  state.usedToolCallIds.add(id);
  return id;
}

function generateStreamToolCallId(
  state: OpenAIStreamState,
  choiceIndex: number,
  toolIndex: number,
): string {
  const base = getStreamToolCallBaseId(state);
  return `call_${base}_${choiceIndex}_${toolIndex}`;
}

function getStreamToolCallBaseId(state: OpenAIStreamState): string {
  if (state.toolCallBaseId === undefined) {
    state.toolCallBaseId = safeToolCallIdPart(state.streamResponseId ?? state.streamSyntheticId);
  }
  return state.toolCallBaseId;
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

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "stream";
}
