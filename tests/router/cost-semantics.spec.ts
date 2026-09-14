/**
 * REPRODUCTION SUITE — Agent B (PilotRoute), audit findings Q4/Q5/Q6/Q7.
 *
 * Cost-accounting reproductions for `maybePreserveStickyForCache`
 * (RouterRuntime.ts) driven through the REAL `createRouterRuntime`
 * `decide()` path with a fake judge and `router.observeUsage()` seeding the
 * session usage cache — no internal state is poked directly.
 *
 * Expected state on the FIXED tree (Modules 2+3: the four-bucket
 * switchCostEstimator wired into maybePreserveStickyForCache):
 *   - [anchor] tests pass: they pin the provider usage-normalization
 *     semantics that the comparison is supposed to respect.
 *   - [repro] tests pass: the estimator's bucket math (write evidence
 *     counts, correct ratio denominator, per-model cache support) produces
 *     the audited post-fix decisions.
 *   - [fixed] tests pass: they pin the post-fix estimate semantics — the
 *     switch side pays a cold cache write on cache-capable targets, and the
 *     token estimate covers the full request (system + tools + messages).
 *
 * Audit findings reproduced here:
 *   Q4  stay/switch comparison counts only input + cache-read; cache-write
 *       (1.25x input price on Anthropic) and output price are never counted.
 *   Q5  observedCacheHitRatio divides cacheReadTokens by inputTokens, but the
 *       normalized usage buckets are MUTUALLY EXCLUSIVE — heavy hits clamp to
 *       1.0 (overestimating stay benefit) and write-heavy turns read as 0.
 *   Q6  Pricing semantics are applied to models regardless of whether they
 *       support caching at all.
 *   Q7  Cache existence is only an estimate projected from the LAST usage;
 *       a just-created cache is invisible to the comparison.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelResponse,
  CanonicalModelRequest,
  CanonicalMessage,
  ModelRuntime,
} from "../../src/model/index.js";
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from "../../src/model/response/normalizeUsage.js";
import { actualInputTokensFromUsage } from "../../src/context/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { countMessagesTokens, estimateRequestInputTokens } from "../../src/router/utils/countTokens.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are PilotDeck, an interactive coding agent.",
  "Workspace: /workspace/project. Permissions: bypass.",
].join("\n");

const MESSAGES: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "Please analyze this project's architecture in depth." }] },
  { role: "assistant", content: [{ type: "text", text: "I will inspect the module layout and core loops first." }] },
  { role: "user", content: [{ type: "text", text: "Include the router internals and the caching behavior." }] },
  { role: "assistant", content: [{ type: "text", text: "The router combines scenario routing, tier classification, and fallback chains." }] },
  { role: "user", content: [{ type: "text", text: "Now summarize what you found about cache costs." }] },
];

const CAPS = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
};

/** claude-nocache genuinely cannot use the prompt cache; other fixtures can. */
function capabilitiesFor(model: string) {
  return model === "claude-nocache" ? { ...CAPS, supportsPromptCache: false } : CAPS;
}

function createJudgeRuntime(tier: string): ModelRuntime {
  return {
    async *stream() {},
    async complete(): Promise<CanonicalModelResponse> {
      return {
        role: "assistant",
        content: [{ type: "text", text: `<tier>${tier}</tier>` }],
        finishReason: "stop",
      };
    },
    getCapabilities(_provider: string, model: string) {
      return capabilitiesFor(model);
    },
    getMultimodal() {
      return { input: ["text"] };
    },
    getProviderProtocol() {
      return "anthropic";
    },
    getProviderBaseUrl(provider: string) {
      return `https://${provider}.invalid`;
    },
  };
}

/**
 * Router whose tokenSaver judge always classifies as `simple`, plus per-model
 * pricing, so every decide() runs the full cache-aware comparison against a
 * controlled price table.
 */
