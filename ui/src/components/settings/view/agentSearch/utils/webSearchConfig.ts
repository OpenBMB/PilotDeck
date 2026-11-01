import { WEB_SEARCH_ENDPOINTS, type WebSearchProvider } from "../../../../../../../src/pilot/config/webSearchProviders.js";
import type { PilotDeckConfig } from "../../modelPool/types";
import { getWebSearchProviderConfig, migrateWebSearchProviderConfigs, resolveWebSearchConfig } from "../../../../../../../src/pilot/config/webSearchConfig.js";

export type { WebSearchProvider };

type WebSearchConfig = NonNullable<
  NonNullable<PilotDeckConfig["tools"]>["webSearch"]
>;

export function webSearchConfigForProvider(
  current: WebSearchConfig,
  provider: WebSearchProvider,
  glmDefaultEndpoint: string,
): WebSearchConfig {
  const endpoint = provider === "custom" ? undefined : provider === "glm" ? glmDefaultEndpoint : WEB_SEARCH_ENDPOINTS[provider];
  const migrated = migrateWebSearchProviderConfigs(current);
  return {
    ...migrated,
    provider,
    providers: {
      ...migrated.providers,
      [provider]: {
        ...(provider === "serpapi" ? { searchEngine: "google" as const } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(provider === "custom"
          ? { customProvider: { auth: "bearer" as const, method: "POST" as const } }
          : {}),
        ...getWebSearchProviderConfig(migrated, provider),
      },
    },
  };
}

export function isWebSearchApiKeyRequired(
  config: WebSearchConfig,
): boolean {
  const active = resolveWebSearchConfig(config);
  return (
    active.provider !== "custom"
    || (active.customProvider?.auth ?? "bearer") !== "none"
  );
}
