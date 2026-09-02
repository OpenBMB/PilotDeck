import { describe, expect, it } from "vitest";
import type { PilotDeckConfig } from "../../modelPool/types";
import {
  isWebSearchApiKeyRequired,
  webSearchConfigForProvider,
} from "./webSearchConfig";

describe("webSearchConfigForProvider", () => {
  const glmEndpoint = "https://api.z.ai/api/paas/v4/web_search";

  it("preserves the enabled switch when changing providers", () => {
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
      endpoint: "https://api.tavily.com/search",
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
      endpoint: glmEndpoint,
    });
  });

  it("keeps the backwards-compatible implicit enabled state", () => {
    expect(
      webSearchConfigForProvider({}, "glm", glmEndpoint),
    ).toEqual({
      provider: "glm",
      endpoint: glmEndpoint,
    });
  });

  it("uses the built-in endpoints for Serper and Brave", () => {
    expect(webSearchConfigForProvider({}, "serper", glmEndpoint)).toEqual({
      provider: "serper",
      endpoint: "https://google.serper.dev/search",
    });
    expect(webSearchConfigForProvider({}, "brave", glmEndpoint)).toEqual({
      provider: "brave",
      endpoint: "https://api.search.brave.com/res/v1/web/search",
    });
  });

  it("initializes a simplified custom provider", () => {
    expect(webSearchConfigForProvider({}, "custom", glmEndpoint)).toEqual({
      provider: "custom",
      customProvider: {
        auth: "bearer",
        method: "POST",
      },
    });
  });
});

describe("isWebSearchApiKeyRequired", () => {
  it("requires a key for custom search services", () => {
    expect(
      isWebSearchApiKeyRequired({
        provider: "custom",
        customProvider: { auth: "none" },
      }),
    ).toBe(true);
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
