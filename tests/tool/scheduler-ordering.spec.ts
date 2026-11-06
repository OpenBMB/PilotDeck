import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { ConcurrentToolScheduler, ToolRegistry, ToolRuntime, type PilotDeckToolCall, type PilotDeckToolDefinition, type PilotDeckToolResult, type PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

const context = (): PilotDeckToolRuntimeContext => ({
  sessionId: "scheduler-contract", turnId: "turn-1", cwd: process.cwd(), permissionMode: "bypassPermissions",
  permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
});

function tool(name: string, safe = true): PilotDeckToolDefinition {
  return { name, aliases: [`${name}_alias`], description: "Synthetic scheduler tool", kind: "custom", inputSchema: { type: "object" },
    isReadOnly: () => safe, isConcurrencySafe: () => safe, execute: async () => ({ content: [] }) };
}

function gate() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}

function controlled(t: TestContext, names: string[], maxConcurrency?: number) {
  const registry = new ToolRegistry();
  registry.register(tool("safe"));
  registry.register(tool("exclusive", false));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const batch = names.map((name, index) => ({ name, id: String(index), input: {} }));
  const gates = batch.map(gate);
  const started: string[] = [];
  const finished: string[] = [];
  const results: PilotDeckToolResult[] = batch.map((call) => ({
    type: "success", toolCallId: call.id, toolName: call.name, content: [],
    startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
  }));
  t.mock.method(runtime, "execute", async (call: PilotDeckToolCall) => {
    started.push(call.id);
    await gates[Number(call.id)].promise;
    finished.push(call.id);
    return results[Number(call.id)];
  });
  t.after(() => { for (const entry of gates) entry.resolve(); });
  return { registry, runtime, batch, gates, started, finished, results,
    scheduler: new ConcurrentToolScheduler(runtime, registry, { maxConcurrency }) };
}

test("empty and singleton batches do not require concurrency classification", async (t) => {
  const f = controlled(t, ["safe"]);
  f.registry.replace({ ...tool("safe"), isConcurrencySafe: () => { assert.fail("Unnecessary classification"); } });
  assert.deepEqual(await f.scheduler.executeAll([], context()), []);
  const result = f.scheduler.executeAll(f.batch, context());
  f.gates[0].resolve();
  assert.deepEqual(await result, f.results);
});

for (const limit of [undefined, 1, 2]) {
  test(`active calls are bounded and replenished (limit ${limit ?? 4})`, async (t) => {
    const f = controlled(t, Array<string>(8).fill("safe"), limit);
    const execution = f.scheduler.executeAll(f.batch, context());
    await setImmediate();
    const cap = limit ?? 4;
    assert.deepEqual(f.started, f.batch.slice(0, cap).map((call) => call.id));
    f.gates[cap - 1].resolve();
    await setImmediate();
    assert.equal(f.started.length - f.finished.length, cap);
    assert.equal(f.started.length, cap + 1);
    for (const entry of f.gates) entry.resolve();
    assert.deepEqual(await execution, f.results);
  });
}

test("exclusive and unknown calls preserve submitted barriers and ordered results", async (t) => {
  const f = controlled(t, ["safe_alias", "safe", "exclusive", "safe", "unknown", "safe"]);
  const execution = f.scheduler.executeAll(f.batch, context());
  await setImmediate();
  assert.deepEqual(f.started, ["0", "1"]);
  f.gates[1].resolve();
  await setImmediate();
  assert.deepEqual(f.started, ["0", "1"]);
  for (const index of [0, 2, 3, 4]) {
    f.gates[index].resolve();
    await setImmediate();
    const last = index === 0 ? 2 : index + 1;
    assert.deepEqual(f.started, f.batch.slice(0, last + 1).map((call) => call.id));
  }
  f.gates[5].resolve();
  assert.deepEqual(await execution, f.results);
  assert.deepEqual(f.finished, ["1", "0", "2", "3", "4", "5"]);
});

test("a same-batch read observes the preceding write, and ordinary errors retain result pairing", async () => {
  const registry = new ToolRegistry();
  let value = "before";
  registry.register({ ...tool("write", false), execute: async () => { value = "after"; return { content: [] }; } });
  registry.register({ ...tool("read"), execute: async () => ({ content: [{ type: "text", text: value }] }) });
  const calls = ["write", "read", "missing", "read"].map((name, index) => ({ name, id: String(index), input: {} }));
  const results = await new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry).executeAll(calls, context());
  assert.deepEqual(results.map((result) => result.toolCallId), ["0", "1", "2", "3"]);
  assert.deepEqual(results[1].content, [{ type: "text", text: "after" }]);
  assert.equal(results[2].type === "error" && results[2].error.code, "tool_not_found");
  assert.equal(results[3].type, "success");
});

for (const reason of [undefined, new Error("Synthetic runtime failure")]) {
  test(`unexpected rejection drains active calls and stops dispatch (${String(reason)})`, async (t) => {
    const f = controlled(t, ["safe", "safe", "safe", "exclusive"], 2);
    let settled = false;
    const execution = f.scheduler.executeAll(f.batch, context());
    const rejection = assert.rejects(execution, (error) => error === reason).finally(() => { settled = true; });
    await setImmediate();
    f.gates[0].reject(reason);
    await setImmediate();
    assert.equal(settled, false);
    assert.deepEqual(f.started, ["0", "1"]);
    f.gates[1].resolve();
    await rejection;
    assert.deepEqual(f.started, ["0", "1"]);
  });
}

test("classification failures also drain already-started calls", async (t) => {
  const f = controlled(t, ["safe", "broken", "safe"]);
  const failure = new Error("Synthetic classifier failure");
  f.registry.register({ ...tool("broken"), isConcurrencySafe: () => { throw failure; } });
  let settled = false;
  const rejection = assert.rejects(f.scheduler.executeAll(f.batch, context()), (error) => error === failure)
    .finally(() => { settled = true; });
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(f.started, ["0"]);
  f.gates[0].resolve();
  await rejection;
});

test("cancellation drains active bodies and audits queued aborted results", async (t) => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  const started = gate();
  const release = gate();
  t.after(() => release.resolve());
  const executed: string[] = [];
  const audited: string[] = [];
  registry.register({ ...tool("safe"), execute: async (_input, ctx) => {
    executed.push(ctx.currentToolCallId!);
    started.resolve();
    await release.promise;
    return { content: [] };
  } });
  let settled = false;
  const execution = new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry, { maxConcurrency: 1 })
    .executeAll(["0", "1", "2"].map((id) => ({ id, name: "safe", input: {} })), {
      ...context(), abortSignal: controller.signal,
      auditRecorder: { recordPermission: () => {}, recordTool: (entry) => { audited.push(entry.toolCallId); } },
    }).finally(() => { settled = true; });
  await started.promise;
  controller.abort();
  await setImmediate();
  assert.equal(settled, false);
  release.resolve();
  const results = await execution;
  assert.deepEqual(executed, ["0"]);
  assert.deepEqual(audited, ["0", "1", "2"]);
  assert.deepEqual(results.map((result) => result.type === "error" ? result.error.code : result.type), ["success", "tool_aborted", "tool_aborted"]);
});

test("invalid pool limits fail at construction", () => {
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  for (const maxConcurrency of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new ConcurrentToolScheduler(runtime, registry, { maxConcurrency }), RangeError);
  }
});
