import { jsonrepair } from "jsonrepair";
import type {
  CanonicalContentBlock,
  CanonicalModelResponse,
  CanonicalToolCallBlock,
} from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";

export function parseOpenAIResponse(raw: unknown, provider = "openai"): CanonicalModelResponse {
  const response = asRecord(raw);
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const content: CanonicalContentBlock[] = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = asRecord(part);
      if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
        content.push({ type: "text", text: p.text });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    content.push(...message.tool_calls.map((toolCall) => toCanonicalToolCall(toolCall, provider)));
  }

  return {
    role: "assistant",
    content,
    usage: normalizeOpenAIUsage(response.usage),
    finishReason: normalizeOpenAIFinishReason(firstChoice.finish_reason),
    raw,
  };
}

function toCanonicalToolCall(toolCall: unknown, provider: string): CanonicalToolCallBlock {
  const record = asRecord(toolCall);
  const fn = asRecord(record.function);
  const rawArguments = typeof fn.arguments === "string" ? fn.arguments : "{}";

  let input: unknown;
  try {
    input = JSON.parse(rawArguments);
  } catch {
    try {
      const repaired = jsonrepair(rawArguments);
      input = JSON.parse(repaired);
      console.warn(`[openai-response] repaired invalid JSON for tool call (len=${rawArguments.length})`);
    } catch {
      throw new ModelProviderError({
        provider,
        protocol: "openai",
        code: "invalid_tool_arguments",
        message: "OpenAI tool call arguments are not valid JSON.",
        retryable: true,
        raw: toolCall,
      });
    }
  }

  return {
    type: "tool_call",
    id: typeof record.id === "string" ? record.id : "",
    name: typeof fn.name === "string" ? fn.name : "",
    input,
    raw: toolCall,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