function costReproConfig(options: {
  simpleModel: { provider: string; model: string };
  pricing: Record<string, { input: number; cacheRead?: number }>;
}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: { id: "anthropic/claude-main", provider: "anthropic", model: "claude-main" } },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stats: { enabled: false, modelPricing: options.pricing },
    tokenSaver: {
      enabled: true,
      judge: { id: "anthropic/judge-mini", provider: "anthropic", model: "judge-mini" },
      defaultTier: "medium",
      tiers: {
        simple: { model: { id: `${options.simpleModel.provider}/${options.simpleModel.model}`, ...options.simpleModel } },
        medium: { model: { id: "anthropic/claude-main", provider: "anthropic", model: "claude-main" } },
      },
      judgeTimeoutMs: 5_000,
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
    },
  };
}

function mainAgentRequest(): CanonicalModelRequest {
  return {
    provider: "anthropic",
    model: "claude-main",
    messages: MESSAGES,
    systemPrompt: SYSTEM_PROMPT,
    maxOutputTokens: 128,
    stream: true,
  };
}

// ---------------------------------------------------------------------------
// [anchor] Provider usage semantics the comparison must respect.
// ---------------------------------------------------------------------------

test("[anchor] Anthropic usage normalization keeps input/cacheRead/cacheWrite mutually exclusive", () => {
  const usage = normalizeAnthropicUsage({
    input_tokens: 2_000,
    output_tokens: 500,
    cache_read_input_tokens: 98_000,
    cache_creation_input_tokens: 0,
  });

  // inputTokens NEVER includes cached tokens on the Anthropic protocol.
  assert.equal(usage?.inputTokens, 2_000);
  assert.equal(usage?.cacheReadTokens, 98_000);
  assert.equal(usage?.cacheWriteTokens, 0);
  // The real total input is the SUM of the three mutually exclusive buckets.
  assert.equal(actualInputTokensFromUsage(usage), 100_000);
});

test("[anchor] OpenAI usage normalization subtracts cached tokens from prompt_tokens", () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 100_000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 90_000 },
  });

  // OpenAI's prompt_tokens INCLUDES cached tokens; the normalized shape must
  // still be mutually exclusive — semantics differ per provider, which is why
  // one provider's ratio formula cannot be generalized to the other.
  assert.equal(usage?.inputTokens, 10_000);
  assert.equal(usage?.cacheReadTokens, 90_000);
  assert.equal(actualInputTokensFromUsage(usage), 100_000);
});

// ---------------------------------------------------------------------------
// [repro] Audit Q7 — a just-created cache is invisible to the comparison.
// ---------------------------------------------------------------------------

test("[repro] just-created cache (write-heavy usage) must not be treated as zero cache evidence", async () => {
  const router = createRouterRuntime(
    costReproConfig({
      simpleModel: { provider: "anthropic", model: "claude-nocache" },
      pricing: {
        "anthropic/claude-main": { input: 15, cacheRead: 0.15 },
        "anthropic/claude-nocache": { input: 1.6 },
      },
    }),
    { modelRuntime: createJudgeRuntime("simple"), judgeRuntime: createJudgeRuntime("simple") },
  );

  // Previous turn on claude-main paid the 1.25x write for a 99k-token prefix:
  // 1k uncached input + 99k cache creation, no cache read yet.
  router.observeUsage("repro-write-heavy", {
    inputTokens: 1_000,
    cacheWriteTokens: 99_000,
    outputTokens: 100,
    totalTokens: 100_100,
  });

  const decision = await router.decide({
    request: mainAgentRequest(),
    sessionId: "repro-write-heavy",
    isMainAgent: true,
    metadata: { previousProvider: "anthropic", previousModel: "claude-main" },
  });

  // DESIRED: the just-written 99k prefix means the NEXT request on claude-main
  // would read ~99% from cache: stay ≈ 0.99×0.15 + 0.01×15 = 0.30 $/M
  // vs switch to claude-nocache at 1.60 $/M with no cache at all → keep sticky.
  //
  // CURRENT (bug): observedCacheHitRatio = cacheRead(0)/input(1000) = 0 →
  // early return { selection: next } — the comparison never runs, the 1.25x
  // write just paid is silently forfeited, and no cacheAwareSwitch mutation is
  // logged for observability.
  assert.equal(
    decision.mutations.cacheAwareSwitch?.action,
    "kept_sticky",
    "a just-created 99k cache must be counted as stay evidence",
  );
  assert.equal(decision.model, "claude-main");
  await router.shutdown();
});

