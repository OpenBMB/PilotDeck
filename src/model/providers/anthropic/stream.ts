import { jsonrepair } from "jsonrepair";
import { normalizeModelError } from "../../errors/normalizeModelError.js";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError, parseRetryAfterFromMessage } from "../../protocol/errors.js";
import { normalizeAnthropicFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeAnthropicUsage } from "../../response/normalizeUsage.js";

type FailedToolCall = {
  index: number;
  rawInput: string;
  name: string | undefined;
  id: string | undefined;
  raw: unknown;
};

export type AnthropicStreamState = {
  toolCalls: Map<number, Partial<CanonicalToolCall> & { inputBuffer?: string }>;
  failedToolCalls: FailedToolCall[];
};

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    toolCalls: new Map(),
    failedToolCalls: [],
  };
}

export function normalizeAnthropicStreamEvent(
  raw: unknown,
  state: AnthropicStreamState = createAnthropicStreamState(),
): CanonicalModelEvent[] {
  const event = asRecord(raw);

  switch (event.type) {
    case "message_start":
      return [{ type: "message_start", role: "assistant", raw }];
    case "content_block_start":
      return contentBlockStartEvents(asRecord(event.content_block), readNumber(event.index), state, raw);
    case "content_block_delta":
      return contentBlockDeltaEvents(asRecord(event.delta), readNumber(event.index), state, raw);
    case "content_block_stop":
      return contentBlockStopEvents(readNumber(event.index), state, raw);
    case "message_delta": {
      const delta = asRecord(event.delta);
      const events: CanonicalModelEvent[] = [];
      const usage = normalizeAnthropicUsage(event.usage);
      if (usage) {
        events.push({ type: "usage", usage, raw });
      }
      if (delta.stop_reason) {
        const fr = normalizeAnthropicFinishReason(delta.stop_reason);
        events.push(...flushFailedToolCalls(state, fr, raw));
        events.push({ type: "message_end", finishReason: fr, raw });
      }
      return events;
    }
    case "message_stop":
      // Safety net: if message_delta never carried a stop_reason (some
      // third-party proxies), flush any deferred failures as unknown.
      return flushFailedToolCalls(state, "unknown", raw);
    case "error": {
      const errObj = asRecord(event.error);
      const normalized = normalizeModelError("anthropic", "anthropic", errObj);
      const errType = readString(errObj.type);
      const explicitlyTransient = new Set([
        "overloaded_error", "rate_limit_error", "api_error", "timeout_error",
      ]).has(errType ?? "");
      const retryAfterMs = parseRetryAfterFromMessage(normalized.message);
      return [
        {
          type: "error",
          error: {
            ...normalized,
            code: normalized.code === "provider_error" && errType ? errType : normalized.code,
            retryable: normalized.retryable || explicitlyTransient,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            raw,
          },
        },
      ];
    }
    default:
      return [];
  }
}

function contentBlockStartEvents(
  block: Record<string, unknown>,
  index: number | undefined,
  state: AnthropicStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  if (block.type === "tool_use") {
    const toolIndex = index ?? state.toolCalls.size;
    const id = readString(block.id) ?? String(toolIndex);
    const name = readString(block.name) ?? "";
    state.toolCalls.set(toolIndex, {
      id,
      name,
      inputBuffer: "",
    });

    return [
      {
        type: "tool_call_start",
        id,
        name,
        raw,
      },
    ];
  }

  return [];
}

