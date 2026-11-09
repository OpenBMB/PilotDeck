import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createPlanTodoStateManager } from "../../src/agent/runtime/PlanTodoState.js";
import { NullLifecycleRuntime } from "../../src/lifecycle/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { ConcurrentToolScheduler, ToolRegistry, ToolRuntime, type PilotDeckToolDefinition, type PilotDeckToolRuntimeContext } from "../../src/tool/index.js";
import type { PilotDeckToolAuditRecord } from "../../src/tool/audit/ToolAuditRecorder.js";

function definition(overrides: Partial<PilotDeckToolDefinition> = {}): PilotDeckToolDefinition {
  return {
    name: "probe", description: "Synthetic tool contract", kind: "custom", inputSchema: { type: "object" },
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async () => ({ content: [] }), ...overrides,
  };
}

function context(overrides: Partial<PilotDeckToolRuntimeContext> = {}): PilotDeckToolRuntimeContext {
  return {
    sessionId: "tool-contract", turnId: "turn-1", cwd: process.cwd(), permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
    ...overrides,
  };
}

function rewrittenRuntime(t: TestContext, stage: "pre" | "permission", tool: PilotDeckToolDefinition, updatedInput: Record<string, unknown>) {
  const registry = new ToolRegistry();
  const executed: unknown[] = [];
  const audited: PilotDeckToolAuditRecord[] = [];
  registry.register({ ...tool, execute: async (input) => { executed.push(input); return { content: [] }; } });
  const lifecycle = new NullLifecycleRuntime();
  t.mock.method(lifecycle, "dispatch", async ({ event }: { event: string }) => ({
    effects: event === "PreToolUse" && stage === "pre" ? [{ type: "updated_tool_input", input: updatedInput }]
      : event === "PermissionRequest" && stage === "permission" ? [{ type: "permission_request_result", result: { behavior: "allow", updatedInput } }]
        : [],
    messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
  }));
  const permission = new PermissionRuntime();
  const reason = { type: "runtime" as const, message: "Synthetic permission" };
  const permissionCalls = t.mock.method(permission, "decide", async () => stage === "permission"
    ? { type: "ask", reason, request: { toolCallId: "call-1", toolName: tool.name, inputSummary: "probe", reason, options: [] } }
    : { type: "allow", reason });
  const runtime = new ToolRuntime(registry, permission, lifecycle);
  return {
    registry, runtime, executed, audited, permissionCalls,
    run(input: Record<string, unknown>, overrides: Partial<PilotDeckToolRuntimeContext> = {}) {
      return runtime.execute({ id: "call-1", name: tool.name, input }, context({
        auditRecorder: { recordPermission: () => {}, recordTool: (entry) => { audited.push(entry); } }, ...overrides,
      }));
    },
  };
}

const plans = join(process.cwd(), ".pilotdeck", "plans");

test("group replacement validates every alias before publishing removals or additions", () => {
  const registry = new ToolRegistry();
  const old = definition({ name: "old", aliases: ["old_alias"] });
  const other = definition({ name: "other", aliases: ["other_alias"] });
  registry.register(old);
  registry.register(other);
  const next = definition({ name: "next", aliases: ["next_alias"] });
  assert.throws(() => registry.replaceGroup([old.name], [next, definition({ name: "conflict", aliases: ["other_alias"] })]));
  assert.equal(registry.get("old_alias"), old);
  assert.equal(registry.get("other_alias"), other);
  assert.equal(registry.has("next"), false);
  registry.replaceGroup([old.name], [next]);
  assert.equal(registry.has("old_alias"), false);
  assert.equal(registry.get("next_alias"), next);
  assert.equal(registry.get("other_alias"), other);
});
const policyCases = [
  {
    name: "ask-mode commands", code: "ask_mode_violation",
    tool: definition({ name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }),
    initial: { command: "pwd" }, updated: { command: "rm -rf example" }, context: { runMode: "ask" as const },
  },
  {
    name: "plan-directory writes", code: "plan_mode_violation",
    tool: definition({ name: "write_file" }),
    initial: { file_path: join(plans, "plan.md") }, updated: { file_path: join(process.cwd(), "application.ts") },
    context: { permissionMode: "plan" as const, planDirectory: { path: plans, resolve: () => undefined, read: () => undefined } },
  },
  {
    name: "prompt capability", code: "unsupported_tool",
    tool: definition({ requiresUserInteraction: (input) => (input as { interactive?: boolean }).interactive === true }),
    initial: { interactive: false }, updated: { interactive: true }, context: {},
  },
  {
    name: "input schema", code: "invalid_tool_input",
    tool: definition({ inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }),
    initial: { value: "valid" }, updated: { value: 7 }, context: {},
  },
];

