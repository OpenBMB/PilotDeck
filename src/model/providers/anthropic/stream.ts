import { createLogger } from '../../../../pilot/logger.js';
const anthropic_stream_log = createLogger('anthropic-stream');
import { jsonrepair } from "jsonrepair";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeAnthropicFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeAnthropicUsage } from "../../response/normalizeUsage.js";

export type AnthropicStreamState = {
  toolCalls: Map<number, Partial<CanonicalToolCall> & { inputBuffer?: string }>;
};

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    toolCalls: new Map(),
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
        events.push({
          type: "message_end",
          finishReason: normalizeAnthropicFinishReason(delta.stop_reason),
          raw,
        });
      }
      return events;
    }
    case "message_stop":
      return [];
    case "error": {
      const errObj = asRecord(event.error);
      const errType = readString(errObj.type) ?? "provider_error";
      const TRANSIENT_ERROR_TYPES = new Set([
        "overloaded_error", "rate_limit_error", "api_error", "timeout_error",
      ]);
      return [
        {
          type: "error",
          error: {
            provider: "anthropic",
            protocol: "anthropic",
            code: errType,
            message: readString(errObj.message) ?? "Anthropic stream error.",
            retryable: TRANSIENT_ERROR_TYPES.has(errType),
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
  try {
    input = rawInput.length > 0 ? JSON.parse(rawInput) : {};
  } catch {
    try {
      const repaired = jsonrepair(rawInput);
      input = JSON.parse(repaired);
      console.warn(
        `[anthropic-stream] repaired invalid JSON for tool "${toolCall.name ?? "?"}" (buf_len=${rawInput.length})`,
      );
    } catch {
      const preview = rawInput.length > 500
        ? rawInput.slice(0, 250) + "\n…[truncated]…\n" + rawInput.slice(-250)
        : rawInput;
      console.error(
        `[anthropic-stream] invalid_tool_arguments for tool "${toolCall.name ?? "?"}" (index=${index}, `
        + `buf_len=${rawInput.length}):\n${preview}`,
      );
      throw new ModelProviderError({
        provider: "anthropic",
        protocol: "anthropic",
        code: "invalid_tool_arguments",
        message: "Anthropic stream tool call arguments are not valid JSON.",
        retryable: true,
        raw,
      });
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
      raw,
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
