import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { AutoCompactionPolicy } from "../../../src/context/compaction/AutoCompactionPolicy.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { createRouterRuntime } from "../../../src/router/RouterRuntime.js";
import { buildCachePlan } from "../../../src/context/cache/CachePlan.js";
import type { ContextPrepareInput } from "../../../src/context/protocol/types.js";
import { requestFingerprint } from "../../../src/model/streaming/requestFingerprint.js";
import { prepareModelRequestAttempt } from "../../../src/agent/loop/prepareModelRequest.js";
import type { EvaluateRequestBudgetOptions } from "../../../src/context/budget/TokenAccountingRuntime.js";

function fixture(options: { route?: string; abort?: AbortController } = {}) {
  const counts = { memory: 0, instructions: 0, artifacts: 0 };
  const budget = new TokenBudgetManager();
  const context = new DefaultContextRuntime({
    tokenBudget: budget, autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: budget }),
    memoryResolver: { async retrieve() { return { systemContext: `release-${++counts.memory}`, diagnostics: [] }; }, async captureTurn() {} },
    instructionDiscovery: { async discover() { counts.instructions++; return []; } } as never,
    sessionArtifactContext: async () => { counts.artifacts++; return undefined; },
    now: () => new Date("2026-11-07T00:00:00Z"),
  });
  const measured: CanonicalModelRequest[] = [];
  const sent: CanonicalModelRequest[] = [];
  const calibrations: unknown[] = [];
  const events: AgentEvent[] = [];
  let routingSignal: AbortSignal | undefined;
  const dependencies: AgentRuntimeDependencies = {
    context, tools: { registry: new ToolRegistry(), scheduler: { async executeAll() { return []; } } },
    getModelTokenLimits: () => ({ maxContextTokens: 100_000, maxOutputTokens: 100 }),
    getModelProtocol: () => "anthropic", getModelSupportsPromptCache: () => true,
    tokenAccounting: { async evaluateRequestBudget(request: CanonicalModelRequest, limits: EvaluateRequestBudgetOptions) {
      measured.push(request);
      calibrations.push(limits.calibration);
      return budget.snapshotFromTokens(100, limits.maxContextTokens, { reservedOutputTokens: limits.reservedOutputTokens });
    }, estimateRequestInput: () => 100 } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    router: {
      async decide(input) {
        routingSignal = input.abortSignal;
        return { provider: "synthetic", model: options.route ?? "model-a", scenarioType: "default", isSubagent: false,
          orchestrating: false, resolvedFrom: "scenario", mutations: {} };
      },
      materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
      async *execute(decision, request) {
        sent.push({ ...request, provider: decision.provider, model: decision.model });
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      },
      async *stream() {},
    },
  };
  const loop = new AgentLoop({ provider: "synthetic", model: "model-a", cwd: "/synthetic", systemPrompt: "Synthetic",
    permissionMode: "default", maxContextTokens: 100_000, maxOutputTokens: 100,
    permissionContext: createDefaultPermissionContext({ cwd: "/synthetic", canPrompt: false }),
  }, dependencies);
  return { counts, context, dependencies, measured, sent, events, calibrations, get routingSignal() { return routingSignal; },
    async run(turnId = "turn") {
      for await (const event of loop.run({ sessionId: "request-attempt", turnId, abortSignal: options.abort?.signal,
        messages: [{ role: "user", content: [{ type: "text", text: "synthetic request" }] }],
      })) events.push(event);
    },
  };
}

test("an unchanged attempt budgets and sends one resolved context; the next turn refreshes it", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.counts, { memory: 1, instructions: 1, artifacts: 1 });
  assert.deepEqual(f.measured[0].messages, f.sent[0].messages);
  assert.equal(f.sent[0].cachePlan?.generation, 1);
  await f.run("next-turn");
  assert.deepEqual(f.counts, { memory: 2, instructions: 2, artifacts: 2 });
  assert.notDeepEqual(f.sent[0].messages, f.sent[1].messages);
});

test("selected route owns prompt identity, cache plan and model-start event", async () => {
  const f = fixture({ route: "model-b" });
  await f.run();
  assert.match(f.sent[0].systemPrompt!, /model: synthetic\/model-b/);
  assert.equal(f.sent[0].cachePlan?.model, "model-b");
  assert.deepEqual(f.events.filter(event => event.type === "model_request_started").map(event => event.model), ["model-b"]);
  assert.deepEqual(f.counts, { memory: 1, instructions: 1, artifacts: 1 });
  assert.equal(f.measured.length, 2, "Changed route must be budgeted even with an unchanged context-window size");
  assert.deepEqual(f.measured.at(-1)?.messages, f.sent[0].messages);
  assert.equal(f.measured.at(-1)?.systemPrompt, f.sent[0].systemPrompt);
});

