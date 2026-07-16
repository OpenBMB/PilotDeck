import type { ModelCapabilities } from "../../protocol/capabilities.js";
import type { MultimodalConstraints } from "../../protocol/multimodal.js";

export const GOOGLE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 1_048_576,
  maxOutputTokens: 65_536,
};

export const GOOGLE_DEFAULT_MULTIMODAL: MultimodalConstraints = {
  input: ["text", "image", "audio", "pdf"],
  maxImagesPerRequest: 20,
  supportedImageMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  imageDetail: "auto",
};
