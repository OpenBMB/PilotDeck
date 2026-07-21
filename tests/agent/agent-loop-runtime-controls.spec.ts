import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, type AgentLoopRunResult } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  ArtifactContractStore,
  ArtifactValidationRuntime,
  FileExistsValidator,
} from "../../src/artifact/index.js";
import type { AgentContextRuntime } from "../../src/context/ContextRuntime.js";
import { DefaultContextRuntime, DynamicContextStore } from "../../src/context/index.js";
import type { TokenBudgetSnapshot } from "../../src/context/index.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { RouterDecision } from "../../src/router/index.js";
import { ToolRegistry } from "../../src/tool/index.js";

test("PreModelRequest mutations survive a post-routing request rebuild and remain model-only", async () => {
  const requests: CanonicalModelRequest[] = [];
  let compactCalls = 0;
  let preModelCalls = 0;
  let observedBudget: unknown;
  const dynamicContext = new DynamicContextStore();
  dynamicContext.register({
    sessionId: "session-1",
    source: "goal-hook",
    id: "checkpoint",
    content: "goal checkpoint survives request rebuild",
    priority: "high",
  });
  const defaultContext = new DefaultContextRuntime({ dynamicContext });
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      compactCalls += 1;
      if (compactCalls === 1) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      return {
        type: "compacted",
        messages: input.messages,
        tier: "micro",
        snapshot: budgetSnapshot(5_000),
      };
    },
  };
  const dependencies = createDependencies(requests, {
    context,
    getModelTokenLimits: (_provider, model) => ({
      maxContextTokens: model === "routed-review-model" ? 5_000 : 10_000,
      maxOutputTokens: 2_048,
    }),
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        observedBudget = (input as { payload?: Record<string, unknown> }).payload?.contextBudget;
        return {
          ...emptyLifecycleResult(),
          messages: [{
            role: "user" as const,
            content: [{ type: "text" as const, text: "current budget checkpoint" }],
            metadata: { synthetic: true },
          }],
          effects: [
            { type: "system_message" as const, content: "runtime policy addendum" },
            {
              type: "model_request_patch" as const,
              patch: { model: "routed-review-model", maxOutputTokens: 9_999, metadata: { goalId: "goal-1" } },
            },
          ],
        };
      },
    } as never,
  });
  const loop = new AgentLoop(createConfig(process.cwd(), { maxContextTokens: 10_000 }), dependencies);

  const completed = await drainLoop(loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [userMessage("original request")],
  }));

  assert.equal(completed.result.type, "success");
  assert.equal(preModelCalls, 1);
  assert.equal(compactCalls, 2);
  assert.equal((observedBudget as TokenBudgetSnapshot | undefined)?.maxContextTokens, 10_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "routed-review-model");
  assert.equal(requests[0]?.maxOutputTokens, 2_048);
  assert.match(requests[0]?.systemPrompt ?? "", /^base system/u);
  assert.match(requests[0]?.systemPrompt ?? "", /runtime policy addendum$/u);
  assert.deepEqual(requests[0]?.metadata, { goalId: "goal-1" });
  assert.match(messageText(requests[0]?.messages ?? []), /current budget checkpoint/);
  assert.match(messageText(requests[0]?.messages ?? []), /goal checkpoint survives request rebuild/);
  assert.doesNotMatch(messageText(completed.messages), /current budget checkpoint/);
  assert.doesNotMatch(messageText(completed.messages), /goal checkpoint survives request rebuild/);
  assert.equal(dynamicContext.hasPending("session-1"), false);
});

test("artifact failure injects one bounded correction turn and succeeds after validation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-agent-loop-artifact-"));
  try {
    const contracts = new ArtifactContractStore();
    contracts.register("session-1", "domain-plugin", [{
      id: "final-workbook",
      path: "deliverable.xlsx",
      required: true,
      expectedExtensions: [".xlsx"],
      validatorIds: ["core:file-exists"],
    }]);
    const requests: CanonicalModelRequest[] = [];
    const dependencies = createDependencies(requests, {
      artifactValidation: new ArtifactValidationRuntime(contracts, [new FileExistsValidator()]),
      beforeResponse: async (requestIndex) => {
        if (requestIndex === 2) await writeFile(join(workspace, "deliverable.xlsx"), "verified workbook fixture");
      },
    });
    const loop = new AgentLoop(createConfig(workspace), dependencies);

    const completed = await drainLoop(loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [userMessage("create the required deliverable")],
    }));

    assert.equal(completed.result.type, "success");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(messageText(requests[0]?.messages ?? []), /Artifact validation failed/);
    assert.match(messageText(requests[1]?.messages ?? []), /Artifact validation failed/);
    assert.match(messageText(requests[1]?.messages ?? []), /deliverable\.xlsx/);
    assert.equal(completed.result.turns, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function createDependencies(
  requests: CanonicalModelRequest[],
  options: Partial<AgentRuntimeDependencies> & { beforeResponse?: (requestIndex: number) => Promise<void> } = {},
): AgentRuntimeDependencies {
  const registry = new ToolRegistry();
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      await options.beforeResponse?.(requests.length);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: `response ${requests.length}` };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  const { beforeResponse: _beforeResponse, ...dependencyOverrides } = options;
  return {
    router,
    tools: {
      registry,
      scheduler: { async executeAll() { return []; } },
    },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    uuid: (() => {
      let sequence = 0;
      return () => `id-${++sequence}`;
    })(),
    ...dependencyOverrides,
  } as AgentRuntimeDependencies;
}

function createConfig(cwd: string, overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    provider: "test-provider",
    model: "test-model",
    cwd,
    systemPrompt: "base system",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
    ...overrides,
  };
}

function emptyLifecycleResult() {
  return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function budgetSnapshot(maxContextTokens: number): TokenBudgetSnapshot {
  return {
    tokens: 10,
    maxContextTokens,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state: "ok",
    ratio: 0.001,
  };
}

async function drainLoop(iterator: AsyncGenerator<unknown, AgentLoopRunResult, unknown>): Promise<AgentLoopRunResult> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
  }
}
