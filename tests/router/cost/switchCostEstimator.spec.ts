/**
 * PilotRoute Module 2 — cache-aware switch cost estimator.
 *
 * Pins the billing-contract rules of src/router/cost/switchCostEstimator.ts
 * (plus the pricing/usage-cache infrastructure it rests on):
 * mutually-exclusive buckets, the sunk-cost rule, write-evidence projection,
 * the correct ratio denominator, TTL staleness, cold/no-cache switch paths,
 * output-price sensitivity, the pricing fallback chain, decision thresholds,
 * keyed SessionUsageCache behavior, and the system+tools token estimate.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, CanonicalUsage } from "../../../src/model/index.js";
import {
  compareStayVsSwitch,
  DEFAULT_CACHE_TTL_MS,
  estimateCandidateCost,
  type CandidateEstimateInput,
} from "../../../src/router/cost/switchCostEstimator.js";
import {
  calculateCacheWriteCost,
  lookupModelPricing,
  lookupModelPricingDetailed,
  PRICING_SNAPSHOT_DATE,
  type RouterModelPricingMap,
} from "../../../src/router/utils/modelPricing.js";
import { SessionUsageCache } from "../../../src/router/session/sessionUsageCache.js";
import {
  countMessagesTokens,
  countTokens,
  estimateRequestInputTokens,
} from "../../../src/router/utils/countTokens.js";

const NOW = 1_800_000_000_000;

/** Complete user pricing so pricing fallbacks never pollute uncertainty. */
const FULL_PRICING: RouterModelPricingMap = {
  "prov/model-a": { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  "prov/model-nocache": { input: 1, output: 1 },
};

function candidate(overrides: Partial<CandidateEstimateInput> = {}): CandidateEstimateInput {
  return {
    provider: "prov",
    model: "model-a",
    supportsPromptCache: true,
    estimatedInputTokens: 100_000,
    estimatedOutputTokens: 1_000,
    modelPricing: FULL_PRICING,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Bucket exclusivity invariant.
// ---------------------------------------------------------------------------

test("input + cacheRead + cacheWrite always equals estimatedInputTokens", () => {
  const cases: Array<{ label: string; input: CandidateEstimateInput }> = [
    {
      label: "stay with warm evidence",
      input: candidate({
        role: "stay",
        cacheEvidence: {
          provider: "prov",
          model: "model-a",
          inputTokens: 2_000,
          cacheReadTokens: 98_000,
          observedAt: NOW,
        },
      }),
    },
    {
      label: "stay without evidence",
      input: candidate({ role: "stay" }),
    },
    {
      label: "switch cold with cache support",
      input: candidate({ role: "switch" }),
    },
    {
      label: "switch without cache support",
      input: candidate({ role: "switch", supportsPromptCache: false, model: "model-nocache" }),
    },
    {
      label: "switch with own hot evidence",
      input: candidate({
        role: "switch",
        cacheEvidence: {
          provider: "prov",
          model: "model-a",
          inputTokens: 2_000,
          cacheReadTokens: 98_000,
          observedAt: NOW,
        },
      }),
    },
    {
      label: "non-terminating ratio rounds into the invariant",
      input: candidate({
        role: "stay",
        estimatedInputTokens: 100_001,
        cacheEvidence: {
          provider: "prov",
          model: "model-a",
          inputTokens: 2,
          cacheReadTokens: 1,
          observedAt: NOW,
        },
      }),
    },
  ];

  for (const { label, input } of cases) {
    const estimate = estimateCandidateCost(input);
    const sum =
      estimate.buckets.inputTokens + estimate.buckets.cacheReadTokens + estimate.buckets.cacheWriteTokens;
    assert.equal(sum, input.estimatedInputTokens, `${label}: buckets must be mutually exclusive`);
    assert.ok(estimate.buckets.inputTokens >= 0, `${label}: no negative buckets`);
    assert.ok(estimate.buckets.cacheReadTokens >= 0, `${label}: no negative buckets`);
    assert.ok(estimate.buckets.cacheWriteTokens >= 0, `${label}: no negative buckets`);
  }
});

// ---------------------------------------------------------------------------
// 2. Sunk cost rule.
// ---------------------------------------------------------------------------

test("stay-side cacheWriteTokens is 0 even when evidence shows a huge cache write", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 1_000,
        cacheWriteTokens: 99_000,
        observedAt: NOW,
      },
    }),
  );
  assert.equal(estimate.buckets.cacheWriteTokens, 0);
  assert.equal(estimate.costs.cacheWrite, 0);

  // Even a stay with zero projected reads never charges a (re-)write.
  const coldStay = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: { provider: "prov", model: "model-a", inputTokens: 100_000, observedAt: NOW },
    }),
  );
  assert.equal(coldStay.buckets.cacheWriteTokens, 0);
  assert.equal(coldStay.buckets.inputTokens, 100_000);

  // Also holds through the comparison entry point.
  const result = compareStayVsSwitch({
    stay: candidate({
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 1_000,
        cacheWriteTokens: 99_000,
        observedAt: NOW,
      },
    }),
    switch: candidate({ model: "model-nocache", supportsPromptCache: false }),
  });
  assert.equal(result.stay.buckets.cacheWriteTokens, 0);
});

