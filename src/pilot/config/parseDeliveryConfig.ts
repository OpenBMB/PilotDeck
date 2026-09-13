import { isRecord } from "../../model/config/schema.js";
import type {
  PilotAgentDeliveryConfig,
  PilotAgentModelSelection,
  PilotConfigDiagnostic,
} from "./types.js";

/**
 * Parse the optional `agent.delivery` section of `pilotdeck.yaml`.
 *
 *   agent:
 *     delivery:
 *       mode: auto                     # auto (default) | off
 *       prompt: "..."                  # optional, <= 32768 bytes, blank allowed
 *       maxRepairs: 2                  # 0..5, default 2
 *       maxTurns: 20                   # 1..100, default 20
 *       reviewerModel: provider/model  # existing provider/model reference
 *       reviewTimeoutMs: 60000         # 1000..180000, default 60000
 *       maxReviewInputTokens: 4096     # 256..16384, default 4096
 *       maxReviewOutputTokens: 512     # 64..2048, default 512
 *
 * Bounds mirror `DeliveryRuntimeConfig` in `src/agent/sub/delivery/types.ts`.
 * Invalid values are rejected (fatal diagnostics) — there is no silent
 * fallback for an invalid configured reviewer model. Omitted fields stay
 * omitted so the runtime defaults in `deliveryConfig()` apply unchanged.
 * A YAML `null` value is treated as an absent field, matching the
 * "null is absent content" convention of the delivery report itself.
 */

export const DELIVERY_PROMPT_MAX_BYTES = 32768;

export const DELIVERY_FIELD_LIMITS = {
  maxRepairs: { min: 0, max: 5 },
  maxTurns: { min: 1, max: 100 },
  reviewTimeoutMs: { min: 1000, max: 180000 },
  maxReviewInputTokens: { min: 256, max: 16384 },
  maxReviewOutputTokens: { min: 64, max: 2048 },
} as const;

export type DeliveryFieldLimitName = keyof typeof DELIVERY_FIELD_LIMITS;

const DELIVERY_FIELD_NAMES = Object.keys(DELIVERY_FIELD_LIMITS) as DeliveryFieldLimitName[];

/**
 * Resolves a raw provider/model reference via the existing agent model
 * selection parser. Invalid references push fatal diagnostics (the config
 * load is rejected — no silent fallback to the conversation model).
 */
export type DeliveryReviewerModelResolver = (
  value: unknown,
  path: string,
) => PilotAgentModelSelection;

export function parseDeliveryConfig(
  rawDelivery: unknown,
  resolveReviewerModel: DeliveryReviewerModelResolver,
  diagnostics: PilotConfigDiagnostic[],
): PilotAgentDeliveryConfig | undefined {
  if (rawDelivery === undefined || rawDelivery === null) {
    return undefined;
  }
  if (!isRecord(rawDelivery)) {
    diagnostics.push({
      code: "CONFIG_AGENT_DELIVERY_INVALID",
      severity: "fatal",
      message: "agent.delivery must be an object.",
      path: "agent.delivery",
      recoverable: false,
    });
    return undefined;
  }

  const result: PilotAgentDeliveryConfig = {};

  if (rawDelivery.mode !== undefined && rawDelivery.mode !== null) {
    if (rawDelivery.mode !== "auto" && rawDelivery.mode !== "off") {
      diagnostics.push({
        code: "CONFIG_AGENT_DELIVERY_MODE_INVALID",
        severity: "fatal",
        message: "agent.delivery.mode must be \"auto\" or \"off\".",
        path: "agent.delivery.mode",
        recoverable: false,
      });
    } else {
      result.mode = rawDelivery.mode;
    }
  }

  if (rawDelivery.prompt !== undefined && rawDelivery.prompt !== null) {
    if (typeof rawDelivery.prompt !== "string") {
      diagnostics.push({
        code: "CONFIG_AGENT_DELIVERY_PROMPT_INVALID",
        severity: "fatal",
        message: "agent.delivery.prompt must be a string.",
        path: "agent.delivery.prompt",
        recoverable: false,
      });
    } else if (new TextEncoder().encode(rawDelivery.prompt).length > DELIVERY_PROMPT_MAX_BYTES) {
      diagnostics.push({
        code: "CONFIG_AGENT_DELIVERY_PROMPT_TOO_LONG",
        severity: "fatal",
        message: `agent.delivery.prompt must be at most ${DELIVERY_PROMPT_MAX_BYTES} bytes.`,
        path: "agent.delivery.prompt",
        recoverable: false,
      });
    } else {
      // Preserved verbatim: an empty/whitespace prompt is meaningful and
      // removes the editable default example while keeping the protocol.
      result.prompt = rawDelivery.prompt;
    }
  }

  for (const field of DELIVERY_FIELD_NAMES) {
    const parsed = readBoundedInteger(
      rawDelivery[field],
      `agent.delivery.${field}`,
      field,
      diagnostics,
    );
    if (parsed !== undefined) {
      result[field] = parsed;
    }
  }

  if (rawDelivery.reviewerModel !== undefined && rawDelivery.reviewerModel !== null) {
    result.reviewerModel = resolveReviewerModel(
      rawDelivery.reviewerModel,
      "agent.delivery.reviewerModel",
    );
  }

  for (const key of Object.keys(rawDelivery)) {
    if (
      key !== "mode"
      && key !== "prompt"
      && key !== "reviewerModel"
      && !DELIVERY_FIELD_NAMES.includes(key as DeliveryFieldLimitName)
    ) {
      diagnostics.push({
        code: "CONFIG_AGENT_DELIVERY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown agent.delivery field ${key}.`,
        path: `agent.delivery.${key}`,
        recoverable: true,
      });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function readBoundedInteger(
  value: unknown,
  path: string,
  field: DeliveryFieldLimitName,
  diagnostics: PilotConfigDiagnostic[],
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const limit = DELIVERY_FIELD_LIMITS[field];
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < limit.min
    || value > limit.max
  ) {
    diagnostics.push({
      code: "CONFIG_AGENT_DELIVERY_FIELD_INVALID",
      severity: "fatal",
      message: `${path} must be an integer between ${limit.min} and ${limit.max}.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return value;
}
