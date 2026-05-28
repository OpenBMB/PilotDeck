import type {
  CanonicalContentBlock,
  CanonicalModelResponse,
  CanonicalToolCallBlock,
} from "../../protocol/canonical.js";
import { normalizeAnthropicFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeAnthropicUsage } from "../../response/normalizeUsage.js";

export function parseAnthropicResponse(raw: unknown): CanonicalModelResponse {
  const response = asRecord(raw);
  const content = Array.isArray(response.content)
    ? response.content.flatMap(toCanonicalContentBlock)
    : [];

  return {
    role: "assistant",
    content,
    usage: normalizeAnthropicUsage(response.usage),
    finishReason: normalizeAnthropicFinishReason(response.stop_reason),
    raw,
  };
}

function toCanonicalContentBlock(block: unknown): CanonicalContentBlock[] {
  const record = asRecord(block);
  switch (record.type) {
    case "text":
      return [{ type: "text", text: readString(record.text) ?? "" }];
    case "thinking":
      return [{ type: "thinking", text: readString(record.thinking) ?? readString(record.text) ?? "" }];
    case "tool_use":
      return [
        {
          type: "tool_call",
          id: readString(record.id) ?? "",
          name: readString(record.name) ?? "",
          input: record.input,
          raw: block,
        } satisfies CanonicalToolCallBlock,
      ];
    default:
      return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