// ---------------------------------------------------------------------------
// 3. Write-evidence projection (audit Q7).
// ---------------------------------------------------------------------------

test("a just-written cache counts as read evidence: {input 1k, cacheWrite 99k} projects ratio 0.99", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 1_000,
        cacheWriteTokens: 99_000,
        observedAt: NOW,
      },
    }),
  );
  assert.equal(estimate.buckets.cacheReadTokens, 99_000);
  assert.equal(estimate.buckets.inputTokens, 1_000);
});

// ---------------------------------------------------------------------------
// 4. Correct ratio denominator (audit Q5).
// ---------------------------------------------------------------------------

test("ratio denominator is input + cacheRead + cacheWrite: {input 2k, cacheRead 98k} is 0.98, not clamped 1.0", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 2_000,
        cacheReadTokens: 98_000,
        observedAt: NOW,
      },
    }),
  );
  assert.equal(estimate.buckets.cacheReadTokens, 98_000);
  assert.equal(estimate.buckets.inputTokens, 2_000);
  assert.equal(estimate.uncertainty, "low");
});

// ---------------------------------------------------------------------------
// 5. TTL staleness.
// ---------------------------------------------------------------------------

test("evidence older than the TTL zeroes the ratio and raises uncertainty to high", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 2_000,
        cacheReadTokens: 98_000,
        observedAt: NOW - DEFAULT_CACHE_TTL_MS - 1,
      },
    }),
  );
  assert.equal(estimate.buckets.cacheReadTokens, 0);
  assert.equal(estimate.buckets.inputTokens, 100_000);
  assert.equal(estimate.uncertainty, "high");
  assert.ok(estimate.notes.includes("cache evidence older than TTL"));

  // Boundary: exactly at the TTL age the evidence is still fresh (> is strict).
  const boundary = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 2_000,
        cacheReadTokens: 98_000,
        observedAt: NOW - DEFAULT_CACHE_TTL_MS,
      },
    }),
  );
  assert.equal(boundary.buckets.cacheReadTokens, 98_000);
  assert.equal(boundary.uncertainty, "low");
});

// ---------------------------------------------------------------------------
// 6. Missing observedAt.
// ---------------------------------------------------------------------------

test("missing observedAt leaves uncertainty at medium with a staleness note", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "stay",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 2_000,
        cacheReadTokens: 98_000,
      },
    }),
  );
  assert.equal(estimate.uncertainty, "medium");
  assert.ok(estimate.notes.includes("usage staleness unknown"));
  // The ratio itself still applies.
  assert.equal(estimate.buckets.cacheReadTokens, 98_000);
});

// ---------------------------------------------------------------------------
// 7/8/9. Switch-side bucket rules.
// ---------------------------------------------------------------------------

test("switch cold with cache support: cacheWrite = T, input = 0", () => {
  const estimate = estimateCandidateCost(candidate({ role: "switch" }));
  assert.equal(estimate.buckets.cacheWriteTokens, 100_000);
  assert.equal(estimate.buckets.inputTokens, 0);
  assert.equal(estimate.buckets.cacheReadTokens, 0);
  assert.ok(estimate.notes.includes("cold prefill with cache write"));
  // Priced at the cacheWrite rate (1.25x input here).
  assert.ok(Math.abs(estimate.costs.cacheWrite - (100_000 / 1_000_000) * 1.25) < 1e-12);
});

