import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import { PermissionRuntime } from "../../src/permission/index.js";
import type { PilotDeckToolAuditRecord } from "../../src/tool/audit/ToolAuditRecorder.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import type { PilotDeckToolResult } from "../../src/tool/protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { ConcurrentToolScheduler } from "../../src/tool/scheduler/ConcurrentToolScheduler.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "scheduler-session",
    turnId: "scheduler-turn",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function tool(name: string, safe = true): PilotDeckToolDefinition {
  return {
    name,
    aliases: [`${name}_alias`],
    description: "Synthetic scheduler fixture",
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => safe,
    isConcurrencySafe: () => safe,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  };
}

function calls(...names: string[]): PilotDeckToolCall[] {
  return names.map((name, index) => ({ id: String(index), name, input: {} }));
}

function success(call: PilotDeckToolCall): PilotDeckToolResult {
  return {
    type: "success", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: call.id }],
    startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function controlled(t: TestContext, batch: PilotDeckToolCall[], maxConcurrency?: number) {
  const registry = new ToolRegistry();
  registry.register(tool("safe"));
  registry.register(tool("exclusive", false));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const gates = batch.map(deferred);
  const results = batch.map(success);
  const started: string[] = [];
  const finished: string[] = [];
  const contexts: PilotDeckToolRuntimeContext[] = [];
  t.mock.method(runtime, "execute", async (call: PilotDeckToolCall, ctx: PilotDeckToolRuntimeContext) => {
    started.push(call.id);
    contexts.push(ctx);
    await gates[Number(call.id)].promise;
    finished.push(call.id);
    return results[Number(call.id)];
  });
  t.after(() => { for (const gate of gates) gate.resolve(); });
  return {
    registry, runtime, gates, results, started, finished, contexts,
    scheduler: new ConcurrentToolScheduler(runtime, registry, { maxConcurrency }),
  };
}

test("scheduler handles empty and single batches and forwards the runtime context", async (t) => {
  const batch = calls("safe");
  const fixture = controlled(t, batch);
  const ctx = context();
  assert.deepEqual(await fixture.scheduler.executeAll([], ctx), []);
  const execution = fixture.scheduler.executeAll(batch, ctx);
  fixture.gates[0].resolve();
  const result = await execution;
  assert.equal(result[0], fixture.results[0]);
  assert.deepEqual(fixture.started, ["0"]);
  assert.equal(fixture.contexts[0], ctx);
});

test("a single call needs no concurrency classification", async (t) => {
  const batch = calls("safe");
  const fixture = controlled(t, batch);
  fixture.registry.replace({ ...tool("safe"), isConcurrencySafe: () => { throw new Error("not needed"); } });
  const execution = fixture.scheduler.executeAll(batch, context());
  fixture.gates[0].resolve();
  assert.deepEqual(await execution, fixture.results);
});

test("exclusive calls are barriers before and after concurrent runs", async (t) => {
  const batch = calls("safe", "safe", "exclusive", "safe", "safe", "exclusive");
  const fixture = controlled(t, batch);
  const execution = fixture.scheduler.executeAll(batch, context());
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[1].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[0].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1", "2"]);
  fixture.gates[2].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1", "2", "3", "4"]);
  fixture.gates[4].resolve();
  await setImmediate();
  assert.equal(fixture.started.length, 5);
  fixture.gates[3].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, batch.map((call) => call.id));
  fixture.gates[5].resolve();
  const results = await execution;
  assert.deepEqual(fixture.finished, ["1", "0", "2", "4", "3", "5"]);
  results.forEach((result, index) => assert.equal(result, fixture.results[index]));
});

test("a read after a write observes the write in the same batch", async () => {
  const registry = new ToolRegistry();
  let value = "before";
  registry.register({ ...tool("write", false), execute: async () => {
    value = "after";
    return { content: [{ type: "text", text: value }] };
  } });
  registry.register({ ...tool("read"), execute: async () => ({ content: [{ type: "text", text: value }] }) });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const results = await new ConcurrentToolScheduler(runtime, registry).executeAll(calls("write", "read"), context());
  assert.deepEqual(results.map((result) => result.content), [
    [{ type: "text", text: "after" }], [{ type: "text", text: "after" }],
  ]);
});

