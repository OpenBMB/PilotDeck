import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { canonicalMessagesToMemoryMessages } from "../../../src/context/memory/MemoryResolver.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { isRealUserRequestMessage } from "../../../src/model/protocol/userRequest.js";
import { buildAnthropicRequest } from "../../../src/model/providers/anthropic/request.js";
import type { CanonicalMessage, ModelDefinition, ModelProtocol } from "../../../src/model/index.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createPlanTodoStateManager } from "../../../src/agent/runtime/PlanTodoState.js";
import { prepareModelRequest, prepareModelRequestAttempt } from "../../../src/agent/loop/prepareModelRequest.js";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";

const message = (text: string, role: "user" | "assistant" = "user"): CanonicalMessage => ({ role, content: [{ type: "text", text }] });
const history = Array.from({ length: 7 }, (_, i) => message(`Synthetic history ${i}`, i % 2 ? "assistant" : "user"));
const model: ModelDefinition = { id: "fixture-model", multimodal: { input: ["text"] }, capabilities: {
  supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false, supportsThinking: false,
  supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: true, maxContextTokens: 100_000, maxOutputTokens: 100,
} };

function fixture(protocol: ModelProtocol = "anthropic", systemPrompt?: string) {
  const planTodoManager = createPlanTodoStateManager();
  const todo = planTodoManager.forSession("cache-prefix");
  todo.markPlanApproved("Inspect synthetic files");
  const config = { provider: "fixture", model: model.id, cwd: "/synthetic", permissionMode: "default" as "default" | "plan",
    systemPrompt, permissionContext: createDefaultPermissionContext({ cwd: "/synthetic", canPrompt: false }) };
  const dependencies = { toolRegistry: new ToolRegistry(),
    context: new DefaultContextRuntime({ now: () => new Date("2026-11-01T00:00:00Z"),
      sessionArtifactContext: async () => "Synthetic video status",
      memoryResolver: { async retrieve() { return { systemContext: "Synthetic memory", diagnostics: [] }; }, async captureTurn() {} },
    }),
    getModelProtocol: () => protocol, getModelSupportsPromptCache: () => true,
    getTodoReminder: () => todo.buildPromptAddendum(),
  };
  const input = { sessionId: "cache-prefix", turnId: "turn", messages: structuredClone(history) };
  return { config, dependencies, input, todo, planTodoManager };
}

for (const protocol of ["anthropic", "openai", "openai-responses", "google"] as const) {
  for (const custom of [false, true]) {
    test(`Todo progress preserves system and real history (${protocol}, custom: ${custom})`, async () => {
      const f = fixture(protocol, custom ? "Custom application policy" : undefined);
      f.todo.writeTodos([{ id: "inspect", content: "Inspect files", status: "in_progress" }]);
      for (let i = 0; i < 10; i++) f.todo.markToolProgressChanged("read_file");
      const before = structuredClone(f.input.messages);
      const first = await prepareModelRequest(f.config, f.dependencies, f.input);
      f.todo.markToolProgressChanged("read_file");
      const next = await prepareModelRequest(f.config, f.dependencies, f.input);
      assert.equal(first.systemPrompt, next.systemPrompt);
      assert.doesNotMatch(next.systemPrompt ?? "", /tool calls since last update/);
      const reminder = next.messages.find(entry => entry.metadata?.purpose === "todo_reminder");
      assert.ok(reminder);
      assert.match(JSON.stringify(reminder), /11 tool calls/);
      assert.match(JSON.stringify(first.messages.at(-1)), /10 tool calls/);
      assert.equal(isRealUserRequestMessage(reminder), false);
      assert.deepEqual(canonicalMessagesToMemoryMessages([reminder]), []);
      assert.deepEqual(next.messages.slice(0, before.length), before);
      assert.deepEqual(f.input.messages, before);
      assert.equal(!!next.cachePlan, protocol === "anthropic");
    });
  }
}