test("routing receives the turn cancellation signal", async () => {
  const abort = new AbortController();
  const f = fixture({ abort });
  await f.run();
  assert.equal(f.routingSignal, abort.signal);
});

test("committing cache generations preserves exact-request usage calibration", async () => {
  const f = fixture();
  f.dependencies.router.execute = async function* (_decision, request, context) {
    const actual = { ...request, cachePlan: request.cachePlan ? { ...request.cachePlan } : undefined };
    await context.onRequestPrepared?.(actual);
    yield { type: "request_started", provider: actual.provider, model: actual.model, requestFingerprint: requestFingerprint(actual) };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "done" };
    yield { type: "usage", usage: { inputTokens: 200, outputTokens: 10 } };
    yield { type: "message_end", finishReason: "stop" };
  };
  await f.run();
  await f.run("next-turn");
  assert.equal(f.calibrations[0], undefined);
  assert.deepEqual(f.calibrations[1], { provider: "synthetic", model: "model-a", actualInputTokens: 200, estimatedInputTokens: 100 });
});

test("legacy custom context runtimes retain preview and committed preparation calls", async () => {
  const f = fixture();
  const modes: Array<boolean | undefined> = [];
  f.dependencies.context = {
    async prepareForModel(input) {
      modes.push(input.previewOnly);
      return { messages: input.messages, tools: input.tools, systemPromptParts: [], diagnostics: [], boundaries: [] };
    },
    tryAutoCompact: f.context.tryAutoCompact.bind(f.context),
  };
  await f.run();
  assert.deepEqual(modes, [true, undefined]);
});

test("a legacy DefaultContextRuntime subclass retains its prepareForModel override", async () => {
  const f = fixture();
  const modes: Array<boolean | undefined> = [];
  class CustomContext extends DefaultContextRuntime {
    override async prepareForModel(input: ContextPrepareInput) {
      modes.push(input.previewOnly);
      const result = await super.prepareForModel(input);
      return { ...result, systemPrompt: "Synthetic custom context" };
    }
  }
  const custom = new CustomContext();
  custom.tryAutoCompact = f.context.tryAutoCompact.bind(f.context);
  f.dependencies.context = custom;
  await f.run();
  assert.deepEqual(modes, [true, undefined]);
  assert.equal(f.sent[0].systemPrompt, "Synthetic custom context");
});

test("cancellation during routing produces an aborted result without model dispatch", async () => {
  const abort = new AbortController();
  const f = fixture({ abort });
  f.dependencies.router.decide = async input => {
    abort.abort("synthetic stop");
    input.abortSignal?.throwIfAborted();
    throw new Error("The turn signal was not forwarded");
  };
  await f.run();
  assert.equal(f.sent.length, 0);
  const completed = f.events.find(event => event.type === "turn_completed");
  assert.equal(completed?.result.type, "aborted");
});

test("compaction candidates are resolved independently and only the chosen candidate commits", async () => {
  const f = fixture();
  f.context.tryAutoCompact = async input => {
    await input.budgetEvaluator!(input.messages);
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "compacted synthetic request" }] }];
    const snapshot = await input.budgetEvaluator!(messages);
    await input.budgetEvaluator!(messages);
    return { type: "compacted", tier: "micro", messages, snapshot };
  };
  await f.run();
  assert.deepEqual(f.counts, { memory: 2, instructions: 2, artifacts: 2 });
  assert.deepEqual(f.sent[0].messages, f.measured.at(-1)?.messages);
  assert.equal(f.sent[0].cachePlan?.generation, 1);
  assert.match(JSON.stringify(f.sent[0].messages), /compacted synthetic request/);
});

test("a custom compactor mutating a candidate in place cannot reuse stale preparation", async () => {
  const f = fixture();
  f.context.tryAutoCompact = async input => {
    await input.budgetEvaluator!(input.messages);
    input.messages[0] = { role: "user", content: [{ type: "text", text: "mutated synthetic candidate" }] };
    const snapshot = await input.budgetEvaluator!(input.messages);
    return { type: "compacted", tier: "micro", messages: input.messages, snapshot };
  };
  await f.run();
  assert.deepEqual(f.counts, { memory: 2, instructions: 2, artifacts: 2 });
  assert.match(JSON.stringify(f.sent[0].messages), /mutated synthetic candidate/);
  assert.deepEqual(f.sent[0].messages, f.measured.at(-1)?.messages);
});

