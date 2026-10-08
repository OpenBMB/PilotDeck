import { WEB_SEARCH_ENDPOINTS, type WebSearchProvider } from "../../../../../../../src/pilot/config/webSearchProviders.js";
import type { PilotDeckConfig } from "../../modelPool/types";

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
  return {
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    provider,
    ...(provider === "serpapi" ? { searchEngine: "google" as const } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(provider === "custom"
      ? { customProvider: { auth: "bearer" as const, method: "POST" as const } }
      : {}),
  };
}

export function isWebSearchApiKeyRequired(
  config: WebSearchConfig,
): boolean {
  return (
    config.provider !== "custom"
    || (config.customProvider?.auth ?? "bearer") !== "none"
  );
}
