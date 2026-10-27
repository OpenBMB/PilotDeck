import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { AgentLoop } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentSteerMessage } from "../../src/agent/session/SteerMailbox.js";
import type { CanonicalModelEvent, CanonicalToolCall } from "../../src/model/index.js";
import { NullContextRuntime } from "../../src/context/NullContextRuntime.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { ConcurrentToolScheduler } from "../../src/tool/scheduler/ConcurrentToolScheduler.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { createExecuteCodeTool } from "../../src/tool/builtin/executeCode.js";
import { createAgentTool } from "../../src/tool/builtin/agent.js";
import { createTaskCreateTool, createTaskWaitTool } from "../../src/tool/builtin/taskTools.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { WorkspaceCheckpoints, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";
import { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import type { PilotDeckHookEvent } from "../../src/extension/hooks/protocol/events.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "workspace-preparation-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace"), home = join(base, "home");
  await fs.mkdir(workspace); await fs.mkdir(home);
  await fs.writeFile(join(workspace, "a.txt"), "original");
  const history = new WorkspaceCheckpoints(workspace, home), store = await getCheckpointStore(workspace, home);
  const release = deferred(), entered = deferred();
  const begin = history.beginTurn.bind(history);
  t.mock.method(history, "beginTurn", async (...args: Parameters<typeof begin>) => {
    entered.resolve();
    await release.promise;
    return begin(...args);
  });
  // Always release a failed assertion's deferred task before removing fixtures.
  t.after(() => release.resolve());
  return { workspace, home, history, store, release, entered, file: join(workspace, "a.txt") };
}

function makeRunner(f: Awaited<ReturnType<typeof fixture>>, options: {
  calls?: (request: number, child: boolean) => CanonicalToolCall[];
  registry?: ToolRegistry;
  lifecycle?: LifecycleRuntime;
  capture?: () => Promise<void>;
  providerWait?: (signal?: AbortSignal) => Promise<void>;
  prepareFailure?: Error;
} = {}) {
  const registry = options.registry ?? new ToolRegistry();
  const requested = deferred(), token = deferred(), detected = deferred(), answer = deferred();
  const requests: string[] = [], events: AgentEvent[] = [], results: string[] = [];
  const counts = new Map<string, number>();
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default",
      isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
    execute: async function* (_decision, _request, context) {
      const sessionId = context.sessionId;
      const count = (counts.get(sessionId) ?? 0) + 1; counts.set(sessionId, count);
      requests.push(sessionId); requested.resolve();
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "Starting the answer." };
      await options.providerWait?.(context.abortSignal);
      const calls = options.calls?.(count, sessionId.includes("::sub::")) ?? [];
      for (const call of calls) {
        yield { type: "tool_call_start", id: call.id, name: call.name };
        yield { type: "tool_call_end", toolCall: call };
      }
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: "message_end", finishReason: calls.length ? "tool_call" : "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> { assert.fail("Unexpected secondary stream"); },
  };
  const permissionContext = createDefaultPermissionContext({ cwd: f.workspace, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true });
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), options.lifecycle);
  const loop = new AgentLoop({ provider: "test", model: "test", cwd: f.workspace, env: process.env,
    permissionMode: "bypassPermissions", permissionContext }, {
    router, tools: { registry, scheduler: new ConcurrentToolScheduler(runtime, registry) }, fileHistory: f.history,
    lifecycle: options.lifecycle,
    ...(options.capture || options.prepareFailure ? { context: { prepareForModel: input => {
      if (options.prepareFailure) throw options.prepareFailure;
      return new NullContextRuntime().prepareForModel(input);
    },
      captureTurn: options.capture } } : {}),
  });
  const transcript = new InMemoryTranscriptWriter();
  const runner = new TurnRunner(loop, transcript, undefined, undefined, options.lifecycle,
    { cwd: f.workspace, transcriptPath: "" }, { fileHistory: f.history });
  const run = (signal?: AbortSignal, turnId = "turn", closeSteerMailbox?: () => AgentSteerMessage[]) => {
    const iterator = runner.run({ sessionId: "session", turnId, messages: [], input: { type: "text", text: "Test the workspace" }, abortSignal: signal, closeSteerMailbox });
    const done = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) return next.value;
        const event = next.value;
        events.push(event);
        if (event.type === "model_event" && event.event.type === "text_delta") token.resolve();
        if (event.type === "tool_calls_detected") detected.resolve();
        if (event.type === "assistant_message") answer.resolve();
        if (event.type === "tool_result") results.push(event.result.type);
      }
    })();
    return { done, iterator };
  };
  return { run, runner, transcript, registry, requested, token, detected, answer, requests, events, results };
}

