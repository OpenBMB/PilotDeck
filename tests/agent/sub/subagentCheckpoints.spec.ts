import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { resolveSubagentProfiles } from "../../../src/agent/sub/subagentProfiles.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { WorkspaceCheckpoints, getCheckpointStore } from "../../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import { createReadFileTool } from "../../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../../src/tool/builtin/writeFile.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";

for (const order of ["parent-child", "child-parent"] as const) {
  test(`nested profile writes in ${order} order retain the root checkpoint and timeline`, async t => {
    const base = await mkdtemp(join(tmpdir(), "nested-subagent-checkpoint-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const cwd = join(base, "workspace"), home = join(base, "home");
    // This path is excluded from the turn scan, so restoring it requires the
    // actual fileHistory dependency to survive both levels of delegation.
    const internal = ".pilotdeck/work/nested.txt";
    const paths = ["a.txt", internal];
    await mkdir(dirname(join(cwd, internal)), { recursive: true });
    await mkdir(home);
    for (const path of paths) await writeFile(join(cwd, path), "A");
    const history = new WorkspaceCheckpoints(cwd, home);
    const store = await getCheckpointStore(cwd, home);
    const begin = t.mock.method(history, "beginTurn");
    const finish = t.mock.method(history, "finishTurn");
    await history.beginTurn("root-session", "root-turn", []);

    const events: AgentEvent[] = [];
    const writes: string[] = [];
    const registry = new ToolRegistry();
    const read = createReadFileTool(), write = createWriteFileTool();
    registry.register(createAgentTool());
    registry.register(read);
    const trackedWrite: typeof write = { ...write, execute: async (input, context) => {
      assert.equal(context.fileHistory, history);
      assert.equal(context.subagentDepth, 2);
      writes.push(context.sessionId!);
      return write.execute(input, context);
    } };
    registry.register(trackedWrite);
    const permissionContext = createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true });
    const parentWrite = async () => {
      const context = { cwd, sessionId: "root-session", turnId: "root-turn", fileHistory: history,
        permissionMode: "bypassPermissions" as const, permissionContext };
      for (const file_path of paths) {
        await read.execute({ file_path }, context);
        await write.execute({ file_path, content: "B" }, context);
      }
    };
    if (order === "parent-child") await parentWrite();
    const turns = new Map<string, number>();
    const dependencies: AgentRuntimeDependencies = {
      tools: { registry, scheduler: new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry) },
      fileHistory: history,
      eventEmitter: event => { events.push(event); },
      router: {
        decide: async ({ request }) => ({ provider: request.provider, model: request.model,
          scenarioType: "default", isSubagent: Boolean(request.metadata?.subagentId),
          orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
        execute: async function* (_decision, request) {
          const role = String(request.metadata?.subagentType ?? "parent");
          const step = turns.get(role) ?? 0;
          turns.set(role, step + 1);
          if (role !== "leaf" && step === 0) {
            const child = role === "parent" ? "dispatcher" : "leaf";
            yield { type: "tool_call_end", toolCall: { id: `call-${child}`, name: "agent",
              input: { description: `Run ${child}`, prompt: "Write the test files.", subagent_type: child } } };
          } else if (role === "leaf" && step < paths.length * 2) {
            const file_path = paths[Math.floor(step / 2)]!;
            yield { type: "tool_call_end", toolCall: { id: `leaf-${step}`, name: step % 2 ? "write_file" : "read_file",
              input: step % 2 ? { file_path, content: "C" } : { file_path } } };
          } else {
            yield { type: "text_delta", text: "Scope: files\nResult: complete\nKey files: a.txt\nFiles changed: a.txt\nIssues: none" };
          }
          yield { type: "message_end", finishReason: "stop" };
        },
        stream: async function* () { assert.fail("Unexpected legacy model stream"); },
      },
    };
    const generator = new AgentLoop({ provider: "test", model: "text", cwd, runMode: "agent",
      permissionMode: "bypassPermissions", permissionContext, maxSubagentDepth: 2,
      subagentProfiles: resolveSubagentProfiles({
        dispatcher: { description: "Delegate file edits", tools: ["agent", "read_file", "write_file"], readOnly: false },
        leaf: { description: "Edit files", tools: ["read_file", "write_file"], readOnly: false },
      }),
    }, dependencies).run({ sessionId: "root-session", turnId: "root-turn", maxTurns: 3,
      messages: [{ role: "user", content: [{ type: "text", text: "Delegate file edits" }] }],
    });
    while (true) {
      const next = await generator.next();
      if (next.done) { assert.equal(next.value.result.type, "success"); break; }
    }
    const leaf = events.find(event => event.type === "subagent_started" && event.subagentType === "leaf");
    assert.ok(leaf && leaf.type === "subagent_started");
    assert.equal(writes.length, 2);
    assert.ok(writes.every(sessionId => sessionId !== "root-session" && sessionId === writes[0]));
    const results = events.filter((event): event is Extract<AgentEvent, { type: "subagent_tool_result" }> =>
      event.type === "subagent_tool_result" && event.subagentId === leaf.subagentId);
    assert.equal(results.length, 4);
    assert.ok(results.every(event => event.sessionId === "root-session" && event.turnId === "root-turn"
      && event.timeline?.turnId === `${leaf.subagentId}-t0`));
    assert.equal(begin.mock.callCount(), 1);
    assert.equal(finish.mock.callCount(), 0);
    if (order === "child-parent") await parentWrite();
    const expected = order === "parent-child" ? "C" : "B";
    const checkpoint = (await history.finishTurn("complete"))!;
    assert.equal(checkpoint.sessionId, "root-session");
    assert.equal(checkpoint.turnId, "root-turn");
    assert.deepEqual(checkpoint.changes.map(change => change.path).sort(), [...paths].sort());
    for (const path of paths) {
      const diff = await store.diff("root-session", checkpoint.id, path);
      assert.equal(diff.oldContent, "A");
      assert.equal(diff.newContent, expected);
    }
    const plan = await store.preview("root-session", checkpoint.id);
    assert.ok(plan.files.every(file => file.status === "ready"));
    const restored = await store.restore("root-session", plan.id);
    for (const path of paths) assert.equal(await readFile(join(cwd, path), "utf8"), "A");
    await store.restore("root-session", (await store.undoPreview("root-session", restored.id)).id);
    for (const path of paths) assert.equal(await readFile(join(cwd, path), "utf8"), expected);
  });
}
