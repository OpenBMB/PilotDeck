import type { ModelCapabilities } from "../../protocol/capabilities.js";
import type { MultimodalConstraints } from "../../protocol/multimodal.js";

export const OPENAI_DEFAULT_CAPABILITIES: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: false,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 128000,
  maxOutputTokens: 65_536,
};

export const OPENAI_DEFAULT_MULTIMODAL: MultimodalConstraints = {
  input: ["text", "image"],
  maxImagesPerRequest: 20,
  supportedImageMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  imageDetail: "auto",
};
