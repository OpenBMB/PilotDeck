export type ModelCapabilities = {
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsParallelToolCalls: boolean;
  supportsThinking: boolean;
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
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 8192,
  maxOutputTokens: 4096,
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
