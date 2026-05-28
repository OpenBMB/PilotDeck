import type { CanonicalFinishReason } from "../protocol/canonical.js";

export function normalizeAnthropicFinishReason(reason: unknown): CanonicalFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}

export function normalizeOpenAIFinishReason(reason: unknown): CanonicalFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "content_filter":
    case "content_filter_results":
      return "content_filter";
    default:
      return "unknown";
  }
}
