import type { PilotDeckConfig } from "../../modelPool/types";

export type WebSearchProvider = "glm" | "tavily" | "custom" | "serper" | "brave";

type WebSearchConfig = NonNullable<
  NonNullable<PilotDeckConfig["tools"]>["webSearch"]
>;

export function webSearchConfigForProvider(
  current: WebSearchConfig,
  provider: WebSearchProvider,
  glmDefaultEndpoint: string,
): WebSearchConfig {
  const endpoint = provider === "glm"
    ? glmDefaultEndpoint
    : provider === "tavily"
      ? "https://api.tavily.com/search"
      : provider === "serper"
        ? "https://google.serper.dev/search"
        : provider === "brave"
          ? "https://api.search.brave.com/res/v1/web/search"
          : undefined;
  return {
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    provider,
    ...(endpoint ? { endpoint } : {}),
  };
}

export function isWebSearchApiKeyRequired(
  config: WebSearchConfig,
): boolean {
  const provider =
    config.provider === "tavily" || config.provider === "custom" || config.provider === "serper" || config.provider === "brave"
      ? config.provider
      : "glm";
  return (
    provider !== "custom" ||
    (config.customProvider?.auth ?? "bearer") !== "none"
  );
}
