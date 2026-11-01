import type { SerpApiEngine, WebSearchProvider } from "./webSearchProviders.js";

export type WebSearchCustomProviderConfig = {
  name?: string;
  auth?: "bearer" | "bodyApiKey" | "queryApiKey" | "headerApiKey" | "none";
  method?: "GET" | "POST";
  queryParam?: string;
  apiKeyParam?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string | number | boolean>;
  bodyEncoding?: "json" | "form";
  requestBody?: Record<string, unknown>;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

export type WebSearchProviderConfig = {
  searchEngine?: SerpApiEngine;
  apiKey?: string;
  endpoint?: string;
  customProvider?: WebSearchCustomProviderConfig;
};

/** One provider is active; saved provider configurations survive switching. */
export type WebSearchConfig = WebSearchProviderConfig & {
  /** Missing webSearch section is off; legacy sections without this flag remain enabled. */
  enabled?: boolean;
  provider?: WebSearchProvider;
  providers?: Partial<Record<WebSearchProvider, WebSearchProviderConfig>>;
};

function legacyProviderConfig(config: WebSearchProviderConfig): WebSearchProviderConfig {
  return {
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.searchEngine !== undefined ? { searchEngine: config.searchEngine } : {}),
    ...(config.customProvider !== undefined ? { customProvider: config.customProvider } : {}),
  };
}

/** Legacy flat fields belong only to the provider selected in that config. */
export function getWebSearchProviderConfig(
  config: WebSearchConfig,
  provider: WebSearchProvider = config.provider ?? "glm",
): WebSearchProviderConfig {
  const saved = config.providers?.[provider];
  if (saved) return saved;
  return provider === (config.provider ?? "glm") ? legacyProviderConfig(config) : {};
}

/** Move legacy settings into their provider without copying them to another provider. */
export function migrateWebSearchProviderConfigs(config: WebSearchConfig): WebSearchConfig {
  const { apiKey, endpoint, searchEngine, customProvider, providers, ...rest } = config;
  const legacy = legacyProviderConfig({ apiKey, endpoint, searchEngine, customProvider });
  if (Object.keys(legacy).length === 0) return { ...rest, ...(providers ? { providers } : {}) };
  const provider = config.provider ?? "glm";
  return {
    ...rest,
    providers: { ...providers, [provider]: providers?.[provider] ?? legacy },
  };
}

/** The UI, connection probe and runtime all resolve the same selected settings. */
export function resolveWebSearchConfig(config: WebSearchConfig): WebSearchConfig {
  const provider = config.provider ?? "glm";
  return {
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    // Keep legacy empty blocks compatible with environment-based provider selection.
    ...(config.provider !== undefined || config.providers?.[provider] ? { provider } : {}),
    ...getWebSearchProviderConfig(config, provider),
  };
}

export function updateWebSearchProviderConfig(
  current: WebSearchConfig,
  next: WebSearchConfig,
): WebSearchConfig {
  const migrated = migrateWebSearchProviderConfigs(current);
  const provider = next.provider ?? current.provider ?? "glm";
  const settings = legacyProviderConfig(next);
  return {
    ...migrated,
    ...(next.enabled !== undefined ? { enabled: next.enabled } : {}),
    ...(next.provider !== undefined ? { provider } : {}),
    ...(Object.keys(settings).length > 0
      ? { providers: { ...migrated.providers, [provider]: settings } }
      : {}),
  };
}
