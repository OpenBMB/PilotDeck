import type { CanonicalModelRequest, ModelConfig, ModelDefinition, ProviderConfig } from "../protocol/canonical.js";
import type { ModelCapabilities } from "../protocol/capabilities.js";
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

  if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0 || request.speed > 1)) {
    throw new ModelRequestError("invalid_speed", "speed must be between 0 and 1.");
  }

  const model = provider.models[request.model];
  if (!model) {
    throw new ModelRequestError(
      "model_not_found",
      `Model ${request.model} does not exist in provider ${request.provider}.`,
    );
  }

  if (request.speed !== undefined && (model.capabilities.supportsSpeed !== true || provider.speedMapping === undefined)) {
    throw new ModelRequestError("unsupported_speed", `Model ${request.model} does not support speed for provider ${request.provider}.`);
  }

  assertModelRequestCapabilities(request, model.capabilities, request.model);
  assertContentSupported(request.messages.flatMap(messageContent), model.multimodal);

  return { provider, model };
}

export function assertModelRequestCapabilities(
  request: Pick<CanonicalModelRequest, "stream" | "systemPrompt" | "tools">,
  capabilities: ModelCapabilities,
  modelId: string,
): void {
  if (request.stream && !capabilities.supportsStreaming) {
    throw new ModelRequestError("unsupported_streaming", `Model ${modelId} does not support streaming.`);
  }

  if (request.systemPrompt && !capabilities.supportsSystemPrompt) {
    throw new ModelRequestError(
      "unsupported_system_prompt",
      `Model ${modelId} does not support system prompts.`,
    );
  }

  if (request.tools?.length && !capabilities.supportsToolUse) {
    throw new ModelRequestError("unsupported_tool_use", `Model ${modelId} does not support tools.`);
  }
}
