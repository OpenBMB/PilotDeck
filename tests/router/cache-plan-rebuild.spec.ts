/**
 * REPRODUCTION SUITE — Agent B (PilotRoute), audit findings Q1/Q2/Q3.
 *
 * Every test captures the FINAL request the router hands to the provider
 * adapter (via a capturing ModelRuntime), lowers it with the REAL
 * `buildAnthropicRequest`, and inspects the actual wire payload for
 * `cache_control` markers. "CachePlan is non-empty" is never used as proof;
 * only what would actually be sent counts.
 *
 * Expected state on the FIXED tree:
 *   - tests marked [baseline] pass: they pin correct unchanged behavior.
 *   - tests marked [repro] pass: they pin the post-fix rebuild behavior.
 *   - tests marked [fixed-legacy] pass: they pin the fixed gating of legacy
 *     cacheBreakpoints-only markers (cleared for non-cache models, kept for
 *     cache-capable Anthropic models).
 *
 * Audit findings reproduced here:
 *   Q1  CachePlan is built for the config-default model BEFORE routing
 *       (AgentLoop.createModelRequest → DefaultContextRuntime.prepareForModel).
 *   Q2  RouterRuntime.applyDecisionToRequest DROPS the plan when the routed
 *       provider/model differs and never rebuilds it (RouterRuntime.ts:553-567
 *       and the disabled passthrough at :577-589).
 *   Q3  Consequence on the wire: the session that left the default model sends
 *       NO cache_control markers at all — no cache read, no cache write, every
 *       turn re-pays full input price. Inverse variant: legacy
 *       cacheBreakpoints-only markers survive ANY model switch unvalidated.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelError,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalToolSchema,
  ModelCapabilities,
  ModelDefinition,
  ModelRuntime,
  ModelRuntimeOptions,
} from "../../src/model/index.js";
import { buildCachePlan } from "../../src/context/cache/CachePlan.js";
import { buildAnthropicRequest } from "../../src/model/providers/anthropic/request.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are PilotDeck, an interactive coding agent.",
  "Workspace: /workspace/project. Permissions: bypass.",
  "Use tools to inspect and edit files; cite paths in answers.",
].join("\n");

const TOOLS: CanonicalToolSchema[] = [
  {
    name: "agent",
    description: "Delegate a self-contained subtask to a forked subagent.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a file from disk.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "edit_file",
    description: "Apply an edit to a file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

const MESSAGES: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "Please analyze this project's architecture." }] },
  { role: "assistant", content: [{ type: "text", text: "I'll start by reading the layout and key modules." }] },
  { role: "user", content: [{ type: "text", text: "Yes, and include the router internals." }] },
  { role: "assistant", content: [{ type: "text", text: "The router consists of scenarios, tokenSaver tiers, and fallback chains." }] },
  { role: "user", content: [{ type: "text", text: "Summarize the caching behavior you observed." }] },
];

const CAPS_CACHE: ModelCapabilities = {
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

const CAPS_NO_CACHE: ModelCapabilities = { ...CAPS_CACHE, supportsPromptCache: false };

const MODEL_DEFS: Record<string, ModelDefinition> = {
  "claude-main": { id: "claude-main", capabilities: CAPS_CACHE, multimodal: { input: ["text"] } },
  "claude-cheap": { id: "claude-cheap", capabilities: CAPS_CACHE, multimodal: { input: ["text"] } },
  "claude-nocache": { id: "claude-nocache", capabilities: CAPS_NO_CACHE, multimodal: { input: ["text"] } },
};

function capabilitiesFor(provider: string, model: string): ModelCapabilities {
  return MODEL_DEFS[model]?.capabilities ?? CAPS_CACHE;
}

type CapturingRuntimeOptions = {
  /** Simulate a provider failure for specific requests (fallback repro). */
  errorFor?: (request: CanonicalModelRequest) => CanonicalModelError | undefined;
};

