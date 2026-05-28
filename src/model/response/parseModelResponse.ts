import { parseAnthropicResponse } from "../providers/anthropic/response.js";
import { parseOpenAIResponse } from "../providers/openai/response.js";
import type { CanonicalModelResponse, ModelProtocol } from "../protocol/canonical.js";

export function parseModelResponse(
  protocol: ModelProtocol,
  raw: unknown,
  providerId?: string,
): CanonicalModelResponse {
  if (protocol === "anthropic") {
    return parseAnthropicResponse(raw);
  }

  return parseOpenAIResponse(raw, providerId);
}