// ---------------------------------------------------------------------------
// [repro] Audit Q5 — mutually-exclusive buckets break the hit ratio and flip
// the stay/switch decision.
// ---------------------------------------------------------------------------

test("[repro] clamped hit ratio must not keep the expensive model when switching is cheaper", async () => {
  const router = createRouterRuntime(
    costReproConfig({
      simpleModel: { provider: "anthropic", model: "claude-nocache" },
      pricing: {
        "anthropic/claude-main": { input: 15, cacheRead: 1.5 },
        "anthropic/claude-nocache": { input: 1.6 },
      },
    }),
    { modelRuntime: createJudgeRuntime("simple"), judgeRuntime: createJudgeRuntime("simple") },
  );

  // Heavy-hit turn on claude-main: 98k cache read + 2k uncached input.
  router.observeUsage("repro-ratio-clamp", {
    inputTokens: 2_000,
    cacheReadTokens: 98_000,
    outputTokens: 500,
    totalTokens: 100_500,
  });

  const decision = await router.decide({
    request: mainAgentRequest(),
    sessionId: "repro-ratio-clamp",
    isMainAgent: true,
    metadata: { previousProvider: "anthropic", previousModel: "claude-main" },
  });

  // DESIRED (correct denominator = input + cacheRead + cacheWrite = 100k):
  //   stay(claude-main)  = 0.98×1.5 + 0.02×15 = 1.77 $/M effective
  //   switch(nocache)    = 1.60 $/M (no cache, no write fee, ever)
  //   → 1.60 < 1.77 → switch.
  //
  // CURRENT (bug): ratio = min(1, 98000/2000) = 1.0 → stay is priced as if
  // 100% of input were cache reads (1.50 $/M) → 1.60 > 1.50 → keep sticky.
  // The bug KEEPS the expensive model exactly when switching is cheaper.
  assert.equal(
    decision.mutations.cacheAwareSwitch?.action,
    "switched",
    "correct hit-ratio math (0.98, not clamped 1.0) should switch to the cheaper model",
  );
  assert.equal(decision.model, "claude-nocache");
  await router.shutdown();
});

// ---------------------------------------------------------------------------
// [fixed] Post-fix estimate semantics, pinned.
// ---------------------------------------------------------------------------

