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
import {
  extractTextToolCalls,
  hasTextToolCallSyntax,
  type PartialTextToolCallInfo,
} from "./parseTextToolCalls.js";

export type ModelMessageAssemblerState = {
  content: CanonicalContentBlock[];
  textBuffer: string;
  thinkingBuffer: string;
  thinkingSignature?: string;
  usage: CanonicalUsage;
  finishReason?: CanonicalFinishReason;
  error?: CanonicalModelError;
  toolCalls: CanonicalToolCall[];
  hasRepairedToolCalls?: boolean;
  hasPartialTextToolCall?: boolean;
  partialTextToolCall?: PartialTextToolCallInfo;
  hasTextFallbackToolCalls?: boolean;
  textToolCallFormat?: PartialTextToolCallInfo["format"];
  hasUnparsedTextToolCall?: boolean;
};

export type AssembledAssistantMessage = {
  message: CanonicalMessage;
  finishReason: CanonicalFinishReason;
  usage?: CanonicalUsage;
  toolCalls: CanonicalToolCall[];
  error?: CanonicalModelError;
  hasRepairedToolCalls?: boolean;
  hasPartialTextToolCall?: boolean;
  partialTextToolCall?: PartialTextToolCallInfo;
  hasTextFallbackToolCalls?: boolean;
  textToolCallFormat?: PartialTextToolCallInfo["format"];
  hasUnparsedTextToolCall?: boolean;
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
      if (event.wasRepaired) {
        state.hasRepairedToolCalls = true;
      }
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
      (b): b is CanonicalTextBlock => b.type === "text" && hasTextToolCallSyntax(b.text),
    );
    if (textIdx >= 0) {
      const textBlock = state.content[textIdx] as CanonicalTextBlock;
      const parseResult = extractTextToolCalls(textBlock.text);
      const { detectedFormat, parseError, partialToolCall } = parseResult;
      state.textToolCallFormat = detectedFormat;
      if (partialToolCall) {
        state.hasPartialTextToolCall = true;
        state.partialTextToolCall = partialToolCall;
      }
      if (parseError) {
        state.hasUnparsedTextToolCall = true;
      }
      if (parseResult.toolCalls.length > 0) {
        console.log(`[text-tool-call-fallback] Extracted ${parseResult.toolCalls.length} tool call(s) from assistant text (format: ${detectedFormat ?? "unknown"})`);
        state.hasTextFallbackToolCalls = true;
        if (parseResult.remainingText.length > 0) {
          (state.content[textIdx] as CanonicalTextBlock).text = parseResult.remainingText;
        } else {
          state.content.splice(textIdx, 1);
        }
        for (const tc of parseResult.toolCalls) {
          state.content.push({ type: "tool_call", ...tc });
          state.toolCalls.push(tc);
        }
      }
    }
  }

  normalizeToolCallIds(state);

  return {
    message: {
      role: "assistant",
      content: [...state.content],
    },
    finishReason: state.finishReason ?? (state.error ? "error" : "unknown"),
    usage: hasUsage(state.usage) ? state.usage : undefined,
    toolCalls: [...state.toolCalls],
    error: state.error,
    hasRepairedToolCalls: state.hasRepairedToolCalls,
    hasPartialTextToolCall: state.hasPartialTextToolCall,
    partialTextToolCall: state.partialTextToolCall,
    hasTextFallbackToolCalls: state.hasTextFallbackToolCalls,
    textToolCallFormat: state.textToolCallFormat,
    hasUnparsedTextToolCall: state.hasUnparsedTextToolCall,
  };
}

function normalizeToolCallIds(state: ModelMessageAssemblerState): void {
  if (state.toolCalls.length === 0) return;

  const used = new Set<string>();
  const normalizedToolCalls = state.toolCalls.map((toolCall, index) => {
    const id = nextToolCallId(toolCall.id, index, used);
    used.add(id);
    return id === toolCall.id ? toolCall : { ...toolCall, id };
  });

  let toolCallIndex = 0;
  state.content = state.content.map((block) => {
    if (block.type !== "tool_call") return block;
    const normalized = normalizedToolCalls[toolCallIndex++];
    return normalized ? { ...block, id: normalized.id } : block;
  });
  state.toolCalls = normalizedToolCalls;
}

function nextToolCallId(rawId: string | undefined, index: number, used: Set<string>): string {
  const base = rawId && rawId.trim().length > 0 ? rawId.trim() : `call_${index}`;
  if (!used.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
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
