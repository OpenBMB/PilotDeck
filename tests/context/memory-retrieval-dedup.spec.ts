import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { MemoryResolver, MemoryRetrieveResult } from "../../src/context/memory/MemoryResolver.js";
import type { ContextPrepareInput, ModelContext } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const message = (text: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text }] });

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "memory-session", turnId: "memory-turn", cwd: "/workspace",
    provider: "test", model: "test", permissionMode: "default",
    additionalWorkingDirectories: [], tools: [], messages: [message("hello")],
    customSystemPrompt: "system", ...overrides,
  };
}

function fixture(
  retrieve: MemoryResolver["retrieve"] = async () => ({ systemContext: "remembered", diagnostics: [] }),
  timeoutMs = 30_000,
) {
  let calls = 0;
  const resolver: MemoryResolver = {
    retrieve: (request) => { calls++; return retrieve(request); },
    async captureTurn() {},
  };
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, memoryRetrievalTimeoutMs: timeoutMs });
  return { runtime, resolver, calls: () => calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const memoryParts = (context: ModelContext) => context.systemPromptParts.filter((part) => part.includes("<memory-context>"));

test("preview and formal preparation reuse a completed memory result", async () => {
  const { runtime, calls } = fixture();
  const preview = await runtime.prepareForModel(input({ previewOnly: true }));
  const actual = await runtime.prepareForModel(input());
  assert.equal(calls(), 1);
  assert.deepEqual(memoryParts(preview), ["<memory-context>\nremembered\n</memory-context>"]);
  assert.deepEqual(memoryParts(actual), memoryParts(preview));
});

test("concurrent preparations share the pending memory task", async () => {
  const pending = deferred<MemoryRetrieveResult>();
  const { runtime, calls } = fixture(() => pending.promise);
  const controller = new AbortController();
  const request = input({ abortSignal: controller.signal });
  const preview = runtime.prepareForModel({ ...request, previewOnly: true });
  const actual = runtime.prepareForModel(request);
  await setImmediate();
  const pendingCalls = calls();
  pending.resolve({ systemContext: "shared pending result", diagnostics: [] });
  const contexts = await Promise.all([preview, actual]);
  assert.equal(pendingCalls, 1);
  assert.deepEqual(memoryParts(contexts[0]), memoryParts(contexts[1]));
  assert.match(memoryParts(contexts[0])[0], /shared pending result/);
});

test("a concurrent preparation joins the remaining timeout budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, calls } = fixture(() => new Promise(() => {}), 40);
  const preview = runtime.prepareForModel(input({ previewOnly: true }));
  await setImmediate();
  t.mock.timers.tick(20);
  let actualDone = false;
  const actual = runtime.prepareForModel(input()).then((result) => { actualDone = true; return result; });
  await setImmediate();
  t.mock.timers.tick(20);
  await setImmediate();
  assert.equal(actualDone, true, "the second preparation must not start a separate timeout");
  assert.deepEqual((await actual).diagnostics, (await preview).diagnostics);
  assert.equal(calls(), 1);
});

test("cancelling one signal does not cancel another preparation's pending query", async () => {
  const pending = deferred<MemoryRetrieveResult>();
  const { runtime, calls } = fixture(() => pending.promise);
  const controller = new AbortController();
  const cancelled = runtime.prepareForModel(input({ abortSignal: controller.signal }));
  const other = runtime.prepareForModel(input({ abortSignal: new AbortController().signal }));
  await setImmediate();
  controller.abort();
  assert.deepEqual(memoryParts(await cancelled), []);
  pending.resolve({ systemContext: "still relevant", diagnostics: [] });
  assert.match(memoryParts(await other)[0], /still relevant/);
  assert.equal(calls(), 2);
});

for (const outcome of ["empty", "error"] as const) {
  test(`${outcome} memory results are reused without retrying`, async () => {
    const { runtime, calls } = fixture(async () => {
      if (outcome === "error") throw new Error("unavailable");
      return { diagnostics: [] };
    });
    const preview = await runtime.prepareForModel(input({ previewOnly: true }));
    const actual = await runtime.prepareForModel(input());
    assert.equal(calls(), 1);
    assert.deepEqual(memoryParts(actual), []);
    assert.deepEqual(actual.diagnostics, preview.diagnostics);
    assert.equal(actual.diagnostics.some((item) => item.code === "memory_provider_error"), outcome === "error");
  });
}

