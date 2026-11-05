import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SubAgentSession } from "../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../src/agent/sub/builtinSubagentTypes.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { createExecuteCodeTool } from "../../src/tool/builtin/executeCode.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { createTaskCreateTool, createTaskWaitTool } from "../../src/tool/builtin/taskTools.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { fixture, assertRestorable, assertUnattributed, nodeCommand } from "./checkpoint-execution-fixture.js";

async function runChild(f: Awaited<ReturnType<typeof fixture>>, mode: "file" | "python" | "task", paths = ["a.txt"]) {
  const registry = new ToolRegistry(), runtime = new BackgroundTaskRuntime();
  registry.register(createReadFileTool()); registry.register(createWriteFileTool()); registry.register(createExecuteCodeTool());
  let taskId = "";
  const createTask = createTaskCreateTool(runtime);
  const childTask: typeof createTask = { ...createTask, execute: async (input, context) => {
    const result = await createTask.execute(input, context); taskId = result.data!.taskId as string; return result;
  } };
  registry.register(childTask);
  registry.register(createTaskWaitTool(runtime));
  const calls = mode === "file" ? paths.flatMap(file_path => [
    () => ({ name: "read_file", input: { file_path } }),
    () => ({ name: "write_file", input: { file_path, content: "C" } }),
  ]) : mode === "python" ? [() => ({ name: "execute_code", input: { code: "from pathlib import Path\nPath('a.txt').write_text('C')" } })] : [
    () => ({ name: "task_create", input: { lifecycle: "finite", command: nodeCommand("require('node:fs').writeFileSync('a.txt','C');") } }),
    () => ({ name: "task_wait", input: { taskId, timeoutMs: 10_000 } }),
  ];
  let step = 0;
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true,
      orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* () {
      const next = calls[step++];
      if (next) {
        const call = { id: `child-${step}`, ...next() };
        yield { type: "tool_call_start", id: call.id, name: call.name };
        yield { type: "tool_call_end", toolCall: call };
      } else yield { type: "text_delta", text: "Scope: test\nResult: complete\nKey files: a.txt\nFiles changed: a.txt\nIssues: none" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    stream: async function* () { assert.fail("Unexpected model stream"); },
  } as AgentRouterRuntime;
  const child = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: "Write C to the test files.",
    parentConfig: { provider: "test", model: "test", cwd: f.workspace, env: process.env, runMode: "agent",
      permissionMode: "bypassPermissions", permissionContext: f.context.permissionContext! },
    parentDependencies: { router, tools: { registry, scheduler: {} as never }, fileHistory: f.history },
    parentSessionId: "session", parentTurnId: "turn", subagentSessionId: "child", subagentId: "child-agent", maxTurns: calls.length + 1,
  });
  await child.run();
  assert.equal(await readFile(f.file, "utf8"), "C");
}

for (const mode of ["file", "python", "task"] as const) for (const order of ["parent-child", "child-parent"]) {
  test(`SubAgentSession ${mode} writes in ${order} order share the parent's checkpoint`, async t => {
    const f = await fixture(t);
    if (order === "parent-child") await f.toolWrite("B");
    await runChild(f, mode);
    if (order === "child-parent") await f.toolWrite("B");
    if (mode === "file") await assertRestorable(f, order === "parent-child" ? "C" : "B");
    else await assertUnattributed(f, order === "parent-child" ? "C" : "B");
  });
}

test("child file tools protect internal work files excluded from the turn scan", async t => {
  const internal = ".pilotdeck/work/child.txt", f = await fixture(t, { [internal]: "A" });
  await f.toolWrite("B"); await runChild(f, "file", ["a.txt", internal]);
  const checkpoint = (await f.history.finishTurn("complete"))!;
  const diff = await f.store.diff("session", checkpoint.id, internal);
  assert.equal(diff.oldContent, "A"); assert.equal(diff.newContent, "C");
  const plan = await f.store.preview("session", checkpoint.id);
  assert.equal(plan.files.length, 2); assert.ok(plan.files.every(file => file.status === "ready"), JSON.stringify(plan.files));
  const restored = await f.store.restore("session", plan.id);
  assert.equal(await readFile(join(f.workspace, internal), "utf8"), "A");
  await f.store.restore("session", (await f.store.undoPreview("session", restored.id)).id);
  assert.equal(await readFile(join(f.workspace, internal), "utf8"), "C");
});
