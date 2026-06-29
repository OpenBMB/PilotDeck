import { parseAnthropicResponse } from "../providers/anthropic/response.js";
import { parseGoogleResponse } from "../providers/google/response.js";
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

  if (protocol === "google") {
    return parseGoogleResponse(raw, providerId);
  }

  return parseOpenAIResponse(raw, providerId);
}