test("a real model loop streams before protection, but terminal success waits for durable preparation", async t => {
  const f = await fixture(t), h = makeRunner(f);
  const { done } = h.run();
  await h.token.promise;
  await f.entered.promise;
  assert.equal(h.events.some(event => event.type === "turn_completed"), false);
  assert.equal((await f.store.list("session")).length, 0);
  f.release.resolve();
  assert.equal((await done).result.type, "success");
  assert.equal(f.store.busy, false);
  assert.equal((await f.store.list("session")).filter(record => record.phase === "after").length, 1);
});

for (const mode of ["write_file", "bash", "execute_code", "agent", "task_create"] as const) {
  test(`${mode} cannot mutate or launch writers before the shared baseline; restore and undo remain valid`, async t => {
    const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive));
    const f = await fixture(t), registry = new ToolRegistry();
    registry.register(createReadFileTool()); registry.register(createWriteFileTool()); registry.register(createAgentTool());
    registry.register(createExecuteCodeTool());
    registry.register(createBashTool({ runner: { async run() {
      await fs.writeFile(f.file, "changed");
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 };
    } } }));
    const tasks = new BackgroundTaskRuntime();
    const taskTool = createTaskCreateTool(tasks);
    let taskId = "";
    const trackedTask: typeof taskTool = { ...taskTool, execute: async (input, context) => {
      const output = await taskTool.execute(input, context); taskId = String(output.data!.taskId); return output;
    } };
    registry.register(trackedTask);
    registry.register(createTaskWaitTool(tasks));
    const node = process.execPath.replace(/'/g, "'\\''");
    const nodeCommand = process.platform === "win32"
      ? `& '${process.execPath.replace(/'/g, "''")}' -e 'require("node:fs").writeFileSync("a.txt","changed")'`
      : `'${node}' -e 'require("node:fs").writeFileSync("a.txt","changed")'`;
    const h = makeRunner(f, { registry, calls: (request, child) => {
      if (child) return request === 1 ? [{ id: "child-write", name: "bash", input: { command: "python write.py" } }] : [];
      if (mode === "task_create" && request === 2) return [{ id: "wait", name: "task_wait", input: { taskId, timeoutMs: 10_000 } }];
      if (request !== 1) return [];
      const input = mode === "write_file" ? { file_path: "new.txt", content: "changed" }
        : mode === "bash" ? { command: "python write.py" }
        : mode === "execute_code" ? { code: "from pathlib import Path\nPath('a.txt').write_text('changed')" }
        : mode === "agent" ? { description: "write", prompt: "Write a.txt", subagent_type: "general-purpose" }
        : { command: nodeCommand };
      return [{ id: "writer", name: mode, input }];
    } });
    const { done } = h.run();
    await h.detected.promise;
    await setImmediate();
    assert.equal(await fs.readFile(f.file, "utf8"), "original");
    await assert.rejects(fs.stat(join(f.workspace, "new.txt")), { code: "ENOENT" });
    assert.equal(h.requests.length, 1, "no child request before preparation");
    assert.equal(tasks.list().length, 0, "no detached process before preparation");
    f.release.resolve();
    assert.equal((await done).result.type, "success");
    assert.ok(h.results.length > 0); assert.ok(h.results.every(result => result === "success"));
    const changedPath = mode === "write_file" ? join(f.workspace, "new.txt") : f.file;
    assert.equal(await fs.readFile(changedPath, "utf8"), "changed");
    const checkpoint = (await f.store.list("session")).find(record => record.phase === "after")!;
    const operation = await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
    if (mode === "write_file") await assert.rejects(fs.stat(changedPath), { code: "ENOENT" });
    else assert.equal(await fs.readFile(changedPath, "utf8"), "original");
    await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
    assert.equal(await fs.readFile(changedPath, "utf8"), "changed");
  });
}

