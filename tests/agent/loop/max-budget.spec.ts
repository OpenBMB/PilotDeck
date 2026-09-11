import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent } from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

test("maxBudgetUsd stops after the charged model response before tool side effects or recovery", async () => {
  let modelRequests = 0;
  let toolExecutions = 0;
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      modelRequests += 1;
      yield { type: "request_started", provider: "test", model: "budget-model" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "write-1", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "write-1", name: "write_file", input: { file_path: "should-not-exist.txt", content: "nope" } },
      };
      yield { type: "usage", usage: { inputTokens: 1_000, outputTokens: 20 } };
      yield { type: "message_end", finishReason: "tool_call" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
    estimateUsageCost: () => 0.25,
  };
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "budget-model",
    cwd: "/workspace/project",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          toolExecutions += 1;
          return [];
        },
      },
    },
    context: {
      prepareForModel: async (input) => ({
        messages: input.messages,
        systemPrompt: undefined,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
      recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
      captureTurn: async () => undefined,
    },
  };
  const loop = new AgentLoop(config, dependencies);
  const events: any[] = [];
  for await (const event of loop.run({
    sessionId: "budget-session",
    turnId: "budget-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
    maxBudgetUsd: 0.1,
  })) {
    events.push(event);
  }

  assert.equal(modelRequests, 1);
  assert.equal(toolExecutions, 0);
  assert.equal(events.some((event) => event.type === "tool_calls_detected"), false);
  const failed = events.find((event) => event.type === "turn_failed");
  assert.equal(failed?.error.code, "agent_max_budget_reached");
  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.result.stopReason, "max_budget");
  assert.equal(completed?.result.usage.inputTokens, 1_000);
});
