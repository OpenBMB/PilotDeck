import test from "node:test";
import assert from "node:assert/strict";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { DynamicContextStore } from "../../src/context/dynamic/DynamicContextStore.js";
import { ArtifactContractStore } from "../../src/artifact/index.js";
import { LifecycleRuntime } from "../../src/lifecycle/runtime/LifecycleRuntime.js";
import type { HookRuntimeRunInput, HookRuntimeRunResult } from "../../src/extension/hooks/execution/HookRuntime.js";

test("lifecycle context is injected as a transient model-only message", async () => {
  const store = new DynamicContextStore();
  const hooks = {
    async run(_input: HookRuntimeRunInput): Promise<HookRuntimeRunResult> {
      return {
        effects: [{ type: "additional_context", source: "legal:test", content: "Review every exhibit." }],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    },
  };
  const lifecycle = new LifecycleRuntime(hooks as never, store);

  const dispatched = await lifecycle.dispatch({
    event: "UserPromptSubmit",
    baseInput: { sessionId: "session-1", transcriptPath: "", cwd: "/tmp" },
  });
  assert.deepEqual(dispatched.messages, []);
  assert.equal(store.hasPending("session-1"), true);

  const context = new DefaultContextRuntime({ dynamicContext: store });
  const prepared = await context.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/tmp",
    provider: "test",
    model: "model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Analyze the file." }] }],
    tools: [],
  });

  assert.equal(prepared.messages.length, 2);
  assert.deepEqual(prepared.messages.at(-1)?.metadata, {
    synthetic: true,
    transient: true,
    transientId: "dynamic-context:session-1:turn-1",
    purpose: "dynamic_context",
  });
  const injected = prepared.messages.at(-1)?.content[0];
  assert.match(injected?.type === "text" ? injected.text : "", /Review every exhibit/);
  assert.equal(store.hasPending("session-1"), true);
  context.commitPreparedContext({ sessionId: "session-1" });
  assert.equal(store.hasPending("session-1"), false);
  assert.equal(prepared.diagnostics.some((item) => item.code === "dynamic_context_injected"), true);
});

test("lifecycle without a dynamic store preserves legacy hook messages", async () => {
  const hooks = {
    async run(): Promise<HookRuntimeRunResult> {
      return {
        effects: [{ type: "additional_context", source: "legacy", content: "legacy context" }],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    },
  };
  const lifecycle = new LifecycleRuntime(hooks as never);
  const dispatched = await lifecycle.dispatch({
    event: "UserPromptSubmit",
    baseInput: { sessionId: "session-1", transcriptPath: "", cwd: "/tmp" },
  });
  assert.equal(dispatched.messages.length, 1);
});

test("SessionEnd clears session-scoped runtime state even when a hook throws", async () => {
  const dynamicContext = new DynamicContextStore();
  dynamicContext.register({ sessionId: "session-1", source: "hook", id: "pending", content: "stale" });
  const artifactContracts = new ArtifactContractStore();
  artifactContracts.register("session-1", "plugin", [{ id: "output", path: "output.txt" }]);
  const lifecycle = new LifecycleRuntime({
    async run() {
      throw new Error("hook crashed");
    },
  } as never, dynamicContext, artifactContracts);

  await assert.rejects(lifecycle.dispatch({
    event: "SessionEnd",
    baseInput: { sessionId: "session-1", transcriptPath: "", cwd: "/tmp" },
  }), /hook crashed/);

  assert.equal(dynamicContext.hasPending("session-1"), false);
  assert.deepEqual(artifactContracts.list("session-1"), []);
});
