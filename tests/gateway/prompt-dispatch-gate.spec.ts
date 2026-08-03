import test from "node:test";
import assert from "node:assert/strict";
import {
  PromptDispatchGate,
  type InternalTurnResult,
  type PromptDispatchHost,
} from "../../src/gateway/internal/PromptDispatchGate.js";

class FakeHost implements PromptDispatchHost {
  busy = false;
  runs: string[] = [];
  private idleResolvers: Array<() => void> = [];
  nextResults: InternalTurnResult[] = [];

  isSessionBusy(): boolean {
    return this.busy;
  }

  async waitForSessionIdle(_sessionKey: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      const cleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      this.idleResolvers.push(() => {
        cleanup();
        resolve();
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) timer = setTimeout(() => reject(new Error("timeout")), options.timeoutMs);
    });
  }

  async runInternalTurn(input: { prompt: string; runId: string }): Promise<InternalTurnResult> {
    this.runs.push(input.prompt);
    return this.nextResults.shift() ?? { status: "completed", runId: input.runId, finishReason: "completed" };
  }

  releaseIdle(): void {
    this.busy = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "session-1",
    prompt: "continue work",
    source: "goal",
    dedupeKey: "goal:continue:v1",
    ...overrides,
  };
}

test("defer returns immediately while a user turn is busy", async () => {
  const host = new FakeHost();
  host.busy = true;
  const gate = new PromptDispatchGate(host);
  assert.deepEqual(await gate.dispatch(request({ queueBehavior: "defer" })), { status: "deferred", reason: "busy" });
  assert.deepEqual(host.runs, []);
});

test("enqueue waits for idle and dispatches exactly once", async () => {
  const host = new FakeHost();
  host.busy = true;
  let sequence = 0;
  const gate = new PromptDispatchGate(host, { uuid: () => `id-${++sequence}` });
  const pending = gate.dispatch(request({ queueBehavior: "enqueue" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.runs, []);
  host.releaseIdle();
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.deepEqual(host.runs, ["continue work"]);
});

test("same semantic key coalesces in-flight and dedupes after completion", async () => {
  const host = new FakeHost();
  host.busy = true;
  let now = 100;
  let sequence = 0;
  const gate = new PromptDispatchGate(host, { now: () => now, uuid: () => `id-${++sequence}` });
  const first = gate.dispatch(request({ queueBehavior: "enqueue", recentDedupeMs: 500 }));
  const second = gate.dispatch(request({ queueBehavior: "enqueue", recentDedupeMs: 500 }));
  host.releaseIdle();
  assert.equal((await first).status, "completed");
  const secondResult = await second;
  assert.equal(secondResult.status, "completed");
  if (secondResult.status === "completed") assert.equal(secondResult.coalesced, true);
  assert.equal(host.runs.length, 1);

  const recent = await gate.dispatch(request({ recentDedupeMs: 500 }));
  assert.equal(recent.status, "deduped");
  now = 700;
  assert.equal((await gate.dispatch(request({ recentDedupeMs: 500 }))).status, "completed");
  assert.equal(host.runs.length, 2);
});

test("an idle-settle race retries when the gateway reports busy", async () => {
  const host = new FakeHost();
  host.nextResults.push({ status: "busy" });
  const gate = new PromptDispatchGate(host);
  const result = await gate.dispatch(request());
  assert.equal(result.status, "completed");
  assert.equal(host.runs.length, 2);
});

test("abort while queued does not run an internal turn", async () => {
  const host = new FakeHost();
  host.busy = true;
  const controller = new AbortController();
  const gate = new PromptDispatchGate(host);
  const pending = gate.dispatch(request({ queueBehavior: "enqueue", signal: controller.signal }));
  controller.abort("cancelled");
  const result = await pending;
  assert.deepEqual(result, { status: "aborted", phase: "waiting_idle" });
  assert.deepEqual(host.runs, []);
});

test("turn timeouts are reported distinctly from generic execution failures", async () => {
  const host = new FakeHost();
  host.nextResults.push({ status: "timed_out" });
  const gate = new PromptDispatchGate(host);

  assert.deepEqual(await gate.dispatch(request()), { status: "timed_out", phase: "running" });
});

test("a zero recent-dedupe window disables completed-result deduplication", async () => {
  const host = new FakeHost();
  const gate = new PromptDispatchGate(host);

  assert.equal((await gate.dispatch(request({ recentDedupeMs: 0 }))).status, "completed");
  assert.equal((await gate.dispatch(request({ recentDedupeMs: 0 }))).status, "completed");
  assert.equal(host.runs.length, 2);
});

test("dispose prevents a queued prompt from starting after shutdown", async () => {
  const host = new FakeHost();
  host.busy = true;
  const gate = new PromptDispatchGate(host);
  const pending = gate.dispatch(request());

  gate.dispose();
  host.releaseIdle();
  const result = await pending;

  assert.equal(result.status, "failed");
  assert.deepEqual(host.runs, []);
});
