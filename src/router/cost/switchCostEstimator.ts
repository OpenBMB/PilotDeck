/**
 * Cache-aware stay/switch cost estimator (PilotRoute Module 2).
 *
 * Billing-contract rules encoded here (replaces the two-bucket comparison in
 * `maybePreserveStickyForCache`; see tests/router/cost-semantics.spec.ts for
 * the audit findings):
 *
 * - Mutually-exclusive buckets: `inputTokens + cacheReadTokens +
 *   cacheWriteTokens` always sums to the estimated request input. A token is
 *   never billed in two buckets, and the normalized usage buckets feeding the
 *   read-ratio projection are summed (never divided against each other).
 * - Write evidence counts: a cache WRITTEN on the last observed turn is
 *   readable on the upcoming turn, so `cacheWriteTokens` contributes to the
 *   projected read ratio (audit Q7 — a just-created cache is not zero
 *   evidence).
 * - SUNK COST RULE: on the stay side the cache write was already paid for on
 *   earlier turns and is never re-charged in a stay decision; the stay side
 *   always prices cacheWriteTokens at 0.
 * - TTL assumption: provider caches refresh on every hit (Anthropic ephemeral
 *   cache TTL is 5m), but intermediate hits are not observable here — the
 *   last usage observation is treated as the cache clock. Evidence older than
 *   the TTL is assumed expired.
 */
import type { RouterModelPricingMap } from "../utils/modelPricing.js";
import { lookupModelPricingDetailed, type PricingQuote } from "../utils/modelPricing.js";

/** Anthropic ephemeral prompt-cache TTL (5 minutes); hits refresh it. */
export const DEFAULT_CACHE_TTL_MS = 300_000;

/** Usage evidence for a candidate model, usually the last observed turn. */
export type CacheEvidence = {
  provider: string;
  model: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  /** Ms epoch; missing → staleness unknown. */
  observedAt?: number;
};

export type CandidateEstimateInput = {
  provider: string;
  model: string;
  supportsPromptCache: boolean;
  /** Total input tokens for the upcoming request (messages+system+tools). */
  estimatedInputTokens: number;
  /** Projected output tokens for the upcoming request. */
  estimatedOutputTokens: number;
  /** Keyed usage evidence for THIS candidate model, if any. */
  cacheEvidence?: CacheEvidence;
  /** Provider cache TTL for staleness (Anthropic ephemeral 5m). Default 300_000. */
  cacheTtlMs?: number;
  /** Current time (ms epoch) for staleness. Default Date.now(). */
  now?: number;
  modelPricing?: RouterModelPricingMap;
  /**
   * Decision role of this candidate. `"stay"` applies the sunk-cost rule
   * (cacheWriteTokens always 0 — the existing cache was paid for earlier);
   * `"switch"` applies the cold-start rules when no warm evidence projects a
   * readable prefix (cache write for the full input on cache-capable models,
   * plain input otherwise). Defaults to `"switch"`; `compareStayVsSwitch`
   * sets both roles explicitly.
   */
  role?: "stay" | "switch";
};

export type CostBuckets = {
  /** Uncached input, billed at input rate. */
  inputTokens: number;
  /** Billed at cacheRead rate. */
  cacheReadTokens: number;
  /** Billed at cacheWrite rate. */
  cacheWriteTokens: number;
  outputTokens: number;
};

export type CandidateCostEstimate = {
  provider: string;
  model: string;
  buckets: CostBuckets;
  costs: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number };
  pricing: PricingQuote;
  uncertainty: "low" | "medium" | "high" | "unknown";
  notes: string[];
};

/**
 * Estimates the cost of serving the upcoming request on one candidate model.
 * Pure: no clock, network, or runtime state (pass `now` for determinism).
 */
