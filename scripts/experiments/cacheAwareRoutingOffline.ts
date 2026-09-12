import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCachePlan,
  rebuildRoutedCachePlan,
} from "../../src/context/cache/CachePlan.js";
import type {
  CachePlan,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
  CanonicalUsage,
  ModelCapabilities,
  ModelDefinition,
} from "../../src/model/index.js";
import { buildAnthropicRequest } from "../../src/model/providers/anthropic/request.js";
import {
  compareStayVsSwitch,
  DEFAULT_CACHE_TTL_MS,
  type CacheEvidence,
  type CostBuckets,
} from "../../src/router/cost/switchCostEstimator.js";
import {
  lookupModelPricingDetailed,
  type RouterModelPricingMap,
} from "../../src/router/utils/modelPricing.js";

export const EXPERIMENT_DATE = "2026-09-11";
export const EVIDENCE_KIND = "offline-deterministic-simulation" as const;
export const OUTPUT_DIRECTORY = "docs/experiments/cache-aware-routing-offline";

const BASE_TIME_MS = Date.parse(`${EXPERIMENT_DATE}T00:00:00.000Z`);
const MIN_SAVINGS_RATIO = 0.05;

export const ARMS = ["original", "plan_fix_only", "plan_and_full_cost"] as const;
export type ExperimentArm = typeof ARMS[number];

type ModelFixture = {
  id: string;
  provider: string;
  model: string;
  protocol: "anthropic" | "openai";
  supportsPromptCache: boolean;
};

const MODELS = {
  opus: model("anthropic", "claude-opus-sim", "anthropic", true),
  sonnet: model("anthropic", "claude-sonnet-sim", "anthropic", true),
  haiku: model("anthropic", "claude-haiku-sim", "anthropic", true),
  edge: model("local", "edge-small-sim", "openai", false),
} as const;

function model(
  provider: string,
  modelId: string,
  protocol: ModelFixture["protocol"],
  supportsPromptCache: boolean,
): ModelFixture {
  return { id: `${provider}/${modelId}`, provider, model: modelId, protocol, supportsPromptCache };
}

export const MODEL_PRICING: RouterModelPricingMap = {
  [MODELS.opus.id]: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  [MODELS.sonnet.id]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  [MODELS.haiku.id]: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  [MODELS.edge.id]: { input: 0.5, output: 1.5, cacheRead: 0.5, cacheWrite: 0.5 },
};

type TurnFixture = {
  atSeconds: number;
  judgeTarget: ModelFixture;
  totalInputTokens: number;
  cacheablePrefixTokens: number;
  messagesOnlyTokens: number;
  outputTokens: number;
  prefixLineage: string;
  contentVariant: string;
  generation: number;
};

type ScenarioFixture = {
  id: string;
  description: string;
  defaultModel: ModelFixture;
  turns: TurnFixture[];
};

function turn(
  atSeconds: number,
  judgeTarget: ModelFixture,
  totalInputTokens: number,
  cacheablePrefixTokens: number,
  messagesOnlyTokens: number,
  outputTokens: number,
  prefixLineage: string,
  contentVariant = prefixLineage,
  generation = 1,
): TurnFixture {
  return {
    atSeconds,
    judgeTarget,
    totalInputTokens,
    cacheablePrefixTokens,
    messagesOnlyTokens,
    outputTokens,
    prefixLineage,
    contentVariant,
    generation,
  };
}

export const SCENARIOS: ScenarioFixture[] = [
  {
    id: "cold_start",
    description: "Single cold Sonnet request.",
    defaultModel: MODELS.sonnet,
    turns: [turn(0, MODELS.sonnet, 50_000, 45_000, 20_000, 2_000, "cold-v1")],
  },
  {
    id: "same_model_stable_prefix",
    description: "Three Sonnet turns sharing one stable prefix lineage.",
    defaultModel: MODELS.sonnet,
    turns: [
      turn(0, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "stable-v1"),
      turn(60, MODELS.sonnet, 105_000, 100_000, 55_000, 2_000, "stable-v1"),
      turn(120, MODELS.sonnet, 110_000, 105_000, 60_000, 2_000, "stable-v1"),
    ],
  },
  {
    id: "hot_strong_then_simple",
    description: "Warm Opus prefix followed by two Haiku judge targets.",
    defaultModel: MODELS.opus,
    turns: [
      turn(0, MODELS.opus, 180_000, 175_000, 90_000, 4_000, "strong-v1"),
      turn(60, MODELS.opus, 190_000, 185_000, 100_000, 4_000, "strong-v1"),
      turn(120, MODELS.haiku, 195_000, 190_000, 105_000, 500, "strong-v1"),
      turn(180, MODELS.haiku, 200_000, 195_000, 110_000, 500, "strong-v1"),
    ],
  },
  {
    id: "lower_output_cost",
    description: "A large observed output makes Haiku's output rate relevant.",
    defaultModel: MODELS.sonnet,
    turns: [
      turn(0, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "output-v1"),
      turn(60, MODELS.sonnet, 105_000, 100_000, 55_000, 100_000, "output-v1"),
      turn(120, MODELS.haiku, 110_000, 105_000, 60_000, 100_000, "output-v1"),
    ],
  },
  {
    id: "prefix_changed_compaction",
    description: "The third turn changes system, tools, messages, and prefix lineage.",
    defaultModel: MODELS.sonnet,
    turns: [
      turn(0, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "v1", "compaction-before", 1),
      turn(60, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "v1", "compaction-before", 1),
      turn(120, MODELS.sonnet, 70_000, 65_000, 35_000, 2_000, "v2", "compaction-after", 2),
    ],
  },
  {
    id: "ttl_expired",
    description: "The final request arrives 340 seconds after the last hit.",
    defaultModel: MODELS.sonnet,
    turns: [
      turn(0, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "ttl-v1"),
      turn(60, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "ttl-v1"),
      turn(400, MODELS.sonnet, 100_000, 95_000, 50_000, 2_000, "ttl-v1"),
    ],
  },
  {
    id: "unsupported_candidate",
    description: "A cache-capable Sonnet session receives a non-cache local judge target.",
    defaultModel: MODELS.sonnet,
    turns: [
      turn(0, MODELS.sonnet, 120_000, 115_000, 60_000, 2_000, "unsupported-v1"),
      turn(60, MODELS.sonnet, 120_000, 115_000, 60_000, 2_000, "unsupported-v1"),
      turn(120, MODELS.edge, 120_000, 115_000, 60_000, 1_000, "unsupported-v1"),
    ],
  },
];

