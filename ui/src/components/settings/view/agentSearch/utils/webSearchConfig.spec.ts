import { describe, expect, it } from "vitest";
import { resolveWebSearchConfig } from "../../../../../../../src/pilot/config/webSearchConfig.js";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  isWebSearchApiKeyRequired,
  webSearchConfigForProvider,
} from "./webSearchConfig";

describe("webSearchConfigForProvider", () => {
  const glmEndpoint = "https://api.z.ai/api/paas/v4/web_search";

  it("preserves the enabled switch and archives the current provider when changing providers", () => {
    expect(
      webSearchConfigForProvider(
        {
          enabled: false,
          provider: "glm",
          apiKey: "********",
          endpoint: glmEndpoint,
        },
        "tavily",
        glmEndpoint,
      ),
    ).toEqual({
      enabled: false,
      provider: "tavily",
      providers: {
        glm: { apiKey: "********", endpoint: glmEndpoint },
        tavily: { endpoint: "https://api.tavily.com/search" },
      },
    });
  });

  it("restores the GLM default endpoint", () => {
    expect(
      webSearchConfigForProvider(
        { enabled: true, provider: "tavily" },
        "glm",
        glmEndpoint,
      ),
    ).toEqual({
      enabled: true,
      provider: "glm",
      providers: { glm: { endpoint: glmEndpoint } },
    });
  });

  it("keeps the backwards-compatible implicit enabled state", () => {
    expect(
      webSearchConfigForProvider({}, "glm", glmEndpoint),
    ).toEqual({
      provider: "glm",
      providers: { glm: { endpoint: glmEndpoint } },
    });
  });

  it("uses the built-in endpoints for Serper and Brave", () => {
    expect(webSearchConfigForProvider({}, "serper", glmEndpoint)).toEqual({
      provider: "serper",
      providers: { serper: { endpoint: "https://google.serper.dev/search" } },
    });
    expect(webSearchConfigForProvider({}, "brave", glmEndpoint)).toEqual({
      provider: "brave",
      providers: { brave: { endpoint: "https://api.search.brave.com/res/v1/web/search" } },
    });
  });

  it("restores each saved key, custom settings and SerpAPI engine after switching", () => {
    const initial = {
      enabled: true,
      provider: "custom" as const,
      apiKey: "custom-key",
      endpoint: "https://custom.example/search",
      customProvider: { auth: "queryApiKey" as const, method: "GET" as const },
      providers: { serpapi: { apiKey: "serpapi-key", searchEngine: "bing" as const } },
    };
    const switched = webSearchConfigForProvider(initial, "serpapi", glmEndpoint);
    expect(resolveWebSearchConfig(switched)).toMatchObject({
      provider: "serpapi", apiKey: "serpapi-key", searchEngine: "bing",
    });
    const returned = webSearchConfigForProvider(switched, "custom", glmEndpoint);
    expect(resolveWebSearchConfig(returned)).toEqual({
      enabled: true, provider: "custom", apiKey: "custom-key",
      endpoint: initial.endpoint, customProvider: initial.customProvider,
    });
    expect(returned.providers?.serpapi?.apiKey).toBe("serpapi-key");
    expect(initial.apiKey).toBe("custom-key");
  });

  it("initializes a simplified custom provider", () => {
    expect(webSearchConfigForProvider({}, "custom", glmEndpoint)).toEqual({
      provider: "custom",
      providers: { custom: { customProvider: { auth: "bearer", method: "POST" } } },
    });
  });
});

describe("isWebSearchApiKeyRequired", () => {
  it("allows unauthenticated custom search services", () => {
    expect(
      isWebSearchApiKeyRequired({
        provider: "custom",
        customProvider: { auth: "none" },
      }),
    ).toBe(false);
    expect(isWebSearchApiKeyRequired({
      provider: "custom",
      providers: { custom: { customProvider: { auth: "none" } } },
    })).toBe(false);
  });

  it("requires a key for built-in and authenticated custom providers", () => {
    expect(isWebSearchApiKeyRequired({ provider: "glm" })).toBe(true);
    expect(
      isWebSearchApiKeyRequired({
        provider: "custom",
        customProvider: { auth: "bearer" },
      }),
    ).toBe(true);
  });

  it("keeps the shared config type in sync with built-in providers", () => {
    const providers: Array<NonNullable<NonNullable<PilotDeckConfig["tools"]>["webSearch"]>["provider"]> = [
      "glm",
      "tavily",
      "custom",
      "serper",
      "brave",
    ];
    expect(providers).toContain("serper");
    expect(providers).toContain("brave");
  });
});
