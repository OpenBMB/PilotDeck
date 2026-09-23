import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { FileRunRegistry, RunRegistryError } from "../../src/gateway/run/RunRegistry.js";
import type { AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

const processWorkerPath = new URL("./run-registry-process-worker.js", import.meta.url);
const restartWorkerPath = new URL("./run-registry-restart-worker.js", import.meta.url);
const ownerWorkerPath = new URL("./run-registry-owner-worker.js", import.meta.url);

test("FileRunRegistry persists accepted runs, ordered events, and conflicts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "registry.json");
  const registry = new FileRunRegistry(path);
  const input = { projectKey: "project", sessionKey: "session", runId: "run-1", requestMaterial: "request" };
  const accepted = await registry.accept(input);
  assert.equal(accepted.duplicate, false);
  assert.equal((await registry.accept(input)).duplicate, true);
  await assert.rejects(() => registry.accept({ ...input, requestMaterial: "other" }), (error: unknown) => error instanceof RunRegistryError && error.code === "conflict");
  await registry.append({ projectKey: "project", sessionKey: "session", runId: "run-1", event: { type: "input_accepted", runId: "run-1" } });
  await registry.append({ projectKey: "project", sessionKey: "session", runId: "run-1", event: { type: "turn_completed", runId: "run-1", usage: {}, finishReason: "completed" } });

  const reloaded = new FileRunRegistry(path);
  const record = await reloaded.get(input);
  assert.equal(record?.state, "completed");
  assert.equal(record?.lastSeq, 2);
  assert.deepEqual((await reloaded.events(input)).map((entry) => entry.seq), [1, 2]);
});

test("FileRunRegistry serializes concurrent accepts for one run id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  const input = { projectKey: "project", sessionKey: "session", runId: "run-concurrent", requestMaterial: "request" };
  const accepted = await Promise.all([registry.accept(input), registry.accept(input)]);
  assert.deepEqual(accepted.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal((await registry.get(input))?.state, "accepted");
});

test("FileRunRegistry preserves mutations from concurrent Gateway processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "registry.json");
  const barrier = join(root, "workers-ready");
  await mkdir(barrier);

  const children = ["run-process-a", "run-process-b"].map((runId) => spawn(
    process.execPath,
    [processWorkerPath.pathname, path, runId, barrier],
    { stdio: ["ignore", "pipe", "pipe"] },
  ));
  const output = children.map(() => "");
  const errors = children.map(() => "");
  children.forEach((child, index) => {
    child.stdout?.on("data", (chunk) => { output[index] += String(chunk); });
    child.stderr?.on("data", (chunk) => { errors[index] += String(chunk); });
  });

  try {
    for (const runId of ["run-process-a", "run-process-b"]) {
      await waitForPath(join(barrier, `${runId}.ready`));
    }
    const exits = await Promise.all(children.map(async (child) => {
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      return { code, signal };
    }));
    assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }], errors.join("\n"));
    assert.deepEqual(output.map((value) => value.trim()).sort(), ["run-process-a", "run-process-b"]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }

  const registry = new FileRunRegistry(path);
  for (const runId of ["run-process-a", "run-process-b"]) {
    const input = { projectKey: path, sessionKey: "session", runId };
    const record = await registry.get(input);
    assert.equal(record?.state, "completed");
    assert.equal(record?.lastSeq, 2);
    assert.deepEqual((await registry.events(input)).map((entry) => entry.seq), [1, 2]);
  }
});

test("FileRunRegistry marks non-terminal runs interrupted after Gateway restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "registry.json");
  const input = { projectKey: "project", sessionKey: "session", runId: "run-1", requestMaterial: "request" };
  const child = spawn(process.execPath, [restartWorkerPath.pathname, path], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => { stderr.push(String(chunk)); });
  const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(exitCode, 0, stderr.join("\n"));
  assert.equal(signal, null);
  const restarted = new FileRunRegistry(path);
  // A real new process fences the dead owner's active run. A second Gateway
  // object in the same process intentionally does not.
  assert.equal((await restarted.get(input))?.state, "interrupted");
});