type SimulatedCosts = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  inputSide: number;
  total: number;
};

type LegacyEstimateSide = {
  model: string;
  buckets: CostBuckets;
  costsUsd: SimulatedCosts;
  uncertainty: "legacy-unmodeled";
};

export type CostComparisonRecord = {
  mechanism: "frozen-cfc4d177-legacy" | "production-four-bucket";
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  stay: LegacyEstimateSide | ReturnType<typeof comparisonSide>;
  switch: LegacyEstimateSide | ReturnType<typeof comparisonSide>;
  recommendation: "switch" | "keep" | "unknown";
  savingsUsd: number;
  requiredSavingsUsd: number;
  uncertainty: string;
};

export type TurnRecord = {
  evidenceKind: typeof EVIDENCE_KIND;
  scenario: string;
  arm: ExperimentArm;
  turn: number;
  timestamp: string;
  ttlMs: number;
  prefixLineage: string;
  judgeTarget: string;
  finalModel: string;
  previousModel: string | null;
  switchOccurred: boolean;
  decisionReason: string;
  costComparison: CostComparisonRecord | null;
  cachePlan: {
    present: boolean;
    provider: string | null;
    model: string | null;
    fingerprint: string | null;
    generation: number | null;
  };
  cachePlanMatchesFinal: boolean;
  wire: {
    systemMarker: boolean;
    messageMarkerCount: number;
    markerCount: number;
  };
  cacheRequestCorrect: boolean;
  canonicalUsage: Required<Pick<CanonicalUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens">>;
  rawUsage: Record<string, unknown>;
  cacheReadRatio: number;
  simulatedCostsUsd: SimulatedCosts;
  simulatedCostUsd: number;
  pricing: {
    source: "experiment-fixture";
    date: typeof EXPERIMENT_DATE;
    productionQuoteSource: string;
    ratesUsdPerMillionTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  latencyMs: null;
  qualityScore: null;
  realProviderHit: null;
  realBilledCostUsd: null;
};

export type SummaryRecord = {
  scenario: string;
  arm: ExperimentArm;
  requestCount: number;
  eligibleCacheRequestCount: number;
  cachePlanFinalModelMatchRate: number | null;
  cacheRequestCorrectRate: number;
  simulatedCacheReadRatio: number;
  simulatedInputSideCostUsd: number;
  simulatedOutputCostUsd: number;
  simulatedTotalCandidateExecutionCostUsd: number;
  coldRequestCount: number;
  hotRequestCount: number;
  switchCount: number;
  actualLatency: "not_measured_offline";
  actualQuality: "not_measured_offline";
};

export type OverallSummary = Omit<SummaryRecord, "scenario"> & {
  costDeltaVsOriginalUsd: number;
  costDeltaPercentVsOriginal: number;
  inputCostReductionVsOriginalPercent: number;
  targetStatus: "met" | "not_met_in_this_synthetic_suite";
};

export type OfflineExperimentResult = {
  metadata: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  turnRecords: TurnRecord[];
  scenarioSummaries: SummaryRecord[];
  overallSummaries: OverallSummary[];
  limitations: string[];
};

type CacheEntry = { cachedTokenCount: number; expiresAtMs: number };
type RoutingOutcome = {
  finalModel: ModelFixture;
  reason: string;
  comparison: CostComparisonRecord | null;
};

/** Runs the full experiment in memory. It performs no network or provider API calls. */
export function runOfflineExperiment(): OfflineExperimentResult {
  const turnRecords: TurnRecord[] = [];

  for (const scenario of SCENARIOS) {
    for (const arm of ARMS) {
      const providerCache = new Map<string, CacheEntry>();
      const evidenceByModel = new Map<string, CacheEvidence>();
      let previousModel: ModelFixture | undefined;
      let lastUsage: CanonicalUsage | undefined;

      for (const [turnIndex, fixture] of scenario.turns.entries()) {
        const nowMs = BASE_TIME_MS + fixture.atSeconds * 1_000;
        const routing = routeTurn(
          arm,
          fixture,
          previousModel,
          lastUsage,
          evidenceByModel,
          nowMs,
        );
        const content = contentFor(fixture.contentVariant);
        const preparedPlan = buildCachePlan({
          provider: scenario.defaultModel.provider,
          model: scenario.defaultModel.model,
          systemPrompt: content.systemPrompt,
          tools: content.tools,
          messages: content.messages,
          enabled: scenario.defaultModel.protocol === "anthropic"
            && scenario.defaultModel.supportsPromptCache,
        }, fixture.generation);
        const preparedRequest: CanonicalModelRequest = {
          provider: scenario.defaultModel.provider,
          model: scenario.defaultModel.model,
          systemPrompt: content.systemPrompt,
          tools: content.tools,
          messages: content.messages,
          maxOutputTokens: Math.max(1, fixture.outputTokens),
          cachePlan: preparedPlan,
          cacheBreakpoints: preparedPlan?.messages,
        };
        const finalRequest = materializeFinalRequest(arm, preparedRequest, routing.finalModel);
        const wire = inspectFinalWire(finalRequest, routing.finalModel);
        const cachePlanMatchesFinal = finalRequest.cachePlan !== undefined
          && finalRequest.cachePlan.provider === routing.finalModel.provider
          && finalRequest.cachePlan.model === routing.finalModel.model;
        const eligible = routing.finalModel.protocol === "anthropic"
          && routing.finalModel.supportsPromptCache;
        const markersPresent = wire.markerCount > 0;
        const cacheRequestCorrect = eligible
          ? cachePlanMatchesFinal && markersPresent
          : finalRequest.cachePlan === undefined && wire.markerCount === 0;
        const usage = simulateProviderUsage({
          providerCache,
          cacheKey: `${arm}|${scenario.id}|${routing.finalModel.id}|${fixture.prefixLineage}`,
          fixture,
          nowMs,
          markersPresent,
          supported: eligible,
        });
        const pricingQuote = lookupModelPricingDetailed(
          routing.finalModel.provider,
          routing.finalModel.model,
          MODEL_PRICING,
        );
        const simulatedCostsUsd = costsFor(usage, pricingQuote);
        const inputDenominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        const record: TurnRecord = {
          evidenceKind: EVIDENCE_KIND,
          scenario: scenario.id,
          arm,
          turn: turnIndex + 1,
          timestamp: new Date(nowMs).toISOString(),
          ttlMs: DEFAULT_CACHE_TTL_MS,
          prefixLineage: fixture.prefixLineage,
          judgeTarget: fixture.judgeTarget.id,
          finalModel: routing.finalModel.id,
          previousModel: previousModel?.id ?? null,
          switchOccurred: previousModel !== undefined && previousModel.id !== routing.finalModel.id,
          decisionReason: routing.reason,
          costComparison: routing.comparison,
          cachePlan: {
            present: finalRequest.cachePlan !== undefined,
            provider: finalRequest.cachePlan?.provider ?? null,
            model: finalRequest.cachePlan?.model ?? null,
            fingerprint: finalRequest.cachePlan?.fingerprint ?? null,
            generation: finalRequest.cachePlan?.generation ?? null,
          },
          cachePlanMatchesFinal,
          wire,
          cacheRequestCorrect,
          canonicalUsage: {
            ...usage,
            totalTokens: inputDenominator + usage.outputTokens,
          },
          rawUsage: rawUsageFor(routing.finalModel, usage),
          cacheReadRatio: ratio(usage.cacheReadTokens, inputDenominator),
          simulatedCostsUsd,
          simulatedCostUsd: simulatedCostsUsd.total,
          pricing: {
            source: "experiment-fixture",
            date: EXPERIMENT_DATE,
            productionQuoteSource: pricingQuote.source,
            ratesUsdPerMillionTokens: {
              input: pricingQuote.input,
              output: pricingQuote.output,
              cacheRead: pricingQuote.cacheRead,
              cacheWrite: pricingQuote.cacheWrite,
            },
          },
          latencyMs: null,
          qualityScore: null,
          realProviderHit: null,
          realBilledCostUsd: null,
        };
        turnRecords.push(record);

        const evidence: CacheEvidence = {
          provider: routing.finalModel.provider,
          model: routing.finalModel.model,
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          observedAt: nowMs,
        };
        evidenceByModel.set(routing.finalModel.id, evidence);
        lastUsage = record.canonicalUsage;
        previousModel = routing.finalModel;
      }
    }
  }

  const scenarioSummaries = SCENARIOS.flatMap((scenario) =>
    ARMS.map((arm) => summarize(scenario.id, arm, turnRecords.filter(
      (record) => record.scenario === scenario.id && record.arm === arm,
    ))));
  const aggregateByArm = ARMS.map((arm) => summarize(
    "overall",
    arm,
    turnRecords.filter((record) => record.arm === arm),
  ));
  const original = aggregateByArm.find((summary) => summary.arm === "original")!;
  const overallSummaries: OverallSummary[] = aggregateByArm.map(({ scenario: _scenario, ...summary }) => {
    const costDelta = summary.simulatedTotalCandidateExecutionCostUsd
      - original.simulatedTotalCandidateExecutionCostUsd;
    const inputReduction = percentReduction(
      original.simulatedInputSideCostUsd,
      summary.simulatedInputSideCostUsd,
    );
    return {
      ...summary,
      costDeltaVsOriginalUsd: round(costDelta),
      costDeltaPercentVsOriginal: round(ratio(
        costDelta,
        original.simulatedTotalCandidateExecutionCostUsd,
      ) * 100),
      inputCostReductionVsOriginalPercent: round(inputReduction),
      targetStatus: inputReduction >= 20
        ? "met"
        : "not_met_in_this_synthetic_suite",
    };
  });

  return {
    metadata: {
      experimentId: "pilotroute-cache-aware-routing-offline",
      experimentDate: EXPERIMENT_DATE,
      evidenceKind: EVIDENCE_KIND,
      executionMode: "deterministic-offline-no-network",
      disclaimer:
        "No real provider API was called. Usage, cache hits, costs, and savings are deterministic simulation; latency and quality are not measured. Wire correctness is real local code execution.",
      networkRequests: 0,
      paidApiCalls: 0,
      minSavingsRatio: MIN_SAVINGS_RATIO,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      judgeCostTreatment: "excluded-unmeasured-shared-across-arms-and-common-to-candidate-ranking",
      exploratoryTarget: "20% multi-turn input-cost reduction in this synthetic suite only",
    },
    fixtures: {
      pricing: {
        source: "experiment-fixture",
        date: EXPERIMENT_DATE,
        unit: "USD per million tokens",
        resolution: "Exact custom entries resolved through production lookupModelPricingDetailed.",
        models: Object.fromEntries(Object.values(MODELS).map((fixture) => {
          const quote = lookupModelPricingDetailed(fixture.provider, fixture.model, MODEL_PRICING);
          return [fixture.id, {
            protocol: fixture.protocol,
            supportsPromptCache: fixture.supportsPromptCache,
            input: quote.input,
            output: quote.output,
            cacheRead: quote.cacheRead,
            cacheWrite: quote.cacheWrite,
            productionQuoteSource: quote.source,
          }];
        })),
      },
      mechanisms: {
        original:
          "Frozen cfc4d177 pre-routing default-model plan/drop-on-mismatch behavior and messages-only two-bucket legacy cost formula.",
        plan_fix_only:
          "Production rebuildRoutedCachePlan for the final model plus the frozen cfc4d177 legacy cost formula.",
        plan_and_full_cost:
          "Production rebuildRoutedCachePlan plus production compareStayVsSwitch at the current integration evidence boundary.",
      },
      scenarios: SCENARIOS.map((scenario) => ({
        id: scenario.id,
        description: scenario.description,
        defaultModel: scenario.defaultModel.id,
        turns: scenario.turns.map((fixture) => ({
          atSeconds: fixture.atSeconds,
          judgeTarget: fixture.judgeTarget.id,
          totalInputTokens: fixture.totalInputTokens,
          cacheablePrefixTokens: fixture.cacheablePrefixTokens,
          messagesOnlyTokens: fixture.messagesOnlyTokens,
          outputTokens: fixture.outputTokens,
          prefixLineage: fixture.prefixLineage,
          contentVariant: fixture.contentVariant,
          generation: fixture.generation,
        })),
      })),
    },
    turnRecords,
    scenarioSummaries,
    overallSummaries,
    limitations: [
      "All usage buckets and provider-shaped rawUsage are deterministic simulation, not provider observations.",
      "simulatedCostUsd applies fixture prices to simulated buckets; it is not billed or provider-reported cost.",
      "Cache TTL, prefix lineage, token counts, outputs, and judge targets are controlled fixtures, not production traffic.",
      "Request-level Anthropic cache marker inspection executes the real local buildAnthropicRequest code, but no request is sent.",
      "The original arm reimplements and freezes cfc4d177 semantics inside this harness; it does not execute a separate cfc4d177 checkout or binary.",
      "Latency, quality, real cache hits, and real billed cost are deliberately unmeasured and null.",
      "Judge cost is excluded and unmeasured; it is shared across arms and common to candidate ranking in this harness.",
      "The 20% input-cost target is exploratory and can only be met or missed in this synthetic suite; it is not a production savings claim.",
    ],
  };
}

function routeTurn(
  arm: ExperimentArm,
  fixture: TurnFixture,
  previousModel: ModelFixture | undefined,
  lastUsage: CanonicalUsage | undefined,
  evidenceByModel: Map<string, CacheEvidence>,
  nowMs: number,
): RoutingOutcome {
  if (!previousModel) {
    return { finalModel: fixture.judgeTarget, reason: "no_previous_model_judge_target_stands", comparison: null };
  }
  if (previousModel.id === fixture.judgeTarget.id) {
    return { finalModel: fixture.judgeTarget, reason: "judge_target_matches_current_model", comparison: null };
  }

  if (arm !== "plan_and_full_cost") {
    return legacyRoute(fixture, previousModel, lastUsage);
  }

  const stayEvidence = evidenceByModel.get(previousModel.id);
  const hasPositiveCacheEvidence = (stayEvidence?.cacheReadTokens ?? 0) > 0
    || (stayEvidence?.cacheWriteTokens ?? 0) > 0;
  if (!stayEvidence || !hasPositiveCacheEvidence) {
    return {
      finalModel: fixture.judgeTarget,
      reason: "full_cost_no_positive_current_cache_evidence_judge_stands",
      comparison: null,
    };
  }

  const switchEvidence = evidenceByModel.get(fixture.judgeTarget.id);
  const compared = compareStayVsSwitch({
    stay: {
      provider: previousModel.provider,
      model: previousModel.model,
      supportsPromptCache: previousModel.supportsPromptCache,
      estimatedInputTokens: fixture.totalInputTokens,
      estimatedOutputTokens: stayEvidence.outputTokens ?? 0,
      cacheEvidence: stayEvidence,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      now: nowMs,
      modelPricing: MODEL_PRICING,
    },
    switch: {
      provider: fixture.judgeTarget.provider,
      model: fixture.judgeTarget.model,
      supportsPromptCache: fixture.judgeTarget.supportsPromptCache,
      estimatedInputTokens: fixture.totalInputTokens,
      estimatedOutputTokens: stayEvidence.outputTokens ?? 0,
      ...(switchEvidence ? { cacheEvidence: switchEvidence } : {}),
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      now: nowMs,
      modelPricing: MODEL_PRICING,
    },
    minSavingsRatio: MIN_SAVINGS_RATIO,
  });
  const comparison: CostComparisonRecord = {
    mechanism: "production-four-bucket",
    estimatedInputTokens: fixture.totalInputTokens,
    estimatedOutputTokens: stayEvidence.outputTokens ?? 0,
    stay: comparisonSide(compared.stay),
    switch: comparisonSide(compared.switch),
    recommendation: compared.recommendation,
    savingsUsd: round(compared.savings),
    requiredSavingsUsd: round(compared.requiredSavings),
    uncertainty: maxUncertainty(compared.stay.uncertainty, compared.switch.uncertainty),
  };
  if (compared.recommendation === "unknown") {
    return {
      finalModel: fixture.judgeTarget,
      reason: "full_cost_unknown_judge_target_stands",
      comparison,
    };
  }
  return compared.recommendation === "switch"
    ? { finalModel: fixture.judgeTarget, reason: "full_cost_recommends_switch", comparison }
    : { finalModel: previousModel, reason: "full_cost_keeps_sticky", comparison };
}

function legacyRoute(
  fixture: TurnFixture,
  previousModel: ModelFixture,
  lastUsage: CanonicalUsage | undefined,
): RoutingOutcome {
  const observedInput = lastUsage?.inputTokens ?? 0;
  const observedRead = lastUsage?.cacheReadTokens ?? 0;
  const observedReadRatio = observedInput > 0
    ? Math.min(1, Math.max(0, observedRead / observedInput))
    : 0;
  if (observedReadRatio <= 0) {
    return {
      finalModel: fixture.judgeTarget,
      reason: "legacy_no_positive_cache_read_ratio_judge_stands",
      comparison: null,
    };
  }

  const estimatedRead = Math.floor(fixture.messagesOnlyTokens * observedReadRatio);
  const stayBuckets: CostBuckets = {
    inputTokens: fixture.messagesOnlyTokens - estimatedRead,
    cacheReadTokens: estimatedRead,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
  const switchBuckets: CostBuckets = {
    inputTokens: fixture.messagesOnlyTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
  const stayQuote = lookupModelPricingDetailed(previousModel.provider, previousModel.model, MODEL_PRICING);
  const switchQuote = lookupModelPricingDetailed(
    fixture.judgeTarget.provider,
    fixture.judgeTarget.model,
    MODEL_PRICING,
  );
  const stayCosts = costsFor(stayBuckets, stayQuote);
  const switchCosts = costsFor(switchBuckets, switchQuote);
  const savings = stayCosts.total - switchCosts.total;
  const requiredSavings = stayCosts.total * MIN_SAVINGS_RATIO;
  const recommendation = switchCosts.total + Number.EPSILON < stayCosts.total - requiredSavings
    ? "switch"
    : "keep";
  const comparison: CostComparisonRecord = {
    mechanism: "frozen-cfc4d177-legacy",
    estimatedInputTokens: fixture.messagesOnlyTokens,
    estimatedOutputTokens: 0,
    stay: {
      model: previousModel.id,
      buckets: stayBuckets,
      costsUsd: stayCosts,
      uncertainty: "legacy-unmodeled",
    },
    switch: {
      model: fixture.judgeTarget.id,
      buckets: switchBuckets,
      costsUsd: switchCosts,
      uncertainty: "legacy-unmodeled",
    },
    recommendation,
    savingsUsd: round(savings),
    requiredSavingsUsd: round(requiredSavings),
    uncertainty: "legacy-omits-cache-write-output-ttl-and-model-keying",
  };
  return recommendation === "switch"
    ? { finalModel: fixture.judgeTarget, reason: "legacy_cost_recommends_switch", comparison }
    : { finalModel: previousModel, reason: "legacy_cost_keeps_sticky", comparison };
}

function comparisonSide(estimate: ReturnType<typeof compareStayVsSwitch>["stay"]) {
  return {
    model: `${estimate.provider}/${estimate.model}`,
    buckets: estimate.buckets,
    costsUsd: {
      input: round(estimate.costs.input),
      cacheRead: round(estimate.costs.cacheRead),
      cacheWrite: round(estimate.costs.cacheWrite),
      output: round(estimate.costs.output),
      inputSide: round(estimate.costs.input + estimate.costs.cacheRead + estimate.costs.cacheWrite),
      total: round(estimate.costs.total),
    },
    uncertainty: estimate.uncertainty,
    notes: estimate.notes,
    pricingSource: "experiment-fixture" as const,
  };
}

function materializeFinalRequest(
  arm: ExperimentArm,
  preparedRequest: CanonicalModelRequest,
  finalModel: ModelFixture,
): CanonicalModelRequest {
  let cachePlan: CachePlan | undefined;
  let cacheBreakpoints: number[] | undefined;
  if (arm === "original") {
    cachePlan = preparedRequest.cachePlan
      && preparedRequest.cachePlan.provider === finalModel.provider
      && preparedRequest.cachePlan.model === finalModel.model
      ? preparedRequest.cachePlan
      : undefined;
    cacheBreakpoints = preparedRequest.cachePlan !== undefined
      ? cachePlan?.messages
      : preparedRequest.cacheBreakpoints;
  } else {
    const rebuilt = rebuildRoutedCachePlan({
      provider: finalModel.provider,
      model: finalModel.model,
      protocol: finalModel.protocol,
      supportsPromptCache: finalModel.supportsPromptCache,
      systemPrompt: preparedRequest.systemPrompt,
      tools: preparedRequest.tools ?? [],
      messages: preparedRequest.messages,
    }, preparedRequest.cachePlan);
    cachePlan = rebuilt.cachePlan;
    cacheBreakpoints = rebuilt.cacheBreakpoints;
  }
  return {
    ...preparedRequest,
    provider: finalModel.provider,
    model: finalModel.model,
    cachePlan,
    cacheBreakpoints,
  };
}

function inspectFinalWire(
  request: CanonicalModelRequest,
  finalModel: ModelFixture,
): TurnRecord["wire"] {
  if (finalModel.protocol !== "anthropic") {
    return { systemMarker: false, messageMarkerCount: 0, markerCount: 0 };
  }
  const body = buildAnthropicRequest(request, modelDefinition(finalModel));
  const systemMarker = Array.isArray(body.system) && body.system.some(hasCacheControl);
  const messageMarkerCount = body.messages.filter((message) => message.content.some(hasCacheControl)).length;
  const toolMarkerCount = (body.tools ?? []).filter(hasCacheControl).length;
  return {
    systemMarker,
    messageMarkerCount,
    markerCount: Number(systemMarker) + messageMarkerCount + toolMarkerCount,
  };
}

function hasCacheControl(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && (value as { cache_control?: { type?: string } }).cache_control?.type === "ephemeral";
}

function simulateProviderUsage(input: {
  providerCache: Map<string, CacheEntry>;
  cacheKey: string;
  fixture: TurnFixture;
  nowMs: number;
  markersPresent: boolean;
  supported: boolean;
}): Required<Pick<CanonicalUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">> {
  let inputTokens = input.fixture.totalInputTokens;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  if (input.markersPresent && input.supported) {
    const entry = input.providerCache.get(input.cacheKey);
    if (entry && input.nowMs <= entry.expiresAtMs) {
      cacheReadTokens = Math.min(entry.cachedTokenCount, input.fixture.cacheablePrefixTokens);
      cacheWriteTokens = Math.max(0, input.fixture.cacheablePrefixTokens - cacheReadTokens);
    } else {
      cacheWriteTokens = input.fixture.cacheablePrefixTokens;
    }
    inputTokens = input.fixture.totalInputTokens - cacheReadTokens - cacheWriteTokens;
    input.providerCache.set(input.cacheKey, {
      cachedTokenCount: input.fixture.cacheablePrefixTokens,
      expiresAtMs: input.nowMs + DEFAULT_CACHE_TTL_MS,
    });
  }
  return {
    inputTokens,
    outputTokens: input.fixture.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function rawUsageFor(
  finalModel: ModelFixture,
  usage: Required<Pick<CanonicalUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">>,
): Record<string, unknown> {
  if (finalModel.protocol === "anthropic") {
    return {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    };
  }
  return {
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    completion_tokens: usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  };
}

function costsFor(
  buckets: Pick<CostBuckets, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">,
  quote: ReturnType<typeof lookupModelPricingDetailed>,
): SimulatedCosts {
  const input = buckets.inputTokens / 1_000_000 * quote.input;
  const cacheRead = buckets.cacheReadTokens / 1_000_000 * quote.cacheRead;
  const cacheWrite = buckets.cacheWriteTokens / 1_000_000 * quote.cacheWrite;
  const output = buckets.outputTokens / 1_000_000 * quote.output;
  return {
    input: round(input),
    cacheRead: round(cacheRead),
    cacheWrite: round(cacheWrite),
    output: round(output),
    inputSide: round(input + cacheRead + cacheWrite),
    total: round(input + cacheRead + cacheWrite + output),
  };
}

function summarize(scenario: string, arm: ExperimentArm, records: TurnRecord[]): SummaryRecord {
  const eligible = records.filter((record) => {
    const modelFixture = modelById(record.finalModel);
    return modelFixture.protocol === "anthropic" && modelFixture.supportsPromptCache;
  });
  const inputTokens = sum(records, (record) => record.canonicalUsage.inputTokens);
  const readTokens = sum(records, (record) => record.canonicalUsage.cacheReadTokens);
  const writeTokens = sum(records, (record) => record.canonicalUsage.cacheWriteTokens);
  return {
    scenario,
    arm,
    requestCount: records.length,
    eligibleCacheRequestCount: eligible.length,
    cachePlanFinalModelMatchRate: eligible.length > 0
      ? round(eligible.filter((record) => record.cachePlanMatchesFinal).length / eligible.length)
      : null,
    cacheRequestCorrectRate: ratio(records.filter((record) => record.cacheRequestCorrect).length, records.length),
    simulatedCacheReadRatio: ratio(readTokens, inputTokens + readTokens + writeTokens),
    simulatedInputSideCostUsd: round(sum(records, (record) => record.simulatedCostsUsd.inputSide)),
    simulatedOutputCostUsd: round(sum(records, (record) => record.simulatedCostsUsd.output)),
    simulatedTotalCandidateExecutionCostUsd: round(sum(records, (record) => record.simulatedCostUsd)),
    coldRequestCount: records.filter((record) =>
      record.canonicalUsage.cacheReadTokens === 0 && record.canonicalUsage.cacheWriteTokens > 0
    ).length,
    hotRequestCount: records.filter((record) => record.canonicalUsage.cacheReadTokens > 0).length,
    switchCount: records.filter((record) => record.switchOccurred).length,
    actualLatency: "not_measured_offline",
    actualQuality: "not_measured_offline",
  };
}

function contentFor(variant: string): {
  systemPrompt: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
} {
  return {
    systemPrompt: `Offline deterministic system fixture: ${variant}`,
    tools: [{
      name: `read_${variant.replaceAll("-", "_")}`,
      description: `Deterministic tool fixture for ${variant}.`,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
    messages: [
      message("user", `Analyze fixture ${variant}.`),
      message("assistant", `Reading fixture ${variant}.`),
      message("user", `Inspect routing for ${variant}.`),
      message("assistant", `Routing notes for ${variant}.`),
      message("user", `Summarize cache behavior for ${variant}.`),
    ],
  };
}

function message(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function modelDefinition(fixture: ModelFixture): ModelDefinition {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: fixture.supportsPromptCache,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 200_000,
  };
  return { id: fixture.model, capabilities, multimodal: { input: ["text"] } };
}

function modelById(id: string): ModelFixture {
  const found = Object.values(MODELS).find((fixture) => fixture.id === id);
  if (!found) throw new Error(`Unknown experiment model: ${id}`);
  return found;
}

function maxUncertainty(...values: Array<"low" | "medium" | "high" | "unknown">): string {
  const order = ["low", "medium", "high", "unknown"] as const;
  return order[Math.max(...values.map((value) => order.indexOf(value)))]!;
}

function sum<T>(values: T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function percentReduction(baseline: number, candidate: number): number {
  return baseline > 0 ? (baseline - candidate) / baseline * 100 : 0;
}

function round(value: number): number {
  return Number(value.toFixed(9));
}

export function serializeOfflineExperiment(result: OfflineExperimentResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderSummaryCsv(result: OfflineExperimentResult): string {
  const columns: Array<keyof SummaryRecord> = [
    "scenario",
    "arm",
    "requestCount",
    "eligibleCacheRequestCount",
    "cachePlanFinalModelMatchRate",
    "cacheRequestCorrectRate",
    "simulatedCacheReadRatio",
    "simulatedInputSideCostUsd",
    "simulatedOutputCostUsd",
    "simulatedTotalCandidateExecutionCostUsd",
    "coldRequestCount",
    "hotRequestCount",
    "switchCount",
    "actualLatency",
    "actualQuality",
  ];
  const lines = [columns.join(",")];
  for (const summary of result.scenarioSummaries) {
    lines.push(columns.map((column) => csvCell(summary[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: SummaryRecord[keyof SummaryRecord]): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderReport(result: OfflineExperimentResult): string {
  const lines = [
    "# PilotRoute 缓存感知路由离线实验",
    "",
    "> **重要声明：本实验未调用任何真实 API。provider usage、缓存命中、成本与节省均为确定性模拟；仅请求级 wire 正确性来自真实本地代码执行。本文不对真实命中率、账单、延迟或质量作任何声明。**",
    "",
    "## 设置与控制",
    "",
    `- 固定日期：${EXPERIMENT_DATE}；固定缓存 TTL：${DEFAULT_CACHE_TTL_MS / 1_000} 秒；无网络、无付费 API、无墙钟时间。`,
    "- 每个场景、每个实验臂使用独立缓存和路由证据状态；缓存键包含实验臂、场景、provider/model 和显式 prefix lineage。",
    "- `original` 在 harness 内复刻并冻结提交 `cfc4d177` 的默认模型预建计划、模型不匹配即丢弃计划，以及仅 messages token 的旧成本公式；并未执行独立的 `cfc4d177` checkout 或 binary。",
    "- `plan_fix_only` 使用生产 `rebuildRoutedCachePlan`，但保留旧成本公式。",
    "- `plan_and_full_cost` 使用生产 `rebuildRoutedCachePlan` 与 `compareStayVsSwitch`，采用完整输入、上次输出、5% 阈值和候选模型键控证据。",
    "- Anthropic wire marker 由真实 `buildAnthropicRequest` 本地执行后检查；usage 与 provider cache 行为仍是模拟。",
    "- 价格来源标记为 `experiment-fixture`（2026-09-11，USD/百万 token），通过生产 pricing quote API 解析精确自定义条目。",
    "- Judge 成本未测量且排除；三个实验臂共享该成本，并且它对候选执行成本排名是共同项。",
    "",
    "## 总体结果",
    "",
    "- 计划匹配率仅以最终模型支持 prompt cache 的请求为分母；请求正确率以全部请求为分母。",
    "",
    "| 实验臂 | 请求 | 缓存资格请求 | 计划匹配率 | 请求正确率 | 模拟缓存读取率 | 模拟输入侧成本 USD | 模拟输出成本 USD | 模拟总成本 USD | 相对 original 总成本变化 | 输入成本降幅 | 20% 探索目标 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...result.overallSummaries.map((summary) =>
      `| ${summary.arm} | ${summary.requestCount} | ${summary.eligibleCacheRequestCount} | ${formatRate(summary.cachePlanFinalModelMatchRate)} | ${formatRate(summary.cacheRequestCorrectRate)} | ${formatRate(summary.simulatedCacheReadRatio)} | ${formatCost(summary.simulatedInputSideCostUsd)} | ${formatCost(summary.simulatedOutputCostUsd)} | ${formatCost(summary.simulatedTotalCandidateExecutionCostUsd)} | ${formatSigned(summary.costDeltaPercentVsOriginal)} | ${summary.inputCostReductionVsOriginalPercent.toFixed(2)}% | ${summary.targetStatus} |`
    ),
    "",
    "## 场景结果",
    "",
    "| 场景 | 实验臂 | 计划匹配率 | 请求正确率 | 模拟读取率 | 模拟输入侧成本 USD | 模拟总成本 USD | 冷/热 | 切换 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...result.scenarioSummaries.map((summary) =>
      `| ${summary.scenario} | ${summary.arm} | ${formatRate(summary.cachePlanFinalModelMatchRate)} | ${formatRate(summary.cacheRequestCorrectRate)} | ${formatRate(summary.simulatedCacheReadRatio)} | ${formatCost(summary.simulatedInputSideCostUsd)} | ${formatCost(summary.simulatedTotalCandidateExecutionCostUsd)} | ${summary.coldRequestCount}/${summary.hotRequestCount} | ${summary.switchCount} |`
    ),
    "",
    "## 观察",
    "",
    ...reportObservations(result),
    "",
    "## 失败边界",
    "",
    "- `original` 在路由模型不同于配置默认模型时丢弃计划和 breakpoints；这只证明本地 materialization 行为，不是真实 provider miss。",
    "- prefix lineage 改变或自上次命中超过 300 秒时，模拟器产生 miss/write；真实 provider 的缓存身份与过期行为未验证。",
    "- 不支持缓存的 local 候选按普通输入计费，并且最终请求不得携带计划或 marker。",
    "- 输出 token、输入 token、缓存前缀与 judge target 都是合成夹具，不能外推到生产流量。",
    "- `original` 是 harness 内对 `cfc4d177` 语义的复刻，不是对该提交 checkout 或 binary 的直接执行。",
    "- `latencyMs`、`qualityScore`、`realProviderHit`、`realBilledCostUsd` 均为 `null`；实际延迟与质量为 `not_measured_offline`。",
    "- 20% 指标仅报告 `met` 或 `not_met_in_this_synthetic_suite`，绝不代表一般生产节省。",
    "",
  ];
  return lines.join("\n");
}

function reportObservations(result: OfflineExperimentResult): string[] {
  const strong = result.turnRecords.filter((record) =>
    record.scenario === "hot_strong_then_simple" && record.turn >= 3
  );
  const outputDecision = result.turnRecords.find((record) =>
    record.scenario === "lower_output_cost" && record.arm === "plan_and_full_cost" && record.turn === 3
  )!;
  const unsupportedDecision = result.turnRecords.find((record) =>
    record.scenario === "unsupported_candidate" && record.arm === "plan_and_full_cost" && record.turn === 3
  )!;
  const originalStrongMarkers = strong.filter((record) => record.arm === "original")
    .map((record) => record.wire.markerCount).join("/");
  const fixedStrongHot = strong.filter((record) =>
    record.arm !== "original" && record.canonicalUsage.cacheReadTokens > 0
  ).length;
  return [
    `- \`hot_strong_then_simple\` 的 original 两个 Haiku turn marker 数为 ${originalStrongMarkers}；两个修复臂在重复 Haiku turn 中共有 ${fixedStrongHot} 个模拟热读。`,
    `- \`lower_output_cost\` 全量成本臂第三 turn 的实际确定性结果为 \`${outputDecision.finalModel}\`（${outputDecision.decisionReason}）；旧公式实验臂保持 Sonnet。`,
    `- \`unsupported_candidate\` 全量成本臂第三 turn 的实际确定性结果为 \`${unsupportedDecision.finalModel}\`（${unsupportedDecision.decisionReason}），最终计划和 marker 均为空。`,
    "- `prefix_changed_compaction` 第三 turn 的真实本地计划 fingerprint 改变，模拟 usage 为 read=0/write>0；`ttl_expired` 最终 turn 同样为模拟 miss/write。",
  ];
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function formatCost(value: number): string {
  return value.toFixed(6);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** Writes deterministic JSON, CSV, and Markdown snapshots under docs/experiments. */
export async function writeOfflineExperimentOutputs(
  outputDirectory = resolve(OUTPUT_DIRECTORY),
): Promise<OfflineExperimentResult> {
  const result = runOfflineExperiment();
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, "raw-results.json"), serializeOfflineExperiment(result), "utf8"),
    writeFile(resolve(outputDirectory, "summary.csv"), renderSummaryCsv(result), "utf8"),
    writeFile(resolve(outputDirectory, "report.md"), renderReport(result), "utf8"),
  ]);
  return result;
}

function printOverallTable(result: OfflineExperimentResult): void {
  console.log("| arm | requests | cache read ratio | input-side USD | total USD | input reduction vs original | target |");
  console.log("|---|---:|---:|---:|---:|---:|---|");
  for (const summary of result.overallSummaries) {
    console.log(
      `| ${summary.arm} | ${summary.requestCount} | ${formatRate(summary.simulatedCacheReadRatio)} | ${formatCost(summary.simulatedInputSideCostUsd)} | ${formatCost(summary.simulatedTotalCandidateExecutionCostUsd)} | ${summary.inputCostReductionVsOriginalPercent.toFixed(2)}% | ${summary.targetStatus} |`,
    );
  }
  console.log("Deterministic simulation only: no real API, billing, cache hit, latency, or quality measurement.");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const result = await writeOfflineExperimentOutputs();
  printOverallTable(result);
}