test("[fixed] switch-side estimate bills the cold cache-write bucket for a cache-capable target", async () => {
  const router = createRouterRuntime(
    costReproConfig({
      simpleModel: { provider: "anthropic", model: "claude-cheap" },
      pricing: {
        "anthropic/claude-main": { input: 15, cacheRead: 1.5 },
        "anthropic/claude-cheap": { input: 0.05, cacheRead: 0.005 },
      },
    }),
    { modelRuntime: createJudgeRuntime("simple"), judgeRuntime: createJudgeRuntime("simple") },
  );

  router.observeUsage("fixed-missing-buckets", {
    inputTokens: 2_000,
    cacheReadTokens: 98_000,
    outputTokens: 500,
    totalTokens: 100_500,
  });

  const decision = await router.decide({
    request: mainAgentRequest(),
    sessionId: "fixed-missing-buckets",
    isMainAgent: true,
    metadata: { previousProvider: "anthropic", previousModel: "claude-main" },
  });

  const mutation = decision.mutations.cacheAwareSwitch;
  assert.equal(mutation?.action, "switched");
  const tokens = mutation?.estimatedInputTokens ?? 0;
  assert.ok(tokens > 0, "estimatedInputTokens should be a positive local estimate");

  // FIXED semantics: switching to a cache-capable model pays a COLD PREFILL —
  // the full input is billed once as a cache WRITE (the mutually-exclusive
  // input bucket is 0). The user pricing for claude-cheap lacks cacheWrite, so
  // the effective write rate falls back to the input rate (0.05 $/M) and
  // prefillCost is that write term alone.
  assert.equal(mutation!.switchBuckets?.inputTokens, 0);
  assert.equal(mutation!.switchBuckets?.cacheWriteTokens, tokens);
  assert.ok(
    Math.abs(mutation!.prefillCost - (tokens / 1_000_000) * 0.05) < 1e-12,
    "prefillCost = cold cache-write term at the effective (input-fallback) write rate",
  );

  // Stay side is input-scoped: uncached share at the input rate + cache-read
  // share at the cacheRead rate; the sunk-cost rule keeps its write term at 0.
  const stayBuckets = mutation!.stayBuckets!;
  assert.equal(stayBuckets.cacheWriteTokens, 0);
  assert.equal(stayBuckets.inputTokens + stayBuckets.cacheReadTokens, tokens);
  assert.ok(
    Math.abs(
      mutation!.cachedCost
        - (stayBuckets.inputTokens * 15 + stayBuckets.cacheReadTokens * 1.5) / 1_000_000,
    ) < 1e-12,
    "cachedCost = stay input + cacheRead terms",
  );

  // The new observability fields are populated alongside the legacy five.
  assert.ok(
    ["low", "medium", "high", "unknown"].includes(mutation!.uncertainty ?? ""),
    "uncertainty is one of the valid values",
  );
  assert.ok(Number.isFinite(mutation!.savings), "savings is a finite number");
  assert.ok((mutation!.savings ?? 0) > 0, "switching to claude-cheap saves money here");
  assert.ok(mutation!.stayTotalCost! > mutation!.switchTotalCost!);
  assert.equal(mutation!.pricingSource, "user/user");
  assert.equal(mutation!.usageEvidence?.provider, "anthropic");
  assert.equal(mutation!.usageEvidence?.model, "claude-main");
  assert.equal(mutation!.usageEvidence?.cacheReadTokens, 98_000);
  assert.equal(
    "observedAt" in (mutation!.usageEvidence ?? {}),
    false,
    "legacy observeUsage seeds no timestamp; undefined evidence fields are omitted",
  );
  await router.shutdown();
});

test("[fixed] token estimate counts the full request — the system prompt is no longer invisible", async () => {
  const router = createRouterRuntime(
    costReproConfig({
      simpleModel: { provider: "anthropic", model: "claude-cheap" },
      pricing: {
        "anthropic/claude-main": { input: 15, cacheRead: 1.5 },
        "anthropic/claude-cheap": { input: 0.05, cacheRead: 0.005 },
      },
    }),
    { modelRuntime: createJudgeRuntime("simple"), judgeRuntime: createJudgeRuntime("simple") },
  );

  router.observeUsage("fixed-token-estimate", {
    inputTokens: 2_000,
    cacheReadTokens: 98_000,
    outputTokens: 500,
    totalTokens: 100_500,
  });

  const decision = await router.decide({
    request: mainAgentRequest(),
    sessionId: "fixed-token-estimate",
    isMainAgent: true,
    metadata: { previousProvider: "anthropic", previousModel: "claude-main" },
  });

  const mutation = decision.mutations.cacheAwareSwitch;
  assert.equal(mutation?.action, "switched");

  // FIXED semantics: the estimate covers the whole upcoming request —
  // messages PLUS the system prompt (and tool schemas, when present), i.e.
  // the stable prefix the cache plan marks. It is strictly greater than the
  // message-only count the old comparison used, so neither side of the
  // comparison undercounts by the hidden prefix.
  assert.equal(mutation?.estimatedInputTokens, estimateRequestInputTokens(mainAgentRequest()));
  assert.ok(
    (mutation?.estimatedInputTokens ?? 0) > countMessagesTokens(MESSAGES),
    "the system prompt must not be invisible to the comparison",
  );
  await router.shutdown();
});
