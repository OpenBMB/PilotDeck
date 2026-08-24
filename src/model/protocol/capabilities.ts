export type ModelCapabilities = {
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsParallelToolCalls: boolean;
  supportsThinking: boolean;
  supportsSpeed?: boolean;
  supportsJsonSchema: boolean;
  supportsSystemPrompt: boolean;
  supportsPromptCache: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
};

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsToolUse: false,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: true,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 8192,
  maxOutputTokens: 32_768,
};

export function mergeCapabilities(
  defaults: ModelCapabilities,
  overrides: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return {
    ...defaults,
    ...(overrides ?? {}),
  };
}