test("switch without cache support: input = T, no cache buckets", () => {
  const estimate = estimateCandidateCost(
    candidate({ role: "switch", supportsPromptCache: false, model: "model-nocache" }),
  );
  assert.equal(estimate.buckets.inputTokens, 100_000);
  assert.equal(estimate.buckets.cacheReadTokens, 0);
  assert.equal(estimate.buckets.cacheWriteTokens, 0);
  assert.equal(estimate.costs.cacheRead, 0);
  assert.equal(estimate.costs.cacheWrite, 0);
  assert.ok(estimate.notes.includes("model does not support prompt caching"));
});

test("switch with own hot evidence uses the read bucket, not a cold write", () => {
  const estimate = estimateCandidateCost(
    candidate({
      role: "switch",
      cacheEvidence: {
        provider: "prov",
        model: "model-a",
        inputTokens: 2_000,
        cacheReadTokens: 98_000,
        observedAt: NOW,
      },
    }),
  );
  assert.equal(estimate.buckets.cacheReadTokens, 98_000);
  assert.equal(estimate.buckets.cacheWriteTokens, 0);
  assert.equal(estimate.buckets.inputTokens, 2_000);
  assert.ok(!estimate.notes.includes("cold prefill with cache write"));
});

// ---------------------------------------------------------------------------
// 10. Output price difference changes the winner.
// ---------------------------------------------------------------------------