test("Todo initialization keeps its enforcement and clears the request reminder after initialization", async () => {
  const f = fixture();
  const first = await prepareModelRequest(f.config, f.dependencies, f.input);
  assert.match(JSON.stringify(first.messages.at(-1)), /MUST call.*todo_write/);
  assert.ok(f.todo.blockingMessageFor("write_file", false));
  f.todo.writeTodos([{ content: "Inspect files", status: "in_progress" }]);
  const next = await prepareModelRequest(f.config, f.dependencies, f.input);
  assert.equal(first.systemPrompt, next.systemPrompt);
  assert.equal(next.messages.some(entry => entry.metadata?.purpose === "todo_reminder"), false);
  assert.equal(f.todo.blockingMessageFor("write_file", false), undefined);
});

test("route projections share one captured Todo reminder per staged request attempt", async () => {
  const f = fixture();
  let reminder = "Original reminder";
  f.dependencies.getTodoReminder = () => reminder;
  const attempt = await prepareModelRequestAttempt(f.config, f.dependencies, f.input);
  reminder = "Changed after preparation";
  const first = await attempt.project();
  const routed = await attempt.project({ provider: "fallback", model: "other-model" });
  assert.match(JSON.stringify(first.request.messages.at(-1)), /Original reminder/);
  assert.deepEqual(routed.request.messages, first.request.messages);
  assert.deepEqual(f.input.messages, history);
});

test("Anthropic keeps a history cache write before video, memory, Todo and plan reminders", async () => {
  const f = fixture();
  f.config.permissionMode = "plan";
  const first = await prepareModelRequest(f.config, f.dependencies, f.input);
  const body = buildAnthropicRequest(first, model);
  const marked = body.messages.flatMap((entry, index) => entry.content.some(block =>
    typeof block === "object" && block !== null && "cache_control" in block) ? [index] : []);
  assert.ok(marked.includes(history.length - 1), "the durable history must have its own cache write");
  assert.ok(marked.length <= 3);
  assert.equal(first.messages.at(-1)?.metadata?.purpose, "plan_mode_reminder");
  const next = await prepareModelRequest(f.config, f.dependencies, { ...f.input,
    messages: [...f.input.messages, message("Synthetic answer", "assistant"), message("Continue")],
  });
  assert.deepEqual(next.messages.slice(0, history.length), first.messages.slice(0, history.length));
  assert.equal(next.systemPrompt, first.systemPrompt);
});

test("AgentLoop sends changing Todo reminders after history without changing system instructions", async () => {
  const f = fixture();
  f.todo.writeTodos([{ content: "Inspect files", status: "in_progress" }]);
  for (let i = 0; i < 10; i++) f.todo.markToolProgressChanged("read_file");
  const sent: CanonicalModelRequest[] = [];
  const dependencies: AgentRuntimeDependencies = { context: f.dependencies.context,
    planTodoManager: f.planTodoManager, getModelProtocol: () => "anthropic", getModelSupportsPromptCache: () => true,
    tools: { registry: f.dependencies.toolRegistry, scheduler: { async executeAll() { return []; } } },
    router: {
      async decide() { return { provider: "fixture", model: model.id, scenarioType: "default", isSubagent: false,
        orchestrating: false, resolvedFrom: "scenario", mutations: {} }; },
      async *execute(_decision, request) {
        sent.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "Synthetic reply" };
        yield { type: "message_end", finishReason: "stop" };
      },
      async *stream() {},
    },
  };
  const loop = new AgentLoop(f.config, dependencies);
  for await (const _event of loop.run(f.input)) { /* Drain the real loop. */ }
  f.todo.markToolProgressChanged("read_file");
  for await (const _event of loop.run({ ...f.input, turnId: "next-turn" })) { /* Drain the real loop. */ }
  assert.equal(sent.length, 2);
  assert.equal(sent[0].systemPrompt, sent[1].systemPrompt);
  assert.match(JSON.stringify(sent[0].messages.at(-1)), /10 tool calls/);
  assert.match(JSON.stringify(sent[1].messages.at(-1)), /11 tool calls/);
});
