import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLoop,
  createAgentEventBuffer,
  type AgentEvent,
  type AgentLoopRunResult,
} from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import type { RouterDecision } from "../../src/router/index.js";
import {
  ConcurrentToolScheduler,
  createAgentTool,
  ToolRegistry,
  ToolRuntime,
} from "../../src/tool/index.js";

test("fork timeout closes child lifecycle and lets the parent finish", async () => {
  const parentRequests: CanonicalModelRequest[] = [];
  const childRequests: CanonicalModelRequest[] = [];
  const eventBuffer = createAgentEventBuffer();
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      const isSubagent = typeof input.request.metadata?.subagentId === "string";
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default",
        isSubagent,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      };
    },
    async *execute(
      decision: RouterDecision,
      request: CanonicalModelRequest,
      context: { abortSignal?: AbortSignal },
    ): AsyncIterable<CanonicalModelEvent> {
      if (decision.isSubagent) {
        childRequests.push(request);
        await waitForAbort(context.abortSignal);
        throw context.abortSignal?.reason ?? new Error("expected child abort");
      }

      parentRequests.push(request);
      yield { type: "message_start", role: "assistant" };
      if (parentRequests.length === 1) {
        const toolCall = {
          id: "run-bounded-child",
          name: "agent",
          input: {
            description: "bounded research",
            prompt: "Investigate the unavailable source and report what is known.",
            subagent_type: "general-purpose",
          },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "Parent completed from bounded partial evidence." };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };

  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  const toolRuntime = new ToolRuntime(registry, new PermissionRuntime(), undefined, eventBuffer.emitter);
  const dependencies: AgentRuntimeDependencies = {
    router: router as AgentRuntimeDependencies["router"],
    tools: {
      registry,
      scheduler: new ConcurrentToolScheduler(toolRuntime, registry),
    },
    eventEmitter: eventBuffer.emitter,
    drainEvents: eventBuffer.drain,
  };
  const config: AgentRuntimeConfig = {
    provider: "test-provider",
    model: "test-model",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    subagentTimeoutMs: 20,
  };
  const loop = new AgentLoop(config, dependencies);

  const events: AgentEvent[] = [];
  const result = await drain(loop.run({
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "Complete the parent task." }] }],
    maxTurns: 3,
  }), events);

  assert.equal(result.result.type, "success");
  assert.equal(parentRequests.length, 2);
  assert.equal(childRequests.length, 1);
  assert.match(requestText(childRequests[0]), /Hard wall-clock budget: 1 seconds\./u);

  const childCompleted = events.find(
    (event): event is Extract<AgentEvent, { type: "subagent_completed" }> =>
      event.type === "subagent_completed",
  );
  assert.ok(childCompleted);
  assert.equal(childCompleted.success, false);

  const agentResult = events.find(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.result.toolName === "agent",
  );
  assert.ok(agentResult);
  assert.equal(agentResult.result.type, "error");
  if (agentResult.result.type === "error") {
    assert.equal(agentResult.result.error.details?.errorCode, "subagent_timeout");
    assert.equal(agentResult.result.error.details?.timeoutMs, 20);
  }
});

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("expected child abort signal");
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function drain(
  iterator: AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown>,
  events: AgentEvent[],
): Promise<AgentLoopRunResult> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    events.push(next.value);
  }
}

function requestText(request: CanonicalModelRequest | undefined): string {
  return (request?.messages ?? []).flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n");
}