export function estimateCandidateCost(input: CandidateEstimateInput): CandidateCostEstimate {
  const pricing = lookupModelPricingDetailed(input.provider, input.model, input.modelPricing);
  const notes: string[] = [];
  const totalInput = input.estimatedInputTokens;

  if (!(totalInput > 0)) {
    const buckets: CostBuckets = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: input.estimatedOutputTokens,
    };
    return {
      provider: input.provider,
      model: input.model,
      buckets,
      costs: costsFromBuckets(buckets, pricing),
      pricing,
      uncertainty: "unknown",
      notes: ["estimated input tokens unavailable", ...pricing.notes],
    };
  }

  let uncertainty: CandidateCostEstimate["uncertainty"] = "low";
  let projectedReadRatio = 0;

  if (input.cacheEvidence) {
    const evidence = input.cacheEvidence;
    const observedInput = positiveTokens(evidence.inputTokens);
    const observedRead = positiveTokens(evidence.cacheReadTokens);
    const observedWrite = positiveTokens(evidence.cacheWriteTokens);
    const totalObservedInput = observedInput + observedRead + observedWrite;
    projectedReadRatio =
      totalObservedInput > 0 ? (observedRead + observedWrite) / totalObservedInput : 0;
    projectedReadRatio = Math.min(1, Math.max(0, projectedReadRatio));

    const now = input.now ?? Date.now();
    const ttlMs = input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (evidence.observedAt !== undefined && now - evidence.observedAt > ttlMs) {
      projectedReadRatio = 0;
      uncertainty = "high";
      notes.push("cache evidence older than TTL");
    } else if (evidence.observedAt === undefined) {
      uncertainty = "medium";
      notes.push("usage staleness unknown");
    }
  } else {
    uncertainty = "medium";
    notes.push("no usage evidence for candidate");
  }

  let buckets: CostBuckets;
  if (projectedReadRatio > 0) {
    // Warm prefix: evidence projects a readable share of the input. Applies to
    // the stay side and to a switch target with its own hot evidence.
    const cacheReadTokens = Math.round(totalInput * projectedReadRatio);
    buckets = {
      inputTokens: totalInput - cacheReadTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      outputTokens: input.estimatedOutputTokens,
    };
  } else if (input.role === "stay") {
    // SUNK COST RULE: the stay side never re-charges the cache write.
    buckets = {
      inputTokens: totalInput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: input.estimatedOutputTokens,
    };
  } else if (input.supportsPromptCache) {
    buckets = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: totalInput,
      outputTokens: input.estimatedOutputTokens,
    };
    notes.push("cold prefill with cache write");
  } else {
    buckets = {
      inputTokens: totalInput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: input.estimatedOutputTokens,
    };
    notes.push("model does not support prompt caching");
  }

  if (pricing.notes.length > 0) {
    uncertainty = raiseUncertainty(uncertainty, "medium");
  }

  return {
    provider: input.provider,
    model: input.model,
    buckets,
    costs: costsFromBuckets(buckets, pricing),
    pricing,
    uncertainty,
    notes: [...notes, ...pricing.notes],
  };
}

export type SwitchCostResult = {
  stay: CandidateCostEstimate;
  switch: CandidateCostEstimate;
  /** stay.total - switch.total. > 0 means switching saves money. */
  savings: number;
  /** stay.total * minSavingsRatio — the threshold savings must exceed. */
  requiredSavings: number;
  recommendation: "switch" | "keep" | "unknown";
};

/**
 * Compares staying on the current model (cache reads, sunk cache writes)
 * against switching (full prefill, cache write when the target supports
 * caching). `recommendation` is `"unknown"` when either side has nothing
 * estimable; otherwise `"switch"` only when savings exceed
 * `stay.total * max(0, minSavingsRatio)` by more than float noise.
 */
export function compareStayVsSwitch(input: {
  stay: CandidateEstimateInput;
  switch: CandidateEstimateInput;
  minSavingsRatio?: number;
}): SwitchCostResult {
  const stay = estimateCandidateCost({ ...input.stay, role: "stay" });
  const target = estimateCandidateCost({ ...input.switch, role: "switch" });
  const savings = stay.costs.total - target.costs.total;
  const requiredSavings = stay.costs.total * Math.max(0, input.minSavingsRatio ?? 0);
  const unknown = stay.uncertainty === "unknown" || target.uncertainty === "unknown";
  return {
    stay,
    switch: target,
    savings,
    requiredSavings,
    recommendation: unknown ? "unknown" : savings > requiredSavings + 1e-12 ? "switch" : "keep",
  };
}

function costsFromBuckets(buckets: CostBuckets, pricing: PricingQuote): CandidateCostEstimate["costs"] {
  const inputCost = (buckets.inputTokens / 1_000_000) * pricing.input;
  const cacheReadCost = (buckets.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  const cacheWriteCost = (buckets.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  const outputCost = (buckets.outputTokens / 1_000_000) * pricing.output;
  return {
    input: inputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    output: outputCost,
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
  };
}

/** Mirrors actualInputTokensFromUsage: only positive finite counts are evidence. */
function positiveTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

const UNCERTAINTY_ORDER: Record<CandidateCostEstimate["uncertainty"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  unknown: 3,
};

function raiseUncertainty(
  current: CandidateCostEstimate["uncertainty"],
  floor: CandidateCostEstimate["uncertainty"],
): CandidateCostEstimate["uncertainty"] {
  return UNCERTAINTY_ORDER[current] >= UNCERTAINTY_ORDER[floor] ? current : floor;
}
