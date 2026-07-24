import { describe, expect, it } from "vitest";
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
    ).toEqual({ enabled: false, provider: "tavily" });
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
});

describe("isWebSearchApiKeyRequired", () => {
  it("allows a custom unauthenticated search service", () => {
    expect(
      isWebSearchApiKeyRequired({
        provider: "custom",
        customProvider: { auth: "none" },
      }),
    ).toBe(false);
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
});
