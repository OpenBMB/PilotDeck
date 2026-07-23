import type { PilotDeckConfig } from "../../modelPool/types";

export type WebSearchProvider = "glm" | "tavily" | "custom";

type WebSearchConfig = NonNullable<
  NonNullable<PilotDeckConfig["tools"]>["webSearch"]
>;

export function webSearchConfigForProvider(
  current: WebSearchConfig,
  provider: WebSearchProvider,
  glmDefaultEndpoint: string,
): WebSearchConfig {
  return {
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    provider,
    ...(provider === "glm" ? { endpoint: glmDefaultEndpoint } : {}),
  };
}

export function isWebSearchApiKeyRequired(
  config: WebSearchConfig,
): boolean {
  const provider =
    config.provider === "tavily" || config.provider === "custom"
      ? config.provider
      : "glm";
  return (
    provider !== "custom" ||
    (config.customProvider?.auth ?? "bearer") !== "none"
  );
}