for (const event of ["UserPromptSubmit", "InstructionsLoaded", "PreModelRequest", "Stop"] as PilotDeckHookEvent[]) {
  test(`${event} hooks wait for protection and their writes are restorable`, async t => {
    const f = await fixture(t);
    let hookRan = false;
    const hooks = new HookRuntime({ [event]: [{ hooks: [{ type: "callback", name: "write" }] }] });
    hooks.getCallbackExecutor().register("write", async () => {
      hookRan = true; await fs.writeFile(f.file, "hook edit");
    });
    const h = makeRunner(f, { lifecycle: new LifecycleRuntime(hooks) });
    const { done } = h.run();
    await f.entered.promise;
    if (event === "Stop") await h.token.promise;
    await setImmediate();
    assert.equal(hookRan, false);
    assert.equal(h.requests.length, event === "Stop" ? 1 : 0);
    f.release.resolve();
    assert.equal((await done).result.type, "success");
    assert.equal(hookRan, true);
    const checkpoint = (await f.store.list("session")).find(record => record.phase === "after")!;
    const operation = await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
    assert.equal(await fs.readFile(f.file, "utf8"), "original");
    await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
    assert.equal(await fs.readFile(f.file, "utf8"), "hook edit");
  });
}

test("unmatched hooks do not delay the first request", async t => {
  const f = await fixture(t);
  const hooks = new HookRuntime({ UserPromptSubmit: [{ matcher: "not-matching", hooks: [{ type: "callback", name: "must-not-run" }] }] });
  const h = makeRunner(f, { lifecycle: new LifecycleRuntime(hooks) });
  const { done } = h.run();
  await h.token.promise;
  f.release.resolve();
  assert.equal((await done).result.type, "success");
});

for (const event of ["PreCompact", "PostCompact"] as const) {
  test(`${event} hooks conservatively guard context operations that dispatch outside AgentLoop`, async t => {
    const f = await fixture(t);
    const hooks = new HookRuntime({ [event]: [{ hooks: [{ type: "callback", name: "context-hook" }] }] });
    hooks.getCallbackExecutor().register("context-hook", () => {});
    const h = makeRunner(f, { lifecycle: new LifecycleRuntime(hooks) });
    const { done } = h.run(); await f.entered.promise; await setImmediate();
    assert.equal(h.requests.length, 0);
    f.release.resolve(); assert.equal((await done).result.type, "success");
  });
}

test("custom lifecycle dispatchers conservatively wait before executing", async t => {
  const f = await fixture(t);
  const dispatch = t.mock.fn(async () => { await fs.writeFile(f.file, "custom hook");
    return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }; });
  const h = makeRunner(f, { lifecycle: { dispatch } as unknown as LifecycleRuntime });
  const { done } = h.run();
  await f.entered.promise; await setImmediate();
  assert.equal(dispatch.mock.callCount(), 0);
  f.release.resolve();
  assert.equal((await done).result.type, "success");
  assert.ok(dispatch.mock.callCount() > 0);
});

test("a real UserPromptSubmit shell hook executes only after both baselines and can be restored", async t => {
  const f = await fixture(t);
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('a.txt','hook edit')"`;
  const hooks = new HookRuntime({ UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] });
  const h = makeRunner(f, { lifecycle: new LifecycleRuntime(hooks) });
  const { done } = h.run(); await f.entered.promise; await setImmediate();
  assert.equal(h.requests.length, 0);
  assert.equal(await fs.readFile(f.file, "utf8"), "original");
  f.release.resolve();
  assert.equal((await done).result.type, "success");
  assert.equal(await fs.readFile(f.file, "utf8"), "hook edit");
  const checkpoint = (await f.store.list("session")).find(record => record.phase === "after")!;
  await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
  assert.equal(await fs.readFile(f.file, "utf8"), "original");
});

test("even a read-only tool's PreToolUse command hook waits for protection", async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry(); registry.register(createReadFileTool());
  const hooks = new HookRuntime({ PreToolUse: [{ matcher: "read_file", hooks: [{ type: "callback", name: "write" }] }] });
  let hookRan = false;
  hooks.getCallbackExecutor().register("write", async () => { hookRan = true; await fs.writeFile(f.file, "hook edit"); });
  const h = makeRunner(f, { registry, lifecycle: new LifecycleRuntime(hooks),
    calls: request => request === 1 ? [{ id: "read", name: "read_file", input: { file_path: "a.txt" } }] : [] });
  const { done } = h.run(); await h.detected.promise; await setImmediate();
  assert.equal(hookRan, false);
  f.release.resolve();
  assert.equal((await done).result.type, "success"); assert.equal(hookRan, true);
  const checkpoint = (await f.store.list("session")).find(record => record.phase === "after")!;
  await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
  assert.equal(await fs.readFile(f.file, "utf8"), "original");
});