test("same-target wire mutations advance cache generation once for each final plan", async () => {
  const context = new DefaultContextRuntime();
  const preparation = await prepareModelRequestAttempt({ provider: "synthetic", model: "model", cwd: "/synthetic",
    permissionMode: "default", permissionContext: createDefaultPermissionContext({ cwd: "/synthetic", canPrompt: false }) },
  { context, toolRegistry: new ToolRegistry(), getModelProtocol: () => "anthropic", getModelSupportsPromptCache: () => true },
  { sessionId: "wire", turnId: "turn", messages: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] });
  const projected = await preparation.project();
  const original = projected.request;
  projected.commit(original);
  assert.equal(original.cachePlan?.generation, 1);
  const changed = { ...original, systemPrompt: `${original.systemPrompt}\nSynthetic wire addendum` };
  changed.cachePlan = buildCachePlan({ ...changed, tools: changed.tools ?? [], enabled: true }, 0);
  projected.commit(changed);
  assert.equal(changed.cachePlan?.generation, 2);
  projected.commit(changed);
  assert.equal(changed.cachePlan?.generation, 2);
});

test("real routing projects fallback identity and fingerprints the patched request", async t => {
  const f = fixture();
  const wire: CanonicalModelRequest[] = [];
  const router = createRouterRuntime({ enabled: true,
    scenarios: { default: { id: "synthetic/model-b", provider: "synthetic", model: "model-b" } },
    fallback: { default: [{ id: "synthetic/model-c", provider: "synthetic", model: "model-c" }] },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 }, transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stats: { enabled: false },
  }, { modelRuntime: {
    async *stream(request) {
      wire.push(request);
      if (request.model === "model-b") {
        yield { type: "error", error: { provider: "synthetic", protocol: "anthropic", code: "overloaded", message: "Synthetic unavailable", retryable: true } };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() { throw new Error("Unexpected completion"); },
    getProviderProtocol: () => "anthropic", getProviderBaseUrl: () => undefined,
    getMultimodal: () => ({ input: ["text"] }),
    getCapabilities: () => ({ supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: true,
      maxContextTokens: 100_000, maxOutputTokens: 100 }),
  } });
  t.after(() => router.shutdown());
  f.dependencies.router = router;
  await f.run();
  assert.deepEqual(wire.map(request => request.model), ["model-b", "model-c"]);
  assert.deepEqual(f.counts, { memory: 1, instructions: 1, artifacts: 1 });
  for (const request of wire) {
    assert.match(request.systemPrompt!, new RegExp(`model: synthetic/${request.model}`));
    assert.equal(request.cachePlan?.model, request.model);
    assert.ok(request.cachePlan!.generation > 0);
    assert.deepEqual(request.cachePlan, buildCachePlan({ ...request, tools: request.tools ?? [], enabled: true }, request.cachePlan!.generation));
  }
  assert.equal(wire[1].cachePlan!.generation, wire[0].cachePlan!.generation + 1);
});

test("cancelling pending context work stops awaiting it and prevents later stages", async () => {
  const abort = new AbortController();
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let discovered = 0;
  const context = new DefaultContextRuntime({
    sessionArtifactContext: async () => { enter(); await new Promise<void>(resolve => { release = resolve; }); return undefined; },
    instructionDiscovery: { async discover() { discovered++; return []; } } as never,
  });
  const input: ContextPrepareInput = { sessionId: "s", turnId: "t", cwd: "/synthetic", provider: "synthetic", model: "model",
    permissionMode: "default", additionalWorkingDirectories: [], tools: [], messages: [], abortSignal: abort.signal };
  const pending = context.prepareForModel(input);
  await entered;
  const reason = new Error("synthetic cancellation");
  abort.abort(reason);
  try { await assert.rejects(pending, error => error === reason); }
  finally { release(); }
  assert.equal(discovered, 0);
});

for (const recoveryType of ["adjust_output_and_retry", "compact_and_retry"] as const) {
  test(`real routing retains ${recoveryType} output caps until dispatch completes`, async t => {
    const f = fixture();
    f.context.recoverFromModelError = async () => recoveryType === "adjust_output_and_retry"
      ? { type: recoveryType, maxOutputTokens: 20, scope: "attempt", reason: "synthetic cap" }
      : { type: recoveryType, maxOutputTokens: 20, reason: "synthetic cap" };
    const wire: number[] = [];
    const router = createRouterRuntime({ enabled: false, stats: { enabled: false } }, { modelRuntime: {
      async *stream(request) {
        wire.push(request.maxOutputTokens!);
        if (wire.length === 1) {
          yield { type: "error", error: { provider: "synthetic", protocol: "anthropic", code: "invalid_request",
            message: "Synthetic token limit", retryable: false } };
          return;
        }
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete() { throw new Error("Unexpected completion"); },
      getProviderProtocol: () => "anthropic", getProviderBaseUrl: () => undefined,
      getMultimodal: () => ({ input: ["text"] }),
      getCapabilities: () => ({ supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
        supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: true,
        maxContextTokens: 100_000, maxOutputTokens: 100 }),
    } });
    t.after(() => router.shutdown());
    f.dependencies.router = router;
    await f.run();
    assert.deepEqual(wire, [100, 20]);
    await f.run("next-turn");
    assert.deepEqual(wire, [100, 20, 100]);
  });
}