function createCapturingRuntime(options: CapturingRuntimeOptions = {}): {
  runtime: ModelRuntime;
  requests: CanonicalModelRequest[];
} {
  const requests: CanonicalModelRequest[] = [];
  const runtime: ModelRuntime = {
    async *stream(request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {
      requests.push(request);
      const error = options.errorFor?.(request);
      if (error) {
        yield { type: "error", error };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    async complete(): Promise<CanonicalModelResponse> {
      throw new Error("not used");
    },
    getCapabilities(provider: string, model: string) {
      return capabilitiesFor(provider, model);
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
  return { runtime, requests };
}

/** Fake judge runtime: classifyAndRoute calls complete() and parses <tier>. */
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
    getCapabilities() {
      return CAPS_CACHE;
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

function baseConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: { id: "anthropic/claude-main", provider: "anthropic", model: "claude-main" } },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stats: { enabled: false },
    ...overrides,
  };
}

/**
 * Build the request exactly the way AgentLoop.createModelRequest does
 * (AgentLoop.ts:2073-2146): provider/model are the CONFIG DEFAULTS, and the
 * cache plan is built for those defaults gated by protocol + cache support
 * (DefaultContextRuntime.ts:242-258). `cacheEnabled` mimics that gate.
 */
function agentStyleRequest(options: {
  provider: string;
  model: string;
  cacheEnabled: boolean;
  generation?: number;
}): CanonicalModelRequest {
  const plan = buildCachePlan(
    {
      provider: options.provider,
      model: options.model,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: MESSAGES,
      enabled: options.cacheEnabled,
    },
    options.generation ?? 1,
  );
  return {
    provider: options.provider,
    model: options.model,
    messages: MESSAGES,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    maxOutputTokens: 128,
    stream: true,
    cacheBreakpoints: plan?.messages,
    cachePlan: plan,
  };
}

/** Lower a captured canonical request to the Anthropic wire format. */
function inspectWire(request: CanonicalModelRequest) {
  const model = MODEL_DEFS[request.model] ?? MODEL_DEFS["claude-main"]!;
  const body = buildAnthropicRequest({ ...request, model: request.model }, model);
  const systemMarked = Array.isArray(body.system);
  const markedMessages = body.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.content.some((block) => (
      typeof block === "object" && block !== null
      && (block as { cache_control?: { type?: string } }).cache_control?.type === "ephemeral"
    )))
    .map(({ index }) => index);
  const toolsMarked = (body.tools ?? []).some(
    (tool) => tool.cache_control?.type === "ephemeral",
  );
  return { body, systemMarked, markedMessages, toolsMarked };
}

async function drainExecute(
  router: ReturnType<typeof createRouterRuntime>,
  decision: RouterDecision,
  request: CanonicalModelRequest,
  sessionId: string,
): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of router.execute(decision, request, {
    sessionId,
    turnId: "turn-1",
    projectPath: "/workspace/project",
  })) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// [baseline] Correct current behavior — proves the harness is faithful.
// ---------------------------------------------------------------------------

test("[baseline] routing to the request's own model keeps system+recent3 markers on the wire", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(baseConfig(), { modelRuntime: runtime });
  const request = agentStyleRequest({ provider: "anthropic", model: "claude-main", cacheEnabled: true });

  const decision = await router.decide({
    request,
    sessionId: "baseline-same-model",
    isMainAgent: true,
  });
  assert.equal(decision.provider, "anthropic");
  assert.equal(decision.model, "claude-main");

  await drainExecute(router, decision, request, "baseline-same-model");
  assert.equal(requests.length, 1);
  const captured = requests[0]!;

  // Plan survives because the routed model equals the plan's model.
  assert.equal(captured.cachePlan?.model, "claude-main");
  assert.deepEqual(captured.cacheBreakpoints, [2, 3, 4]);

  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, true, "system block should carry cache_control");
  assert.deepEqual(wire.markedMessages, [2, 3, 4], "recent3 message breakpoints should carry cache_control");
  assert.equal(wire.toolsMarked, false);
  await router.shutdown();
});

// ---------------------------------------------------------------------------
// [repro] Audit Q2/Q3 — plan dropped on model switch, never rebuilt.
// These assert the DESIRED behavior and are RED on the unfixed tree.
// ---------------------------------------------------------------------------