for (const phase of ["checkpoint", "artifact"] as const) {
  test(`${phase} failure rejects a streaming turn and prevents all tool writes`, async t => {
    const f = await fixture(t), registry = new ToolRegistry(); registry.register(createWriteFileTool());
    if (phase === "checkpoint") t.mock.method(f.history, "beginTurn", async () => { await f.release.promise; throw new Error("disk failure"); });
    else t.mock.method(FileArtifactCollector, "start", async () => { throw new Error("artifact failure"); });
    const h = makeRunner(f, { registry,
      calls: request => request === 1 ? [{ id: "write", name: "write_file", input: { file_path: "new.txt", content: "unsafe" } }] : [] });
    const { done } = h.run(); await h.token.promise;
    f.release.resolve();
    const result = await done;
    assert.equal(result.result.type, "error");
    assert.ok(h.events.some(event => event.type === "turn_failed" && event.error.code === "agent_transcript_error"));
    assert.equal(h.events.some(event => event.type === "turn_completed" && event.result.type === "success"), false);
    await assert.rejects(fs.stat(join(f.workspace, "new.txt")), { code: "ENOENT" });
    assert.equal(f.store.busy, false);
  });
}

test("a completed model answer cannot hide a late preparation failure", async t => {
  const f = await fixture(t);
  t.mock.method(f.history, "beginTurn", async () => { await f.release.promise; throw new Error("late disk failure"); });
  const h = makeRunner(f), { done } = h.run();
  await h.token.promise; f.release.resolve();
  assert.equal((await done).result.type, "error");
  assert.ok(h.events.some(event => event.type === "turn_failed"));
});

test("context preparation errors are not replaced by consumer-cancellation errors", async t => {
  const f = await fixture(t);
  const h = makeRunner(f, { prepareFailure: new Error("Attachment is unavailable") });
  const { done } = h.run(); await f.entered.promise; await setImmediate();
  f.release.resolve();
  const { result } = await done;
  assert.equal(result.type, "error");
  assert.equal(result.errors?.[0].message, "Attachment is unavailable");
  assert.equal(f.store.busy, false);
});

test("late protection failures retain already-durable assistant messages in session state", async t => {
  const f = await fixture(t);
  t.mock.method(f.history, "beginTurn", async () => { await f.release.promise; throw new Error("late disk failure"); });
  const h = makeRunner(f), { done } = h.run();
  await h.answer.promise; await setImmediate(); f.release.resolve();
  const result = await done;
  assert.equal(result.result.type, "error");
  assert.equal(result.messages.at(-1)?.role, "assistant");
});

test("late preparation failure preserves unapplied queued guidance", async t => {
  const f = await fixture(t);
  t.mock.method(f.history, "beginTurn", async () => { await f.release.promise; throw new Error("late disk failure"); });
  const h = makeRunner(f);
  let queued: AgentSteerMessage[] = [{ itemId: "queued", message: { role: "user", content: [{ type: "text", text: "more guidance" }] } }];
  const { done } = h.run(undefined, "turn", () => { const result = queued; queued = []; return result; });
  await h.token.promise; f.release.resolve();
  assert.equal((await done).result.type, "error");
  assert.equal(h.events.filter(event => event.type === "steer_unapplied" && event.itemId === "queued").length, 1);
});

test("tools wait for artifact readiness even after the checkpoint is durably captured", async t => {
  const f = await fixture(t); f.release.resolve();
  const start = FileArtifactCollector.start.bind(FileArtifactCollector), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  t.mock.method(FileArtifactCollector, "start", async (options: Parameters<typeof start>[0]) => {
    entered.resolve(); await release.promise; return start(options);
  });
  const registry = new ToolRegistry(); registry.register(createWriteFileTool());
  const h = makeRunner(f, { registry, calls: request => request === 1
    ? [{ id: "write", name: "write_file", input: { file_path: "new.txt", content: "protected" } }] : [] });
  const { done } = h.run(); await entered.promise; await h.detected.promise; await setImmediate();
  assert.equal(f.store.busy, true);
  assert.equal((await f.store.list("session")).filter(record => record.phase === "before").length, 1);
  await assert.rejects(fs.stat(join(f.workspace, "new.txt")), { code: "ENOENT" });
  release.resolve();
  assert.equal((await done).result.type, "success");
  const output = h.events.find(event => event.type === "file_artifacts");
  assert.ok(output?.type === "file_artifacts" && output.artifacts.some(file => file.path === "new.txt"));
});