for (const stage of ["pre", "permission"] as const) {
  for (const scenario of policyCases) {
    test(`${stage} hook input changes cannot bypass ${scenario.name}`, async (t) => {
      const f = rewrittenRuntime(t, stage, scenario.tool, scenario.updated);
      const result = await f.run(scenario.initial, scenario.context);
      assert.equal(result.type === "error" && result.error.code, scenario.code);
      assert.deepEqual(f.executed, []);
      assert.equal(f.audited.length, 1);
      assert.equal(f.audited[0].errorCode, scenario.code);
      if (stage === "pre") assert.equal(f.permissionCalls.mock.callCount(), 0);
    });
  }

  test(`${stage} hook input changes retain valid execution and auditing`, async (t) => {
    const f = rewrittenRuntime(t, stage, definition(), { value: "updated" });
    const result = await f.run({ value: "original" });
    assert.equal(result.type, "success");
    assert.deepEqual(f.executed, [{ value: "updated" }]);
    assert.equal(f.audited.length, 1);
    assert.equal(f.audited[0].status, "success");
  });
}

test("permission-rewritten arguments pass the tool's semantic validator", async (t) => {
  const validated: unknown[] = [];
  const f = rewrittenRuntime(t, "permission", definition({ validateInput: async (input) => {
    validated.push(input);
    return (input as { path: string }).path === "blocked"
      ? { ok: false, issues: [{ path: "path", code: "invalid_enum", message: "Blocked path" }] }
      : { ok: true, input };
  } }), { path: "blocked" });
  const result = await f.run({ path: "allowed" });
  assert.equal(result.type === "error" && result.error.code, "invalid_tool_input");
  assert.deepEqual(validated, [{ path: "allowed" }, { path: "blocked" }]);
  assert.deepEqual(f.executed, []);
});

test("permission rewrites cannot bypass an approved plan's todo gate", async (t) => {
  const planTodo = createPlanTodoStateManager().forSession("tool-contract");
  planTodo.markPlanApproved("Implement the synthetic plan");
  const f = rewrittenRuntime(t, "permission", definition({
    isReadOnly: (input) => !(input as { write?: boolean }).write,
  }), { write: true });
  const result = await f.run({ write: false }, { planTodo });
  assert.equal(result.type === "error" && result.error.code, "tool_execution_failed");
  assert.match(result.type === "error" ? result.error.message : "", /todo_write/);
  assert.deepEqual(f.executed, []);
});

test("invalid final permission input is rejected before invoking the semantic validator again", async (t) => {
  const f = rewrittenRuntime(t, "permission", definition({
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    validateInput: async (input) => { assert.equal(typeof (input as { value: string }).value, "string"); return { ok: true, input }; },
  }), { value: 7 });
  const result = await f.run({ value: "valid" });
  assert.equal(result.type === "error" && result.error.code, "invalid_tool_input");
  assert.deepEqual(f.executed, []);
});

test("cancellation while permission auditing prevents a tool body from starting", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  let ran = false;
  registry.register(definition({ execute: async () => { ran = true; return { content: [] }; } }));
  const audited: PilotDeckToolAuditRecord[] = [];
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({ id: "abort", name: "probe", input: {} }, context({
    abortSignal: controller.signal,
    auditRecorder: { recordPermission: () => { controller.abort(); }, recordTool: (entry) => { audited.push(entry); } },
  }));
  assert.equal(result.type === "error" && result.error.code, "tool_aborted");
  assert.equal(ran, false);
  assert.equal(audited[0].errorCode, "tool_aborted");
});

