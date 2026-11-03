import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { TokenAccountingRuntime } from "../../../src/context/budget/TokenAccountingRuntime.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../../src/context/compaction/AutoCompactionPolicy.js";
import { InstructionDiscovery } from "../../../src/context/instructions/InstructionDiscovery.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { requestFingerprint } from "../../../src/model/streaming/requestFingerprint.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";

const message = (text: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text }] });
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "request-reuse-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "PILOTDECK.md"), "original project rule");
  const counts = { preparations: 0, tokenizations: 0, retrievals: 0, budgets: 0 };
  const clock = { now: new Date("2026-09-11T12:00:00Z") };
  const tokenBudget = new TokenBudgetManager();
  const estimate = tokenBudget.estimateMessagesTokens.bind(tokenBudget);
  tokenBudget.estimateMessagesTokens = messages => { counts.tokenizations++; return estimate(messages); };
  const context = new DefaultContextRuntime({ now: () => clock.now, tokenBudget, maxContextTokens: 2_000_000,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    instructionDiscovery: new InstructionDiscovery(cwd, cwd, join(cwd, "home")),
    memoryResolver: { retrieve: async () => { counts.retrievals++; return { systemContext: "memory attachment", diagnostics: [] }; }, captureTurn: async () => {} },
  });
  const prepare = context.prepareForModel.bind(context);
  context.prepareForModel = async input => { counts.preparations++; return prepare(input); };
  const accounting = new TokenAccountingRuntime({ tokenBudget, modelConfig: { providers: {} },
    fetch: async () => { throw new Error("Unexpected network"); } });
  const evaluate = accounting.evaluateRequestBudget.bind(accounting);
  accounting.evaluateRequestBudget = async (...args) => { counts.budgets++; return evaluate(...args); };
  const requests: CanonicalModelRequest[] = [], events: AgentEvent[] = [];
  const registry = new ToolRegistry();
  registry.register({ name: "inspect", description: "original tool", kind: "filesystem", inputSchema: { type: "object" },
    isReadOnly: () => true, isConcurrencySafe: () => true, isDestructive: () => false, execute: async () => ({ content: [] }) });
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: false,
      orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    execute: async function* (decision, request) {
      const actual = router.materializeRequest!(decision, request);
      requests.push(actual);
      yield { type: "request_started", provider: actual.provider, model: actual.model, requestFingerprint: requestFingerprint(actual) };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 1 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* () { throw new Error("Unexpected stream"); },
  };
  const dependencies: AgentRuntimeDependencies = { context, tokenAccounting: accounting, router,
    getModelProtocol: () => "anthropic", getModelSupportsPromptCache: () => true,
    getModelTokenLimits: (_provider, model) => ({ maxContextTokens: model === "small" ? 1_000_000 : 2_000_000 }),
    eventEmitter: event => events.push(event), tools: { registry, scheduler: { executeAll: async () => [] } },
  };
  const loop = new AgentLoop({ cwd, provider: "test", model: "large", permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }) }, dependencies);
  async function run(messages = [message("question")], options: Partial<AgentLoopInput> = {}) {
    for await (const event of loop.run({ sessionId: "session", turnId: `turn-${requests.length}`, messages, ...options })) {
      events.push(event);
      if (event.type === "turn_completed") assert.equal(event.result.type, "success");
    }
  }
  return { cwd, clock, counts, context, accounting, router, registry, dependencies, loop, requests, events, run };
}

