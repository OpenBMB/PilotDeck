import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";

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
  reasoningSnapshot: string;
};

export function createOpenAIStreamState(): OpenAIStreamState {
  return {
    started: false,
    toolCalls: new Map(),
    usedToolCallIds: new Set(),
    streamSyntheticId: `stream_${randomUUID().slice(0, 12)}`,
    reasoningSnapshot: "",
  };
}

export function normalizeOpenAIStreamEvent(
  raw: unknown,
  state: OpenAIStreamState = createOpenAIStreamState(),
): CanonicalModelEvent[] {
  const chunk = asRecord(raw);
  const events: CanonicalModelEvent[] = [];
  const error = asRecord(chunk.error);
  if (Object.keys(error).length > 0) {
    const code = readNonEmptyString(error.type) ?? readNonEmptyString(error.code) ?? "provider_error";
    return [{
      type: "error",
      error: {
        provider: "openai",
        protocol: "openai",
        code,
        message: readNonEmptyString(error.message) ?? "OpenAI stream request failed.",
        retryable: code === "rate_limit_error" || code === "overloaded_error" || code === "server_error" || code === "timeout_error",
        raw,
      },
    }];
  }
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

    // Native fields define the reasoning channel, including when a provider
    // sends reasoning and answer text together in the same chunk.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
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
        events.push({ type: "thinking_delta", text: emit, reasoningContent: emit, raw });
      }
    }

    // Content is always answer text. Literal tags in prose or Markdown must
    // not switch channels, even when this chunk has no native reasoning field.
    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push({ type: "text_delta", text: delta.content, raw });
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
