/**
 * UI-side mirror of the provider catalog in `src/model/catalog/providers.ts`.
 * Kept here as a hand-curated subset because the UI bundle can't reach into
 * the engine catalog (different tsconfig / build root).
 *
 * Keep this in sync with the engine catalog when adding providers/models.
 * Token limits are used as the settings placeholders, so they must match the
 * effective capabilities resolved by the engine.
 *
 * Model lineups are checked against each vendor's model catalogue.
 * Last verified: 2026-10-22.
 */

export type CatalogModel = {
  id: string;
  displayName: string;
  aliases?: string[];
  /** Whether the model accepts image input. Drives the 🖼 indicator in the UI. */
  supportsImage?: boolean;
  /** Context window size (tokens). Drives the placeholder in the max-context-tokens setting. */
  maxContextTokens?: number;
  /** Output cap (tokens). Drives the placeholder in the max-output-tokens setting. */
  maxOutputTokens?: number;
};

export type CatalogProviderProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'google';

export type ModelTokenLimits = {
  maxContextTokens: number;
  maxOutputTokens: number;
};

/** Mirrors the protocol defaults used by `src/model/config/parseModelConfig.ts`. */
export const DEFAULT_MODEL_TOKEN_LIMITS: Record<CatalogProviderProtocol, ModelTokenLimits> = {
  anthropic: { maxContextTokens: 200_000, maxOutputTokens: 32_768 },
  openai: { maxContextTokens: 128_000, maxOutputTokens: 32_768 },
  'openai-responses': { maxContextTokens: 128_000, maxOutputTokens: 32_768 },
  google: { maxContextTokens: 1_048_576, maxOutputTokens: 32_768 },
};

export type CatalogProvider = {
  id: string;
  displayName: string;
  protocol: CatalogProviderProtocol;
  defaultUrl: string;
  /** Environment variable used when apiKey is omitted from the config. */
  apiKeyEnvVar?: string;
  modelListUrl?: string;
  /** The provider rejects model-list requests until an API key is supplied. */
  modelListRequiresApiKey?: boolean;
  requiresApiKey?: boolean;
  models: CatalogModel[];
};