test("FileRunRegistry does not fence a live owner process during a handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "registry.json");
  const readyPath = join(root, "owner.ready");
  const releasePath = join(root, "owner.release");
  const observerPath = join(root, "observer.json");
  const owner = spawn(process.execPath, [ownerWorkerPath.pathname, "hold", path, readyPath, releasePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const ownerErrors: string[] = [];
  owner.stderr?.on("data", (chunk) => { ownerErrors.push(String(chunk)); });

  try {
    await waitForPath(readyPath);
    const observer = spawn(process.execPath, [ownerWorkerPath.pathname, "observe", path, observerPath, releasePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const [observerExit] = await once(observer, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(observerExit, 0);
    assert.deepEqual(JSON.parse(await readFile(observerPath, "utf8")), { state: "running" });

    await writeFile(releasePath, "release", "utf8");
    const [ownerExit, ownerSignal] = await once(owner, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(ownerExit, 0, ownerErrors.join("\n"));
    assert.equal(ownerSignal, null);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
  }

  const restarted = new FileRunRegistry(path);
  assert.equal((await restarted.get({ projectKey: "project", sessionKey: "session", runId: "run-owner" }))?.state, "interrupted");
});

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for run registry process marker: ${path}`);
}

test("FileRunRegistry preserves aborted state when a late terminal event arrives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-abort-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  const input = { projectKey: "project", sessionKey: "session", runId: "run-aborted", requestMaterial: "request" };
  await registry.accept(input);
  await registry.append({
    ...input,
    event: { type: "turn_completed", runId: input.runId, usage: {}, finishReason: "aborted_streaming" },
  });

  await assert.rejects(
    () => registry.append({
      ...input,
      event: { type: "turn_completed", runId: input.runId, usage: {}, finishReason: "completed" },
    }),
    (error: unknown) => error instanceof RunRegistryError && error.code === "terminal",
  );
  assert.equal((await registry.get(input))?.state, "aborted");
  assert.deepEqual((await registry.events(input)).map((entry) => entry.seq), [1]);
});

test("Gateway replays an accepted run without executing it twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-gateway-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  let executions = 0;
  const session = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      executions += 1;
      const turnId = options.turnId ?? "run-1";
      yield { type: "input_accepted", sessionId: "sdk:registry", turnId, messages: [] } as const;
      yield {
        type: "turn_completed",
        sessionId: "sdk:registry",
        turnId,
        result: {
          type: "success",
          sessionId: "sdk:registry",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, { runRegistry: registry });
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const input = {
    sessionKey: "sdk:registry",
    channelKey: "test" as const,
    projectKey: root,
    message: "same request",
    runId: "run-1",
  };
  const first: unknown[] = [];
  for await (const event of gateway.submitTurn(input)) first.push(event);
  const second: unknown[] = [];
  for await (const event of gateway.submitTurn(input)) second.push(event);

  assert.equal(executions, 1);
  assert.deepEqual(second, first);
  const conflict: unknown[] = [];
  for await (const event of gateway.submitTurn({ ...input, message: "different request" })) conflict.push(event);
  assert.equal((conflict[0] as { type?: string; code?: string } | undefined)?.type, "error");
  assert.equal((conflict[0] as { type?: string; code?: string } | undefined)?.code, "conflict");
  const optionConflict: unknown[] = [];
  for await (const event of gateway.submitTurn({
    ...input,
    modelOverride: { mode: "model", provider: "test", model: "different-model" },
  })) optionConflict.push(event);
  assert.equal((optionConflict[0] as { type?: string; code?: string } | undefined)?.code, "conflict");
  const publicRecord = await gateway.runGet({ projectKey: root, sessionKey: input.sessionKey, runId: input.runId });
  assert.ok(publicRecord);
  assert.equal("requestMaterial" in publicRecord, false);
  assert.equal("ownerPid" in publicRecord, false);
});

test("Gateway records a terminal registry event when admission rejects an accepted run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  assert.equal(router.beginTurn("session:busy", "active-run"), true);
  const gateway = new InProcessGateway(router, { runRegistry: registry });
  t.after(() => {
    router.endTurn("session:busy", "active-run");
    gateway.dispose();
    router.shutdown();
  });

  const events: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session:busy",
    channelKey: "test",
    projectKey: root,
    message: "must be rejected",
    runId: "rejected-run",
  })) events.push(event);
  assert.equal(events.at(-1)?.type, "error");
  const record = await registry.get({ projectKey: root, sessionKey: "session:busy", runId: "rejected-run" });
  assert.equal(record?.state, "failed");
  assert.equal((await registry.events({ projectKey: root, sessionKey: "session:busy", runId: "rejected-run" })).at(-1)?.event.type, "error");
});

test("Gateway persists the task-budget terminal event after budget admission rejection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const gateway = new InProcessGateway(router, {
    runRegistry: registry,
    taskBudgetSnapshot: async () => ({ totalUsd: 1, spentUsd: 1 }),
  });
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const events: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session:budget",
    channelKey: "test",
    projectKey: root,
    message: "budget is exhausted",
    runId: "budget-run",
  })) events.push(event);

  assert.deepEqual(events.map((event) => event.type), ["error", "turn_completed"]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "turn_completed" ? terminal.finishReason : undefined, "task_budget");
  const record = await registry.get({ projectKey: root, sessionKey: "session:budget", runId: "budget-run" });
  assert.equal(record?.state, "completed");
  assert.equal((await registry.events({ projectKey: root, sessionKey: "session:budget", runId: "budget-run" })).at(-1)?.event.type, "turn_completed");
});

test("Gateway exposes a durable registry failure as result_unknown", async (t) => {
  let executions = 0;
  const session = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      executions += 1;
      const turnId = options.turnId ?? "run-failure";
      yield { type: "input_accepted", sessionId: "sdk:registry-failure", turnId, messages: [] } as const;
      yield {
        type: "turn_completed",
        sessionId: "sdk:registry-failure",
        turnId,
        result: {
          type: "success",
          sessionId: "sdk:registry-failure",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, {
    runRegistry: {
      async accept(input) {
        return {
          duplicate: false,
          record: {
            ...input,
            state: "accepted",
            revision: 1,
            lastSeq: 0,
            acceptedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        };
      },
      async append() { throw new Error("disk full"); },
      async get() { return undefined; },
      async events() { return []; },
      async markOrphansInterrupted() {},
    },
  });
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const events: Array<{ type?: string; code?: string }> = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:registry-failure",
    channelKey: "test",
    projectKey: "/tmp/project",
    message: "persist this",
    runId: "run-failure",
  })) events.push(event as { type?: string; code?: string });

  assert.equal(executions, 1);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.at(-1)?.code, "result_unknown");
});

test("Gateway reports an acceptance persistence failure as result_unknown", async (t) => {
  let executions = 0;
  const session = {
    async *submit() {
      executions += 1;
      yield { type: "turn_completed", runId: "run-accept-failure", usage: {}, finishReason: "completed" } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router, {
    runRegistry: {
      async accept() { throw new Error("disk full during acceptance"); },
      async append() {},
      async get() { return undefined; },
      async events() { return []; },
      async markOrphansInterrupted() {},
    },
  });
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const events: Array<{ type?: string; code?: string; recoverable?: boolean; userHint?: string }> = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:registry-accept-failure",
    channelKey: "test",
    projectKey: "/tmp/project",
    message: "do not execute",
    runId: "run-accept-failure",
  })) events.push(event as typeof events[number]);

  assert.equal(executions, 0);
  assert.deepEqual(events, [{
    type: "error",
    runId: "run-accept-failure",
    code: "result_unknown",
    message: "disk full during acceptance",
    recoverable: false,
    userHint: "Gateway acceptance could not be durably confirmed. Inspect the run state before retrying.",
  }]);
});

test("Gateway run observers can page the same durable event stream independently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-run-registry-observe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileRunRegistry(join(root, "registry.json"));
  const input = { projectKey: root, sessionKey: "session", runId: "run-observe", requestMaterial: "request" };
  await registry.accept(input);
  await registry.append({ ...input, event: { type: "input_accepted", runId: input.runId } });
  await registry.append({ ...input, event: { type: "assistant_text_delta", runId: input.runId, text: "partial" } });
  await registry.append({ ...input, event: { type: "turn_completed", runId: input.runId, usage: {}, finishReason: "completed" } });

  const gateway = new InProcessGateway(new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) }), { runRegistry: registry });
  t.after(() => gateway.dispose());
  const first = await gateway.runEvents({ projectKey: root, sessionKey: input.sessionKey, runId: input.runId, afterSeq: 0, limit: 2 });
  const second = await gateway.runEvents({ projectKey: root, sessionKey: input.sessionKey, runId: input.runId, afterSeq: first.nextSeq, limit: 2 });
  const observerTwo = await gateway.runEvents({ projectKey: root, sessionKey: input.sessionKey, runId: input.runId, afterSeq: 0, limit: 2 });
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(second.events.map((event) => event.seq), [3]);
  assert.deepEqual(observerTwo, first);
  assert.deepEqual(await gateway.runEvents({ ...input, afterSeq: 99 }), { events: [], nextSeq: 3, gap: true });
  await assert.rejects(() => gateway.runEvents({ ...input, limit: 0 }), { code: "INVALID_RUN_LIMIT" });
  await assert.rejects(() => gateway.runEvents({ ...input, limit: 501 }), { code: "INVALID_RUN_LIMIT" });
});