test("unchanged iteration prepares/tokenizes once and emits instruction events once", async t => {
  const f = await fixture(t);
  let previewMessages: CanonicalMessage[] | undefined;
  const evaluate = f.accounting.evaluateRequestBudget;
  f.accounting.evaluateRequestBudget = async (...args) => { previewMessages = args[0].messages; return evaluate(...args); };
  await f.run();
  assert.deepEqual(f.counts, { preparations: 1, tokenizations: 1, retrievals: 1, budgets: 1 });
  assert.equal(f.events.filter(e => e.type === "instructions_loaded").length, 1);
  assert.match(f.requests[0].systemPrompt!, /memory attachment/);
  assert.match(f.requests[0].systemPrompt!, /original project rule/);
  assert.equal(f.requests[0].cachePlan?.generation, 1);
  assert.equal(f.requests[0].messages, previewMessages, "the prepared text request body is adopted directly");
  await f.run([message("new question")]);
  assert.equal(f.counts.preparations, 2);
  assert.equal(f.counts.tokenizations, 2, "a later turn must not reuse the previous estimate scope");
});

test("a routed window reuses preparation and local count while recalculating its budget", async t => {
  const f = await fixture(t);
  const decide = f.router.decide;
  f.router.decide = async input => ({ ...await decide(input), model: "small" });
  await f.run();
  assert.deepEqual(f.counts, { preparations: 1, tokenizations: 1, retrievals: 1, budgets: 2 });
  assert.equal(f.requests[0].model, "small");
  const budgets = f.events.filter(e => e.type === "context_budget");
  assert.equal(budgets.at(-1)?.snapshot.totalContextTokens, 1_000_000);
  // Calibration must use the estimate for the request actually executed.
  const calibration = await f.accounting.evaluateRequestBudget(f.requests[0], { maxContextTokens: 1_000_000 });
  assert.ok(calibration.localEstimateTokens! > 0);
});

test("routing transformations invalidate local counts and calibration uses the executed input", async t => {
  const f = await fixture(t);
  const decide = f.router.decide;
  f.router.decide = async input => ({ ...await decide(input), model: "small" });
  f.router.materializeRequest = (decision, request) => ({ ...request, provider: decision.provider, model: decision.model,
    systemPrompt: request.systemPrompt + " routed instructions ".repeat(100) });
  await f.run();
  assert.equal(f.counts.preparations, 1);
  assert.equal(f.counts.tokenizations, 2);
  const budget = f.events.find(e => e.type === "context_budget");
  assert.equal(budget?.snapshot.localEstimateTokens, f.accounting.estimateRequestInput(f.requests[0]));
  await f.run();
  const calibrated = f.events.filter(e => e.type === "context_budget").at(-1);
  assert.equal(calibrated?.snapshot.calibrationActualInputTokens, 100);
  assert.equal(calibrated?.snapshot.calibrationEstimatedInputTokens, budget?.snapshot.localEstimateTokens);
});

test("discarded candidates cannot replace the executed history or emit instruction events", async t => {
  const f = await fixture(t);
  f.context.tryAutoCompact = async input => {
    const snapshot = await input.budgetEvaluator!(input.messages);
    await input.budgetEvaluator!([message("discarded hypothetical history")]);
    return { type: "skipped", snapshot };
  };
  await f.run();
  assert.equal(f.requests[0].messages[0].content[0].type, "text");
  assert.match(JSON.stringify(f.requests[0].messages), /question/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /discarded/);
  assert.equal(f.counts.tokenizations, 2, "the restored original input can reuse its matching count");
  assert.equal(f.events.filter(e => e.type === "instructions_loaded").length, 1);
});

test("rules and tools changed during budget evaluation invalidate preparation and counting", async t => {
  const f = await fixture(t);
  const evaluate = f.accounting.evaluateRequestBudget;
  f.accounting.evaluateRequestBudget = async (...args) => {
    const result = await evaluate(...args);
    await writeFile(join(f.cwd, "PILOTDECK.md"), "changed project rule");
    f.registry.get("inspect")!.description = "changed tool";
    return result;
  };
  await f.run();
  assert.equal(f.counts.preparations, 2);
  assert.equal(f.counts.tokenizations, 2);
  assert.match(f.requests[0].systemPrompt!, /changed project rule/);
  assert.equal(f.requests[0].tools?.[0].description, "changed tool");
});