test("failed protection aborts an already-streaming provider instead of waiting for its response", async t => {
  const f = await fixture(t);
  t.mock.method(f.history, "beginTurn", async () => { await f.release.promise; throw new Error("disk failure"); });
  let aborted = false;
  const h = makeRunner(f, { providerWait: signal => new Promise<void>((resolve) => {
    const onAbort = () => { aborted = true; resolve(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  }) });
  const { done } = h.run(); await h.token.promise; f.release.resolve();
  assert.equal((await done).result.type, "error"); assert.equal(aborted, true);
  assert.ok(h.events.some(event => event.type === "turn_failed" && event.error.code === "agent_transcript_error"));
});

test("cancelling artifact startup cleans the checkpoint lease and collector registration", async t => {
  const f = await fixture(t); f.release.resolve();
  const controller = new AbortController(), entered = deferred(), releaseArtifact = deferred();
  const start = FileArtifactCollector.start.bind(FileArtifactCollector);
  const mocked = t.mock.method(FileArtifactCollector, "start", async (options: Parameters<typeof start>[0]) => {
    entered.resolve(); await releaseArtifact.promise; return start(options);
  });
  const h = makeRunner(f), { done } = h.run(controller.signal);
  await entered.promise; controller.abort(); releaseArtifact.resolve();
  assert.equal((await done).result.type, "aborted"); assert.equal(f.store.busy, false);
  mocked.mock.restore();
  const collector = await FileArtifactCollector.start({ cwd: f.workspace });
  await fs.writeFile(join(f.workspace, "after-cancel.txt"), "new");
  collector.observeToolResult({ type: "success", toolName: "bash", toolCallId: "later", content: [],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  assert.deepEqual((await collector.finish("complete")).map(file => file.path), ["after-cancel.txt"]);
});

test("cancellation during preparation blocks tools, flushes cleanup and releases the lease", async t => {
  const f = await fixture(t), controller = new AbortController();
  const registry = new ToolRegistry(); registry.register(createWriteFileTool());
  const h = makeRunner(f, { registry, calls: request => request === 1
    ? [{ id: "write", name: "write_file", input: { file_path: "new.txt", content: "unsafe" } }] : [] });
  const { done } = h.run(controller.signal); await h.detected.promise;
  controller.abort(); f.release.resolve();
  assert.equal((await done).result.type, "aborted");
  assert.equal(h.events.some(event => event.type === "turn_failed"), false);
  assert.equal(f.store.busy, false);
  await assert.rejects(fs.stat(join(f.workspace, "new.txt")), { code: "ENOENT" });
});

test("closing a streaming consumer aborts pending preparation and closes the model iterator", async t => {
  const f = await fixture(t);
  f.release.resolve();
  const captured = deferred(), allowCapture = deferred();
  const capture = f.store.capture.bind(f.store);
  let signal: AbortSignal | undefined;
  t.mock.method(f.store, "capture", async (...args: Parameters<typeof capture>) => {
    signal = args[4]; captured.resolve(); await allowCapture.promise; return capture(...args);
  });
  const h = makeRunner(f);
  const iterator = h.runner.run({ sessionId: "session", turnId: "turn", messages: [], input: { type: "text", text: "hello" } });
  while (true) {
    const event = await iterator.next();
    assert.equal(event.done, false);
    if (!event.done && event.value.type === "model_event" && event.value.event.type === "text_delta") break;
  }
  await captured.promise;
  const closed = iterator.return(undefined as never);
  await setImmediate(); assert.equal(signal?.aborted, true);
  allowCapture.resolve(); await closed;
  assert.equal(f.store.busy, false);
  const collector = await FileArtifactCollector.start({ cwd: f.workspace }); collector.dispose();
});

test("context capture at model completion cannot write before preparation", async t => {
  const f = await fixture(t);
  let captured = false;
  const h = makeRunner(f, { capture: async () => { captured = true; await fs.writeFile(f.file, "memory capture"); } });
  const { done } = h.run(); await h.token.promise; await setImmediate();
  assert.equal(captured, false); f.release.resolve();
  assert.equal((await done).result.type, "success"); assert.equal(captured, true);
});

test("overlapping workspace leases still serialize writes while both models can begin", async t => {
  const f = await fixture(t); f.release.resolve();
  const releaseLease = await f.store.acquire();
  const one = makeRunner(f), two = makeRunner({ ...f, history: new WorkspaceCheckpoints(f.workspace, f.home) });
  const first = one.run(undefined, "one"), second = two.run(undefined, "two");
  await Promise.all([one.token.promise, two.token.promise]);
  assert.equal(one.events.some(event => event.type === "turn_completed"), false);
  assert.equal(two.events.some(event => event.type === "turn_completed"), false);
  releaseLease();
  assert.equal((await first.done).result.type, "success");
  assert.equal((await second.done).result.type, "success");
  assert.equal(f.store.busy, false);
});