export const CATALOG_PROVIDERS: CatalogProvider[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic',
    defaultUrl: 'https://api.anthropic.com',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', aliases: ['claude-fable-5.1'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', aliases: ['claude-opus-5.5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', aliases: ['claude-sonnet-5.5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', aliases: ['claude-haiku-5.5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-fable-5', displayName: 'Claude Fable 5', aliases: ['claude-fable-5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', aliases: ['claude-opus-5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', aliases: ['claude-opus-4.8'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', aliases: ['claude-opus-4.7'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', aliases: ['claude-opus-4.6'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', aliases: ['claude-opus-4-5', 'claude-opus-4.5'], supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 64000 },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', aliases: ['claude-sonnet-5'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', aliases: ['claude-sonnet-4.6'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', aliases: ['claude-haiku-4-5', 'claude-haiku-4.5'], supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 64000 },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    defaultUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4', displayName: 'GPT-5.4', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.2', displayName: 'GPT-5.2', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.1', displayName: 'GPT-5.1', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5', displayName: 'GPT-5', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      { id: 'gpt-4o', displayName: 'GPT-4o', aliases: ['gpt-4o-2024-11-20'], supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      { id: 'o3', displayName: 'o3', supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
      { id: 'o4-mini', displayName: 'o4-mini', supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
    ],
  },
  {
    id: 'openai-responses',
    displayName: 'OpenAI (Responses API)',
    protocol: 'openai-responses',
    defaultUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4', displayName: 'GPT-5.4', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.2', displayName: 'GPT-5.2', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5.1', displayName: 'GPT-5.1', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-5', displayName: 'GPT-5', supportsImage: true, maxContextTokens: 400000, maxOutputTokens: 128000 },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      { id: 'gpt-4o', displayName: 'GPT-4o', aliases: ['gpt-4o-2024-11-20'], supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      { id: 'o3', displayName: 'o3', supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
      { id: 'o4-mini', displayName: 'o4-mini', supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
    ],
  },
  {
    id: 'dashscope',
    displayName: '阿里云百炼 (DashScope)',
    protocol: 'openai',
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    models: [
      { id: 'qwen3.8-max', displayName: 'Qwen3.8 Max', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 131072 },
      { id: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 131072 },
      { id: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 131072 },
    ],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    defaultUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    modelListUrl: 'https://api.deepseek.com/models',
    modelListRequiresApiKey: true,
    models: [
      { id: 'deepseek-flash', displayName: 'DeepSeek Flash (V4.1)', aliases: ['deepseek-v4-flash', 'deepseek-v4.1-flash'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 393216 },
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', aliases: ['deepseek-v4-pro-0813'], maxContextTokens: 1048576, maxOutputTokens: 393216 },
    ],
  },
  {
    id: 'google',
    displayName: 'Google AI (Gemini)',
    protocol: 'google',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', aliases: ['gemini-4'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', aliases: ['gemini-3.1-pro'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', aliases: ['gemini-3-flash'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
    ],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    defaultUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    models: [
      { id: 'anthropic/claude-fable-5.1', displayName: 'Claude Fable 5.1', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'anthropic/claude-opus-5.5', displayName: 'Claude Opus 5.5', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'openai/gpt-6-astra', displayName: 'GPT-6 Astra', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'openai/gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportsImage: true, maxContextTokens: 1050000, maxOutputTokens: 128000 },
      { id: 'google/gemini-4-argon', displayName: 'Gemini 4 Argon', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'google/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 65536 },
      { id: 'deepseek/deepseek-v4.1-flash-1017', displayName: 'DeepSeek Flash (V4.1)', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 393216 },
      { id: 'moonshotai/kimi-k3', displayName: 'Kimi K3', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 131072 },
      { id: 'minimax/minimax-m3.1-flash', displayName: 'MiniMax M3.1 Flash', supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 524288 },
      { id: 'z-ai/glm-5.3', displayName: 'GLM-5.3', maxContextTokens: 1048576, maxOutputTokens: 131072 },
    ],
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    protocol: 'openai',
    defaultUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    models: [
      { id: 'qwen3:0.6b', displayName: 'Qwen3 0.6B (Ollama)', maxContextTokens: 40960, maxOutputTokens: 8192 },
      { id: 'qwen3:8b', displayName: 'Qwen3 8B (Ollama)', maxContextTokens: 40960, maxOutputTokens: 8192 },
      { id: 'llama3.1:8b', displayName: 'Llama 3.1 8B (Ollama)', maxContextTokens: 131072, maxOutputTokens: 8192 },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    defaultUrl: 'https://api.minimax.io/v1',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    models: [
      { id: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', aliases: ['minimax-m3.1-flash'], supportsImage: true, maxContextTokens: 1000000, maxOutputTokens: 524288 },
      { id: 'MiniMax-M3', displayName: 'MiniMax M3', aliases: ['minimax-m3'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 512000 },
    ],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    protocol: 'openai',
    defaultUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    modelListRequiresApiKey: true,
    models: [
      { id: 'kimi-k3', displayName: 'Kimi K3', aliases: ['moonshotai/kimi-k3'], supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 131072 },
      { id: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', aliases: ['moonshotai/kimi-k2.7-code'], supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 131072 },
      { id: 'kimi-k2.7-code-highspeed', displayName: 'Kimi K2.7 Code Highspeed', aliases: ['moonshotai/kimi-k2.7-code-highspeed'], supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 131072 },
      { id: 'kimi-k2.6', displayName: 'Kimi K2.6', aliases: ['moonshotai/kimi-k2.6'], supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 131072 },
    ],
  },
  {
    id: 'volc_ark',
    displayName: '火山方舟 (Volcano Ark)',
    protocol: 'openai',
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnvVar: 'VOLC_ARK_API_KEY',
    models: [
      { id: 'doubao-seed-evolving', displayName: 'Doubao Seed Evolving', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 262144 },
      { id: 'doubao-seed-2-1-pro-260915', displayName: 'Doubao Seed 2.1 Pro (260915)', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 262144 },
      { id: 'doubao-seed-2-1-lite-260915', displayName: 'Doubao Seed 2.1 Lite (260915)', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 262144 },
      { id: 'doubao-seed-2-1-turbo-260628', displayName: 'Doubao Seed 2.1 Turbo (260628)', supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 262144 },
      { id: 'doubao-seed-2-1-pro-260628', displayName: 'Doubao Seed 2.1 Pro (260628)', supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 262144 },
      { id: 'doubao-seed-2-0-lite-260428', displayName: 'Doubao Seed 2.0 Lite (260428)', supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 131072 },
      { id: 'doubao-seed-2-0-mini-260428', displayName: 'Doubao Seed 2.0 Mini (260428)', supportsImage: true, maxContextTokens: 262144, maxOutputTokens: 131072 },
    ],
  },
  {
    id: 'zhipu',
    displayName: '智谱 Z.AI',
    protocol: 'openai',
    defaultUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnvVar: 'ZAI_API_KEY',
    models: [
      { id: 'glm-5.3', displayName: 'GLM-5.3', maxContextTokens: 1048576, maxOutputTokens: 131072 },
      { id: 'glm-5.3-flash', displayName: 'GLM-5.3 Flash', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 131072 },
      { id: 'glm-5.3-flashx', displayName: 'GLM-5.3 FlashX', supportsImage: true, maxContextTokens: 1048576, maxOutputTokens: 131072 },
      { id: 'glm-5.2', displayName: 'GLM-5.2', maxContextTokens: 1048576, maxOutputTokens: 131072 },
    ],
  },
];

export function findCatalogProviderById(id: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.id === id);
}

export function findCatalogProviderByUrl(url: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.defaultUrl === url);
}
