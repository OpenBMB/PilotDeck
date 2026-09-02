import { describe, expect, it } from "vitest";
import type { V2Provider } from "../types";
import {
  clearProviderConnectionTests,
  isProviderConnected,
  isProviderPending,
  modelHasPassingConnectionTest,
} from "./providerStatus";

const passingTest = {
  status: "passed",
  textInput: "supported",
  imageInput: "supported",
};

function providerWith(models: V2Provider["models"]): V2Provider {
  return { apiKey: "sk-test", models };
}

describe("provider connection status", () => {
  it("treats a provider as pending until every enabled model has a passing test", () => {
    expect(isProviderPending(providerWith({}))).toBe(true);
    expect(isProviderConnected(providerWith({ "model-a": {} }))).toBe(false);
    expect(isProviderConnected(providerWith({
      "model-a": { connectionTest: passingTest },
      "model-b": {},
    }))).toBe(false);
  });

  it("treats a provider as connected when all enabled models passed text and resolved image checks", () => {
    expect(isProviderConnected(providerWith({
      "model-a": { connectionTest: passingTest },
      "model-b": {
        connectionTest: {
          status: "passed",
          textInput: "supported",
          imageInput: "unsupported",
        },
      },
    }))).toBe(true);
  });

  it("does not count unknown image support as a passing test", () => {
    expect(modelHasPassingConnectionTest({
      connectionTest: {
        status: "passed",
        textInput: "supported",
        imageInput: "unknown",
      },
    })).toBe(false);
    expect(isProviderConnected(providerWith({
      "model-a": {
        connectionTest: {
          status: "passed",
          textInput: "supported",
          imageInput: "unknown",
        },
      },
    }))).toBe(false);
  });

  it("clears stored tests without dropping other model fields", () => {
    const cleared = clearProviderConnectionTests({
      apiKey: "sk-test",
      models: {
        "model-a": {
          connectionTest: passingTest,
          capabilities: { maxOutputTokens: 1024 },
        },
      },
    });
    expect(cleared.models?.["model-a"]).toEqual({
      capabilities: { maxOutputTokens: 1024 },
    });
  });
});