test("tool results start a fresh preparation and estimate scope", async t => {
  const f = await fixture(t);
  const execute = f.router.execute;
  let calls = 0;
  f.router.execute = async function* (...args) {
    if (calls++ > 0) { yield* execute(...args); return; }
    yield { type: "message_start", role: "assistant" };
    yield { type: "tool_call_end", toolCall: { id: "call", name: "inspect", input: {} } };
    yield { type: "message_end", finishReason: "tool_call" };
  };
  f.dependencies.tools.scheduler.executeAll = async calls => calls.map(call => ({ type: "success", toolCallId: call.id,
    toolName: call.name, content: [{ type: "text", text: "new tool result" }], startedAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString() }));
  await f.run();
  assert.equal(f.counts.preparations, 2);
  assert.equal(f.counts.tokenizations, 2);
  assert.match(JSON.stringify(f.requests[0].messages), /new tool result/);
});

test("budget failures fall through to normal execution", async t => {
  const f = await fixture(t);
  f.accounting.evaluateRequestBudget = async () => { throw new Error("count endpoint failed"); };
  await f.run();
  assert.equal(f.counts.preparations, 1);
  assert.equal(f.counts.tokenizations, 1);
  assert.equal(f.requests.length, 1);
});

test("selected full compaction rebuilds its date and counts the final adopted request", async t => {
  const f = await fixture(t);
  f.clock.now = new Date("2026-09-10T12:00:00Z");
  await f.context.prepareForModel({ sessionId: "session", turnId: "old", cwd: f.cwd, provider: "test", model: "large",
    protocol: "anthropic", supportsPromptCache: true, permissionMode: "bypassPermissions", runMode: "agent",
    additionalWorkingDirectories: [], tools: [], messages: [message("earlier work")] });
  f.clock.now = new Date("2026-09-11T12:00:00Z");
  const compacted: CanonicalMessage[] = [message('<compact-boundary trigger="auto" />'),
    { role: "assistant", content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }] }, message("latest task")];
  f.context.tryAutoCompact = async input => {
    await input.budgetEvaluator!(input.messages);
    const snapshot = await input.budgetEvaluator!(compacted);
    return { type: "compacted", tier: "full", messages: structuredClone(compacted), snapshot };
  };
  await f.run();
  assert.deepEqual(f.requests[0].messages, compacted);
  assert.equal(f.events.filter(e => e.type === "instructions_loaded").length, 1);
  assert.ok(f.requests[0].cachePlan!.generation > 1);
  assert.match(f.requests[0].systemPrompt!, /now: 2026-09-11/);
  assert.equal(f.counts.preparations, 4, "initial state, original probe, compact probe, formal checkpoint");
  assert.equal(f.counts.tokenizations, 3, "the refreshed date invalidates the compact preview estimate");
});

test("plan mode request reuse inserts exactly one reminder", async t => {
  const f = await fixture(t);
  await f.run([message("plan this task")], { permissionMode: "plan" });
  assert.equal(f.counts.preparations, 1);
  assert.equal(f.counts.tokenizations, 1);
  assert.equal(f.requests[0].messages.filter(m => m.metadata?.purpose === "plan_mode_reminder").length, 1);
});

test("file-backed media is re-read before execution even when context is reused", async t => {
  const f = await fixture(t);
  const path = join(f.cwd, "image.b64");
  await writeFile(path, "AA==");
  const evaluate = f.accounting.evaluateRequestBudget;
  f.accounting.evaluateRequestBudget = async (...args) => {
    const result = await evaluate(...args);
    await writeFile(path, "AQ==");
    return result;
  };
  await f.run([{ role: "user", content: [{ type: "text", text: "inspect this image" },
    { type: "media_reference", path, originalBytes: 1, preview: "image", hasMore: false, mimeType: "image/png", mediaType: "image" }] }]);
  assert.equal(f.counts.preparations, 1);
  assert.equal(f.counts.tokenizations, 2);
  const image = f.requests[0].messages[0].content.find(b => b.type === "image");
  assert.equal(image?.data, "AQ==");
});