test("[repro] explicit switch to another cache-capable Claude: final request must carry rebuilt markers", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(baseConfig(), { modelRuntime: runtime });
  const request = agentStyleRequest({ provider: "anthropic", model: "claude-main", cacheEnabled: true });

  const decision = await router.decide({
    request,
    sessionId: "repro-explicit-switch",
    isMainAgent: true,
    metadata: { explicitProvider: "anthropic", explicitModel: "claude-cheap" },
  });
  assert.equal(decision.model, "claude-cheap");

  await drainExecute(router, decision, request, "repro-explicit-switch");
  const captured = requests.at(-1)!;

  // DESIRED: the plan is rebuilt for the FINAL routed model, so the session
  // keeps reading/writing the prompt cache instead of silently going full-price.
  //
  // CURRENT (bug): RouterRuntime.applyDecisionToRequest drops the mismatched
  // plan (captured.cachePlan === undefined) and buildAnthropicRequest then
  // emits zero cache_control markers.
  assert.equal(
    captured.cachePlan?.provider,
    "anthropic",
    "cache plan should be rebuilt for the routed provider",
  );
  assert.equal(
    captured.cachePlan?.model,
    "claude-cheap",
    "cache plan should be rebuilt for the routed model",
  );
  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, true, "system block should carry cache_control after rebuild");
  assert.deepEqual(
    wire.markedMessages,
    [2, 3, 4],
    "recent3 breakpoints should carry cache_control after rebuild",
  );
  await router.shutdown();
});

test("[repro] tokenSaver judge tier switch: final request must carry rebuilt markers", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(
    baseConfig({
      tokenSaver: {
        enabled: true,
        judge: { id: "anthropic/judge-mini", provider: "anthropic", model: "judge-mini" },
        defaultTier: "medium",
        tiers: {
          simple: { model: { id: "anthropic/claude-cheap", provider: "anthropic", model: "claude-cheap" } },
          medium: { model: { id: "anthropic/claude-main", provider: "anthropic", model: "claude-main" } },
        },
        judgeTimeoutMs: 5_000,
      },
    }),
    { modelRuntime: runtime, judgeRuntime: createJudgeRuntime("simple") },
  );
  const request = agentStyleRequest({ provider: "anthropic", model: "claude-main", cacheEnabled: true });

  const decision = await router.decide({
    request,
    sessionId: "repro-tokensaver-switch",
    isMainAgent: true,
  });
  assert.equal(decision.resolvedFrom, "tokenSaver");
  assert.equal(decision.model, "claude-cheap", "judge classifies the turn as simple → cheap tier");

  await drainExecute(router, decision, request, "repro-tokensaver-switch");
  const captured = requests.at(-1)!;

  // DESIRED: rebuild for the tier-selected model. CURRENT (bug): plan dropped,
  // wire has no markers — the flagship "tier switch" scenario loses the cache.
  assert.equal(captured.cachePlan?.model, "claude-cheap");
  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, true);
  assert.deepEqual(wire.markedMessages, [2, 3, 4]);
  await router.shutdown();
});

test("[repro] fallback attempt: re-routed request must carry rebuilt markers", async () => {
  const { runtime, requests } = createCapturingRuntime({
    errorFor: (request) =>
      request.model === "claude-main"
        ? {
            provider: "anthropic",
            protocol: "anthropic",
            code: "overloaded_error",
            message: "simulated provider overload",
            retryable: true,
          }
        : undefined,
  });
  const router = createRouterRuntime(
    baseConfig({
      fallback: {
        default: [{ id: "anthropic/claude-cheap", provider: "anthropic", model: "claude-cheap" }],
      },
    }),
    { modelRuntime: runtime },
  );
  const request = agentStyleRequest({ provider: "anthropic", model: "claude-main", cacheEnabled: true });

  const decision = await router.decide({
    request,
    sessionId: "repro-fallback",
    isMainAgent: true,
  });
  await drainExecute(router, decision, request, "repro-fallback");

  assert.equal(requests.length, 2, "primary attempt fails → one fallback attempt");
  const fallbackRequest = requests[1]!;
  assert.equal(fallbackRequest.model, "claude-cheap");

  // DESIRED: the fallback attempt rebuilds the plan for the fallback model.
  // CURRENT (bug): applyDecisionToRequest(attemptDecision, request) drops the
  // plan for every fallback attempt (RouterRuntime.ts:693).
  assert.equal(fallbackRequest.cachePlan?.model, "claude-cheap");
  const wire = inspectWire(fallbackRequest);
  assert.equal(wire.systemMarked, true);
  assert.deepEqual(wire.markedMessages, [2, 3, 4]);
  await router.shutdown();
});