function contentBlockDeltaEvents(
  delta: Record<string, unknown>,
  index: number | undefined,
  state: AnthropicStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  switch (delta.type) {
    case "text_delta":
      return [{ type: "text_delta", text: readString(delta.text) ?? "", raw }];
    case "thinking_delta":
      return [{ type: "thinking_delta", text: readString(delta.thinking) ?? "", raw }];
    case "signature_delta":
      // Anthropic extended-thinking signature; emitted as a thinking_delta with
      // an empty text and the signature payload so the assembler can attach it
      // to the active thinking block. Required for prompt-cache validity.
      return [{ type: "thinking_delta", text: "", signature: readString(delta.signature) ?? "", raw }];
    case "input_json_delta":
      if (index !== undefined) {
        const current = state.toolCalls.get(index) ?? { id: String(index), name: "", inputBuffer: "" };
        const partial = readString(delta.partial_json) ?? "";
        current.inputBuffer = `${current.inputBuffer ?? ""}${partial}`;
        state.toolCalls.set(index, current);
      }
      return [
        {
          type: "tool_call_delta",
          id: toolCallIdForIndex(index, state),
          delta: readString(delta.partial_json) ?? "",
          raw,
        },
      ];
    default:
      return [];
  }
}

function contentBlockStopEvents(
  index: number | undefined,
  state: AnthropicStreamState,
  raw: unknown,
): CanonicalModelEvent[] {
  if (index === undefined) {
    return [];
  }

  const toolCall = state.toolCalls.get(index);
  if (!toolCall) {
    return [];
  }

  const rawInput = toolCall.inputBuffer ?? "{}";
  let input: unknown;
  let wasRepaired = false;
  try {
    input = rawInput.length > 0 ? JSON.parse(rawInput) : {};
  } catch {
    try {
      const repaired = jsonrepair(rawInput);
      input = JSON.parse(repaired);
      wasRepaired = true;
      console.warn(
        `[anthropic-stream] repaired invalid JSON for tool "${toolCall.name ?? "?"}" (buf_len=${rawInput.length})`,
      );
    } catch {
      // Defer the error — finishReason is not yet known (content_block_stop
      // arrives before message_delta). flushFailedToolCalls() will emit the
      // correct error code once message_delta delivers the stop_reason.
      state.failedToolCalls.push({
        index,
        rawInput,
        name: toolCall.name,
        id: toolCall.id,
        raw,
      });
      state.toolCalls.delete(index);
      return [];
    }
  }

  state.toolCalls.delete(index);
  return [
    {
      type: "tool_call_end",
      toolCall: {
        id: toolCall.id ?? String(index),
        name: toolCall.name ?? "",
        input,
        raw,
      },
      wasRepaired,
      raw,
    },
  ];
}

/**
 * Emit deferred errors for tool calls whose JSON could not be parsed.
 * Called when message_delta arrives and finishReason is known, so the
 * error code can distinguish truncation (max_output_reached) from a
 * genuine model JSON error (invalid_tool_arguments).
 */
function flushFailedToolCalls(
  state: AnthropicStreamState,
  finishReason: string,
  raw: unknown,
): CanonicalModelEvent[] {
  if (state.failedToolCalls.length === 0) {
    return [];
  }

  const failed = state.failedToolCalls.splice(0);
  const isTruncation = finishReason === "length";
  const code = isTruncation ? "max_output_reached" : "invalid_tool_arguments";
  const message = isTruncation
    ? "Output token limit reached — tool call arguments were truncated."
    : "Anthropic stream tool call arguments are not valid JSON.";

  for (const entry of failed) {
    const preview = entry.rawInput.length > 500
      ? entry.rawInput.slice(0, 250) + "\n…[truncated]…\n" + entry.rawInput.slice(-250)
      : entry.rawInput;
    console.error(
      `[anthropic-stream] ${code} for tool "${entry.name ?? "?"}" (index=${entry.index}, `
      + `buf_len=${entry.rawInput.length}):\n${preview}`,
    );
  }

  return [
    {
      type: "error",
      error: {
        provider: "anthropic",
        protocol: "anthropic" as const,
        code,
        message,
        retryable: true,
        raw,
      },
    },
  ];
}

function toolCallIdForIndex(index: number | undefined, state: AnthropicStreamState): string {
  if (index === undefined) {
    return "";
  }
  return state.toolCalls.get(index)?.id ?? String(index);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