test("output price difference flips the recommendation when input sides tie", () => {
  const base = { estimatedOutputTokens: 10_000, estimatedInputTokens: 100_000 };

  const cheapOutputSwitch: RouterModelPricingMap = {
    "prov/stay-m": { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
    "prov/switch-m": { input: 1, output: 0.5, cacheRead: 0.1, cacheWrite: 1.25 },
  };
  const a = compareStayVsSwitch({
    stay: { ...candidate(base), model: "stay-m", modelPricing: cheapOutputSwitch, supportsPromptCache: false },
    switch: { ...candidate(base), model: "switch-m", modelPricing: cheapOutputSwitch, supportsPromptCache: false },
  });
  // Input sides tie at 0.1; output sides are 0.1 vs 0.005.
  assert.equal(a.stay.costs.input, a.switch.costs.input);
  assert.ok(a.savings > 0);
  assert.equal(a.recommendation, "switch");

  const expensiveOutputSwitch: RouterModelPricingMap = {
    "prov/stay-m": { input: 1, output: 0.5, cacheRead: 0.1, cacheWrite: 1.25 },
    "prov/switch-m": { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 },
  };
  const b = compareStayVsSwitch({
    stay: { ...candidate(base), model: "stay-m", modelPricing: expensiveOutputSwitch, supportsPromptCache: false },
    switch: { ...candidate(base), model: "switch-m", modelPricing: expensiveOutputSwitch, supportsPromptCache: false },
  });
  assert.ok(b.savings < 0);
  assert.equal(b.recommendation, "keep");
});

// ---------------------------------------------------------------------------
// 11. Pricing fallback chain and cacheWrite pricing.
// ---------------------------------------------------------------------------

test("lookupModelPricingDetailed resolves user → builtin → fallback with provenance", () => {
  const user = lookupModelPricingDetailed("prov", "model-a", {
    "prov/model-a": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
  });
  assert.equal(user.source, "user");
  assert.deepEqual(
    { input: user.input, output: user.output, cacheRead: user.cacheRead, cacheWrite: user.cacheWrite },
    { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
  );
  assert.equal(user.snapshotDate, undefined);
  assert.deepEqual(user.notes, []);

  const builtin = lookupModelPricingDetailed("anthropic", "claude-sonnet-4");
  assert.equal(builtin.source, "builtin");
  assert.equal(builtin.input, 3);
  assert.equal(builtin.output, 15);
  assert.equal(builtin.cacheRead, 0.3);
  assert.equal(builtin.cacheWrite, 3.75);
  assert.equal(builtin.snapshotDate, PRICING_SNAPSHOT_DATE);
  assert.equal(PRICING_SNAPSHOT_DATE, "2026-09-11");
  assert.deepEqual(builtin.notes, []);

  const fallback = lookupModelPricingDetailed("acme", "widget-xl");
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.input, 0.5);
  assert.equal(fallback.output, 1.5);
  assert.ok(fallback.notes.includes("cacheRead missing: fallback to input rate"));
  assert.ok(fallback.notes.includes("cacheWrite missing: priced at input rate"));
});

test("missing cacheWrite/cacheRead sub-prices fall back to the input rate with a note", () => {
  const noWrite = lookupModelPricingDetailed("prov", "model-a", {
    "prov/model-a": { input: 2, output: 4, cacheRead: 0.2 },
  });
  assert.equal(noWrite.source, "user");
  assert.equal(noWrite.cacheWrite, 2);
  assert.ok(noWrite.notes.includes("cacheWrite missing: priced at input rate"));

  const noRead = lookupModelPricingDetailed("prov", "model-a", {
    "prov/model-a": { input: 2, output: 4 },
  });
  assert.equal(noRead.cacheRead, 2);
  assert.ok(noRead.notes.includes("cacheRead missing: fallback to input rate"));
});

test("builtin Anthropic cacheWrite pricing (1.25x input) flows through the cost helpers", () => {
  assert.equal(lookupModelPricing("anthropic", "claude-opus-4-1").cacheWrite, 18.75);
  assert.ok(Math.abs(calculateCacheWriteCost(1_000_000, "anthropic", "claude-sonnet-4") - 3.75) < 1e-12);
  assert.ok(Math.abs(calculateCacheWriteCost(1_000_000, "anthropic", "claude-opus-4-1") - 18.75) < 1e-12);
  // User entry without cacheWrite is priced at the input rate.
  assert.ok(
    Math.abs(
      calculateCacheWriteCost(1_000_000, "anthropic", "claude-opus-4-1", {
        "anthropic/claude-opus-4-1": { input: 2 },
      }) - 2,
    ) < 1e-12,
  );
});

// ---------------------------------------------------------------------------
// 12. compareStayVsSwitch thresholds.
// ---------------------------------------------------------------------------

test("minSavingsRatio 0: any positive savings switches, zero savings keeps", () => {
  const equal = compareStayVsSwitch({
    stay: { ...candidate({ estimatedOutputTokens: 0 }), model: "model-a", supportsPromptCache: false },
    switch: { ...candidate({ estimatedOutputTokens: 0 }), model: "model-nocache", supportsPromptCache: false },
  });
  assert.ok(Math.abs(equal.savings) < 1e-12);
  assert.equal(equal.recommendation, "keep");

  const cheaper = compareStayVsSwitch({
    stay: { ...candidate({ estimatedOutputTokens: 0 }), model: "model-a", supportsPromptCache: false },
    switch: {
      ...candidate({ estimatedOutputTokens: 0 }),
      model: "model-nocache",
      supportsPromptCache: false,
      modelPricing: { "prov/model-nocache": { input: 0.9, output: 1 } },
    },
  });
  assert.ok(cheaper.savings > 1e-12);
  assert.equal(cheaper.recommendation, "switch");
});

test("minSavingsRatio 0.2 boundary: savings equal to the threshold keeps, exceeding it switches", () => {
  const stay = { ...candidate({ estimatedOutputTokens: 0 }), model: "model-a", supportsPromptCache: false };
  // stay.total = 0.1; threshold = 0.02.
  const atThreshold = compareStayVsSwitch({
    stay,
    switch: {
      ...candidate({ estimatedOutputTokens: 0 }),
      model: "model-nocache",
      supportsPromptCache: false,
      modelPricing: { "prov/model-nocache": { input: 0.8, output: 1 } },
    },
    minSavingsRatio: 0.2,
  });
  assert.ok(Math.abs(atThreshold.requiredSavings - 0.02) < 1e-12);
  assert.ok(Math.abs(atThreshold.savings - 0.02) < 1e-9);
  assert.equal(atThreshold.recommendation, "keep");

  const aboveThreshold = compareStayVsSwitch({
    stay,
    switch: {
      ...candidate({ estimatedOutputTokens: 0 }),
      model: "model-nocache",
      supportsPromptCache: false,
      modelPricing: { "prov/model-nocache": { input: 0.799, output: 1 } },
    },
    minSavingsRatio: 0.2,
  });
  assert.equal(aboveThreshold.recommendation, "switch");
});

test("recommendation is unknown when either side has nothing estimable", () => {
  const result = compareStayVsSwitch({
    stay: { ...candidate({ estimatedInputTokens: 0 }), role: "stay" },
    switch: candidate({ model: "model-nocache", supportsPromptCache: false }),
  });
  assert.equal(result.stay.uncertainty, "unknown");
  assert.equal(result.recommendation, "unknown");
});

// ---------------------------------------------------------------------------
// 13. SessionUsageCache keyed behavior.
// ---------------------------------------------------------------------------

test("SessionUsageCache keys entries by (session, provider, model) separately from the session key", () => {
  const cache = new SessionUsageCache();
  const keyed: CanonicalUsage = { inputTokens: 2_000, cacheReadTokens: 98_000, outputTokens: 500 };
  cache.observe("s1", keyed, { provider: "anthropic", model: "claude", observedAt: 123 });

  assert.equal(cache.get("s1", "anthropic", "claude"), keyed);
  assert.equal(cache.get("s1"), undefined, "model-keyed observe must not populate the session slot");

  const legacy: CanonicalUsage = { inputTokens: 7 };
  cache.observe("s1", legacy);
  assert.equal(cache.get("s1"), legacy);
  assert.equal(cache.get("s1", "anthropic", "claude"), keyed, "session observe must not touch model slots");

  const entry = cache.getEntry("s1", "anthropic", "claude");
  assert.equal(entry?.usage, keyed);
  assert.equal(entry?.observedAt, 123);
  assert.equal(cache.getEntry("s1")?.usage, legacy);
  assert.equal(cache.getEntry("s1")?.observedAt, undefined);
});

test("SessionUsageCache ignores undefined and all-zero usage", () => {
  const cache = new SessionUsageCache();
  cache.observe("s1", undefined);
  cache.observe("s1", { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(cache.get("s1"), undefined);
});

test("SessionUsageCache keeps LRU capacity across composite keys", () => {
  const cache = new SessionUsageCache(2);
  cache.observe("a", { inputTokens: 1 }, { provider: "p", model: "m1" });
  cache.observe("a", { inputTokens: 2 }, { provider: "p", model: "m2" });
  cache.observe("a", { inputTokens: 3 }, { provider: "p", model: "m3" });
  assert.equal(cache.get("a", "p", "m1"), undefined, "oldest composite key evicted");
  assert.equal(cache.get("a", "p", "m2")?.inputTokens, 2);
  assert.equal(cache.get("a", "p", "m3")?.inputTokens, 3);

  // Re-observing an existing key refreshes its recency.
  cache.observe("a", { inputTokens: 22 }, { provider: "p", model: "m2" });
  cache.observe("a", { inputTokens: 4 }, { provider: "p", model: "m4" });
  assert.equal(cache.get("a", "p", "m3"), undefined, "m3 evicted after m2 refresh");
  assert.equal(cache.get("a", "p", "m2")?.inputTokens, 22);
  assert.equal(cache.get("a", "p", "m4")?.inputTokens, 4);
});

// ---------------------------------------------------------------------------
// 14. estimateRequestInputTokens counts system + tools + messages.
// ---------------------------------------------------------------------------

test("estimateRequestInputTokens counts messages + system prompt + tool schemas", () => {
  const request: CanonicalModelRequest = {
    provider: "prov",
    model: "model-a",
    messages: [{ role: "user", content: [{ type: "text", text: "Summarize the cache layout." }] }],
    systemPrompt:
      "You are PilotDeck, an interactive coding agent. Workspace: /workspace/project. Permissions: bypass.",
    tools: [
      {
        name: "read_file",
        description: "Reads a file from the workspace filesystem and returns its text content.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Absolute file path." } },
          required: ["path"],
        },
      },
    ],
  };

  const messagesOnly = countMessagesTokens(request.messages);
  const system = countTokens(request.systemPrompt!);
  const tool = request.tools![0]!;
  const toolTokens = countTokens(
    `${tool.name}${tool.description ?? ""}${JSON.stringify(tool.inputSchema)}`,
  );

  const total = estimateRequestInputTokens(request);
  assert.ok(total > messagesOnly, "system + tools must not be invisible to the estimate");
  assert.equal(total, messagesOnly + system + toolTokens);

  // Without system/tools the estimate degrades to the message count.
  assert.equal(
    estimateRequestInputTokens({ ...request, systemPrompt: undefined, tools: undefined }),
    messagesOnly,
  );
});
