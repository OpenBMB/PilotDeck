import { describe, expect, it } from "vitest";
import type { ChatModelCatalogItem } from "../chat/hooks/useChatProviderState";
import {
  buildExplicitSelection,
  mergeModelSelections,
  normalizeModelSelection,
  parseCatalogItem,
  preserveParamsForModel,
  sameCapabilityValue,
  speedOptionValues,
} from "./modelCapabilityOptions";

const catalogItem: ChatModelCatalogItem = {
  id: "openai/gpt-4o",
  provider: "openai",
  model: "gpt-4o",
  displayName: "GPT-4o",
  available: true,
  capabilities: {
    reasoning: { type: "enum", values: [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1] },
    temperature: { type: "range", min: 0, max: 1, step: 0.1 },
    speed: { type: "enum", values: [0, 1] },
  },
};

describe("modelCapabilityOptions", () => {
  it("treats nearby reasoning values as the same selected option", () => {
    expect(sameCapabilityValue(0.6, 0.6)).toBe(true);
    expect(sameCapabilityValue(0.6000000004, 0.6)).toBe(true);
    expect(sameCapabilityValue(undefined, 0.6)).toBe(false);
  });

  it("exposes two-tier speed options even when the catalog still sends a range", () => {
    expect(speedOptionValues({ type: "enum", values: [0, 1] })).toEqual([0, 1]);
    expect(
      speedOptionValues({ type: "range", min: 0, max: 1, step: 0.1 }),
    ).toEqual([0, 1]);
  });

  it("keeps reasoning, temperature, and speed when reselecting the same model", () => {
    const preserved = preserveParamsForModel(catalogItem, {
      mode: "model",
      provider: "openai",
      model: "gpt-4o",
      reasoning: 0.6,
      temperature: 0.3,
      speed: 1,
    });
    expect(preserved).toEqual({ reasoning: 0.6, temperature: 0.3, speed: 1 });
    expect(buildExplicitSelection(catalogItem, preserved)).toEqual({
      mode: "model",
      provider: "openai",
      model: "gpt-4o",
      reasoning: 0.6,
      temperature: 0.3,
      speed: 1,
    });
  });

  it("merges session saved model with locally stored parameters", () => {
    expect(
      mergeModelSelections(
        { mode: "model", provider: "openai", model: "gpt-4o" },
        { mode: "model", provider: "openai", model: "gpt-4o", reasoning: 0.8, speed: 1 },
      ),
    ).toEqual({
      mode: "model",
      provider: "openai",
      model: "gpt-4o",
      reasoning: 0.8,
      speed: 1,
    });
  });

  it("parses catalog speed capabilities from the models API", () => {
    expect(
      parseCatalogItem({
        id: "openai/gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        displayName: "GPT-4o",
        available: true,
        capabilities: {
          reasoning: { type: "enum", values: [0, 0.6, 1] },
          speed: { type: "enum", values: [0, 1] },
        },
      })?.capabilities,
    ).toEqual({
      reasoning: { type: "enum", values: [0, 0.6, 1] },
      speed: { type: "enum", values: [0, 1] },
    });
  });

  it("normalizes numeric model parameters from persisted JSON", () => {
    expect(
      normalizeModelSelection({
        mode: "model",
        provider: "openai",
        model: "gpt-4o",
        reasoning: "0.6",
        speed: "1",
      }),
    ).toEqual({
      mode: "model",
      provider: "openai",
      model: "gpt-4o",
      reasoning: 0.6,
      speed: 1,
    });
  });
});
