import { PROVIDER_CATALOG } from "../../../src/model/catalog/providers.js";
import { protocolTokenLimits } from "../../../src/model/metadata/tokenLimits.js";

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
  anthropic: protocolTokenLimits('anthropic'),
  openai: protocolTokenLimits('openai'),
  'openai-responses': protocolTokenLimits('openai-responses'),
  google: protocolTokenLimits('google'),
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

const PROVIDER_PRESENTATION: CatalogProvider[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic',
    defaultUrl: 'https://api.anthropic.com',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    models: [],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    defaultUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [],
  },
  {
    id: 'openai-responses',
    displayName: 'OpenAI (Responses API)',
    protocol: 'openai-responses',
    defaultUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [],
  },
  {
    id: 'dashscope',
    displayName: '阿里云百炼 (DashScope)',
    protocol: 'openai',
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    models: [],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    defaultUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    modelListUrl: 'https://api.deepseek.com/models',
    modelListRequiresApiKey: true,
    models: [],
  },
  {
    id: 'google',
    displayName: 'Google AI (Gemini)',
    protocol: 'google',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    models: [],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    defaultUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    models: [],
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    protocol: 'openai',
    defaultUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    models: [],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    defaultUrl: 'https://api.minimax.io/v1',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    models: [],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    protocol: 'openai',
    defaultUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    modelListRequiresApiKey: true,
    models: [],
  },
  {
    id: 'volc_ark',
    displayName: '火山方舟 (Volcano Ark)',
    protocol: 'openai',
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnvVar: 'VOLC_ARK_API_KEY',
    models: [],
  },
  {
    id: 'zhipu',
    displayName: '智谱 Z.AI',
    protocol: 'openai',
    defaultUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnvVar: 'ZAI_API_KEY',
    models: [],
  },
];

// Provider presentation fields stay local until #682's catalog view lands.
// Model capabilities and aliases always come from the engine's one catalog.
// Until #682 provides OpenRouter's own catalog, its suggestions reference engine
// entries by ID rather than maintaining a second copy of their capabilities.
const OPENROUTER_REFERENCES = [
  ['anthropic', 'claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6'],
  ['google', 'gemini-2.5-pro', 'google/gemini-2.5-pro'],
  ['deepseek', 'deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
  ['moonshot', 'kimi-k2.6', 'moonshotai/kimi-k2.6'],
] as const;
const openRouterFallback = Object.fromEntries(OPENROUTER_REFERENCES.flatMap(([provider, model, id]) => {
  const entry = PROVIDER_CATALOG[provider]?.models[model];
  return entry ? [[id, entry]] : [];
}));

export const CATALOG_PROVIDERS: CatalogProvider[] = PROVIDER_PRESENTATION.map(provider => ({
  ...provider,
  models: Object.entries(provider.id === 'openrouter' && !Object.keys(PROVIDER_CATALOG.openrouter.models).length
    ? openRouterFallback : PROVIDER_CATALOG[provider.id]?.models ?? {}).map(([id, model]) => ({
    id, displayName: model.displayName, aliases: model.aliases,
    supportsImage: model.multimodal.input.includes('image'),
    maxContextTokens: model.capabilities.maxContextTokens,
    maxOutputTokens: model.capabilities.maxOutputTokens,
  })),
}));

export function findCatalogProviderById(id: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.id === id);
}

export function findCatalogProviderByUrl(url: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find((p) => p.defaultUrl === url);
}
