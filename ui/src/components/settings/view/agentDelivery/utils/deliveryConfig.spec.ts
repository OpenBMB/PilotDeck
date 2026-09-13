import { describe, expect, it } from "vitest";
import type { AgentDeliveryConfig } from "../../modelPool/types";
import {
  DELIVERY_DEFAULTS,
  DELIVERY_LIMITS,
  DELIVERY_PROMPT_MAX_BYTES,
  deliveryPromptByteLength,
  validateDelivery,
} from "./deliveryConfig";

describe("validateDelivery", () => {
  it("accepts an absent delivery section (backend defaults apply)", () => {
    expect(validateDelivery({})).toEqual([]);
  });

  it("accepts defaults and a valid reviewer ref", () => {
    expect(
      validateDelivery({
        mode: "auto",
        prompt: "guidance",
        reviewerModel: "HXAPI/reviewer",
        maxRepairs: DELIVERY_DEFAULTS.maxRepairs,
        maxTurns: DELIVERY_DEFAULTS.maxTurns,
        reviewTimeoutMs: DELIVERY_DEFAULTS.reviewTimeoutMs,
        maxReviewInputTokens: DELIVERY_DEFAULTS.maxReviewInputTokens,
        maxReviewOutputTokens: DELIVERY_DEFAULTS.maxReviewOutputTokens,
      }),
    ).toEqual([]);
  });

  it("accepts a blank prompt (protocol only)", () => {
    expect(validateDelivery({ prompt: "   \n" })).toEqual([]);
  });

  it("rejects a prompt over the UTF-8 byte budget", () => {
    const bytes = DELIVERY_PROMPT_MAX_BYTES + 1;
    const errors = validateDelivery({ prompt: "x".repeat(bytes) });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("settingsPage.delivery.invalidPrompt");
    expect(errors[0].params).toMatchObject({ bytes, max: DELIVERY_PROMPT_MAX_BYTES });
  });

  it("counts multibyte characters in the byte budget", () => {
    expect(deliveryPromptByteLength("üü")).toBe(4);
  });

  it.each([
    ["maxRepairs", DELIVERY_LIMITS.maxRepairs.min - 1],
    ["maxRepairs", DELIVERY_LIMITS.maxRepairs.max + 1],
    ["maxTurns", DELIVERY_LIMITS.maxTurns.min - 1],
    ["maxTurns", DELIVERY_LIMITS.maxTurns.max + 1],
    ["reviewTimeoutMs", DELIVERY_LIMITS.reviewTimeoutMs.min - 1],
    ["reviewTimeoutMs", DELIVERY_LIMITS.reviewTimeoutMs.max + 1],
    ["maxReviewInputTokens", DELIVERY_LIMITS.maxReviewInputTokens.min - 1],
    ["maxReviewInputTokens", DELIVERY_LIMITS.maxReviewInputTokens.max + 1],
    ["maxReviewOutputTokens", DELIVERY_LIMITS.maxReviewOutputTokens.min - 1],
    ["maxReviewOutputTokens", DELIVERY_LIMITS.maxReviewOutputTokens.max + 1],
  ] as const)("rejects out-of-range %s=%s", (field, value) => {
    const errors = validateDelivery({ [field]: value } as AgentDeliveryConfig);
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("settingsPage.delivery.invalidNumber");
    expect(errors[0].params).toMatchObject({
      field: `settingsPage.delivery.budgets.${field}`,
    });
  });

  it("rejects non-integer budget values", () => {
    expect(validateDelivery({ maxRepairs: 1.5 })).not.toEqual([]);
  });

  it("rejects a reviewer ref without a provider prefix", () => {
    expect(validateDelivery({ reviewerModel: "just-a-model" })).toEqual([
      { key: "settingsPage.delivery.invalidReviewer" },
    ]);
    expect(validateDelivery({ reviewerModel: "HXAPI/model" })).toEqual([]);
  });
});

 it("accepts slash-containing model IDs after the provider prefix", () => {
  expect(validateDelivery({reviewerModel:"openrouter/org/model"})).toEqual([]);
 });