test("[repro] non-Anthropic default model routed to a cache-capable Claude: plan must be built for the routed model", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(
    baseConfig({
      scenarios: { default: { id: "openai/gpt-main", provider: "openai", model: "gpt-main" } },
    }),
    { modelRuntime: runtime },
  );
  // AgentLoop builds the request for the CONFIG DEFAULT (openai/gpt-main).
  // DefaultContextRuntime's gate (protocol !== "anthropic") yields NO plan —
  // this is exactly what prepareForModel produces for an openai default.
  const request = agentStyleRequest({ provider: "openai", model: "gpt-main", cacheEnabled: false });
  assert.equal(request.cachePlan, undefined, "fixture sanity: openai default builds no plan");

  const decision = await router.decide({
    request,
    sessionId: "repro-cross-provider",
    isMainAgent: true,
    metadata: { explicitProvider: "anthropic", explicitModel: "claude-cheap" },
  });
  assert.equal(decision.model, "claude-cheap");

  await drainExecute(router, decision, request, "repro-cross-provider");
  const captured = requests.at(-1)!;

  // DESIRED: once the final model is an Anthropic cache-capable model, the
  // router builds a plan for IT. CURRENT (bug): no code path ever creates a
  // plan after the prepare-time gate ran for the openai default — the routed
  // Claude request carries no markers for the whole session lifetime.
  assert.equal(captured.cachePlan?.model, "claude-cheap");
  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, true);
  assert.deepEqual(wire.markedMessages, [2, 3, 4]);
  await router.shutdown();
});

// ---------------------------------------------------------------------------
// [fixed-legacy] Legacy cacheBreakpoints-only markers are now gated by the
// same protocol + prompt-cache check as cache plans.
// ---------------------------------------------------------------------------

test("[fixed-legacy] legacy cacheBreakpoints-only markers are cleared when routed to a non-cache model", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(baseConfig(), { modelRuntime: runtime });
  // Legacy shape: callers that only set cacheBreakpoints (no cachePlan).
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "claude-main",
    messages: MESSAGES,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    maxOutputTokens: 128,
    stream: true,
    cacheBreakpoints: [2, 3, 4],
  };

  const decision = await router.decide({
    request,
    sessionId: "fixed-legacy-leak",
    isMainAgent: true,
    metadata: { explicitProvider: "anthropic", explicitModel: "claude-nocache" },
  });
  assert.equal(decision.model, "claude-nocache");

  await drainExecute(router, decision, request, "fixed-legacy-leak");
  const captured = requests.at(-1)!;

  // FIXED: legacy breakpoints now pass the same protocol + prompt-cache gate
  // as cache plans. claude-nocache declares supportsPromptCache: false, so
  // the breakpoints must be cleared and the wire must carry NO markers.
  assert.equal(captured.cacheBreakpoints, undefined);
  assert.equal(captured.cachePlan, undefined);
  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, false, "no cache_control marker may reach a non-cache model");
  assert.deepEqual(wire.markedMessages, []);
  assert.equal(wire.toolsMarked, false);
  await router.shutdown();
});

test("[fixed-legacy] legacy cacheBreakpoints-only markers survive a switch to a cache-capable Anthropic model", async () => {
  const { runtime, requests } = createCapturingRuntime();
  const router = createRouterRuntime(baseConfig(), { modelRuntime: runtime });
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "claude-main",
    messages: MESSAGES,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    maxOutputTokens: 128,
    stream: true,
    cacheBreakpoints: [2, 3, 4],
  };

  const decision = await router.decide({
    request,
    sessionId: "fixed-legacy-keep",
    isMainAgent: true,
    metadata: { explicitProvider: "anthropic", explicitModel: "claude-cheap" },
  });
  assert.equal(decision.model, "claude-cheap");

  await drainExecute(router, decision, request, "fixed-legacy-keep");
  const captured = requests.at(-1)!;

  // FIXED (complementary case): the routed model is Anthropic-protocol and
  // cache-capable, so the legacy breakpoints survive the switch and the wire
  // carries the markers. No plan is synthesized for legacy callers.
  assert.deepEqual(captured.cacheBreakpoints, [2, 3, 4]);
  assert.equal(captured.cachePlan, undefined, "legacy callers get no synthesized plan");
  const wire = inspectWire(captured);
  assert.equal(wire.systemMarked, true);
  assert.deepEqual(wire.markedMessages, [2, 3, 4]);
  assert.equal(wire.toolsMarked, false);
  await router.shutdown();
});
