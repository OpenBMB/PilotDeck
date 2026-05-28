import type {
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalTextBlock,
  CanonicalThinkingBlock,
  CanonicalToolCall,
  CanonicalUsage,
} from "../protocol/canonical.js";
import type { CanonicalModelError } from "../protocol/errors.js";
import { extractTextToolCalls } from "./parseTextToolCalls.js";

export type ModelMessageAssemblerState = {
  content: CanonicalContentBlock[];
  textBuffer: string;
  thinkingBuffer: string;
  thinkingSignature?: string;
  usage: CanonicalUsage;
  finishReason?: CanonicalFinishReason;
  error?: CanonicalModelError;
  toolCalls: CanonicalToolCall[];
};

export type AssembledAssistantMessage = {
  message: CanonicalMessage;
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
  toolCalls: CanonicalToolCall[];
  error?: CanonicalModelError;
};

export function createModelMessageAssemblerState(): ModelMessageAssemblerState {
  return {
    content: [],
    textBuffer: "",
    thinkingBuffer: "",
    usage: {},
    toolCalls: [],
  };
}

export function applyModelEventToAssembler(
  state: ModelMessageAssemblerState,
  event: CanonicalModelEvent,
): void {
  switch (event.type) {
    case "request_started":
    case "message_start":
    case "tool_call_start":
    case "tool_call_delta":
      return;
    case "text_delta":
      state.textBuffer += event.text;
      return;
    case "thinking_delta":
      state.thinkingBuffer += event.text;
      if (event.signature !== undefined && event.signature.length > 0) {
        state.thinkingSignature = event.signature;
      }
      return;
    case "tool_call_end":
      flushTextBuffers(state);
      state.toolCalls.push(event.toolCall);
      state.content.push({
        type: "tool_call",
        ...event.toolCall,
      });
      return;
    case "message_end":
      flushTextBuffers(state);
      state.finishReason = event.finishReason;
      return;
    case "usage":
      state.usage = mergeUsage(state.usage, event.usage);
      return;
    case "error":
      flushTextBuffers(state);
      state.error = event.error;
      state.finishReason = "error";
      return;
  }
}

export function assembleAssistantMessage(state: ModelMessageAssemblerState): AssembledAssistantMessage {
  flushTextBuffers(state);

  if (state.toolCalls.length === 0) {
    const textIdx = state.content.findIndex(
      (b): b is CanonicalTextBlock => b.type === "text" && hasTextToolCallMarker(b.text),
    );
    if (textIdx >= 0) {
      const textBlock = state.content[textIdx] as CanonicalTextBlock;
      const { toolCalls, remainingText } = extractTextToolCalls(textBlock.text);
      if (toolCalls.length > 0) {
        console.log(`[text-tool-call-fallback] Extracted ${toolCalls.length} tool call(s) from assistant text`);
        if (remainingText.length > 0) {
          (state.content[textIdx] as CanonicalTextBlock).text = remainingText;
        } else {
          state.content.splice(textIdx, 1);
        }
        for (const tc of toolCalls) {
          state.content.push({ type: "tool_call", ...tc });
          state.toolCalls.push(tc);
        }
      }
    }
  }

  return {
    message: {
      role: "assistant",
      content: [...state.content],
    },
    finishReason: state.finishReason ?? (state.error ? "error" : "unknown"),
    usage: hasUsage(state.usage) ? state.usage : undefined,
    toolCalls: [...state.toolCalls],
    error: state.error,
  };
}

const TEXT_TOOL_CALL_MARKERS = [
  "<function=",
  "<tool_call>",
  "\uff5cDSML\uff5c",
  "[TOOL_CALLS]",
  "<|python_tag|>",
];

function hasTextToolCallMarker(text: string): boolean {
  return TEXT_TOOL_CALL_MARKERS.some((m) => text.includes(m));
}

function flushTextBuffers(state: ModelMessageAssemblerState): void {
  if (state.thinkingBuffer.length > 0 || state.thinkingSignature !== undefined) {
    const block: CanonicalThinkingBlock = {
      type: "thinking",
      text: state.thinkingBuffer,
    };
    if (state.thinkingSignature !== undefined) {
      block.signature = state.thinkingSignature;
    }
    state.content.push(block);
    state.thinkingBuffer = "";
    state.thinkingSignature = undefined;
  }

  if (state.textBuffer.length > 0) {
    state.content.push({
      type: "text",
      text: state.textBuffer,
    } satisfies CanonicalTextBlock);
    state.textBuffer = "";
  }
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

function hasUsage(usage: CanonicalUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}