for (const lateOutcome of ["success", "error"] as const) {
  test(`a timeout consumes one wait budget and ignores late ${lateOutcome}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred<MemoryRetrieveResult>();
    const { runtime, calls } = fixture(() => pending.promise, 40);
    let previewDone = false;
    const preview = runtime.prepareForModel(input({ previewOnly: true })).then((result) => {
      previewDone = true;
      return result;
    });
    await setImmediate();
    t.mock.timers.tick(39);
    await setImmediate();
    assert.equal(previewDone, false);
    t.mock.timers.tick(1);
    const timedOut = await preview;
    assert.match(timedOut.diagnostics[0]?.message ?? "", /timed out after 40ms/);

    let actualDone = false;
    const actual = runtime.prepareForModel(input()).then((result) => { actualDone = true; return result; });
    await setImmediate();
    assert.equal(actualDone, true, "formal preparation must finish without advancing the clock again");
    assert.equal(calls(), 1);
    assert.deepEqual((await actual).diagnostics, timedOut.diagnostics);

    if (lateOutcome === "success") pending.resolve({ systemContext: "too late", diagnostics: [] });
    else pending.reject(new Error("late failure"));
    await setImmediate();
    const afterLateResult = await runtime.prepareForModel(input());
    assert.deepEqual(memoryParts(afterLateResult), []);
    assert.deepEqual(afterLateResult.diagnostics, timedOut.diagnostics);
    assert.equal(calls(), 1);
  });
}

test("query identity includes session, turn, project, full messages, and signal identity", async () => {
  const { runtime, calls } = fixture();
  const first = input({ abortSignal: new AbortController().signal });
  await runtime.prepareForModel(first);
  const changes: Partial<ContextPrepareInput>[] = [
    { sessionId: "other-session" },
    { turnId: "other-turn" },
    { cwd: "/other-project" },
    { messages: [message("new query")] },
    { messages: [message("older context"), ...first.messages] },
    { messages: [{ ...first.messages[0], metadata: { purpose: "changed" } }] },
    { abortSignal: new AbortController().signal },
    { abortSignal: undefined },
  ];
  for (const [index, change] of changes.entries()) {
    const changed = { ...first, ...change };
    await runtime.prepareForModel(changed);
    await runtime.prepareForModel({ ...changed, previewOnly: true });
    assert.equal(calls(), index + 2, `changed fields: ${Object.keys(change).join(", ")}`);
  }
  await runtime.prepareForModel(first);
  assert.equal(calls(), changes.length + 1, "returning to an earlier input reuses its own result");
});

test("identity uses the resolved project root and projected messages", async () => {
  let calls = 0;
  const runtime = new DefaultContextRuntime({
    projectRoot: "/project",
    memoryResolver: {
      async retrieve(request) {
        calls++;
        assert.equal(request.projectRoot, "/project");
        assert.deepEqual(request.recentMessages, [message("hello")]);
        return { diagnostics: [] };
      },
      async captureTurn() {},
    },
  });
  await runtime.prepareForModel(input({ maxMessages: 1, messages: [message("discarded"), message("hello")] }));
  await runtime.prepareForModel(input({ cwd: "/project/subdirectory" }));
  assert.equal(calls, 1);
});

test("steering and compaction cause fresh queries even within the same turn", async () => {
  const { runtime, calls } = fixture();
  const original = input();
  const steered = { ...original, messages: [...original.messages, message("also add tests")] };
  const compacted = {
    ...original,
    messages: [
      message('<compact-boundary trigger="manual" />'),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }] },
      message("also add tests"),
    ],
  };
  for (const request of [original, steered, compacted]) {
    await runtime.prepareForModel({ ...request, previewOnly: true });
    await runtime.prepareForModel(request);
  }
  assert.equal(calls(), 3);
});

test("missing or blank turn and session identifiers retain uncached behavior", async () => {
  for (const field of ["sessionId", "turnId"] as const) {
    for (const value of [undefined, "", "  "]) {
      const { runtime, calls } = fixture();
      const request = input({ [field]: value });
      await runtime.prepareForModel(request);
      await runtime.prepareForModel(request);
      assert.equal(calls(), 2, `${field}=${String(value)}`);
    }
  }
});

test("aborted preparations do not attach an earlier successful result", async () => {
  const { runtime, calls } = fixture();
  const controller = new AbortController();
  const request = input({ abortSignal: controller.signal });
  await runtime.prepareForModel(request);
  controller.abort();
  const aborted = await runtime.prepareForModel(request);
  assert.deepEqual(memoryParts(aborted), []);
  assert.equal(calls(), 1);
});

test("only memory is reused while prompts, tools, and artifact status update", async () => {
  const { resolver, calls } = fixture();
  let artifact = "artifact pending";
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, sessionArtifactContext: async () => artifact });
  const preview = await runtime.prepareForModel(input({ previewOnly: true }));
  artifact = "artifact ready";
  const tools = [{ name: "read_file", description: "read", inputSchema: { type: "object" } }];
  const actual = await runtime.prepareForModel(input({ customSystemPrompt: "new system", tools }));
  assert.equal(calls(), 1);
  assert.deepEqual(memoryParts(actual), memoryParts(preview));
  assert.match(actual.systemPrompt ?? "", /new system/);
  assert.deepEqual(actual.tools, tools);
  assert.deepEqual(preview.messages.at(-1)?.content, [{ type: "text", text: "artifact pending" }]);
  assert.deepEqual(actual.messages.at(-1)?.content, [{ type: "text", text: "artifact ready" }]);
});

test("releaseTurn is idempotent and only releases the specified session and turn", async () => {
  const { runtime, calls } = fixture();
  const requests = [input(), input({ turnId: "other-turn" }), input({ sessionId: "other-session" })];
  for (const request of requests) await runtime.prepareForModel(request);
  runtime.releaseTurn(requests[0]);
  runtime.releaseTurn(requests[0]);
  for (const request of requests) await runtime.prepareForModel(request);
  assert.equal(calls(), 4);
});

test("releasing a pending task prevents its late completion from repopulating the turn", async () => {
  const pending = deferred<MemoryRetrieveResult>();
  const { runtime, calls } = fixture(() => pending.promise);
  const first = runtime.prepareForModel(input());
  await setImmediate();
  runtime.releaseTurn(input());
  const second = runtime.prepareForModel(input());
  await setImmediate();
  pending.resolve({ diagnostics: [] });
  await Promise.all([first, second]);
  await runtime.prepareForModel(input());
  assert.equal(calls(), 2);
});

test("release during asynchronous request assembly cannot recreate the released turn", async () => {
  const pending = deferred<void>();
  const { resolver, calls } = fixture();
  const runtime = new DefaultContextRuntime({
    memoryResolver: resolver,
    sessionArtifactContext: async () => { await pending.promise; return undefined; },
  });
  const preparing = runtime.prepareForModel(input());
  await setImmediate();
  runtime.releaseTurn(input());
  pending.resolve();
  await preparing;
  await runtime.prepareForModel(input());
  assert.equal(calls(), 2, "a preparation that outlives release must not populate the next turn's cache");
});

for (const capture of ["success", "failure", "skipped"] as const) {
  test(`captureTurn releases memory when capture is ${capture}`, async () => {
    const { runtime, resolver, calls } = fixture();
    let captures = 0;
    resolver.captureTurn = async () => { captures++; if (capture === "failure") throw new Error("capture failed"); };
    const request = input({ sessionId: capture === "skipped" ? "always-on/discovery:test" : "memory-session" });
    await runtime.prepareForModel(request);
    await runtime.captureTurn({ ...request, errored: false });
    await runtime.prepareForModel(request);
    assert.equal(calls(), 2);
    assert.equal(captures, capture === "skipped" ? 0 : 1);
  });
}

test("captureTurn remains non-fatal if a custom release hook throws", async (t) => {
  const { runtime } = fixture();
  t.mock.method(runtime, "releaseTurn", () => { throw new Error("cleanup failed"); });
  await assert.doesNotReject(runtime.captureTurn({ ...input(), errored: false }));
});
