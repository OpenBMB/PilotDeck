import type { AgentDeliveryConfig } from "../../modelPool/types";

/**
 * Backend defaults for agent.delivery. Absent fields fall back to these on
 * the host side, so the UI treats "key absent" and "key equals default" the
 * same and keeps the raw config minimal.
 */
export const DELIVERY_DEFAULTS = {
  maxRepairs: 2,
  maxTurns: 20,
  reviewTimeoutMs: 60000,
  maxReviewInputTokens: 4096,
  maxReviewOutputTokens: 512,
} as const;

export const DELIVERY_LIMITS = {
  maxRepairs: { min: 0, max: 5 },
  maxTurns: { min: 1, max: 100 },
  reviewTimeoutMs: { min: 1000, max: 180000 },
  maxReviewInputTokens: { min: 256, max: 16384 },
  maxReviewOutputTokens: { min: 64, max: 2048 },
} as const;

export const DELIVERY_PROMPT_MAX_BYTES = 32768;

export const DELIVERY_NUMERIC_FIELDS = [
  "maxRepairs",
  "maxTurns",
  "reviewTimeoutMs",
  "maxReviewInputTokens",
  "maxReviewOutputTokens",
] as const;

export type DeliveryNumericField = (typeof DELIVERY_NUMERIC_FIELDS)[number];

export type DeliveryValidationError = {
  key: string;
  params?: Record<string, unknown>;
};

/** Mirrors the host reviewer ref check: `provider/model` raw reference. */
const REVIEWER_REF_PATTERN = /^[^/\s]+\/\S+$/;

export function deliveryPromptByteLength(prompt: string): number {
  return new TextEncoder().encode(prompt).length;
}

export function validateDelivery(
  delivery: AgentDeliveryConfig,
): DeliveryValidationError[] {
  const errors: DeliveryValidationError[] = [];

  if (typeof delivery.prompt === "string") {
    const bytes = deliveryPromptByteLength(delivery.prompt);
    if (bytes > DELIVERY_PROMPT_MAX_BYTES) {
      errors.push({
        key: "settingsPage.delivery.invalidPrompt",
        params: { bytes, max: DELIVERY_PROMPT_MAX_BYTES },
      });
    }
  }

  for (const field of DELIVERY_NUMERIC_FIELDS) {
    const value = delivery[field];
    if (value === undefined) continue;
    const { min, max } = DELIVERY_LIMITS[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push({
        key: "settingsPage.delivery.invalidNumber",
        params: {
          field: `settingsPage.delivery.budgets.${field}`,
          min,
          max,
        },
      });
    }
  }

  if (
    typeof delivery.reviewerModel === "string"
    && delivery.reviewerModel.trim() !== ""
    && !REVIEWER_REF_PATTERN.test(delivery.reviewerModel.trim())
  ) {
    errors.push({ key: "settingsPage.delivery.invalidReviewer" });
  }

  return errors;
}
