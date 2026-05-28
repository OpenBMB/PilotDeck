export { createModelRuntime, type ModelRuntime } from "./ModelRuntime.js";
export { parseModelConfig, type ParseModelConfigOptions } from "./config/parseModelConfig.js";
export { resolveApiKey, type CredentialEnv } from "./config/resolveCredentials.js";
export { ModelProviderRegistry, type ModelProviderAdapter } from "./providers/registry.js";
export { buildModelRequest, type ProviderRequestBody } from "./request/buildModelRequest.js";
export { validateModelRequest, type ResolvedModelRequest } from "./request/validateModelRequest.js";
export { parseModelResponse } from "./response/parseModelResponse.js";
export { complete, streamModel, type ModelRuntimeOptions, type ModelTransport } from "./streaming/streamModel.js";
export {
  normalizeStreamEvent,
  createStreamNormalizerState,
  type StreamNormalizerState,
} from "./streaming/normalizeStreamEvent.js";
export {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  type AssembledAssistantMessage,
  type ModelMessageAssemblerState,
} from "./streaming/assembleModelMessage.js";
export { normalizeModelError } from "./errors/normalizeModelError.js";

export type {
  CanonicalAudioBlock,
  CanonicalContentBlock,
  CanonicalFinishReason,
  CanonicalImageBlock,
  CanonicalMessage,
  CanonicalMessageMetadata,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalOutputSchema,
  CanonicalPdfBlock,
  CanonicalRole,
  CanonicalTextBlock,
  CanonicalThinkingBlock,
  CanonicalThinkingConfig,
  CanonicalToolCall,
  CanonicalToolCallBlock,
  CanonicalToolChoice,
  CanonicalToolResultContentBlock,
  CanonicalToolResultBlock,
  CanonicalToolResultReferenceBlock,
  CanonicalToolResult,
  CanonicalToolSchema,
  CanonicalUsage,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "./protocol/canonical.js";
export {
  flattenToolResultBlockText,
  flattenToolResultContentText,
  toolResultContentBlockToText,
} from "./protocol/toolResultContent.js";
export { cloneContentBlock, cloneMessage, cloneMessages } from "./protocol/clone.js";
export {
  ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
} from "./providers/anthropic/request.js";
export {
  extractStructuredOutput,
  type ExtractStructuredOutputOptions,
  type StructuredOutputExtraction,
  type StructuredOutputExtractionError,
} from "./structuredOutput/extractStructuredOutput.js";
export type { ModelCapabilities } from "./protocol/capabilities.js";
export type { InputModality, MultimodalConstraints } from "./protocol/multimodal.js";
export {
  ModelConfigError,
  ModelProviderError,
  ModelRequestError,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  MAX_OUTPUT_REACHED_PATTERN,
  type CanonicalModelError,
  type CanonicalModelErrorCode,
} from "./protocol/errors.js";