for (const limit of [undefined, 1, 2]) {
  test(`concurrency limit ${limit ?? "default (4)"} bounds and replenishes the active pool`, async (t) => {
    const batch = calls(...Array<string>(8).fill("safe"));
    const fixture = controlled(t, batch, limit);
    const execution = fixture.scheduler.executeAll(batch, context());
    const expectedLimit = limit ?? 4;
    await setImmediate();
    assert.deepEqual(fixture.started, batch.slice(0, expectedLimit).map((call) => call.id));
    // Free the last slot while the earlier calls are still running.
    fixture.gates[expectedLimit - 1].resolve();
    await setImmediate();
    assert.deepEqual(fixture.started, batch.slice(0, expectedLimit + 1).map((call) => call.id));
    assert.equal(fixture.started.length - fixture.finished.length, expectedLimit);
    for (const gate of fixture.gates) gate.resolve();
    assert.deepEqual(await execution, fixture.results);
  });
}

test("invalid concurrency limits fail at construction", () => {
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  for (const maxConcurrency of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new ConcurrentToolScheduler(runtime, registry, { maxConcurrency }), RangeError);
  }
});

test("aliases and input-dependent concurrency flags retain their ordering boundaries", async (t) => {
  const batch = calls("safe_alias", "safe", "safe_alias");
  batch[1].input = { exclusive: true };
  const fixture = controlled(t, batch);
  fixture.registry.replace({ ...tool("safe"), isConcurrencySafe: (input) => !(input as { exclusive?: boolean }).exclusive });
  const execution = fixture.scheduler.executeAll(batch, context());
  await setImmediate();
  assert.deepEqual(fixture.started, ["0"]);
  fixture.gates[0].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[1].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1", "2"]);
  fixture.gates[2].resolve();
  await execution;
});

test("unknown tools conservatively separate concurrent runs", async (t) => {
  const batch = calls("safe", "unknown", "safe");
  const fixture = controlled(t, batch);
  const execution = fixture.scheduler.executeAll(batch, context());
  await setImmediate();
  assert.deepEqual(fixture.started, ["0"]);
  fixture.gates[0].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[1].resolve();
  await setImmediate();
  assert.deepEqual(fixture.started, ["0", "1", "2"]);
  fixture.gates[2].resolve();
  await execution;
});

test("ordinary tool errors preserve one result per call and allow later calls", async () => {
  const registry = new ToolRegistry();
  registry.register({ ...tool("broken"), execute: async () => { throw new Error("fixture failure"); } });
  registry.register(tool("exclusive", false));
  const batch = calls("broken", "missing", "exclusive");
  const results = await new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry)
    .executeAll(batch, context());
  assert.deepEqual(results.map((result) => result.toolCallId), batch.map((call) => call.id));
  assert.deepEqual(results.map((result) => result.type === "error" ? result.error.code : result.type),
    ["tool_execution_failed", "tool_not_found", "success"]);
});

test("unexpected rejection stops queued calls and drains active calls before rejecting", async (t) => {
  const batch = calls("safe", "safe", "safe", "exclusive");
  const fixture = controlled(t, batch, 2);
  const failure = new Error("audit unavailable");
  let settled = false;
  const execution = fixture.scheduler.executeAll(batch, context());
  const rejection = assert.rejects(execution, (error) => error === failure).finally(() => { settled = true; });
  await setImmediate();
  fixture.gates[0].reject(failure);
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[1].resolve();
  await rejection;
  assert.deepEqual(fixture.finished, ["1"]);
  assert.deepEqual(fixture.started, ["0", "1"]);
});

test("classification failures also drain calls that have already started", async (t) => {
  const batch = calls("safe", "invalid", "exclusive");
  const fixture = controlled(t, batch);
  const failure = new Error("invalid concurrency classification");
  fixture.registry.register({ ...tool("invalid"), isConcurrencySafe: () => { throw failure; } });
  let settled = false;
  const execution = fixture.scheduler.executeAll(batch, context());
  const rejection = assert.rejects(execution, (error) => error === failure).finally(() => { settled = true; });
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(fixture.started, ["0"]);
  fixture.gates[0].resolve();
  await rejection;
  assert.deepEqual(fixture.finished, ["0"]);
});

test("a runtime failure while draining a barrier prevents the barrier and later calls", async (t) => {
  const batch = calls("safe", "safe", "exclusive", "safe");
  const fixture = controlled(t, batch);
  const failure = new Error("failed while waiting at the barrier");
  let settled = false;
  const execution = fixture.scheduler.executeAll(batch, context());
  const rejection = assert.rejects(execution, (error) => error === failure).finally(() => { settled = true; });
  await setImmediate();
  fixture.gates[0].reject(failure);
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(fixture.started, ["0", "1"]);
  fixture.gates[1].resolve();
  await rejection;
  assert.deepEqual(fixture.started, ["0", "1"]);
});

