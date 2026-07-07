export { createModelRuntime, type ModelRuntime } from "./ModelRuntime.js";
export { normalizeProviderBaseUrl } from "./normalizeProviderBaseUrl.js";
export { parseModelConfig, type ParseModelConfigOptions } from "./config/parseModelConfig.js";
export { resolveApiKey, type CredentialEnv } from "./config/resolveCredentials.js";
export { ModelProviderRegistry, type ModelProviderAdapter } from "./providers/registry.js";
export { buildModelRequest, type ProviderRequestBody } from "./request/buildModelRequest.js";
export {
  materializeMediaReferences,
  type MaterializeMediaReferencesResult,
  type MediaReferenceMaterializationDiagnostic,
} from "./request/materializeMediaReferences.js";
export { validateModelRequest, type ResolvedModelRequest } from "./request/validateModelRequest.js";
export { parseModelResponse } from "./response/parseModelResponse.js";
export {
  complete,
  streamModel,
  LITELLM_COMPLETION_HTTP_FALLBACK_MS,
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_DEFAULT_REQUEST_TIMEOUT_MS,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_HTTP_CONNECTOR_LIMIT,
  LITELLM_HTTP_CONNECTOR_LIMIT_PER_HOST,
  LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
  LITELLM_HTTP_SO_KEEPALIVE,
  LITELLM_HTTP_TCP_KEEPCNT,
  LITELLM_HTTP_TCP_KEEPIDLE_SECONDS,
  LITELLM_HTTP_TCP_KEEPINTVL_SECONDS,
  LITELLM_HTTP_TTL_DNS_CACHE_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_REPEATED_STREAMING_CHUNK_LIMIT,
  LITELLM_RETRY_JITTER,
  LITELLM_STREAM_MAX_DURATION_MS,
  type ModelRuntimeOptions,
  type ModelStreamRetryProgress,
  type ModelTransport,
} from "./streaming/streamModel.js";
export {
  buildLiteLLMContinuationRequest,
  LITELLM_CONTINUATION_INSTRUCTION,
  stripLiteLLMContinuationMessages,
} from "./streaming/continuationRequest.js";
export {
  normalizeStreamEvent,
  createStreamNormalizerState,
  type StreamNormalizerState,
} from "./streaming/normalizeStreamEvent.js";
export {
  extractTextToolCalls,
  detectFormatByText,
  getSelfCorrectPrompt,
  hasTextToolCallSyntax,
  type PartialTextToolCallFormat,
  type PartialTextToolCallInfo,
  type TextToolCallParseResult,
} from "./streaming/parseTextToolCalls.js";
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
  CanonicalMediaReferenceBlock,
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
  ProviderRetryConfig,
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
export { downgradeUnsupportedContent } from "./protocol/multimodal.js";
export type { InputModality, MultimodalConstraints } from "./protocol/multimodal.js";
export {
  ModelConfigError,
  ModelProviderError,
  ModelRequestError,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  MAX_OUTPUT_REACHED_PATTERN,
  parseRetryAfterFromMessage,
  parseRetryAfterHeader,
  type CanonicalModelError,
  type CanonicalModelErrorCode,
} from "./protocol/errors.js";
