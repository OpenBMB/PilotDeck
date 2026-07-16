import type { CanonicalModelRequest, ModelConfig, ModelDefinition, ProviderConfig } from "../protocol/canonical.js";
import { messageContent } from "../protocol/clone.js";
import { ModelRequestError } from "../protocol/errors.js";
import { assertContentSupported } from "../protocol/multimodal.js";

export type ResolvedModelRequest = {
  provider: ProviderConfig;
  model: ModelDefinition;
};

export function validateModelRequest(
  request: CanonicalModelRequest,
  config: ModelConfig,
): ResolvedModelRequest {
  const provider = config.providers[request.provider];
  if (!provider) {
    throw new ModelRequestError("provider_not_found", `Provider ${request.provider} does not exist.`);
  }

  const model = provider.models[request.model];
  if (!model) {
    throw new ModelRequestError(
      "model_not_found",
      `Model ${request.model} does not exist in provider ${request.provider}.`,
    );
  }

  if (request.stream && !model.capabilities.supportsStreaming) {
    throw new ModelRequestError("unsupported_streaming", `Model ${request.model} does not support streaming.`);
  }

  if (request.systemPrompt && !model.capabilities.supportsSystemPrompt) {
    throw new ModelRequestError(
      "unsupported_system_prompt",
      `Model ${request.model} does not support system prompts.`,
    );
  }

  if (request.tools?.length && !model.capabilities.supportsToolUse) {
    throw new ModelRequestError("unsupported_tool_use", `Model ${request.model} does not support tools.`);
  }

  for (const message of request.messages) {
    assertContentSupported(messageContent(message), model.multimodal);
  }

  return { provider, model };
}