test("a pre-aborted batch preserves audited results without classifying or executing tools", async () => {
  const registry = new ToolRegistry();
  registry.register({
    ...tool("safe"),
    isConcurrencySafe: () => { assert.fail("Cancelled calls need no classification"); },
    execute: async () => { assert.fail("Cancelled calls must not execute"); },
  });
  const audits: PilotDeckToolAuditRecord[] = [];
  const batch = calls("safe", "safe_alias", "missing");
  const results = await new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry)
    .executeAll(batch, {
      ...context(), abortSignal: AbortSignal.abort(),
      auditRecorder: { recordPermission: () => { assert.fail("Cancelled calls need no permission request"); },
        recordTool: (record) => { audits.push(record); } },
    });
  assert.deepEqual(results.map((result) => result.toolCallId), batch.map((call) => call.id));
  assert.deepEqual(results.map((result) => result.type === "error" && result.error.code), Array(3).fill("tool_aborted"));
  assert.deepEqual(audits.map((record) => record.toolCallId), batch.map((call) => call.id));
});

test("cancellation drains active bodies before returning results for the rest of the batch", async (t) => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  const bothStarted = deferred();
  const gates = [deferred(), deferred()];
  t.after(() => { for (const gate of gates) gate.resolve(); });
  const executed: string[] = [];
  const audits: PilotDeckToolAuditRecord[] = [];
  registry.register({ ...tool("safe"), execute: async (_input, ctx) => {
    const id = ctx.currentToolCallId!;
    executed.push(id);
    if (executed.length === 2) bothStarted.resolve();
    await gates[Number(id)].promise;
    return { content: [] };
  } });
  const batch = calls("safe", "safe", "safe");
  let settled = false;
  const execution = new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry, { maxConcurrency: 2 })
    .executeAll(batch, {
      ...context(), abortSignal: controller.signal,
      auditRecorder: { recordPermission: () => {}, recordTool: (record) => { audits.push(record); } },
    }).finally(() => { settled = true; });
  await bothStarted.promise;
  controller.abort();
  gates[0].resolve();
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(executed, ["0", "1"]);
  assert.deepEqual(audits.map((record) => record.toolCallId), ["0"]);
  gates[1].resolve();
  const results = await execution;
  assert.deepEqual(executed, ["0", "1"]);
  assert.deepEqual(results.map((result) => result.type === "error" ? result.error.code : result.type),
    ["success", "success", "tool_aborted"]);
  assert.deepEqual(audits.map((record) => record.toolCallId), ["0", "1", "2"]);
});

test("cancellation keeps audited results for queued calls without executing their bodies", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  const executed: string[] = [];
  const audits: PilotDeckToolAuditRecord[] = [];
  registry.register({ ...tool("cancel"), execute: async () => {
    executed.push("cancel");
    controller.abort();
    return { content: [] };
  } });
  registry.register({ ...tool("queued"), execute: async () => {
    executed.push("queued");
    return { content: [] };
  } });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const batch = calls("cancel", "queued", "queued");
  const results = await new ConcurrentToolScheduler(runtime, registry, { maxConcurrency: 1 }).executeAll(batch, {
    ...context(), abortSignal: controller.signal,
    auditRecorder: { recordPermission: () => {}, recordTool: (record) => { audits.push(record); } },
  });
  assert.deepEqual(executed, ["cancel"]);
  assert.deepEqual(results.map((result) => result.toolCallId), batch.map((call) => call.id));
  assert.deepEqual(results.map((result) => result.type === "error" ? result.error.code : result.type),
    ["success", "tool_aborted", "tool_aborted"]);
  assert.deepEqual(audits.map((record) => record.toolCallId), batch.map((call) => call.id));
});

test("cancellation during permission auditing prevents the tool body from starting", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({ ...tool("safe"), execute: async () => { executed = true; return { content: [] }; } });
  const audits: PilotDeckToolAuditRecord[] = [];
  const results = await new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry)
    .executeAll(calls("safe"), {
      ...context(), abortSignal: controller.signal,
      auditRecorder: {
        recordPermission: () => { controller.abort(); },
        recordTool: (record) => { audits.push(record); },
      },
    });
  assert.equal(executed, false);
  assert.equal(results[0].type === "error" && results[0].error.code, "tool_aborted");
  assert.equal(audits[0].errorCode, "tool_aborted");
});
