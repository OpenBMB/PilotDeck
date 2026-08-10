import { describe, expect, it } from "vitest";
import type { PilotDeckConfig } from "../../modelPool/types";
import { setModelImageInput } from "./modelRefs";

describe("setModelImageInput", () => {
  it("persists an explicit text-only capability when image input is disabled", () => {
    const config: PilotDeckConfig = {
      agent: { model: "custom/text-model" },
      model: {
        providers: {
          custom: {
            protocol: "openai",
            models: { "text-model": {} },
          },
        },
      },
    };

    const updated = setModelImageInput(config, "custom/text-model", false);

    expect(updated.model?.providers?.custom.models?.["text-model"]).toEqual({
      multimodal: { input: ["text"] },
    });
    expect(config.model?.providers?.custom.models?.["text-model"]).toEqual({});
  });

  it("persists image input while preserving other model and multimodal settings", () => {
    const config: PilotDeckConfig = {
      model: {
        providers: {
          custom: {
            models: {
              "vision-model": {
                capabilities: { maxOutputTokens: 8192 },
                multimodal: { maxImagesPerRequest: 5, input: ["text"] },
              },
            },
          },
        },
      },
    };

    const updated = setModelImageInput(config, "custom/vision-model", true);

    expect(updated.model?.providers?.custom.models?.["vision-model"]).toEqual({
      capabilities: { maxOutputTokens: 8192 },
      multimodal: { maxImagesPerRequest: 5, input: ["text", "image"] },
    });
  });
});
