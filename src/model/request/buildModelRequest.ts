import { buildAnthropicRequest, type AnthropicRequestBody } from "../providers/anthropic/request.js";
import { buildOpenAIRequest, type OpenAIRequestBody } from "../providers/openai/request.js";
import type { CanonicalModelRequest, ModelConfig } from "../protocol/canonical.js";
import { validateModelRequest } from "./validateModelRequest.js";

export type ProviderRequestBody = AnthropicRequestBody | OpenAIRequestBody;

export function buildModelRequest(
  request: CanonicalModelRequest,
  config: ModelConfig,
): ProviderRequestBody {
  const { provider, model } = validateModelRequest(request, config);

  if (provider.protocol === "anthropic") {
    return buildAnthropicRequest(request, model);
  }

  return buildOpenAIRequest(request, model);
}