test("a safe-to-exclusive rewrite is rejected in a parallel batch but can run alone", async (t) => {
  const f = rewrittenRuntime(t, "pre", definition({ isConcurrencySafe: (input) => !(input as { exclusive?: boolean }).exclusive }), { exclusive: true });
  const scheduler = new ConcurrentToolScheduler(f.runtime, f.registry);
  const batch = ["1", "2"].map((id) => ({ id, name: "probe", input: {} }));
  const results = await scheduler.executeAll(batch, context());
  assert.ok(results.every((result) => result.type === "error" && result.error.code === "tool_execution_failed"));
  assert.match(results[0].content[0].type === "text" ? results[0].content[0].text : "", /retry.*alone/i);
  assert.deepEqual(f.executed, []);
  assert.equal((await scheduler.executeAll([batch[0]], context()))[0].type, "success");
  assert.deepEqual(f.executed, [{ exclusive: true }]);
});

test("unchanged concurrency-safe rewritten inputs still execute in a parallel batch", async (t) => {
  const f = rewrittenRuntime(t, "permission", definition(), { value: "updated" });
  const results = await new ConcurrentToolScheduler(f.runtime, f.registry).executeAll(
    ["1", "2"].map((id) => ({ id, name: "probe", input: {} })), context(),
  );
  assert.deepEqual(results.map((result) => result.type), ["success", "success"]);
  assert.deepEqual(f.executed, [{ value: "updated" }, { value: "updated" }]);
});

test("a final concurrency classifier failure becomes a paired error without executing the tool", async (t) => {
  const f = rewrittenRuntime(t, "pre", definition({ isConcurrencySafe: (input) => {
    if ((input as { changed?: boolean }).changed) throw new Error("Unsupported rewritten input");
    return true;
  } }), { changed: true });
  const results = await new ConcurrentToolScheduler(f.runtime, f.registry).executeAll(
    ["1", "2"].map((id) => ({ id, name: "probe", input: {} })), context(),
  );
  assert.ok(results.every((result) => result.type === "error" && result.error.code === "tool_execution_failed"));
  assert.deepEqual(results.map((result) => result.toolCallId), ["1", "2"]);
  assert.deepEqual(f.executed, []);
});

test("replacement cannot steal another tool's canonical name or alias", () => {
  for (const conflictingAlias of ["second", "second_alias"]) {
    const registry = new ToolRegistry();
    const first = definition({ name: "first", aliases: ["first_alias"] });
    const second = definition({ name: "second", aliases: ["second_alias"] });
    registry.register(first);
    registry.register(second);
    assert.throws(() => registry.replace(definition({ name: "first", aliases: ["new_alias", conflictingAlias] })));
    assert.equal(registry.get("first"), first);
    assert.equal(registry.get("first_alias"), first);
    assert.equal(registry.get("second"), second);
    assert.equal(registry.get("second_alias"), second);
    assert.equal(registry.get("new_alias"), undefined);
    registry.unregister("first");
    assert.equal(registry.get("second_alias"), second);
  }
});

test("replacement preserves its own aliases and clears diagnostics for newly active aliases", () => {
  const registry = new ToolRegistry();
  registry.register(definition({ aliases: ["retained", "old"] }));
  registry.markUnavailable({ toolName: "other_missing", code: "unavailable", reason: "Synthetic missing plugin" }, ["new"]);
  const replacement = definition({ aliases: ["retained", "new"] });
  registry.replace(replacement);
  assert.equal(registry.get("retained"), replacement);
  assert.equal(registry.get("new"), replacement);
  assert.equal(registry.has("old"), false);
  assert.equal(registry.getUnavailable("new"), undefined);
  assert.equal(registry.getUnavailable("other_missing")?.reason, "Synthetic missing plugin");
});

test("register and replace preserve redundant alias compatibility without mutating definitions", () => {
  for (const aliases of [["alias", "alias"], ["probe"], ["probe", "alias", "alias"]]) {
    const registry = new ToolRegistry();
    const original = definition({ aliases });
    registry.register(original);
    for (const name of ["probe", ...aliases]) assert.equal(registry.get(name), original);
    const replacementAliases = [...aliases, "replacement", "replacement"];
    const replacement = definition({ aliases: replacementAliases });
    registry.replace(replacement);
    for (const name of ["probe", ...replacementAliases]) assert.equal(registry.get(name), replacement);
    assert.deepEqual(original.aliases, aliases);
    assert.deepEqual(replacement.aliases, replacementAliases);
    assert.equal(registry.unregister("probe"), true);
    for (const name of ["probe", ...replacementAliases]) assert.equal(registry.has(name), false);
  }
});
