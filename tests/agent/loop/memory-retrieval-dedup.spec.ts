import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../../src/context/compaction/AutoCompactionPolicy.js";
import type { ContextPrepareInput } from "../../../src/context/protocol/types.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function fixture() {
  let calls = 0;
  let artifact = "artifact pending";
  const budget = new TokenBudgetManager();
  const context = new DefaultContextRuntime({
    tokenBudget: budget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: budget }),
    sessionArtifactContext: async () => artifact,
    memoryResolver: {
      async retrieve() { calls++; return { systemContext: "shared memory", diagnostics: [] }; },
      async captureTurn() {},
    },
  });
  const previews: CanonicalModelRequest[] = [];
  const requests: CanonicalModelRequest[] = [];
  const config: AgentRuntimeConfig = {
    provider: "test", model: "test", cwd: "/workspace", systemPrompt: "system",
    maxContextTokens: 16_384, maxOutputTokens: 1_024, permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "default", canPrompt: false }),
  };
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({
      provider: request.provider, model: request.model, scenarioType: "default",
      isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {},
    }),
    execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* () {},
  };
  const loop = new AgentLoop(config, {
    context, router,
    tools: { registry: new ToolRegistry(), scheduler: { async executeAll() { return []; } } },
    tokenAccounting: {
      async evaluateRequestBudget(request: CanonicalModelRequest, options: { maxContextTokens: number }) {
        previews.push(request);
        artifact = "artifact ready";
        return budget.snapshotFromTokens(100, options.maxContextTokens);
      },
    } as AgentRuntimeDependencies["tokenAccounting"],
  });
  const controller = new AbortController();
  const input: AgentLoopInput = {
    sessionId: "memory-session", turnId: "memory-turn", abortSignal: controller.signal,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const prepare = (): Promise<unknown> => context.prepareForModel({
    ...input, cwd: config.cwd, provider: config.provider, model: config.model,
    permissionMode: "default", additionalWorkingDirectories: [], tools: [],
  } as ContextPrepareInput);
  return { loop, context, router, input, controller, prepare, previews, requests, calls: () => calls };
}

async function drain(loop: AgentLoop, input: AgentLoopInput) {
  const generator = loop.run(input);
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

test("real preflight and formal requests share memory while artifact status stays current", async () => {
  const f = fixture();
  const result = await drain(f.loop, f.input);
  assert.equal(result.result.type, "success");
  assert.equal(f.previews.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls(), 1);
  assert.match(f.previews[0].systemPrompt ?? "", /<memory-context>\nshared memory\n<\/memory-context>/);
  assert.equal(f.previews[0].systemPrompt, f.requests[0].systemPrompt);
  assert.deepEqual(f.previews[0].messages.at(-1)?.content, [{ type: "text", text: "artifact pending" }]);
  assert.deepEqual(f.requests[0].messages.at(-1)?.content, [{ type: "text", text: "artifact ready" }]);
  await f.prepare();
  assert.equal(f.calls(), 2, "finishing a turn releases its remembered result");
});

for (const outcome of ["success", "failure", "abort", "early return", "throw"] as const) {
  test(`outer run cleanup releases memory on ${outcome} without relying on captureTurn`, async (t) => {
    const f = fixture();
    // Capture is advisory; release must still work for implementations that skip it.
    t.mock.method(f.context, "captureTurn", async () => {});
    const release = t.mock.method(f.context, "releaseTurn");
    const originalError = new Error("original failure");
    if (outcome === "failure" || outcome === "abort") {
      f.router.execute = async function* () {
        if (outcome === "abort") f.controller.abort();
        throw originalError;
      };
    } else if (outcome === "throw") {
      f.router.decide = async () => { throw originalError; };
    }

    if (outcome === "early return") {
      for await (const event of f.loop.run(f.input)) {
        if (event.type === "model_request_started") break;
      }
    } else if (outcome === "throw") {
      await assert.rejects(drain(f.loop, f.input), (error) => error === originalError);
    } else {
      const result = await drain(f.loop, f.input);
      assert.equal(result.result.type, outcome === "failure" ? "error" : outcome === "abort" ? "aborted" : "success");
    }
    assert.equal(release.mock.callCount(), 1);
    assert.deepEqual(release.mock.calls[0].arguments, [{ sessionId: f.input.sessionId, turnId: f.input.turnId }]);
    assert.equal(f.calls(), 1);
    if (outcome !== "abort") {
      await f.prepare();
      assert.equal(f.calls(), 2);
    }
  });
}

for (const outcome of ["success", "throw"] as const) {
  test(`a throwing release hook does not replace the original ${outcome}`, async (t) => {
    const f = fixture();
    t.mock.method(f.context, "captureTurn", async () => {});
    const release = t.mock.method(f.context, "releaseTurn", () => { throw new Error("cleanup failed"); });
    const originalError = new Error("original failure");
    if (outcome === "throw") {
      f.router.decide = async () => { throw originalError; };
      await assert.rejects(drain(f.loop, f.input), (error) => error === originalError);
    } else {
      assert.equal((await drain(f.loop, f.input)).result.type, "success");
    }
    assert.equal(release.mock.callCount(), 1);
  });
}
