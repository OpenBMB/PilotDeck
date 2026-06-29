import { buildAnthropicRequest, type AnthropicRequestBody } from "../providers/anthropic/request.js";
import { buildGoogleRequest, type GoogleRequestBody } from "../providers/google/request.js";
import { buildOpenAIRequest, type OpenAIRequestBody } from "../providers/openai/request.js";
import type { CanonicalModelRequest, ModelConfig } from "../protocol/canonical.js";
import { validateModelRequest } from "./validateModelRequest.js";

export type ProviderRequestBody = AnthropicRequestBody | GoogleRequestBody | OpenAIRequestBody;

export function buildModelRequest(
  request: CanonicalModelRequest,
  config: ModelConfig,
): ProviderRequestBody {
  const { provider, model } = validateModelRequest(request, config);

  if (provider.protocol === "anthropic") {
    return buildAnthropicRequest(request, model);
  }

  if (provider.protocol === "google") {
    return buildGoogleRequest(request, model);
  }

  return buildOpenAIRequest(request, model);
}
