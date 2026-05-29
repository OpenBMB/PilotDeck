/**
 * UI-side mirror of the provider catalog in `src/model/catalog/providers.ts`.
 * Kept here as a hand-curated subset because the UI bundle can't reach into
 * the engine catalog (different tsconfig / build root).
 *
 * Keep this in sync with the engine catalog when adding providers/models.
 * The engine catalog auto-fills capabilities and multimodal — this UI list
 * only needs the IDs and display names.
 */

export type CatalogModel = {
  id: string;
  displayName: string;
  /** Whether the model accepts image input. Drives the 🖼 indicator in the UI. */
  supportsImage?: boolean;
  /** Context window size (tokens). Drives the placeholder in the max-context-tokens setting. */
  maxContextTokens?: number;
};

export type CatalogProvider = {
  id: string;
  displayName: string;
  protocol: 'anthropic' | 'openai';
  defaultUrl: string;
  models: CatalogModel[];
};

export const CATALOG_PROVIDERS: CatalogProvider[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic',
    defaultUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', supportsImage: true, maxContextTokens: 200000 },
      { id: 'claude-opus-4-20250514', displayName: 'Claude Opus 4', supportsImage: true, maxContextTokens: 200000 },
      { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', supportsImage: true, maxContextTokens: 200000 },
      { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', supportsImage: true, maxContextTokens: 200000 },
      { id: 'claude-haiku-3-5-20241022', displayName: 'Claude 3.5 Haiku', supportsImage: true, maxContextTokens: 200000 },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    defaultUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4.1', displayName: 'GPT-4.1', supportsImage: true, maxContextTokens: 1047576 },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', supportsImage: true, maxContextTokens: 1047576 },
      { id: 'gpt-4o', displayName: 'GPT-4o', supportsImage: true, maxContextTokens: 128000 },
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', supportsImage: true, maxContextTokens: 128000 },
      { id: 'o3', displayName: 'o3', supportsImage: true, maxContextTokens: 200000 },
      { id: 'o3-mini', displayName: 'o3 Mini', maxContextTokens: 200000 },
    ],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    defaultUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', maxContextTokens: 131072 },
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', maxContextTokens: 1048576 },
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)', maxContextTokens: 65536 },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', maxContextTokens: 65536 },
    ],
  },
  {
    id: 'google',
    displayName: 'Google AI',
    protocol: 'openai',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportsImage: true, maxContextTokens: 1048576 },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportsImage: true, maxContextTokens: 1048576 },
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportsImage: true, maxContextTokens: 1048576 },
    ],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    defaultUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', supportsImage: true, maxContextTokens: 200000 },
      { id: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportsImage: true, maxContextTokens: 1048576 },
      { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', maxContextTokens: 1048576 },
      { id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6', supportsImage: true, maxContextTokens: 262144 },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    defaultUrl: 'https://api.minimaxi.com/v1',
    models: [
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5', maxContextTokens: 1000000 },
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed', maxContextTokens: 1000000 },
    ],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    protocol: 'openai',
    defaultUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2.6', displayName: 'Kimi K2.6', supportsImage: true, maxContextTokens: 262144 },
      { id: 'kimi-k1.5', displayName: 'Kimi K1.5', supportsImage: true, maxContextTokens: 131072 },
    ],
  },
];

export function findCatalogProviderById(id: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.id === id);
}

export function findCatalogProviderByUrl(url: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.defaultUrl === url);
}
