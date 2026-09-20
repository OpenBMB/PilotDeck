import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  createAgentLoopSidecarRuntimeFactory,
  createSidecarModuleComposition,
  createSidecarDefaultModuleDispatcher,
  createStdioAgentLoopSidecarConnectionFactory,
  SessionAgentLoopOperationLedger,
} from "../../../src/agent/index.js";
import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createAgentSession } from "../../../src/agent/session/createAgentSession.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import type { AgentLoopSeedState } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { HostToolCheckpoint } from "../../../src/agent/modules/checkpoint/hostToolCheckpoint.js";
import type { OneShotSubagentPort } from "../../../src/agent/sub/OneShotSubagentPort.js";
import type { ModelInvokerPort, ToolPort } from "../../../src/agent/modules/protocol.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import { createPlanTodoSnapshot } from "../../../src/plan-todo/projection/PlanTodoProjection.js";
import { emptyLifecycleDispatchResult, LifecycleRuntime, type LifecycleDispatchInput } from "../../../src/lifecycle/index.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import {
  createWebFetchTool,
  ToolRegistry,
  ToolRuntime,
  type PilotDeckPlanTodoStateHandle,
  type PilotDeckToolDefinition,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

test("capability-only sidecar factory completes a durable host tool turn and restores terminal seed state", async () => {
  let modelCalls = 0;
  const durableCalls: string[] = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "tool-1", name: "lookup", input: { query: "status" } } };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "text_delta", text: "remote complete" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "lookup",
      description: "lookup state",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
    }],
    async executeAll(calls, _context, execution) {
      durableCalls.push(`${execution.runId}:${calls[0]?.id}`);
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "host value" }],
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.001Z",
      }));
    },
  };
  const initialSeed: AgentLoopSeedState = {
    allowedReadFiles: ["/workspace/input.txt"],
    readFileState: new Map([["/workspace/input.txt", { mtimeMs: 1, kind: "text" }]]),
  };
  const sidecarFactory = createAgentLoopSidecarRuntimeFactory({
    connect: () => loopbackConnection(),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "remote-session",
    config: config(),
    seedState: initialSeed,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: sidecarFactory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "inspect remote state" }, {
    turnId: "remote-turn",
  })) events.push(event);

  assert.equal(durableCalls.length, 1);
  assert.match(durableCalls[0] ?? "", /^run-[0-9]+:tool-1$/);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
  const messages = session.snapshot().messages;
  const assistantTool = messages.find((message) => message.content.some((block) => block.type === "tool_call"));
  const toolResult = messages.find((message) => message.content.some((block) => block.type === "tool_result"));
  const assistantText = [...messages].reverse().find((message) => message.role === "assistant"
    && message.content.some((block) => block.type === "text"));
  assert.ok(assistantTool?.content.every((block) => block.timeline?.version === 1));
  assert.ok(toolResult?.content.every((block) => block.timeline?.version === 1));
  assert.ok(assistantText?.content.every((block) => block.timeline?.version === 1));
  const restoredFileState = session.snapshotForRuntimeReload().fileState;
  assert.ok(restoredFileState);
  assert.deepEqual(restoredFileState.allowedReadFiles, ["/workspace/input.txt"]);
  assert.equal(restoredFileState.readFileState?.get("/workspace/input.txt")?.kind, "text");
});

test("production sidecar receives the first model delta before the provider finishes", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let signalProviderDelta!: () => void;
  const providerDelta = new Promise<void>((resolve) => { signalProviderDelta = resolve; });
  let providerFinished = false;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      signalProviderDelta();
      yield { type: "text_delta", text: "first" };
      await providerGate;
      providerFinished = true;
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "streaming-sidecar-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });
  const iterator = session.submit({ type: "text", text: "stream now" }, {
    turnId: "streaming-sidecar-turn",
  })[Symbol.asyncIterator]();
  const firstDelta = (async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done) return false;
      if (next.value.type === "model_event" && next.value.event.type === "text_delta") return true;
    }
  })();

  await providerDelta;
  assert.equal(await Promise.race([
    firstDelta,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]), true);
  assert.equal(providerFinished, false);
  releaseProvider();
  while (!(await iterator.next()).done) {
    // Drain the remaining terminal events.
  }
});

test("production sidecar closes the host provider iterator when its consumer stops early", async () => {
  let providerClosed = false;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      try {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "partial" };
        await new Promise(() => {});
      } finally {
        providerClosed = true;
      }
    },
  };
  const session = createAgentSession({
    sessionId: "closing-sidecar-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });
  const iterator = session.submit({ type: "text", text: "stop after one delta" }, {
    turnId: "closing-sidecar-turn",
  })[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value?.type === "model_event" && next.value.event.type === "text_delta") break;
  }

  await iterator.return?.(undefined as never);
  assert.equal(providerClosed, true);
});

test("production sidecar budget module stops before host tool side effects and persists one status", async () => {
  let toolExecutions = 0;
  const transcript = new InMemoryTranscriptWriter();
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "request_started", provider: "host-provider", model: "host-model" } as const;
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "tool_call_end", toolCall: { id: "write-1", name: "write", input: {} } } as const;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } as const;
      yield { type: "message_end", finishReason: "tool_call" } as const;
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "write",
      description: "write",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => ({ content: [] }),
    }],
    async executeAll() {
      toolExecutions += 1;
      return [];
    },
  };
  const session = createAgentSession({
    sessionId: "sidecar-budget-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: {
        model,
        tools,
        budget: {
          estimateRequestInput: () => 10,
          estimateUsageCost: async () => 1,
        },
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "write" }, {
    turnId: "sidecar-budget-turn",
    maxBudgetUsd: 0.5,
  })) events.push(event);

  assert.equal(toolExecutions, 0);
  assert.equal(events.find((event) => event.type === "turn_failed")?.type, "turn_failed");
  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.type === "turn_completed" && completed.result.stopReason, "max_budget");
  const statuses = transcript.entries.filter((entry) => entry.type === "agent_status_message");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.type === "agent_status_message" && statuses[0].event, "max_budget_reached");
});

test("production sidecar does not acknowledge a status event when durable persistence fails", async () => {
  const transcript = new InMemoryTranscriptWriter();
  transcript.recordAgentStatusMessage = async () => {
    throw new Error("status persistence failed");
  };
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "request_started", provider: "host-provider", model: "host-model" } as const;
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const session = createAgentSession({
    sessionId: "sidecar-status-failure-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: {
        model,
        tools: noopTools(),
        budget: { estimateUsageCost: async () => 1 },
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "persist status" }, {
      turnId: "sidecar-status-failure-turn",
      maxBudgetUsd: 0.5,
  })) events.push(event);

  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.type === "turn_completed" && completed.result.type, "error");
  assert.equal(events.some((event) => event.type === "turn_completed" && event.result.type === "success"), false);
});

test("production sidecar turn module drains and acknowledges live steer exactly once", async () => {
  const transcript = new InMemoryTranscriptWriter();
  let modelRequests = 0;
  let session: ReturnType<typeof createAgentSession>;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      modelRequests += 1;
      if (modelRequests === 1) {
        assert.deepEqual(await session.steer({
          turnId: "sidecar-steer-turn",
          itemId: "steer-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "revise through the host mailbox" }],
            metadata: { purpose: "mid_turn_steer", queueItemId: "steer-1" },
          },
        }), { accepted: true });
      }
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "text_delta", text: modelRequests === 1 ? "first" : "revised" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  session = createAgentSession({
    sessionId: "sidecar-steer-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "draft" }, {
    turnId: "sidecar-steer-turn",
  })) events.push(event);

  assert.equal(modelRequests, 2);
  assert.equal(events.filter((event) => event.type === "steer_applied").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_continued").length, 1);
  const durableSteers = transcript.entries.filter((entry) =>
    entry.type === "durable_message" && entry.message.metadata?.queueItemId === "steer-1");
  assert.equal(durableSteers.length, 1);
});

test("production sidecar persists compaction before the compacted model request", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const observedMessages: string[][] = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      observedMessages.push(request.messages.flatMap((message) => message.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [])));
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "text_delta", text: "done" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const compactedMessages = [{
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "durable compact summary" }],
  }];
  const session = createAgentSession({
    sessionId: "sidecar-compaction-session",
    config: { ...config(), maxContextTokens: 1_000 },
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      context: {
        prepareForModel: async (input) => ({
          messages: input.messages,
          systemPromptParts: [],
          tools: input.tools,
          diagnostics: [],
          boundaries: [],
        }),
        tryAutoCompact: async () => ({
          type: "compacted" as const,
          tier: "full" as const,
          messages: compactedMessages,
          snapshot: {
            tokens: 20,
            maxContextTokens: 1_000,
            warningRatio: 0.8,
            blockingRatio: 0.9,
            state: "ok" as const,
            ratio: 0.02,
          },
          result: {
            compactionId: "compact-sidecar-1",
            trigger: "auto" as const,
            preTokens: 800,
            postTokens: 20,
            messagesSummarized: 1,
            boundaryMarker: { role: "assistant" as const, content: [{ type: "text" as const, text: "boundary" }] },
            messagesToKeep: [],
            attachments: [],
            hookResults: [],
            diagnostics: [],
          },
        }),
      },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "compact this" }, {
    turnId: "sidecar-compaction-turn",
  })) events.push(event);

  assert.ok(observedMessages[0]?.includes("durable compact summary"));
  assert.equal(events.some((event) => event.type === "turn_failed"), false);
  assert.equal(transcript.entries.filter((entry) => entry.type === "control_boundary").length, 1);
  assert.equal(transcript.entries.filter((entry) => entry.type === "compaction_completed").length, 1);
});

test("production sidecar advertises elicitation availability without serializing the channel", async () => {
  const exposedTools: string[][] = [];
  const executePayloads: Array<Record<string, unknown>> = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      exposedTools.push((request.tools ?? []).map((tool) => tool.name));
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "text_delta", text: "done" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const askTool = {
    name: "ask_user_question",
    description: "ask",
    kind: "custom" as const,
    inputSchema: { type: "object" as const },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    requiresUserInteraction: () => true,
    execute: async () => ({ content: [] }),
  };
  const tools: ToolPort = { list: () => [askTool], executeAll: async () => [] };
  const connectionFactory = () => {
    const connection = loopbackConnection();
    return {
      ...connection,
      send(message: unknown) {
        const request = message as Record<string, unknown>;
        if (request.method === "execute") executePayloads.push(structuredClone(request.payload as Record<string, unknown>));
        return connection.send(message);
      },
    };
  };
  const session = createAgentSession({
    sessionId: "sidecar-elicitation-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      elicitation: { async askUser() { return { type: "cancelled" as const }; } },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: connectionFactory,
      uuid: deterministicIds(),
    }),
  });

  for await (const _event of session.submit({ type: "text", text: "ask if needed" }, {
    turnId: "sidecar-elicitation-turn",
    canPrompt: false,
    canElicit: true,
  })) {
    // Drain the complete production sidecar turn.
  }

  assert.ok(exposedTools[0]?.includes("ask_user_question"));
  assert.deepEqual(executePayloads[0]?.interactionCapabilities, { elicitationAvailable: true });
  assert.equal(JSON.stringify(executePayloads[0]).includes("askUser"), false);

  const withoutChannelTools: string[][] = [];
  const noChannelSession = createAgentSession({
    sessionId: "sidecar-no-elicitation-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: {
        model: {
          async prepare({ request }) {
            withoutChannelTools.push((request.tools ?? []).map((tool) => tool.name));
            return { request, provider: request.provider, model: request.model };
          },
          async *stream() {
            yield { type: "message_start", role: "assistant" } as const;
            yield { type: "message_end", finishReason: "stop" } as const;
          },
        },
        tools,
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });
  for await (const _event of noChannelSession.submit({ type: "text", text: "no channel" }, {
    turnId: "sidecar-no-elicitation-turn",
    canPrompt: false,
    canElicit: true,
  })) {
    // Drain the complete production sidecar turn.
  }
  assert.equal(withoutChannelTools[0]?.includes("ask_user_question"), false);
});

test("sidecar connection factory receives only transport turn facts", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const session = createAgentSession({
    sessionId: "transport-only-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        assert.equal("ports" in input, false);
        assert.equal("config" in input, false);
        assert.equal(input.turn.sessionId, "transport-only-session");
        return loopbackConnection();
      },
      uuid: deterministicIds(),
    }),
  });
  for await (const _event of session.submit({ type: "text", text: "hello" }, { turnId: "transport-only-turn" })) {
    // Drain protocol events.
  }
  assert.equal(seen.length, 1);
});

test("sidecar execute wire preserves AgentLoop turn limits and model configuration", async () => {
  const executeRequests: Array<Record<string, unknown>> = [];
  const runtimeConfig: AgentRuntimeConfig = {
    ...config(),
    appendSystemPrompt: "append instructions",
    planModeInstructions: "plan instructions",
    thinking: { enabled: true, mode: "high", preserve: true },
    toolChoice: "auto",
    maxContextMessages: 14,
    stopOnStructuredOutput: true,
    jsonSelfCorrect: true,
    isSubagent: true,
    permissionModeBeforePlan: "bypassPermissions",
    metadata: { subagentId: "child-1", subagentType: "general-purpose" },
  };
  const session = createAgentSession({
    sessionId: "wire-config-session",
    config: runtimeConfig,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => {
        const connection = loopbackConnection();
        return {
          ...connection,
          send(message: unknown) {
            const request = message as Record<string, unknown>;
            if (request.method === "execute") executeRequests.push(structuredClone(request));
            return connection.send(message);
          },
        };
      },
      uuid: deterministicIds(),
    }),
  });

  for await (const _event of session.submit({ type: "text", text: "preserve wire configuration" }, {
    turnId: "wire-config-turn",
    maxTurns: 7,
    maxBudgetUsd: 1.5,
    taskBudgetUsd: 4,
    initialTaskBudgetSpentUsd: 0.25,
    canElicit: true,
    modelOverride: {
      provider: "override-provider",
      model: "override-model",
      speed: 2,
      thinking: { enabled: true, mode: "medium" },
    },
  })) {
    // Drain the turn; this test inspects the execute request at the transport boundary.
  }

  assert.equal(executeRequests.length, 1);
  const payload = executeRequests[0]?.payload as Record<string, unknown>;
  assert.deepEqual(payload.modelOverride, {
    provider: "override-provider",
    model: "override-model",
    speed: 2,
    thinking: { enabled: true, mode: "medium" },
  });
  assert.equal(payload.maxTurns, 7);
  assert.equal(payload.maxBudgetUsd, 1.5);
  assert.equal(payload.taskBudgetUsd, 4);
  assert.equal(payload.initialTaskBudgetSpentUsd, 0.25);
  assert.equal(payload.canElicit, true);
  const agent = payload.agent as Record<string, unknown>;
  assert.equal(agent.appendSystemPrompt, "append instructions");
  assert.equal(agent.planModeInstructions, "plan instructions");
  assert.deepEqual(agent.thinking, { enabled: true, mode: "high", preserve: true });
  assert.equal(agent.toolChoice, "auto");
  assert.equal(agent.maxContextMessages, 14);
  assert.equal(agent.stopOnStructuredOutput, true);
  assert.equal(agent.jsonSelfCorrect, true);
  assert.equal(agent.isSubagent, true);
  assert.equal(agent.permissionModeBeforePlan, "bypassPermissions");
  assert.deepEqual(agent.metadata, { subagentId: "child-1", subagentType: "general-purpose" });
});

test("sidecar runner reprojects child and host events onto one visible timeline", async () => {
  const responses = queue<unknown>();
  const hostEvents: AgentEvent[] = [];
  const sessionId = "projected-event-session";
  const turnId = "projected-event-turn";
  const childAssistantMessage = {
    role: "assistant" as const,
    content: [{
      type: "text" as const,
      blockId: "child-text",
      text: "projected",
      timeline: { version: 1, turnId: "child-local-turn", id: "child-text", order: 99, revision: 99 },
    }],
  };
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => ({
      send(message: unknown) {
        const request = message as Record<string, unknown>;
        if (request.method === "hello") {
          responses.push(handshakeResponse(request, {}, "projected-events", {
            capabilitiesVersion: "2.0",
            methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
          }));
          return;
        }
        if (request.method === "capabilities") {
          const capabilities = {
            capabilitiesVersion: "2.0",
            methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
          };
          responses.push(handshakeResponse(request, capabilities, "projected-events", capabilities));
          return;
        }
        if (request.method !== "execute") return;
        hostEvents.push({
          type: "subagent_started",
          sessionId,
          turnId,
          subagentId: "child-a",
          subagentType: "general-purpose",
        }, {
          type: "pre_tool_execute",
          sessionId: `${sessionId}::sub::child-a`,
          turnId,
          toolCallId: "host-tool",
          toolName: "read_file",
        });
        responses.push({
          kind: "response",
          messageId: "projected-events-accepted",
          inReplyTo: request.messageId,
          requestId: request.requestId,
          ok: true,
          streamId: "projected-events-stream",
          cursor: 0,
        });
        responses.push({
          kind: "event",
          eventType: "agent.execute.event",
          streamId: "projected-events-stream",
          sequence: 0,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: {
            type: "assistant_message",
            sessionId,
            turnId,
            message: childAssistantMessage,
          },
        });
        responses.push({
          kind: "event",
          eventType: "agent.execute.event",
          streamId: "projected-events-stream",
          sequence: 1,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: {
            type: "tool_calls_detected",
            sessionId,
            turnId,
            calls: [{
              id: "child-tool",
              name: "read_file",
              input: {},
              timeline: { version: 1, turnId: "child-local-turn", id: "tool:child-tool", order: 100, revision: 100 },
            }],
          },
        });
        responses.push({
          kind: "event",
          eventType: "agent.execute.completed",
          streamId: "projected-events-stream",
          sequence: 2,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: true,
          outcome: "completed",
          payload: {
            result: { ...completedResult(sessionId, turnId), finalMessage: childAssistantMessage },
            messages: [childAssistantMessage],
          },
        });
        responses.end();
      },
      receive: () => responses,
    }),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId,
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      eventEmitter: (event) => hostEvents.push(event),
      drainEvents: () => hostEvents.splice(0),
    },
    agentLoopFactory: factory,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.submit({ type: "text", text: "project events" }, { turnId })) events.push(event);

  const assistant = events.find((event) => event.type === "assistant_message");
  const text = assistant?.type === "assistant_message" ? assistant.message.content[0] : undefined;
  assert.equal(text?.type, "text");
  assert.equal(text?.timeline?.turnId, turnId);
  assert.notEqual(text?.timeline?.order, 99);
  const terminal = events.find((event) => event.type === "turn_completed");
  const terminalText = terminal?.type === "turn_completed"
    ? terminal.result.finalMessage?.content[0]
    : undefined;
  assert.equal(terminalText?.type, "text");
  assert.deepEqual(terminalText?.timeline, text?.timeline);
  const snapshotText = session.snapshot().messages.find((message) =>
    message.content.some((block) => block.type === "text" && block.blockId === "child-text"))?.content[0];
  assert.equal(snapshotText?.type, "text");
  assert.deepEqual(snapshotText?.timeline, text?.timeline);
  const calls = events.find((event) => event.type === "tool_calls_detected");
  assert.equal(calls?.type, "tool_calls_detected");
  assert.equal(calls?.type === "tool_calls_detected" && calls.calls[0]?.timeline?.turnId, turnId);
  assert.notEqual(calls?.type === "tool_calls_detected" && calls.calls[0]?.timeline?.order, 100);
  const derivedStatus = events.find((event) => event.type === "subagent_status");
  assert.equal(derivedStatus?.type, "subagent_status");
  assert.equal(derivedStatus?.type === "subagent_status" && derivedStatus.status, "tool_started");
  await session.dispose();
});

test("sidecar known terminal keeps host tool checkpoint state and current attachment authorization", async () => {
  const toolContexts: PilotDeckToolRuntimeContext[] = [];
  const forkSnapshots: Array<{ readFiles: string[]; writeFiles: string[] }> = [];
  const firstHostRead = "/workspace/host-first.txt";
  const secondHostRead = "/workspace/host-second.txt";
  const firstHostWrite = "/workspace/host-first-write.txt";
  const secondHostWrite = "/workspace/host-second-write.txt";
  const currentAttachment = "/tmp/current-turn-attachment.txt";
  const transcript = new InMemoryTranscriptWriter();
  const oneShotSubagentPort: OneShotSubagentPort = {
    createForkApi(input) {
      return {
        depth: 0,
        maxSubagentDepth: 1,
        listDefinitions: () => [{ id: "checkpoint", description: "Checkpoint inspection" }],
        isAllowedDefinition: (id) => id === "checkpoint",
        async fork() {
          forkSnapshots.push({
            readFiles: [...(input.parentReadFileState?.keys() ?? [])],
            writeFiles: [...(input.parentWriteSnapshots?.keys() ?? [])],
          });
          return {
            markdown: "checkpoint complete",
            usage: {},
            turns: 1,
            durationMs: 1,
            subagentSessionId: "checkpoint-session::sub::child",
          };
        },
      };
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "checkpoint",
      description: "Mutates host file checkpoint state.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls, context) {
      toolContexts.push(context);
      assert.ok(context.readFileState);
      assert.ok(context.writeSnapshots);
      assert.deepEqual(context.allowedReadFiles, ["/workspace/seed-attachment.txt", currentAttachment]);
      if (calls[0]?.id === "checkpoint-1") {
        context.readFileState.set(firstHostRead, { mtimeMs: 2, kind: "text" });
        context.writeSnapshots.set(firstHostWrite, {
          absolutePath: firstHostWrite,
          mtimeMs: 2,
          contentHash: "host-first",
        });
      } else {
        assert.equal(context.readFileState, toolContexts[0]?.readFileState);
        assert.equal(context.writeSnapshots, toolContexts[0]?.writeSnapshots);
        assert.ok(context.readFileState.has(firstHostRead));
        assert.ok(context.writeSnapshots.has(firstHostWrite));
        context.readFileState.set(secondHostRead, { mtimeMs: 3, kind: "text" });
        context.writeSnapshots.set(secondHostWrite, {
          absolutePath: secondHostWrite,
          mtimeMs: 3,
          contentHash: "host-second",
        });
        assert.ok(context.subagent);
        await context.subagent.fork({
          definitionId: "checkpoint",
          directive: "Inspect the shared host checkpoint.",
          subagentId: "child",
          toolCallId: calls[0]?.id,
        });
      }
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [],
        startedAt: "2026-09-12T00:00:00.000Z",
        completedAt: "2026-09-12T00:00:00.001Z",
      }));
    },
  };
  let modelCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls <= 2) {
        yield {
          type: "tool_call_end",
          toolCall: { id: `checkpoint-${modelCalls}`, name: "checkpoint", input: {} },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "host checkpoint retained" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "checkpoint-session",
    config: {
      ...config(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: "/workspace",
        mode: "bypassPermissions",
        bypassAvailable: true,
        canPrompt: false,
      }),
    },
    seedState: {
      allowedReadFiles: ["/workspace/seed-attachment.txt"],
      readFileState: new Map([["/workspace/seed.txt", { mtimeMs: 1, kind: "text" }]]),
      writeSnapshots: new Map([["/workspace/seed-write.txt", {
        absolutePath: "/workspace/seed-write.txt",
        mtimeMs: 1,
        contentHash: "seed",
      }]]),
    },
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      oneShotSubagentPort,
    },
    transcript,
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "exercise host checkpoint" }, {
    turnId: "checkpoint-turn",
    allowedReadFiles: [currentAttachment],
  })) events.push(event);

  assert.equal(modelCalls, 3);
  assert.equal(toolContexts.length, 2);
  assert.deepEqual(forkSnapshots, [{
    readFiles: ["/workspace/seed.txt", firstHostRead, secondHostRead],
    writeFiles: ["/workspace/seed-write.txt", firstHostWrite, secondHostWrite],
  }]);
  const fileState = session.snapshotForRuntimeReload().fileState;
  assert.ok(fileState);
  assert.deepEqual(fileState.allowedReadFiles, ["/workspace/seed-attachment.txt", currentAttachment]);
  assert.equal(fileState.readFileState?.get(firstHostRead)?.mtimeMs, 2);
  assert.equal(fileState.readFileState?.get(secondHostRead)?.mtimeMs, 3);
  assert.equal(fileState.writeSnapshots?.get(firstHostWrite)?.contentHash, "host-first");
  assert.equal(fileState.writeSnapshots?.get(secondHostWrite)?.contentHash, "host-second");
  const operationTerminal = transcript.entries.find((entry) => entry.type === "agent_loop_operation_terminal");
  assert.ok(operationTerminal && operationTerminal.type === "agent_loop_operation_terminal");
  const persistedReadState = operationTerminal.seedState?.readFileState as Record<string, { mtimeMs?: number }> | undefined;
  const persistedWriteSnapshots = operationTerminal.seedState?.writeSnapshots as Record<string, { contentHash?: string }> | undefined;
  assert.equal(persistedReadState?.[secondHostRead]?.mtimeMs, 3);
  assert.equal(persistedWriteSnapshots?.[secondHostWrite]?.contentHash, "host-second");
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
});

test("sidecar permission callback uses the canonical host tool cwd", async () => {
  const actualCwd = "/workspace/actual";
  const stalePermissionCwd = "/workspace/stale";
  const writeTool: PilotDeckToolDefinition = {
    name: "write_file",
    description: "Writes one workspace file.",
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [] }),
  };

  const run = async (mode: "native" | "sidecar") => {
    const permissionRuntime = new PermissionRuntime();
    const permissionContexts: PilotDeckToolRuntimeContext[] = [];
    let executed = 0;
    const permission = {
      async decide(
        tool: PilotDeckToolDefinition,
        input: unknown,
        context: PilotDeckToolRuntimeContext,
        toolCallId: string,
      ) {
        permissionContexts.push(context);
        return permissionRuntime.decide(tool, input, context, toolCallId);
      },
    };
    const tools: ToolPort = {
      list: () => [writeTool],
      async executeAll(calls, context) {
        const call = calls[0];
        assert.ok(call);
        const decision = await permission.decide(writeTool, call.input, context, call.id);
        assert.equal(decision.type, "allow");
        executed += 1;
        return [{
          type: "success" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text" as const, text: "written" }],
          startedAt: "2026-09-12T00:00:00.000Z",
          completedAt: "2026-09-12T00:00:00.001Z",
        }];
      },
    };
    let modelCalls = 0;
    const model: ModelInvokerPort = {
      async prepare({ request }) {
        return { request, provider: request.provider, model: request.model };
      },
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        modelCalls += 1;
        yield { type: "message_start", role: "assistant" };
        if (modelCalls === 1) {
          yield {
            type: "tool_call_end",
            toolCall: { id: "write-call", name: "write_file", input: { file_path: "notes.md" } },
          };
          yield { type: "message_end", finishReason: "tool_call" };
          return;
        }
        yield { type: "text_delta", text: "write complete" };
        yield { type: "message_end", finishReason: "stop" };
      },
    };
    const session = createAgentSession({
      sessionId: `${mode}-permission-cwd-session`,
      config: {
        ...config(),
        cwd: actualCwd,
        permissionContext: createDefaultPermissionContext({
          cwd: stalePermissionCwd,
          canPrompt: false,
          rules: {
            allow: [{ source: "user", behavior: "allow", toolName: "write_file" }],
          },
        }),
      },
      dependencies: {
        router: {} as never,
        ports: { model, tools },
        tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
        permission,
      },
      ...(mode === "sidecar"
        ? {
            agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
              connect: () => loopbackConnection(),
              uuid: deterministicIds(),
            }),
          }
        : {}),
    });
    const events = [];
    for await (const event of session.submit({ type: "text", text: "write the note" }, {
      turnId: `${mode}-permission-cwd-turn`,
    })) events.push(event);
    return { executed, permissionContexts, events };
  };

  const native = await run("native");
  const sidecar = await run("sidecar");

  for (const result of [native, sidecar]) {
    assert.equal(result.executed, 1);
    assert.ok(result.permissionContexts.length > 0);
    assert.deepEqual(result.permissionContexts.map((context) => context.cwd), result.permissionContexts.map(() => actualCwd));
    assert.deepEqual(
      result.permissionContexts.map((context) => context.permissionContext.cwd),
      result.permissionContexts.map(() => actualCwd),
    );
    const terminal = result.events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
    assert.equal(terminal?.result?.type, "success");
  }
});

test("sidecar host owns tool-driven plan mode across callbacks and turns", async () => {
  const enterPlanTool: PilotDeckToolDefinition = {
    name: "enter_plan_mode",
    description: "Enter plan mode.",
    kind: "session",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [] }),
  };
  const exitPlanTool: PilotDeckToolDefinition = {
    name: "exit_plan_mode",
    description: "Exit plan mode.",
    kind: "session",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [] }),
  };
  const writeTool: PilotDeckToolDefinition = {
    name: "write_file",
    description: "Writes a workspace file.",
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [] }),
  };

  const run = async (
    kind: "native" | "sidecar",
    baseMode: "default" | "bypassPermissions",
  ) => {
    const runtimeConfig: AgentRuntimeConfig = baseMode === "bypassPermissions"
      ? {
          ...config(),
          permissionMode: "bypassPermissions",
          permissionContext: createDefaultPermissionContext({
            cwd: "/workspace",
            mode: "bypassPermissions",
            bypassAvailable: true,
            canPrompt: false,
          }),
        }
      : config();
    const permissionRuntime = new PermissionRuntime();
    const permissionModes: string[] = [];
    const lifecycle = new RecordingLifecycleRuntime();
    const permission = {
      async decide(
        tool: PilotDeckToolDefinition,
        input: unknown,
        context: PilotDeckToolRuntimeContext,
        toolCallId: string,
      ) {
        permissionModes.push(context.permissionMode);
        return permissionRuntime.decide(tool, input, context, toolCallId);
      },
    };
    const tools: ToolPort = {
      list: () => [enterPlanTool, exitPlanTool, writeTool],
      async executeAll(calls, context) {
        return Promise.all(calls.map(async (call) => {
          // This ToolPort represents the host execution boundary in both
          // modes, so it remains the single permission-enforcement owner.
          const tool = [enterPlanTool, exitPlanTool, writeTool].find((candidate) => candidate.name === call.name);
          assert.ok(tool);
          const decision = await permission.decide(tool, call.input, context, call.id);
          if (decision.type !== "allow") {
            const message = decision.type === "ask"
              ? "Permission is required to run write_file."
              : decision.message;
            return {
              type: "error" as const,
              toolCallId: call.id,
              toolName: call.name,
              error: { code: "permission_denied" as const, message },
              content: [{ type: "text" as const, text: message }],
              startedAt: "2026-09-12T00:00:00.000Z",
              completedAt: "2026-09-12T00:00:00.001Z",
            };
          }
          const requestedMode = call.name === "enter_plan_mode"
            ? "plan"
            : call.name === "exit_plan_mode"
              ? "default"
              : undefined;
          return {
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: `${call.name} complete` }],
            ...(requestedMode ? { data: { requestedMode } } : {}),
            startedAt: "2026-09-12T00:00:00.000Z",
            completedAt: "2026-09-12T00:00:00.001Z",
          };
        }));
      },
    };
    let modelCalls = 0;
    const model: ModelInvokerPort = {
      async prepare({ request }) {
        return { request, provider: request.provider, model: request.model };
      },
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        modelCalls += 1;
        yield { type: "message_start", role: "assistant" };
        const toolByModelCall: Record<number, string> = {
          1: "enter_plan_mode",
          3: "write_file",
          5: "exit_plan_mode",
          7: "write_file",
        };
        const toolName = toolByModelCall[modelCalls];
        if (toolName) {
          yield {
            type: "tool_call_end",
            toolCall: { id: `mode-call-${modelCalls}`, name: toolName, input: { path: "notes.md" } },
          };
          yield { type: "message_end", finishReason: "tool_call" };
          return;
        }
        yield { type: "text_delta", text: `model pass ${modelCalls}` };
        yield { type: "message_end", finishReason: "stop" };
      },
    };
    const session = createAgentSession({
      sessionId: `${kind}-mode-session`,
      config: runtimeConfig,
      dependencies: {
        router: {} as never,
        ports: { model, tools },
        tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
        permission,
        lifecycle,
      },
      ...(kind === "sidecar" ? {
        agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
          connect: () => loopbackConnection(),
          uuid: deterministicIds(),
        }),
      } : {}),
    });

    const submit = async (turnId: string, allowPlanModeTools = false) => {
      const events = [];
      for await (const event of session.submit({ type: "text", text: turnId }, {
        turnId,
        ...(allowPlanModeTools ? { allowPlanModeTools: true } : {}),
      })) events.push(event);
      return events;
    };

    const entered = await submit(`${kind}-enter`, true);
    const plannedWrite = await submit(`${kind}-planned-write`);
    const exited = await submit(`${kind}-exit`, true);
    const defaultWrite = await submit(`${kind}-default-write`);
    return { runtimeConfig, permissionModes, lifecycle, entered, plannedWrite, exited, defaultWrite, baseMode };
  };

  const results = await Promise.all([
    run("native", "default"),
    run("sidecar", "default"),
    run("native", "bypassPermissions"),
    run("sidecar", "bypassPermissions"),
  ]);

  for (const result of results) {
    assert.deepEqual(result.permissionModes, [result.baseMode, "plan", "plan", result.baseMode]);
    assert.deepEqual(
      result.lifecycle.inputs.filter((input) => input.event === "Stop").map((input) => input.baseInput.permissionMode),
      ["plan", "plan", result.baseMode, result.baseMode],
    );
    assert.equal(result.runtimeConfig.permissionMode, result.baseMode);
    assert.equal(result.runtimeConfig.permissionContext.mode, result.baseMode);
    const plannedResult = result.plannedWrite.find((event) => event.type === "tool_result") as {
      result?: { type?: string; error?: { code?: string } };
    } | undefined;
    assert.equal(plannedResult?.result?.type, "error");
    assert.equal(plannedResult?.result?.error?.code, "permission_denied");
    const postExitWrite = result.defaultWrite.find((event) => event.type === "tool_result") as {
      result?: { type?: string };
    } | undefined;
    assert.equal(postExitWrite?.result?.type, result.baseMode === "bypassPermissions" ? "success" : "error", JSON.stringify({
      baseMode: result.baseMode,
      permissionModes: result.permissionModes,
      postExitWrite,
    }));
  }
});

test("sidecar host applies submit ask mode before capability execution", async () => {
  const registry = new ToolRegistry();
  let writeExecutions = 0;
  registry.register({
    name: "write_file",
    description: "Writes a workspace file.",
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => {
      writeExecutions += 1;
      return { content: [] };
    },
  });
  const hostRuntime = new ToolRuntime(registry, new PermissionRuntime());
  const hostContexts: PilotDeckToolRuntimeContext[] = [];
  const runtimeConfig: AgentRuntimeConfig = {
    ...config(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace",
      mode: "bypassPermissions",
      canPrompt: false,
    }),
  };
  const tools: ToolPort = {
    list: () => registry.list(),
    async executeAll(calls, context) {
      hostContexts.push(context);
      return Promise.all(calls.map((call) => hostRuntime.execute(call, context)));
    },
  };
  let modelCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield {
          type: "tool_call_end",
          toolCall: { id: "ask-mode-write-call", name: "write_file", input: { path: "blocked.txt" } },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "inspection complete" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "ask-mode-host-session",
    config: runtimeConfig,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry, scheduler: { executeAll: async () => [] } },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "inspect only" }, {
    turnId: "ask-mode-host-turn",
    runMode: "ask",
  })) events.push(event);

  assert.equal(runtimeConfig.runMode, "ask");
  assert.deepEqual(hostContexts.map((context) => context.runMode), ["ask"]);
  assert.equal(writeExecutions, 0);
  const toolResult = events.find((event) => event.type === "tool_result") as {
    result?: { type?: string; error?: { code?: string } };
  } | undefined;
  assert.equal(toolResult?.result?.type, "error");
  assert.equal(toolResult?.result?.error?.code, "ask_mode_violation");
});

test("sidecar host canonicalizes forged context policy to its live config", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const connectedRunModes: Array<string | undefined> = [];
  const runtimeConfig = config();
  const session = createAgentSession({
    sessionId: "forged-policy-session",
    config: runtimeConfig,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      context: {
        async prepareForModel(input) {
          inputs.push(input as unknown as Record<string, unknown>);
          return { messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] };
        },
      },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: (input) => {
        connectedRunModes.push(runtimeConfig.runMode);
        return forgedPolicyContextConnection(input.turn.sessionId, input.turn.turnId);
      },
      uuid: deterministicIds(),
    }),
  });

  for await (const _event of session.submit({ type: "text", text: "inspect only" }, {
    turnId: "forged-policy-turn",
    runMode: "ask",
  })) {
    // The protocol fixture only exercises host context dispatch.
  }
  for await (const _event of session.submit({ type: "text", text: "continue inspecting" }, {
    turnId: "forged-policy-next-turn",
  })) {
    // The omitted override must preserve the native live run mode.
  }

  assert.deepEqual(connectedRunModes, ["ask", "ask"]);
  assert.equal(runtimeConfig.runMode, "ask");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.sessionId, "forged-policy-session");
  assert.equal(inputs[0]?.turnId, "forged-policy-turn");
  assert.equal(inputs[0]?.cwd, "/workspace");
  assert.equal(inputs[0]?.permissionMode, "default");
  assert.equal(inputs[0]?.runMode, "ask");
  assert.equal(inputs[1]?.sessionId, "forged-policy-session");
  assert.equal(inputs[1]?.turnId, "forged-policy-next-turn");
  assert.equal(inputs[1]?.permissionMode, "default");
  assert.equal(inputs[1]?.runMode, "ask");
});

test("sidecar factory maps an unknown terminal to a failure without publishing a success", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const observations: string[] = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => unknownTerminalConnection(),
    transportObserver: { observe: (observation) => { observations.push(observation.type); } },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "unknown-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript,
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "unknown" }, { turnId: "unknown-turn" })) {
    events.push(event);
  }
  const complete = events.find((event) => event.type === "turn_completed") as { result: { type: string; errors?: Array<{ code: string }> } };
  assert.equal(complete.result.type, "error");
  assert.equal(complete.result.errors?.[0]?.code, "agent_invalid_state");
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const terminalEntry = operationEntries.at(-1);
  assert.equal(terminalEntry?.type, "agent_loop_operation_terminal");
  if (terminalEntry?.type === "agent_loop_operation_terminal") {
    assert.equal(terminalEntry.outcome, "result_unknown");
  }
  assert.deepEqual(observations, ["handshake_completed", "stream_accepted", "result_unknown_fail_closed"]);
});

test("sidecar omits context host methods when composition supplies its no-op context port", async () => {
  const executePayloads: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => unknownTerminalConnection(executePayloads),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "no-context-host-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  for await (const _event of session.submit({ type: "text", text: "no host context" }, {
    turnId: "no-context-host-turn",
  })) {
    // The unknown terminal fixture stops before model dispatch.
  }

  assert.equal(executePayloads.length, 1);
  const hostModules = executePayloads[0]?.hostModules as Record<string, unknown>;
  assert.equal("context" in hostModules, false);
});

test("sidecar factory projects a preflight final execute rejection as one failed turn", async () => {
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => loopbackConnection(),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "expired-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "expired" }, {
    turnId: "expired-turn",
    execution: {
      runId: "expired-run",
      operationId: "expired-operation",
      operationDeadline: "2020-01-01T00:00:00.000Z",
    },
  })) events.push(event);

  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result: { type: string; stopReason: string; errors?: Array<{ code: string; details?: unknown }> };
  }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result.type, "error");
  assert.equal(terminals[0]?.result.stopReason, "aborted_streaming");
  assert.equal(terminals[0]?.result.errors?.[0]?.code, "agent_execution_rejected");
  assert.deepEqual(terminals[0]?.result.errors?.[0]?.details, {
    sidecarCode: "DEADLINE_EXCEEDED",
  });
});

test("sidecar factory delegates result_unknown reconciliation to the host operation owner", async () => {
  const reconciliations: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => unknownTerminalConnection(),
    transportObserver: { observe: (observation) => { observations.push({ ...observation }); } },
    reconcileResultUnknown: async (input) => {
      reconciliations.push(input);
      return {
        outcome: "completed",
        result: completedResult("reconciled-session", "reconciled-turn"),
        messages: [],
      };
    },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "reconciled-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "reconcile" }, { turnId: "reconciled-turn" })) {
    events.push(event);
  }

  assert.equal(reconciliations.length, 1);
  assert.match(String(reconciliations[0]?.runId), /^run-[0-9]+$/);
  assert.equal(reconciliations[0]?.operationId, "reconciled-turn");
  assert.match(String(reconciliations[0]?.requestId), /^request-[0-9]+$/);
  assert.equal(reconciliations[0]?.streamId, "stream-1");
  assert.equal(reconciliations[0]?.lastAppliedSequence, 0);
  assert.deepEqual(reconciliations[0]?.binding, {
    moduleInstanceId: "test-sidecar-instance",
    connectionGeneration: "test-sidecar-connection",
  });
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  assert.deepEqual(observations, [
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "1" },
    { type: "stream_accepted", resumeSupported: false },
    { type: "result_unknown_resolved", source: "sidecar_final", outcome: "completed" },
  ]);
});

test("restored session composition reconciles a matching sidecar result_unknown from its durable ledger", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const identity = {
    runId: "restored-run",
    operationId: "restored-operation",
    requestId: "request-4",
    sessionId: "restored-session",
    turnId: "restored-turn",
    binding: {
      moduleInstanceId: "test-sidecar-instance",
      connectionGeneration: "test-sidecar-connection",
    },
  };
  const priorLedger = new SessionAgentLoopOperationLedger({
    sessionId: identity.sessionId,
    transcript,
  });
  await priorLedger.start(identity);
  await priorLedger.accept({ ...identity, streamId: "stream-1" });
  await priorLedger.terminal({
    ...identity,
    streamId: "stream-1",
    lastAppliedSequence: 0,
    outcome: "completed",
    result: completedResult(identity.sessionId, identity.turnId),
    messages: [{ role: "assistant", content: [{ type: "text", text: "settled before restart" }] }],
  });

  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => unknownTerminalConnection(),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: identity.sessionId,
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript,
    restoredEntries: transcript.entries,
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "recover" }, {
    turnId: identity.turnId,
    execution: { runId: identity.runId, operationId: identity.operationId },
  })) events.push(event);

  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result?: { type?: string };
  }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const terminal = operationEntries.at(-1);
  assert.equal(terminal?.type, "agent_loop_operation_terminal");
  if (terminal?.type === "agent_loop_operation_terminal") {
    assert.equal(terminal.outcome, "completed");
  }
});

test("sidecar factory requires a v2 streaming handshake before execute", async () => {
  const methods: string[] = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => ({
      send(message) {
        const request = message as Record<string, unknown>;
        methods.push(String(request.method));
        if (request.method === "hello") {
          responses.push({
            kind: "response",
            messageId: "hello-response",
            inReplyTo: request.messageId,
            ok: true,
            protocolVersion: "9.0",
            moduleId: "wrong-version",
            moduleInstanceId: "wrong-version-instance",
            connectionGeneration: "wrong-version-connection",
            capabilitiesVersion: "1",
            payload: {},
          });
        }
      },
      receive: () => responses,
    }),
    uuid: deterministicIds(),
  });
  const responses = queue<unknown>();
  const session = createAgentSession({
    sessionId: "handshake-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "handshake" }, { turnId: "handshake-turn" })) {
    events.push(event);
  }

  assert.deepEqual(methods, ["hello"]);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "error");
});

test("sidecar factory rejects a module identity that differs from the configured implementation", async () => {
  const methods: string[] = [];
  const responses = queue<unknown>();
  const factory = createAgentLoopSidecarRuntimeFactory({
    expectedModuleId: "configured.loop",
    connect: () => ({
      send(message) {
        const request = message as Record<string, unknown>;
        methods.push(String(request.method));
        if (request.method === "hello") responses.push(handshakeResponse(request, {}));
      },
      receive: () => responses,
    }),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "identity-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "identity" }, { turnId: "identity-turn" })) {
    events.push(event);
  }

  assert.deepEqual(methods, ["hello"]);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "error");
});

test("sidecar factory sends cancel only after the streaming execute accepted response", async () => {
  const methods: string[] = [];
  const responses = queue<unknown>();
  let session: ReturnType<typeof createAgentSession> | undefined;
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => ({
      send(message) {
        const request = message as Record<string, unknown>;
        methods.push(String(request.method));
        if (request.method === "hello") {
          responses.push(handshakeResponse(request, {}));
        } else if (request.method === "capabilities") {
          responses.push(handshakeResponse(request, {
            capabilitiesVersion: "1",
            methods: [{ name: "execute", enabled: true, profiles: ["streaming"], cancel: true }],
          }));
        } else if (request.method === "execute") {
          session?.abort("user_cancelled");
          queueMicrotask(() => {
            assert.deepEqual(methods, ["hello", "capabilities", "execute"]);
            responses.push({
              kind: "response",
              messageId: "execute-accepted",
              inReplyTo: request.messageId,
              requestId: request.requestId,
              ok: true,
              streamId: "cancel-stream",
              cursor: 0,
            });
          });
        } else if (request.method === "cancel") {
          responses.push({
            kind: "response",
            messageId: "cancel-accepted",
            inReplyTo: request.messageId,
            requestId: request.requestId,
            ok: true,
            payload: {},
          });
          responses.push({
            kind: "event",
            eventType: "agent.turn_completed",
            streamId: "cancel-stream",
            sequence: 0,
            runId: request.runId,
            operationId: request.operationId,
            requestId: request.requestId,
            final: false,
            payload: {
              type: "turn_completed",
              sessionId: "cancel-session",
              turnId: "cancel-turn",
              result: cancelledResult("cancel-session", "cancel-turn"),
            },
          });
          responses.push({
            kind: "event",
            eventType: "agent.execute.cancelled",
            streamId: "cancel-stream",
            sequence: 1,
            runId: request.runId,
            operationId: request.operationId,
            requestId: request.requestId,
            final: true,
            outcome: "cancelled",
            payload: {
              result: cancelledResult("cancel-session", "cancel-turn"),
              messages: [],
            },
          });
          responses.end();
        }
      },
      receive: () => responses,
    }),
    uuid: deterministicIds(),
  });
  session = createAgentSession({
    sessionId: "cancel-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "cancel" }, { turnId: "cancel-turn" })) {
    events.push(event);
  }

  assert.deepEqual(methods, ["hello", "capabilities", "execute", "cancel"]);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "aborted");
});

test("sidecar maps a compaction persistence cancellation without a terminal result to aborted", async () => {
  const responses = queue<unknown>();
  let session: ReturnType<typeof createAgentSession> | undefined;
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => ({
      send(message) {
        const request = message as Record<string, unknown>;
        if (request.method === "hello") {
          responses.push(handshakeResponse(request, {}));
        } else if (request.method === "capabilities") {
          responses.push(handshakeResponse(request, {
            capabilitiesVersion: "1",
            methods: [{ name: "execute", enabled: true, profiles: ["streaming"], cancel: true }],
          }));
        } else if (request.method === "execute") {
          session?.abort("compaction_persistence_failed");
          responses.push({
            kind: "response",
            messageId: "persistence-execute-accepted",
            inReplyTo: request.messageId,
            requestId: request.requestId,
            ok: true,
            streamId: "persistence-cancel-stream",
            cursor: 0,
          });
        } else if (request.method === "cancel") {
          responses.push({
            kind: "response",
            messageId: "persistence-cancel-accepted",
            inReplyTo: request.messageId,
            requestId: request.requestId,
            ok: true,
            payload: {},
          });
          responses.push({
            kind: "event",
            eventType: "agent.execute.cancelled",
            streamId: "persistence-cancel-stream",
            sequence: 0,
            runId: request.runId,
            operationId: request.operationId,
            requestId: request.requestId,
            final: true,
            outcome: "cancelled",
            error: { message: "Sidecar module call aborted." },
            payload: { error: { message: "Sidecar module call aborted." } },
          });
          responses.end();
        }
      },
      receive: () => responses,
    }),
    uuid: deterministicIds(),
  });
  const transcript = new InMemoryTranscriptWriter();
  session = createAgentSession({
    sessionId: "persistence-cancel-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript,
    agentLoopFactory: factory,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.submit(
    { type: "text", text: "compact" },
    { turnId: "persistence-cancel-turn" },
  )) events.push(event);

  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type, "turn_completed");
  if (terminal?.type === "turn_completed") {
    assert.equal(terminal.result.type, "aborted");
    assert.equal(terminal.result.stopReason, "aborted_streaming");
    assert.notEqual(terminal.result.errors?.[0]?.code, "agent_invalid_state");
  }
  const durable = transcript.entries.find((entry) => entry.type === "turn_result");
  assert.equal(durable?.type, "turn_result");
  if (durable?.type === "turn_result") assert.equal(durable.result.type, "aborted");
});

test("sidecar factory resumes an accepted stream on an explicit reconnectable transport", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const reconnects: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => reconnectingConnection(reconnects),
    transportObserver: {
      observe(observation) {
        observations.push({ ...observation });
        throw new Error("observer failure must not affect the sidecar turn");
      },
    },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "reconnect-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript,
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "resume transport" }, {
    turnId: "reconnect-turn",
    execution: { runId: "reconnect-run", operationId: "reconnect-operation" },
  })) events.push(event);

  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0]?.streamId, "reconnect-stream");
  assert.equal(reconnects[0]?.lastAppliedSequence, 0);
  assert.deepEqual(reconnects[0]?.previousBinding, {
    moduleInstanceId: "reconnect-sidecar",
    connectionGeneration: "connection-a",
  });
  assert.equal(events.filter((event) => event.type === "warning").length, 1);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  assert.deepEqual(observations, [
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "2.0" },
    { type: "stream_accepted", resumeSupported: true },
    { type: "reconnect_started", attempt: 1, lastAppliedSequence: 0 },
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "2.0" },
    { type: "reconnect_succeeded", attempt: 1 },
  ]);
  assert.deepEqual(
    transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_")).map((entry) => entry.type),
    ["agent_loop_operation_started", "agent_loop_operation_accepted", "agent_loop_operation_terminal"],
  );
});

test("sidecar factory reconciles a process-restarted stream without replaying execute", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const reconnects: Array<Record<string, unknown>> = [];
  const methods: string[] = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => restartingConnection(reconnects, methods),
    transportObserver: { observe: (observation) => { observations.push({ ...observation }); } },
    reconcileResultUnknown: async (input) => {
      reconciliations.push(structuredClone(input));
      return {
        outcome: "completed",
        result: completedResult("restart-session", "restart-turn"),
        messages: [{ role: "assistant", content: [{ type: "text", text: "host status confirmed completion" }] }],
      };
    },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "restart-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "recover process restart" }, {
    turnId: "restart-turn",
    execution: { runId: "restart-run", operationId: "restart-operation" },
  })) events.push(event);

  assert.equal(reconnects.length, 1);
  assert.equal(methods.filter((method) => method === "execute").length, 1);
  assert.equal(methods.includes("resume"), false);
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0]?.code, "SIDECAR_INSTANCE_RESTARTED");
  assert.deepEqual(reconciliations[0]?.binding, {
    moduleInstanceId: "restart-instance-a",
    connectionGeneration: "restart-connection-a",
  });
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  assert.deepEqual(
    transcript.entries
      .filter((entry) => entry.type === "agent_loop_operation_terminal")
      .map((entry) => entry.outcome),
    ["result_unknown", "completed"],
  );
  assert.deepEqual(observations, [
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "2.0" },
    { type: "stream_accepted", resumeSupported: true },
    { type: "reconnect_started", attempt: 1, lastAppliedSequence: 0 },
    { type: "sidecar_instance_restarted" },
    { type: "reconnect_failed", attempt: 1 },
    { type: "result_unknown_resolved", source: "transport_interruption", outcome: "completed" },
  ]);
});

test("sidecar transport observes a replayed pending module call without dispatching it again", async () => {
  const observations: Array<Record<string, unknown>> = [];
  const responses: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => replayedModuleCallConnection(responses),
    transportObserver: { observe: (observation) => { observations.push({ ...observation }); } },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "module-replay-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "replay module response" }, {
    turnId: "module-replay-turn",
    execution: { runId: "module-replay-run", operationId: "module-replay-operation" },
  })) events.push(event);

  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.inReplyTo, "replayed-context-call");
  assert.equal(responses[0]?.ok, false);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.deepEqual(observations, [
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "2.0" },
    { type: "stream_accepted", resumeSupported: true },
    { type: "module_call_received", module: "context" },
    { type: "reconnect_started", attempt: 1, lastAppliedSequence: -1 },
    { type: "handshake_completed", moduleId: "test-sidecar", capabilitiesVersion: "2.0" },
    { type: "reconnect_succeeded", attempt: 1 },
    { type: "pending_module_call_replayed", module: "context" },
    { type: "cached_module_response_replayed", module: "context" },
  ]);
});

test("stdio sidecar connection runs the built binary and keeps model and tool execution in the host", async () => {
  let modelCalls = 0;
  const hostToolCalls: string[] = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "stdio-tool-1", name: "lookup", input: { query: "stdio" } } };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "text_delta", text: "stdio complete" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
  };
  const tools: ToolPort = {
    list: () => [lookupTool()],
    async executeAll(calls, _context, execution) {
      hostToolCalls.push(`${execution.runId}:${calls[0]?.id}`);
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "stdio host value" }],
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.001Z",
      }));
    },
  };
  const sidecarFactory = createAgentLoopSidecarRuntimeFactory({
    connect: createStdioAgentLoopSidecarConnectionFactory({
      command: process.execPath,
      args: [builtSidecarPath()],
      killTimeoutMs: 5_000,
    }),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "stdio-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: sidecarFactory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "run via stdio" }, { turnId: "stdio-turn" })) {
    events.push(event);
  }

  assert.equal(hostToolCalls.length, 1);
  assert.match(hostToolCalls[0] ?? "", /^run-[0-9]+:stdio-tool-1$/);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
});

test("stdio sidecar keeps one unknown terminal when a host tool returns after its deadline", async () => {
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
  let signalToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => { signalToolStarted = resolve; });
  let toolReturned = false;
  const deadlineAt = Date.now() + 5_000;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_end", toolCall: { id: "stdio-late-tool", name: "slow_tool", input: {} } };
      yield { type: "message_end", finishReason: "tool_call" };
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "slow_tool",
      description: "Completes only after the sidecar deadline.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls) {
      signalToolStarted();
      await toolGate;
      toolReturned = true;
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "late stdio host success" }],
        startedAt: "2026-09-11T00:00:00.000Z",
        completedAt: "2026-09-11T00:00:00.001Z",
      }));
    },
  };
  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "stdio-late-tool-session",
    config: {
      ...config(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: "/workspace",
        mode: "bypassPermissions",
        bypassAvailable: true,
        canPrompt: false,
      }),
    },
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: createStdioAgentLoopSidecarConnectionFactory({
        command: process.execPath,
        args: [builtSidecarPath()],
        killTimeoutMs: 5_000,
      }),
      uuid: deterministicIds(),
    }),
  });

  const submitted = (async () => {
    const emitted = [];
    for await (const event of session.submit({ type: "text", text: "run a slow stdio host tool" }, {
      turnId: "stdio-late-tool-turn",
      execution: {
        runId: "stdio-late-tool-run",
        operationId: "stdio-late-tool-operation",
        operationDeadline: new Date(deadlineAt).toISOString(),
      },
    })) emitted.push(event);
    return emitted;
  })();
  await waitForSignal(toolStarted, 7_000, "stdio sidecar did not begin the host tool before its deadline");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAt - Date.now() + 50)));
  releaseTool();
  const events = await submitted;

  assert.equal(toolReturned, true, "the host tool completion is intentionally late");
  assert.equal(events.filter((event) => event.type === "tool_result").length, 0);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result?: { type?: string; errors?: Array<{ code?: string }> };
  }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "error");
  assert.equal(terminals[0]?.result?.errors?.[0]?.code, "agent_invalid_state");
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const operationTerminal = operationEntries.at(-1);
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.outcome, "result_unknown");
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.code, "DEADLINE_EXCEEDED");
});

test("sidecar keeps a timed-out result_unknown fail-closed without terminal evidence", async () => {
  const responses = queue<unknown>();
  let session: ReturnType<typeof createAgentSession> | undefined;
  let reconciliations = 0;
  let cancelReason: unknown;
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => ({
      send(message) {
        const request = message as Record<string, unknown>;
        if (request.method === "hello") {
          responses.push(handshakeResponse(request, {}));
        } else if (request.method === "capabilities") {
          responses.push(handshakeResponse(request, {
            capabilitiesVersion: "1",
            methods: [{ name: "execute", enabled: true, profiles: ["streaming"], cancel: true }],
          }));
        } else if (request.method === "execute") {
          session?.abort("timeout:gateway-timeout-run");
          responses.push({
            kind: "response",
            messageId: "timeout-execute-accepted",
            inReplyTo: request.messageId,
            requestId: request.requestId,
            ok: true,
            streamId: "timeout-stream",
            cursor: 0,
          });
        } else if (request.method === "cancel") {
          cancelReason = request.reason;
          responses.push({
            kind: "response",
            messageId: "timeout-cancel-accepted",
            inReplyTo: request.messageId,
            requestId: request.requestId,
            ok: true,
            payload: {},
          });
          responses.push({
            kind: "event",
            eventType: "agent.execute.unknown",
            streamId: "timeout-stream",
            sequence: 0,
            runId: request.runId,
            operationId: request.operationId,
            requestId: request.requestId,
            final: true,
            outcome: "result_unknown",
            payload: {},
          });
          responses.end();
        }
      },
      receive: () => responses,
    }),
    reconcileResultUnknown: async () => {
      reconciliations += 1;
      return undefined;
    },
    uuid: deterministicIds(),
  });
  const transcript = new InMemoryTranscriptWriter();
  session = createAgentSession({
    sessionId: "gateway-timeout-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript,
    agentLoopFactory: factory,
  });

  const events: AgentEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const event of session!.submit(
        { type: "text", text: "timeout" },
        {
          turnId: "gateway-timeout-turn",
          execution: {
            runId: "gateway-timeout-run",
            operationId: "gateway-timeout-operation",
          },
        },
      )) events.push(event);
    },
    /result_unknown/,
  );
  assert.equal(events.some((event) => event.type === "turn_completed"), false);
  assert.equal(events.some((event) => event.type === "turn_failed"), false);
  assert.equal(reconciliations, 1);
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const operationTerminals = operationEntries.filter(
    (entry): entry is Extract<typeof entry, { type: "agent_loop_operation_terminal" }> =>
      entry.type === "agent_loop_operation_terminal",
  );
  assert.equal(operationTerminals[0]?.outcome, "result_unknown");
  assert.equal(cancelReason, "timeout:gateway-timeout-run");
});

test("stdio sidecar connection reports malformed stdout and exit diagnostics", async () => {
  const malformed = createStdioAgentLoopSidecarConnectionFactory({
    command: process.execPath,
    args: ["--eval", "process.stdout.write('{\\n')"],
  });
  const malformedConnection = await malformed({} as never);
  await assert.rejects(drain(malformedConnection.receive()), /malformed NDJSON/);
  await malformedConnection.close?.();

  const failed = createStdioAgentLoopSidecarConnectionFactory({
    command: process.execPath,
    args: ["--eval", "process.stderr.write('sidecar startup failed'); process.exit(9)"],
  });
  const failedConnection = await failed({} as never);
  await assert.rejects(
    drain(failedConnection.receive()),
    /exited with code 9 before execute reached a terminal event\. stderr: sidecar startup failed/,
  );
  await failedConnection.close?.();
});

test("sidecar host capability calls reconstruct plan/todo and host execution services", async () => {
  const moduleResponses: Array<Record<string, unknown>> = [];
  const toolContexts: PilotDeckToolRuntimeContext[] = [];
  const toolExecutions: Array<{ operationDeadline?: string }> = [];
  const routedModelContexts: Array<Record<string, unknown>> = [];
  const auditRecorder = {};
  const elicitation = {};
  const fileHistory = {};
  const fileUpdateNotifier = {};
  const planFileManager = {
    getPlanDirectoryPath: () => "/workspace/.pilotdeck/plans",
    resolvePlanFilePath: (filePath: string) => `/workspace/.pilotdeck/plans/${filePath}`,
    readPlanFile: (filePath: string) => `# ${filePath}`,
  };
  const snapshot = {
    ...createPlanTodoSnapshot(),
    approvedPlan: "# Approved plan\nWrite the artifact.",
    requiresInitialization: true,
  };
  const handle: PilotDeckPlanTodoStateHandle = {
    getSnapshot: () => structuredClone(snapshot),
    async markPlanApproved() {},
    async recordTodoWrite() { return []; },
    async writeTodos() { return []; },
    async markToolProgressChanged() {},
    buildPromptAddendum: () => "host plan/todo prompt",
    blockingMessageFor: () => undefined,
  };
  const tools: ToolPort = {
    list: () => [
      {
        name: "write",
        description: "write",
        kind: "custom",
        inputSchema: { type: "object" },
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        execute: async () => ({ content: [] }),
      },
    ],
    async executeAll(calls, context, execution) {
      toolContexts.push(context);
      toolExecutions.push(execution);
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [],
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.001Z",
      }));
    },
  };
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => planTodoFenceConnection(moduleResponses),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "plan-todo-host-session",
    config: {
      ...config(),
      env: { HOST_EXECUTION_ENV: "present" },
      toolAliases: { legacy_write: "write" },
      maxResultBytes: 777,
      maxOutputTokens: 321,
      subagentDepth: 1,
      subagentTimeoutMs: 456,
    },
    dependencies: {
      router: {} as never,
      ports: {
        model: noopModel(),
        tools,
        auxiliaryModel: {
          async *stream(_request, signal) {
            routedModelContexts.push({
              sessionId: "plan-todo-host-session",
              turnId: "plan-todo-host-turn",
              projectPath: "/workspace",
              abortSignal: signal,
              isMainAgent: false,
            });
          },
        },
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      planTodoManager: { forSession: () => handle },
      auditRecorder: auditRecorder as never,
      elicitation: elicitation as never,
      fileHistory: fileHistory as never,
      fileUpdateNotifier: fileUpdateNotifier as never,
      planFileManager,
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "write it" }, {
    turnId: "plan-todo-host-turn",
    execution: {
      runId: "plan-todo-host-run",
      operationId: "plan-todo-host-operation",
      operationDeadline: "2099-09-11T00:00:00.000Z",
    },
  })) {
    events.push(event);
  }

  const rejected = moduleResponses.find((response) => response.inReplyTo === "wrong-plan-todo");
  assert.equal(rejected?.ok, false);
  assert.match(String((rejected?.error as Record<string, unknown> | undefined)?.message), /identity does not match/);
  const accepted = moduleResponses.find((response) => response.inReplyTo === "valid-plan-todo");
  assert.equal(accepted?.ok, true);
  assert.deepEqual((accepted?.payload as Record<string, unknown> | undefined)?.snapshot, snapshot);
  const executed = moduleResponses.find((response) => response.inReplyTo === "execute-with-plan-todo");
  assert.equal(executed?.ok, true, JSON.stringify(executed));
  assert.equal(toolContexts.length, 1);
  assert.equal(toolExecutions[0]?.operationDeadline, "2099-09-11T00:00:00.000Z");
  assert.equal(toolContexts[0]?.sessionId, "plan-todo-host-session");
  assert.equal(toolContexts[0]?.turnId, "plan-todo-host-turn");
  assert.equal(toolContexts[0]?.planTodo, handle);
  assert.equal(toolContexts[0]?.messageId, "plan-todo-host-turn");
  assert.equal(typeof toolContexts[0]?.auditRecorder?.recordTool, "function");
  assert.equal(typeof toolContexts[0]?.elicitation?.askUser, "function");
  assert.equal(toolContexts[0]?.fileHistory, fileHistory);
  assert.equal(toolContexts[0]?.fileUpdateNotifier, fileUpdateNotifier);
  assert.equal(toolContexts[0]?.env?.HOST_EXECUTION_ENV, "present");
  assert.equal(toolContexts[0]?.env?.PILOTDECK_SESSION_ID, "plan-todo-host-session");
  assert.equal(toolContexts[0]?.env?.PILOTDECK_TURN_ID, "plan-todo-host-turn");
  assert.deepEqual(toolContexts[0]?.toolAliases, { legacy_write: "write" });
  assert.equal(toolContexts[0]?.maxResultBytes, 777);
  assert.equal(toolContexts[0]?.maxOutputTokens, 321);
  assert.equal(toolContexts[0]?.subagentDepth, 1);
  assert.equal(toolContexts[0]?.subagentTimeoutMs, 456);
  assert.equal(toolContexts[0]?.planDirectory?.path, "/workspace/.pilotdeck/plans");
  assert.equal(toolContexts[0]?.planDirectory?.resolve("proposal.md"), "/workspace/.pilotdeck/plans/proposal.md");
  assert.equal(toolContexts[0]?.planDirectory?.read("proposal.md"), "# proposal.md");
  assert.equal(typeof toolContexts[0]?.model?.stream, "function");
  for await (const _event of toolContexts[0]!.model!.stream({
    provider: "host-provider",
    model: "host-model",
    messages: [],
  }, new AbortController().signal)) {
    // The injected host routing port has no events in this focused test.
  }
  assert.deepEqual(routedModelContexts, [{
    sessionId: "plan-todo-host-session",
    turnId: "plan-todo-host-turn",
    projectPath: "/workspace",
    abortSignal: routedModelContexts[0]?.abortSignal,
    isMainAgent: false,
  }]);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
});

test("sidecar compaction rebuilds candidate requests through host context and the bound preparation", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const preparationInputs: Array<Record<string, unknown>> = [];
  const modelPreparationRequests: Array<Record<string, unknown>> = [];
  const materializedCandidates: Array<Record<string, unknown>> = [];
  const evaluatedRequests: Array<Record<string, unknown>> = [];
  const manifests: Array<Record<string, unknown>> = [];
  const moduleResponses: Array<Record<string, unknown>> = [];
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => compactionContextConnection(manifests, moduleResponses),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "compaction-host-session",
    config: { ...config(), maxContextTokens: 128_000 },
    dependencies: {
      router: {} as never,
      ports: {
        model: {
          async prepare({ request }) {
            modelPreparationRequests.push(structuredClone(request as unknown as Record<string, unknown>));
            return {
              request: {
                ...request,
                systemPrompt: `host prepared: ${request.systemPrompt ?? ""}`,
                metadata: { ...request.metadata, hostRouteMaterialized: true },
              },
              provider: request.provider,
              model: request.model,
              opaque: { route: `${request.provider}/${request.model}` },
            };
          },
          async *stream() {},
        },
        tools: noopTools(),
        budget: {
          async evaluateRequestBudget(request, options) {
            evaluatedRequests.push({ request: request as unknown as Record<string, unknown>, options: { ...options, signal: undefined } });
            return {
              tokens: 240,
              maxContextTokens: options.maxContextTokens,
              warningRatio: 0.8,
              blockingRatio: 0.9,
              state: "ok",
              ratio: 240 / options.maxContextTokens,
            };
          },
        },
        routing: {
          materializeRequest(decision, request) {
            materializedCandidates.push({ prepared: decision as unknown as Record<string, unknown>, request });
            return {
              ...request,
              systemPrompt: `router materialized: ${"R".repeat(1024)}`,
              tools: [{ name: "routed_tool", description: "T".repeat(1024), inputSchema: { type: "object" } }],
            };
          },
        },
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      context: {
        async prepareForModel(input) {
          preparationInputs.push(structuredClone(input as unknown as Record<string, unknown>));
          return {
            messages: [
              { role: "user", content: [{ type: "text", text: "host runtime prefix" }] },
              ...input.messages.filter((message) => !message.content.some((block) => block.type === "tool_result")),
            ],
            systemPrompt: "host runtime context",
            systemPromptParts: [],
            tools: input.tools,
            diagnostics: [],
            boundaries: [],
          };
        },
        async tryAutoCompact(input) {
          inputs.push(input as unknown as Record<string, unknown>);
          assert.equal(typeof input.budgetEvaluator, "function");
          const snapshot = await input.budgetEvaluator?.([{
            role: "user",
            content: [{ type: "text", text: "candidate" }],
          }, {
            role: "user",
            content: [{
              type: "tool_result",
              toolCallId: "orphan-result",
              content: [{ type: "text", text: "orphan tool result" }],
            }],
          }]);
          return {
            type: "skipped" as const,
            snapshot: snapshot ?? {
              tokens: 0,
              maxContextTokens: input.maxContextTokens ?? 0,
              warningRatio: 0,
              blockingRatio: 0,
              state: "ok" as const,
              ratio: 0,
            },
          };
        },
      },
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "compact" }, {
    turnId: "compaction-host-turn",
  })) {
    events.push(event);
  }

  assert.equal(inputs.length, 3, JSON.stringify(events));
  assert.equal(((manifests[0]?.budget as Record<string, unknown> | undefined)?.methods as unknown[]).includes("evaluate_request_budget"), true);
  assert.equal(inputs[0]?.maxContextTokens, 128_000);
  assert.equal(inputs[1]?.maxContextTokens, 32_000);
  assert.equal(inputs[0]?.budgetStage, "pre_route");
  assert.equal(inputs[1]?.budgetStage, "routed");
  assert.equal(inputs[2]?.budgetStage, "recovery");
  assert.equal(inputs[0]?.sessionId, "compaction-host-session");
  assert.equal(inputs[0]?.turnId, "compaction-host-turn");
  assert.ok(moduleResponses.every((response) => response.ok === true), JSON.stringify(moduleResponses));
  assert.equal(evaluatedRequests.length, 3);
  assert.equal(preparationInputs.length, 3);
  assert.equal(modelPreparationRequests.length, 2);
  assert.equal(materializedCandidates.length, 2);
  assert.deepEqual((preparationInputs[0]?.messages as unknown[]), [{
    role: "user",
    content: [{ type: "text", text: "candidate" }],
  }, {
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: "orphan-result",
      content: [{ type: "text", text: "orphan tool result" }],
    }],
  }]);
  assert.equal(preparationInputs[0]?.previewOnly, true);
  assert.equal((evaluatedRequests[0]?.request as Record<string, unknown>).systemPrompt, "host runtime context");
  assert.equal(((evaluatedRequests[0]?.request as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.hostRouteMaterialized, undefined);
  assert.equal(((evaluatedRequests[0]?.request as Record<string, unknown>).tools as unknown[]).length, 1);
  assert.deepEqual((evaluatedRequests[0]?.request as Record<string, unknown>).messages, [{
    role: "user",
    content: [{ type: "text", text: "host runtime prefix" }],
  }, {
    role: "user",
    content: [{ type: "text", text: "candidate" }],
  }]);
  assert.equal(JSON.stringify((evaluatedRequests[0]?.request as Record<string, unknown>).messages).includes("orphan tool result"), false);
  assert.equal((evaluatedRequests[0]?.options as Record<string, unknown>).maxContextTokens, 128_000);
  assert.equal((evaluatedRequests[1]?.options as Record<string, unknown>).maxContextTokens, 32_000);
  assert.equal((evaluatedRequests[2]?.options as Record<string, unknown>).maxContextTokens, 16_000);
  assert.match(String((evaluatedRequests[1]?.request as Record<string, unknown>).systemPrompt), /^router materialized:/);
  assert.equal(((evaluatedRequests[1]?.request as Record<string, unknown>).tools as Array<{ name: string }>)[0]?.name, "routed_tool");
  assert.match(String((evaluatedRequests[2]?.request as Record<string, unknown>).systemPrompt), /^router materialized:/);
});

test("sidecar compaction rejects malformed or cross-route calibration before host context", async () => {
  let contextCalls = 0;
  const dispatcher = createSidecarDefaultModuleDispatcher({
    config: config(),
    input: {
      sessionId: "calibration-host-session",
      turnId: "calibration-host-turn",
      messages: [],
    },
    checkpoint: new HostToolCheckpoint({}),
    capabilityResultObserver: { onCapabilityResults: async () => undefined },
    planTodoHandler: async () => ({}),
    modules: {
      model: { execution: noopModel() },
      budget: {
        async evaluateRequestBudget() {
          throw new Error("must not evaluate invalid calibration");
        },
      },
      capability: {
        execution: noopTools(),
        runtimeContext: {
          bindTurn: () => ({
            permissionContext: () => config().permissionContext,
            toolRuntimeContext: () => ({} as never),
            executionContext: () => ({} as never),
            contextIdentity: (source) => ({ ...(source ?? {}) }),
          }),
        },
      },
      context: {
        execution: {
          async prepareForModel(input) {
            return { messages: input.messages, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] };
          },
          async tryAutoCompact() {
            contextCalls += 1;
            throw new Error("must not reach context for invalid calibration");
          },
        },
        requestIdentity: {
          bindTurn: () => ({ contextIdentity: (source) => ({ ...(source ?? {}) }) }),
        },
      },
    },
  });
  const handler = dispatcher.handlers.context!;
  const request = (calibration: Record<string, unknown>) => handler({
    kind: "request",
    messageId: `calibration-${String(calibration.provider)}`,
    method: "module_call",
    runId: "run-calibration",
    operationId: "operation-calibration",
    requestId: "request-calibration",
    module: "context",
    payload: {
      operation: "try_auto_compact",
      input: {
        messages: [],
        maxContextTokens: 1_024,
        budgetRequest: { provider: "provider-a", model: "model-a", messages: [], tools: [] },
        budgetPreparation: {
          sessionId: "calibration-host-session",
          turnId: "calibration-host-turn",
          provider: "provider-a",
          model: "model-a",
          tools: [],
        },
        budgetCalibration: calibration,
      },
    },
  } as never);

  await assert.rejects(
    () => request({ provider: "provider-b", model: "model-a", actualInputTokens: 10, estimatedInputTokens: 8 }),
    (error: Error & { code?: string }) => error.message.includes("does not match the request route")
      && error.code === "COMPACTION_BUDGET_CONTRACT_INVALID",
  );
  await assert.rejects(
    () => request({ provider: "provider-a", model: "model-a", actualInputTokens: -1, estimatedInputTokens: 8 }),
    (error: Error & { code?: string }) => error.message.includes("actualInputTokens must be positive")
      && error.code === "COMPACTION_BUDGET_CONTRACT_INVALID",
  );
  assert.equal(contextCalls, 0);
  await dispatcher.dispose();
});

test("sidecar dispatcher advertises and serves a narrow host model metadata snapshot", async () => {
  const dispatcher = createSidecarDefaultModuleDispatcher({
    config: config(),
    input: { sessionId: "metadata-host-session", turnId: "metadata-host-turn", messages: [] },
    checkpoint: new HostToolCheckpoint({}),
    capabilityResultObserver: { onCapabilityResults: async () => undefined },
    planTodoHandler: async () => ({}),
    modules: {
      model: {
        execution: noopModel(),
        metadata: {
          getModelMaxContextTokens: () => 4096,
          getModelMaxOutputTokens: () => 1024,
          getModelTokenLimits: () => ({ maxContextTokens: 4096, maxOutputTokens: 1024 }),
          getModelProtocol: () => "anthropic",
          getModelSupportsPromptCache: () => true,
        },
      },
      capability: {
        execution: noopTools(),
        runtimeContext: {
          bindTurn: () => ({
            permissionContext: () => config().permissionContext,
            toolRuntimeContext: () => ({} as never),
            executionContext: () => ({} as never),
            contextIdentity: (source) => ({ ...(source ?? {}) }),
          }),
        },
      },
    },
  });

  assert.deepEqual((dispatcher.manifest.hostModules.model as { methods: string[] }).methods, [
    "prepare", "stream", "stream_next", "close_stream", "get_metadata",
  ]);
  const response = await dispatcher.handlers.model!({
    kind: "request",
    messageId: "metadata-call",
    method: "module_call",
    runId: "metadata-run",
    operationId: "metadata-operation",
    requestId: "metadata-request",
    module: "model",
    payload: { operation: "get_metadata", provider: "provider-a", model: "model-a" },
  } as never);
  assert.deepEqual(response, {
    metadata: {
      provider: "provider-a",
      model: "model-a",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      tokenLimits: { maxContextTokens: 4096, maxOutputTokens: 1024 },
      protocol: "anthropic",
      supportsPromptCache: true,
    },
  });
  await dispatcher.dispose();
});

test("sidecar dispatcher legacy stream uses its cached prepared request when omitted", async () => {
  let streamedRequest: Record<string, unknown> | undefined;
  const dispatcher = createSidecarDefaultModuleDispatcher({
    config: config(),
    input: { sessionId: "legacy-stream-session", turnId: "legacy-stream-turn", messages: [] },
    checkpoint: new HostToolCheckpoint({}),
    capabilityResultObserver: { onCapabilityResults: async () => undefined },
    planTodoHandler: async () => ({}),
    modules: {
      model: {
        execution: {
          async prepare({ request }) {
            return {
              request: { ...request, systemPrompt: "cached prepared prompt" },
              provider: request.provider,
              model: request.model,
            };
          },
          async *stream({ prepared }) {
            streamedRequest = prepared.request as unknown as Record<string, unknown>;
            yield { type: "message_start", role: "assistant" } as const;
            yield { type: "message_end", finishReason: "stop" } as const;
          },
        },
      },
      capability: {
        execution: noopTools(),
        runtimeContext: {
          bindTurn: () => ({
            permissionContext: () => config().permissionContext,
            toolRuntimeContext: () => ({} as never),
            executionContext: () => ({} as never),
            contextIdentity: (source) => ({ ...(source ?? {}) }),
          }),
        },
      },
    },
  });
  const handler = dispatcher.handlers.model!;
  const identity = {
    kind: "request",
    method: "module_call",
    runId: "legacy-stream-run",
    operationId: "legacy-stream-operation",
    requestId: "legacy-stream-request",
    module: "model",
  } as const;
  await handler({
    ...identity,
    messageId: "legacy-stream-prepare",
    payload: {
      operation: "prepare",
      preparationId: "legacy-preparation",
      request: { provider: "host-provider", model: "host-model", messages: [] },
    },
  } as never);
  const response = await handler({
    ...identity,
    messageId: "legacy-stream-call",
    payload: { operation: "stream", preparationId: "legacy-preparation" },
  } as never);

  assert.equal(streamedRequest?.systemPrompt, "cached prepared prompt");
  assert.deepEqual(response, {
    events: [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ],
  });
  await dispatcher.dispose();
});

test("sidecar dispatcher materializes a prepared request through the narrow host routing capability", async () => {
  const materialized: Array<Record<string, unknown>> = [];
  const dispatcher = createSidecarDefaultModuleDispatcher({
    config: config(),
    input: { sessionId: "materialize-session", turnId: "materialize-turn", messages: [] },
    checkpoint: new HostToolCheckpoint({}),
    capabilityResultObserver: { onCapabilityResults: async () => undefined },
    planTodoHandler: async () => ({}),
    modules: {
      model: {
        execution: {
          async prepare({ request }) {
            return {
              request: { ...request, systemPrompt: "prepared prompt", tools: [{ name: "prepared_tool", inputSchema: { type: "object" } }], maxOutputTokens: 64 },
              provider: request.provider,
              model: request.model,
              opaque: { hostOnly: true },
            };
          },
          async *stream() { yield { type: "message_end", finishReason: "stop" } as const; },
        },
        materializeRequest(prepared, request) {
          materialized.push({ opaque: prepared.opaque, request });
          return { ...request, systemPrompt: "router prompt", tools: [{ name: "router_tool", inputSchema: { type: "object" } }], maxOutputTokens: 32 };
        },
      },
      capability: {
        execution: noopTools(),
        runtimeContext: {
          bindTurn: () => ({
            permissionContext: () => config().permissionContext,
            toolRuntimeContext: () => ({} as never),
            executionContext: () => ({} as never),
            contextIdentity: (source) => ({ ...(source ?? {}) }),
          }),
        },
      },
    },
  });
  assert.ok((dispatcher.manifest.hostModules.model as { methods: string[] }).methods.includes("materialize_prepared_request"));
  const handler = dispatcher.handlers.model!;
  const identity = {
    kind: "request", method: "module_call", runId: "materialize-run", operationId: "materialize-operation", requestId: "materialize-request", module: "model",
  } as const;
  await handler({
    ...identity,
    messageId: "materialize-prepare",
    payload: { operation: "prepare", preparationId: "prepared-1", request: { provider: "p", model: "m", messages: [] } },
  } as never);
  const response = await handler({
    ...identity,
    messageId: "materialize-call",
    payload: {
      operation: "materialize_prepared_request",
      preparationId: "prepared-1",
      request: { provider: "p", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "compacted" }] }], systemPrompt: "candidate" },
    },
  } as never);

  assert.deepEqual(materialized[0]?.opaque, { hostOnly: true });
  assert.equal((response.request as { systemPrompt?: string }).systemPrompt, "router prompt");
  assert.equal((response.request as { tools?: Array<{ name: string }> }).tools?.[0]?.name, "router_tool");
  assert.equal((response.request as { maxOutputTokens?: number }).maxOutputTokens, 32);
  await dispatcher.dispose();
});

test("sidecar agent tool delegates through the host-owned one-shot subagent port", async () => {
  const forkBindings: Array<{ sessionId: string; turnId: string; parentFiles: number }> = [];
  const forkRequests: Array<{ definitionId: string; directive: string; subagentId: string }> = [];
  let transportSeed: AgentLoopSeedState | undefined;
  const oneShotSubagentPort: OneShotSubagentPort = {
    createForkApi(input) {
      forkBindings.push({
        sessionId: input.sessionId,
        turnId: input.turnId,
        parentFiles: input.parentReadFileState?.size ?? 0,
      });
      return {
        depth: 0,
        maxSubagentDepth: 1,
        listDefinitions: () => [{ id: "explore", description: "Inspect" }],
        isAllowedDefinition: (id) => id === "explore",
        async fork(request) {
          forkRequests.push({
            definitionId: request.definitionId,
            directive: request.directive,
            subagentId: request.subagentId,
          });
          return {
            markdown: "Scope: delegated\nResult: complete",
            usage: { totalTokens: 2 },
            turns: 1,
            durationMs: 3,
            subagentSessionId: "sidecar-subagent-session::sub::sidecar-child",
            transcriptRelativePath: "sessions/sidecar-subagent-session/subagents/sidecar-child.jsonl",
          };
        },
      };
    },
  };
  const agentTool: PilotDeckToolDefinition = {
    name: "agent",
    description: "Delegates through the host-owned subagent port.",
    kind: "agent",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(_arguments, context) {
      assert.ok(context.subagent, "host tool execution must receive a one-shot subagent port");
      const report = await context.subagent.fork({
        definitionId: "explore",
        directive: "Inspect the host-owned delegation boundary.",
        subagentId: "sidecar-child",
        toolCallId: context.currentToolCallId,
      });
      return {
        content: [{ type: "text", text: report.markdown }],
        data: {
          subagentSessionId: report.subagentSessionId,
          transcriptRelativePath: report.transcriptRelativePath,
        },
        metadata: {
          subagentSessionId: report.subagentSessionId,
          transcriptRelativePath: report.transcriptRelativePath,
        },
      };
    },
  };
  const tools: ToolPort = {
    list: () => [agentTool],
    async executeAll(calls, context) {
      return Promise.all(calls.map(async (call) => {
        const output = await agentTool.execute(call.input, context);
        return {
          type: "success" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: output.content,
          data: output.data,
          metadata: output.metadata,
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:00.001Z",
        };
      }));
    },
  };
  let modelCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "delegate-call", name: "agent", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "delegation complete" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "sidecar-subagent-session",
    config: {
      ...config(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: "/workspace",
        mode: "bypassPermissions",
        bypassAvailable: true,
        canPrompt: false,
      }),
    },
    seedState: {
      readFileState: new Map([["/workspace/already-read.txt", { mtimeMs: 1, kind: "text" }]]),
    },
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      oneShotSubagentPort,
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: (input) => {
        transportSeed = input.seedState;
        return loopbackConnection();
      },
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "delegate" }, {
    turnId: "sidecar-subagent-turn",
  })) {
    events.push(event);
  }

  assert.equal(modelCalls, 2);
  assert.equal(transportSeed?.readFileState?.size, 1);
  assert.deepEqual(forkBindings, [{
    sessionId: "sidecar-subagent-session",
    turnId: "sidecar-subagent-turn",
    parentFiles: 1,
  }]);
  assert.equal(forkRequests.length, 1);
  assert.deepEqual(forkRequests[0]?.definitionId, "explore");
  assert.equal(forkRequests[0]?.directive, "Inspect the host-owned delegation boundary.");
  const toolResult = events.find((event) => event.type === "tool_result") as {
    result?: {
      type?: string;
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  } | undefined;
  assert.equal(toolResult?.result?.type, "success");
  assert.equal(toolResult?.result?.data?.subagentSessionId, "sidecar-subagent-session::sub::sidecar-child");
  assert.equal(toolResult?.result?.data?.transcriptRelativePath, "sessions/sidecar-subagent-session/subagents/sidecar-child.jsonl");
  assert.equal(toolResult?.result?.metadata?.subagentSessionId, "sidecar-subagent-session::sub::sidecar-child");
  assert.equal(toolResult?.result?.metadata?.transcriptRelativePath, "sessions/sidecar-subagent-session/subagents/sidecar-child.jsonl");
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success", JSON.stringify(events));
});

test("sidecar lifecycle calls run with host-owned turn identity and environment", async () => {
  const moduleResponses: Array<Record<string, unknown>> = [];
  const lifecycle = new RecordingLifecycleRuntime();
  const factory = createAgentLoopSidecarRuntimeFactory({
    connect: () => lifecycleFenceConnection(moduleResponses),
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId: "lifecycle-host-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      lifecycle,
    },
    agentLoopFactory: factory,
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "stop" }, { turnId: "lifecycle-host-turn" })) {
    events.push(event);
  }

  assert.equal(moduleResponses.find((response) => response.inReplyTo === "lifecycle-dispatch")?.ok, true);
  const input = lifecycle.inputs.find((candidate) => candidate.event === "Stop");
  assert.ok(input);
  assert.equal(input.event, "Stop");
  assert.deepEqual(input.payload, { lastAssistantMessage: "done" });
  assert.deepEqual(input.baseInput, {
    sessionId: "lifecycle-host-session",
    transcriptPath: "",
    cwd: "/workspace",
    permissionMode: "default",
  });
  assert.equal(input.matchQuery, "Stop");
  assert.equal(input.env?.PILOTDECK_SESSION_ID, "lifecycle-host-session");
  assert.equal(input.env?.PILOTDECK_TURN_ID, "lifecycle-host-turn");
  assert.equal(events.find((event) => event.type === "turn_completed")?.type, "turn_completed");
});

test("loopback sidecar flushes AgentLoop-emitted events to the host before final", async () => {
  const hostEvents: Array<{ type: string; sessionId: string; turnId?: string }> = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "event bridge complete" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "event-bridge-session",
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      eventEmitter: (event) => hostEvents.push(event),
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "emit an instruction event" }, {
    turnId: "event-bridge-turn",
  })) {
    events.push(event);
  }

  assert.deepEqual(hostEvents.find((event) => event.type === "instructions_loaded"), {
    type: "instructions_loaded",
    sessionId: "event-bridge-session",
    turnId: "event-bridge-turn",
    hasSystemPrompt: false,
  });
  assert.equal(events.find((event) => event.type === "turn_completed")?.type, "turn_completed");
});

test("sidecar binds the auxiliary model before executing web_fetch in llm mode", async () => {
  let primaryCalls = 0;
  const bindings: Array<{ sessionId: string; turnId: string; projectPath?: string }> = [];
  let auxiliaryCalls = 0;
  const webFetch = createWebFetchTool({
    fetchUrl: async () => ({
      bytes: 18,
      code: 200,
      codeText: "OK",
      content: "PilotDeck source page",
      contentType: "text/markdown",
      fromCache: false,
    }),
  });
  const model: ModelInvokerPort = {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {
      yield { type: "message_start", role: "assistant" };
      if (++primaryCalls === 1) {
        yield { type: "tool_call_end", toolCall: {
          id: "fetch-1",
          name: "web_fetch",
          input: { url: "https://example.com", prompt: "Summarize the source" },
        } };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "fetched" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const auxiliary = {
    forTurn: (binding: { sessionId: string; turnId: string; projectPath?: string }) => {
      bindings.push(binding);
      return {
        async *stream() {
          auxiliaryCalls += 1;
          yield { type: "text_delta" as const, text: "source summary" };
          yield { type: "message_end" as const, finishReason: "stop" as const };
        },
      };
    },
    async *stream() { throw new Error("Auxiliary model must be bound before use."); },
  };
  const tools: ToolPort = {
    list: () => [webFetch],
    async executeAll(calls, context) {
      return Promise.all(calls.map(async (call) => {
        const output = await webFetch.execute(call.input as never, context);
        return {
          type: "success" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: output.content,
          data: output.data,
          startedAt: "2026-09-17T00:00:00.000Z",
          completedAt: "2026-09-17T00:00:00.001Z",
        };
      }));
    },
  };
  const session = createAgentSession({
    sessionId: "auxiliary-model-session",
    config: { ...config(), permissionMode: "bypassPermissions", permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "bypassPermissions" }) },
    dependencies: {
      router: {} as never,
      ports: { model, tools, auxiliaryModel: auxiliary },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({ connect: () => loopbackConnection(), uuid: deterministicIds() }),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "Fetch and summarize" }, { turnId: "auxiliary-model-turn" })) events.push(event);

  assert.equal(auxiliaryCalls, 1);
  assert.deepEqual(bindings, [{ sessionId: "auxiliary-model-session", turnId: "auxiliary-model-turn", projectPath: "/workspace" }]);
  assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "success");
  await session.dispose();
});

test("sidecar binds routing once per turn and clears a completed non-orchestration tier", async () => {
  const preparedMetadata: Array<Record<string, unknown> | undefined> = [];
  const invalidations: string[] = [];
  const model: ModelInvokerPort = {
    async prepare({ request, context }) {
      preparedMetadata.push(context.metadata);
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const modules = createSidecarModuleComposition({
    model,
    routing: {
      invalidateSticky(sessionId: string) {
        invalidations.push(sessionId);
        return {
          previousTier: "complex",
          previousProvider: "previous-provider",
          previousModel: "previous-model",
          orchestrating: false,
        };
      },
    },
    toolExecution: noopTools(),
  });
  const bound = modules.model.bindTurn?.({ sessionId: "routing-session", turnId: "routing-turn" });
  assert.ok(bound);
  const context = { sessionId: "routing-session", turnId: "routing-turn", runId: "routing-run" };
  const prepared = await bound.execution.prepare({ request: { provider: "primary", model: "model", messages: [] }, context });
  for await (const _ of bound.execution.stream({ prepared, context })) {
    // Consume the host stream to settle the turn-local routing tier.
  }
  await bound.execution.prepare({ request: { provider: "primary", model: "model", messages: [] }, context });

  assert.deepEqual(invalidations, ["routing-session"]);
  assert.deepEqual(preparedMetadata, [
    { previousTier: "complex", previousProvider: "previous-provider", previousModel: "previous-model" },
    { previousProvider: "previous-provider", previousModel: "previous-model" },
  ]);
});

test("sidecar runner binds host routing before every submitted turn", async () => {
  const invalidations: string[] = [];
  const prepareMetadata: Array<Record<string, unknown> | undefined> = [];
  const model: ModelInvokerPort = {
    async prepare({ request, context }) {
      prepareMetadata.push(context.metadata);
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    sessionId: "runner-routing-session",
    config: config(),
    dependencies: {
      router: {
        invalidateSticky(sessionId: string) {
          invalidations.push(sessionId);
          return { previousTier: "medium", previousProvider: "previous", previousModel: "model", orchestrating: false };
        },
      } as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({ connect: () => loopbackConnection(), uuid: deterministicIds() }),
  });

  for await (const _ of session.submit({ type: "text", text: "first" }, { turnId: "runner-routing-turn-1" })) {}
  for await (const _ of session.submit({ type: "text", text: "second" }, { turnId: "runner-routing-turn-2" })) {}

  assert.deepEqual(invalidations, ["runner-routing-session", "runner-routing-session"]);
  assert.deepEqual(prepareMetadata, [
    { previousTier: "medium", previousProvider: "previous", previousModel: "model" },
    { previousTier: "medium", previousProvider: "previous", previousModel: "model" },
  ]);
  await session.dispose();
});

test("production sidecar refreshes a host-owned deferred tool catalog before the next model request", async () => {
  let revealed = false;
  let modelCalls = 0;
  const visibleTools: string[][] = [];
  const revealTool = toolDefinition("reveal_tool", false);
  const deferredTool = toolDefinition("deferred_tool", true);
  const tools: ToolPort = {
    list: () => revealed ? [revealTool, deferredTool] : [revealTool],
    async executeAll(calls) {
      if (calls.some((call) => call.name === "reveal_tool")) revealed = true;
      return calls.map((call) => successfulToolResult(call));
    },
  };
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      visibleTools.push((request.tools ?? []).map((tool) => tool.name));
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      if (++modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "reveal-1", name: "reveal_tool", input: {} } } as const;
        yield { type: "message_end", finishReason: "tool_call" } as const;
        return;
      }
      yield { type: "text_delta", text: "deferred catalog refreshed" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const session = sidecarSession("deferred-catalog-session", model, tools);

  for await (const _ of session.submit({ type: "text", text: "reveal the next tool" }, {
    turnId: "deferred-catalog-turn",
  })) {}

  assert.deepEqual(visibleTools, [["reveal_tool"], ["reveal_tool", "deferred_tool"]]);
  await session.dispose();
});

test("production sidecar preserves host prepare request materialization through execution", async () => {
  let streamedRequest: Record<string, unknown> | undefined;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return {
        request: {
          ...request,
          systemPrompt: "host materialized prompt",
          maxOutputTokens: 321,
          metadata: { preparedByHost: true },
        },
        provider: request.provider,
        model: request.model,
      };
    },
    async *stream({ prepared }) {
      streamedRequest = prepared.request as unknown as Record<string, unknown>;
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "text_delta", text: "materialized" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const session = sidecarSession("prepared-request-session", model, noopTools());

  for await (const _ of session.submit({ type: "text", text: "use the prepared request" }, {
    turnId: "prepared-request-turn",
  })) {}

  assert.equal(streamedRequest?.systemPrompt, "host materialized prompt");
  assert.equal(streamedRequest?.maxOutputTokens, 321);
  assert.deepEqual(streamedRequest?.metadata, { preparedByHost: true });
  await session.dispose();
});

test("prepared output caps constrain normal native and sidecar requests before provider limits", async () => {
  const run = async (
    kind: "native" | "sidecar",
    providerLimit?: number,
  ): Promise<number | undefined> => {
    let streamedCap: number | undefined;
    const model: ModelInvokerPort = {
      async prepare({ request }) {
        return {
          request: { ...request, maxOutputTokens: 64 },
          provider: request.provider,
          model: request.model,
        };
      },
      async *stream({ prepared }) {
        streamedCap = prepared.request.maxOutputTokens;
        yield { type: "message_start", role: "assistant" } as const;
        yield { type: "text_delta", text: "done" } as const;
        yield { type: "message_end", finishReason: "stop" } as const;
      },
    };
    const session = createAgentSession({
      sessionId: `${kind}-prepared-cap-${providerLimit ?? "none"}`,
      config: { ...config(), maxOutputTokens: 200 },
      dependencies: {
        router: {} as never,
        ports: {
          model,
          tools: noopTools(),
          ...(providerLimit === undefined ? {} : {
            metadata: { getModelTokenLimits: () => ({ maxContextTokens: 8_192, maxOutputTokens: providerLimit }) },
          }),
        },
        tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      ...(kind === "sidecar" ? {
        agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
          connect: () => loopbackConnection(),
          uuid: deterministicIds(),
        }),
      } : {}),
    });
    for await (const _event of session.submit({ type: "text", text: "respect the prepared cap" }, {
      turnId: `${kind}-prepared-cap-turn-${providerLimit ?? "none"}`,
    })) {}
    await session.dispose();
    return streamedCap;
  };

  assert.deepEqual(await Promise.all([
    run("native"),
    run("sidecar"),
  ]), [64, 64]);
  assert.deepEqual(await Promise.all([
    run("native", 48),
    run("sidecar", 48),
  ]), [48, 48]);
});

test("production sidecar applies a steer attachment to host tools only after the steer is durable", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const attachment = "/outside/steer-attachment.txt";
  let modelCalls = 0;
  let session: ReturnType<typeof createAgentSession>;
  const tools: ToolPort = {
    list: () => [toolDefinition("bootstrap", false), toolDefinition("read_attachment", true)],
    async executeAll(calls, context) {
      if (calls[0]?.name === "read_attachment") {
        assert.ok(context.allowedReadFiles?.includes(attachment));
        assert.ok(transcript.entries.some((entry) =>
          entry.type === "durable_message" && entry.message.metadata?.queueItemId === "attachment-steer"));
      }
      return calls.map((call) => successfulToolResult(call));
    },
  };
  const model: ModelInvokerPort = {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.deepEqual(await session.steer({
          turnId: "steer-attachment-turn",
          itemId: "attachment-steer",
          message: {
            role: "user",
            content: [{ type: "text", text: "This attachment is authorized." }],
            metadata: { purpose: "mid_turn_steer", queueItemId: "attachment-steer" },
          },
          allowedReadFiles: [attachment],
        }), { accepted: true });
        yield { type: "tool_call_end", toolCall: { id: "bootstrap-1", name: "bootstrap", input: {} } } as const;
        yield { type: "message_end", finishReason: "tool_call" } as const;
        return;
      }
      if (modelCalls === 2) {
        yield { type: "tool_call_end", toolCall: { id: "attachment-1", name: "read_attachment", input: {} } } as const;
        yield { type: "message_end", finishReason: "tool_call" } as const;
        return;
      }
      yield { type: "text_delta", text: "attachment read" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  session = sidecarSession("steer-attachment-session", model, tools, transcript);

  for await (const _ of session.submit({ type: "text", text: "use a later attachment" }, {
    turnId: "steer-attachment-turn",
  })) {}

  assert.equal(modelCalls, 3);
  await session.dispose();
});

test("production sidecar carries persistent model output caps into the next child turn", async () => {
  const executedOutputCaps: Array<number | undefined> = [];
  let streamCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream({ prepared }) {
      executedOutputCaps.push(prepared.request.maxOutputTokens);
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "error",
          error: {
            provider: "host-provider",
            model: "host-model",
            protocol: "openai",
            code: "provider_output_limit",
            message: "provider accepts at most 48 output tokens",
            retryable: false,
          },
        } as const;
        return;
      }
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "text_delta", text: `completed ${streamCalls}` } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const context: NonNullable<AgentRuntimeDependencies["context"]> = {
    async prepareForModel(input) {
      return {
        messages: input.messages,
        systemPrompt: undefined,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      };
    },
    async recoverFromModelError() {
      return {
        type: "adjust_output_and_retry",
        maxOutputTokens: 48,
        reason: "provider-output-cap",
        scope: "hard_cap",
      };
    },
    async captureTurn() {},
  };
  const session = createAgentSession({
    sessionId: "sidecar-model-state-session",
    config: { ...config(), maxOutputTokens: 200 },
    dependencies: {
      router: {} as never,
      ports: { model, tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      context,
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  for await (const _ of session.submit({ type: "text", text: "discover the provider cap" }, {
    turnId: "sidecar-model-state-first",
  })) {}
  for await (const _ of session.submit({ type: "text", text: "reuse the provider cap" }, {
    turnId: "sidecar-model-state-second",
  })) {}

  assert.deepEqual(executedOutputCaps, [200, 48, 48]);
  await session.dispose();
});

test("production sidecar emits host tool progress before a slow tool completes", async () => {
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
  let toolCompleted = false;
  let modelCalls = 0;
  const tools: ToolPort = {
    list: () => [toolDefinition("slow_tool", false)],
    async executeAll(calls, context) {
      context.progress?.({
        type: "tool_progress",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: calls[0]!.id,
        toolName: calls[0]!.name,
        message: "tool started",
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      await toolGate;
      toolCompleted = true;
      return calls.map((call) => successfulToolResult(call));
    },
  };
  const model: ModelInvokerPort = {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      if (++modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "slow-1", name: "slow_tool", input: {} } } as const;
        yield { type: "message_end", finishReason: "tool_call" } as const;
        return;
      }
      yield { type: "text_delta", text: "tool completed" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const session = createAgentSession({
    sessionId: "sidecar-tool-progress-session",
    config: { ...config(), includeToolProgress: true },
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });
  const events: string[] = [];
  let resolveProgress!: () => void;
  const progressSeen = new Promise<void>((resolve) => { resolveProgress = resolve; });
  const consume = (async () => {
    for await (const event of session.submit({ type: "text", text: "run the slow tool" }, {
      turnId: "sidecar-tool-progress-turn",
    })) {
      events.push(event.type);
      if (event.type === "tool_progress") {
        assert.equal(event.message, "tool started");
        assert.equal(toolCompleted, false);
        resolveProgress();
      }
    }
  })();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      progressSeen,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("sidecar did not emit tool progress before completion")), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  releaseTool();
  await consume;

  assert.equal(toolCompleted, true);
  assert.ok(events.indexOf("tool_progress") < events.indexOf("tool_result"));
  await session.dispose();
});

test("production sidecar keeps the host file checkpoint when tool-result durability fails", async () => {
  const checkpointPath = "/workspace/retained-after-durable-failure.txt";
  const transcript = new InMemoryTranscriptWriter();
  const recordDurableMessage = transcript.recordDurableMessage.bind(transcript);
  transcript.recordDurableMessage = (sessionId, turnId, message) => {
    if (message.content.some((block) => block.type === "tool_result")) {
      return Promise.reject(new Error("intentional durable tool result failure"));
    }
    return recordDurableMessage(sessionId, turnId, message);
  };
  let modelCalls = 0;
  const tools: ToolPort = {
    list: () => [toolDefinition("checkpoint_tool", true)],
    async executeAll(calls, context) {
      context.readFileState?.set(checkpointPath, { mtimeMs: 17, kind: "text" });
      return calls.map((call) => successfulToolResult(call));
    },
  };
  const model: ModelInvokerPort = {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {
      yield { type: "message_start", role: "assistant" } as const;
      if (++modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "checkpoint-1", name: "checkpoint_tool", input: {} } } as const;
        yield { type: "message_end", finishReason: "tool_call" } as const;
        return;
      }
      yield { type: "text_delta", text: "unreachable" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const session = createAgentSession({
    sessionId: "sidecar-checkpoint-failure-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });

  for await (const _ of session.submit({ type: "text", text: "update the checkpoint" }, {
    turnId: "sidecar-checkpoint-failure-turn",
  })) {}

  const fileState = session.snapshotForRuntimeReload().fileState;
  assert.ok(fileState);
  assert.equal(fileState.readFileState?.get(checkpointPath)?.mtimeMs, 17);
  assert.equal(fileState.readFileState?.get(checkpointPath)?.kind, "text");
  await session.dispose();
});

function config(): AgentRuntimeConfig {
  return {
    provider: "host-provider",
    model: "host-model",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", canPrompt: false }),
  };
}

class RecordingLifecycleRuntime extends LifecycleRuntime {
  readonly inputs: LifecycleDispatchInput[] = [];

  override async dispatch(input: LifecycleDispatchInput) {
    this.inputs.push(input);
    return emptyLifecycleDispatchResult();
  }
}

function noopModel(): ModelInvokerPort {
  return {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {},
  };
}

function noopTools(): ToolPort {
  return { list: () => [], executeAll: async () => [] };
}

function sidecarSession(
  sessionId: string,
  model: ModelInvokerPort,
  tools: ToolPort,
  transcript?: InMemoryTranscriptWriter,
) {
  return createAgentSession({
    sessionId,
    config: config(),
    ...(transcript ? { transcript } : {}),
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => loopbackConnection(),
      uuid: deterministicIds(),
    }),
  });
}

function toolDefinition(name: string, readOnly: boolean): PilotDeckToolDefinition {
  return {
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [] }),
  };
}

function successfulToolResult(call: { id: string; name: string }) {
  return {
    type: "success" as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [],
    startedAt: "2026-09-17T00:00:00.000Z",
    completedAt: "2026-09-17T00:00:00.001Z",
  };
}

function lookupTool() {
  return {
    name: "lookup",
    description: "lookup state",
    kind: "custom" as const,
    inputSchema: { type: "object" as const },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text" as const, text: "unused" }] }),
  };
}

function builtSidecarPath(): string {
  return resolve(process.cwd(), "dist/src/cli/pilotdeck-agent-loop-sidecar.js");
}

async function drain(values: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of values) {
    // The test only needs to observe the connection's terminal error.
  }
}

function deterministicIds(): () => string {
  let sequence = 0;
  return () => String(++sequence);
}

function loopbackConnection() {
  const sidecarToHost = queue<unknown>();
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AgentLoopSidecarServer(createSidecarExecution, { uuid: deterministicIds() });
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line) sidecarToHost.push(JSON.parse(line));
    }
  });
  void server.serve(input, output).finally(() => sidecarToHost.end());
  return {
    send: (message: unknown) => { input.write(`${JSON.stringify(message)}\n`); },
    receive: () => sidecarToHost,
    close: () => { input.end(); },
  };
}

function planTodoFenceConnection(moduleResponses: Array<Record<string, unknown>>) {
  const responses = queue<unknown>();
  let runId = "";
  let operationId = "";
  let requestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
  };
  const moduleCall = (
    messageId: string,
    module: "model" | "capability",
    payload: Record<string, unknown>,
  ) => ({
    kind: "request",
    messageId,
    method: "module_call",
    runId,
    operationId,
    requestId,
    module,
    payload,
  });
  return {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        responses.push(handshakeResponse(request, {}, "plan-todo-host", capabilities));
        return;
      }
      if (request.method === "capabilities") {
        responses.push(handshakeResponse(request, capabilities, "plan-todo-host", capabilities));
        return;
      }
      if (request.method === "execute") {
        runId = String(request.runId);
        operationId = String(request.operationId);
        requestId = String(request.requestId);
        responses.push({
          kind: "response",
          messageId: "accepted-plan-todo",
          inReplyTo: request.messageId,
          requestId,
          ok: true,
          streamId: "plan-todo-stream",
          cursor: 0,
        });
        responses.push(moduleCall("prepare-host-model", "model", {
          operation: "prepare",
          preparationId: "host-prepare",
          request: { provider: "host-provider", model: "host-model", messages: [] },
        }));
        return;
      }
      if (request.kind !== "response") return;
      moduleResponses.push(structuredClone(request));
      if (request.inReplyTo === "prepare-host-model") {
        responses.push(moduleCall("stream-host-model", "model", {
          operation: "stream",
          preparationId: "host-prepare",
          request: { provider: "host-provider", model: "host-model", messages: [] },
        }));
        return;
      }
      if (request.inReplyTo === "stream-host-model") {
        responses.push(moduleCall("wrong-plan-todo", "capability", {
          operation: "plan_todo",
          method: "read",
          sessionId: "other-session",
          turnId: "other-turn",
        }));
        return;
      }
      if (request.inReplyTo === "wrong-plan-todo") {
        responses.push(moduleCall("valid-plan-todo", "capability", {
          operation: "plan_todo",
          method: "read",
          sessionId: "plan-todo-host-session",
          turnId: "plan-todo-host-turn",
        }));
        return;
      }
      if (request.inReplyTo === "valid-plan-todo") {
        responses.push(moduleCall("execute-with-plan-todo", "capability", {
          operation: "execute",
          toolCallId: "write-call",
          name: "write",
          arguments: {},
          context: {
            currentToolCallId: "untrusted-call-id",
            sessionId: "other-session",
            turnId: "other-turn",
          },
        }));
        return;
      }
      if (request.inReplyTo === "execute-with-plan-todo") {
        responses.push({
          kind: "event",
          eventType: "agent.execute.completed",
          streamId: "plan-todo-stream",
          sequence: 0,
          runId,
          operationId,
          requestId,
          final: true,
          outcome: "completed",
          payload: {
            result: completedResult("plan-todo-host-session", "plan-todo-host-turn"),
            messages: [],
          },
        });
        responses.end();
      }
    },
    receive: () => responses,
  };
}

function lifecycleFenceConnection(moduleResponses: Array<Record<string, unknown>>) {
  const responses = queue<unknown>();
  let runId = "";
  let operationId = "";
  let requestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
  };
  return {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        responses.push(handshakeResponse(request, {}, "lifecycle-host", capabilities));
        return;
      }
      if (request.method === "capabilities") {
        responses.push(handshakeResponse(request, capabilities, "lifecycle-host", capabilities));
        return;
      }
      if (request.method === "execute") {
        runId = String(request.runId);
        operationId = String(request.operationId);
        requestId = String(request.requestId);
        responses.push({
          kind: "response",
          messageId: "accepted-lifecycle",
          inReplyTo: request.messageId,
          requestId,
          ok: true,
          streamId: "lifecycle-stream",
          cursor: 0,
        });
        responses.push({
          kind: "request",
          messageId: "lifecycle-dispatch",
          method: "module_call",
          runId,
          operationId,
          requestId,
          module: "lifecycle",
          payload: {
            operation: "dispatch",
            event: "Stop",
            payload: { lastAssistantMessage: "done" },
          },
        });
        return;
      }
      if (request.kind !== "response" || request.inReplyTo !== "lifecycle-dispatch") return;
      moduleResponses.push(structuredClone(request));
      responses.push({
        kind: "event",
        eventType: "agent.execute.completed",
        streamId: "lifecycle-stream",
        sequence: 0,
        runId,
        operationId,
        requestId,
        final: true,
        outcome: "completed",
        payload: {
          result: completedResult("lifecycle-host-session", "lifecycle-host-turn"),
          messages: [],
        },
      });
      responses.end();
    },
    receive: () => responses,
  };
}

function compactionContextConnection(
  manifests: Array<Record<string, unknown>> = [],
  moduleResponses: Array<Record<string, unknown>> = [],
) {
  const responses = queue<unknown>();
  let runId = "";
  let operationId = "";
  let requestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
  };
  const moduleCall = (messageId: string, input: Record<string, unknown>) => ({
    kind: "request",
    messageId,
    method: "module_call",
    runId,
    operationId,
    requestId,
    module: "context",
    payload: { operation: "try_auto_compact", input },
  });
  const modelPrepareCall = (messageId: string, preparationId: string, request: Record<string, unknown>) => ({
    kind: "request",
    messageId,
    method: "module_call",
    runId,
    operationId,
    requestId,
    module: "model",
    payload: { operation: "prepare", preparationId, request },
  });
  return {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        responses.push(handshakeResponse(request, {}, "context-host", capabilities));
        return;
      }
      if (request.method === "capabilities") {
        responses.push(handshakeResponse(request, capabilities, "context-host", capabilities));
        return;
      }
      if (request.method === "execute") {
        const payload = request.payload as Record<string, unknown> | undefined;
        if (payload?.hostModules && typeof payload.hostModules === "object") {
          manifests.push(payload.hostModules as Record<string, unknown>);
        }
        runId = String(request.runId);
        operationId = String(request.operationId);
        requestId = String(request.requestId);
        responses.push({
          kind: "response",
          messageId: "accepted-context",
          inReplyTo: request.messageId,
          requestId,
          ok: true,
          streamId: "context-stream",
          cursor: 0,
        });
        responses.push(moduleCall("pre-route-compact", {
          messages: [],
          reservedOutputTokens: 8192,
          budgetRequest: {
            provider: "host-provider",
            model: "host-model",
            systemPrompt: "S".repeat(256),
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
            maxOutputTokens: 8192,
            messages: [],
          },
          budgetPreparation: {
            sessionId: "compaction-host-session",
            turnId: "compaction-host-turn",
            cwd: "/workspace",
            provider: "host-provider",
            model: "host-model",
            permissionMode: "default",
            runMode: "agent",
            additionalWorkingDirectories: [],
            messages: [],
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
          },
          budgetProjection: { stage: "pre_route", trigger: "auto", reservedOutputTokens: 8192 },
        }));
        return;
      }
      if (request.kind !== "response") return;
      moduleResponses.push(structuredClone(request));
      if (request.inReplyTo === "pre-route-compact") {
        responses.push(modelPrepareCall("routed-model-prepare", "routed-preparation", {
          provider: "routed-provider", model: "routed-model", messages: [],
        }));
        return;
      }
      if (request.inReplyTo === "routed-model-prepare") {
        responses.push(moduleCall("routed-compact", {
          messages: [],
          maxContextTokens: 32_000,
          budgetRequest: {
            provider: "routed-provider",
            model: "routed-model",
            systemPrompt: "S".repeat(256),
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
            maxOutputTokens: 8192,
            messages: [],
          },
          budgetPreparation: {
            sessionId: "compaction-host-session",
            turnId: "compaction-host-turn",
            cwd: "/workspace",
            provider: "routed-provider",
            model: "routed-model",
            permissionMode: "default",
            runMode: "agent",
            additionalWorkingDirectories: [],
            messages: [],
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
          },
          budgetPreparationId: "routed-preparation",
          budgetProjection: { stage: "routed", trigger: "auto", maxContextTokens: 32_000 },
        }));
        return;
      }
      if (request.inReplyTo === "routed-compact") {
        responses.push(modelPrepareCall("recovery-model-prepare", "recovery-preparation", {
          provider: "recovery-provider", model: "recovery-model", messages: [],
        }));
        return;
      }
      if (request.inReplyTo === "recovery-model-prepare") {
        responses.push(moduleCall("recovery-compact", {
          messages: [],
          maxContextTokens: 16_000,
          budgetRequest: {
            provider: "recovery-provider",
            model: "recovery-model",
            systemPrompt: "S".repeat(256),
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
            maxOutputTokens: 8192,
            messages: [],
          },
          budgetPreparation: {
            sessionId: "compaction-host-session",
            turnId: "compaction-host-turn",
            cwd: "/workspace",
            provider: "recovery-provider",
            model: "recovery-model",
            permissionMode: "default",
            runMode: "agent",
            additionalWorkingDirectories: [],
            messages: [],
            tools: [{ name: "large_tool", description: "T".repeat(256), inputSchema: { type: "object" } }],
          },
          budgetPreparationId: "recovery-preparation",
          budgetProjection: { stage: "recovery", trigger: "model_error", maxContextTokens: 16_000 },
        }));
        return;
      }
      if (request.inReplyTo !== "recovery-compact") return;
      responses.push({
        kind: "event",
        eventType: "agent.execute.completed",
        streamId: "context-stream",
        sequence: 0,
        runId,
        operationId,
        requestId,
        final: true,
        outcome: "completed",
        payload: {
          result: completedResult("compaction-host-session", "compaction-host-turn"),
          messages: [],
        },
      });
      responses.end();
    },
    receive: () => responses,
  };
}

function forgedPolicyContextConnection(sessionId: string, turnId: string) {
  const responses = queue<unknown>();
  let runId = "";
  let operationId = "";
  let requestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
  };
  return {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        responses.push(handshakeResponse(request, {}, "forged-policy-host", capabilities));
        return;
      }
      if (request.method === "capabilities") {
        responses.push(handshakeResponse(request, capabilities, "forged-policy-host", capabilities));
        return;
      }
      if (request.method === "execute") {
        runId = String(request.runId);
        operationId = String(request.operationId);
        requestId = String(request.requestId);
        responses.push({
          kind: "response",
          messageId: "accepted-forged-policy",
          inReplyTo: request.messageId,
          requestId,
          ok: true,
          streamId: "forged-policy-stream",
          cursor: 0,
        });
        responses.push({
          kind: "request",
          messageId: "forged-policy-context",
          method: "module_call",
          runId,
          operationId,
          requestId,
          module: "context",
          payload: {
            operation: "prepare_for_model",
            input: {
              sessionId: "wire-session",
              turnId: "wire-turn",
              cwd: "/wire-workspace",
              provider: "wire-provider",
              model: "wire-model",
              permissionMode: "bypassPermissions",
              runMode: "agent",
              additionalWorkingDirectories: [],
              messages: [],
              tools: [],
            },
          },
        });
        return;
      }
      if (request.kind !== "response" || request.inReplyTo !== "forged-policy-context") return;
      responses.push({
        kind: "event",
        eventType: "agent.execute.completed",
        streamId: "forged-policy-stream",
        sequence: 0,
        runId,
        operationId,
        requestId,
        final: true,
        outcome: "completed",
        payload: {
          result: completedResult(sessionId, turnId),
          messages: [],
        },
      });
      responses.end();
    },
    receive: () => responses,
  };
}

function unknownTerminalConnection(executePayloads?: Array<Record<string, unknown>>) {
  const responses = queue<unknown>();
  return {
    send: (message: unknown) => {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        responses.push(handshakeResponse(request, {}));
        return;
      }
      if (request.method === "capabilities") {
        responses.push(handshakeResponse(request, {
          capabilitiesVersion: "1",
          methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }],
        }));
        return;
      }
      if (request.method !== "execute") return;
      executePayloads?.push(structuredClone(request.payload as Record<string, unknown>));
      responses.push({
        kind: "response",
        messageId: "accepted",
        inReplyTo: request.messageId,
        requestId: request.requestId,
        ok: true,
        streamId: "stream-1",
        cursor: 0,
      });
      responses.push({
        kind: "event",
        eventType: "agent.execute.unknown",
        streamId: "stream-1",
        sequence: 0,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome: "result_unknown",
        payload: {},
      });
      responses.end();
    },
    receive: () => responses,
  };
}

function reconnectingConnection(reconnects: Array<Record<string, unknown>>) {
  const first = queue<unknown>();
  const second = queue<unknown>();
  let activeRequestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
    ],
  };
  const firstConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        first.push(handshakeResponse(request, {}, "connection-a", capabilities));
      } else if (request.method === "capabilities") {
        first.push(handshakeResponse(request, capabilities, "connection-a", capabilities));
      } else if (request.method === "execute") {
        activeRequestId = String(request.requestId);
        first.push({
          kind: "response",
          messageId: "accepted-a",
          inReplyTo: request.messageId,
          requestId: request.requestId,
          ok: true,
          streamId: "reconnect-stream",
          cursor: 0,
        });
        first.push({
          kind: "event",
          eventType: "agent.warning",
          streamId: "reconnect-stream",
          sequence: 0,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: {
            type: "warning",
            sessionId: "reconnect-session",
            turnId: "reconnect-turn",
            code: "TRANSPORT_TEST",
            message: "first connection",
          },
        });
        first.end();
      }
    },
    receive: () => first,
    reconnect(input: {
      streamId: string;
      previousBinding: { moduleInstanceId: string; connectionGeneration: string };
      lastAppliedSequence: number;
    }) {
      reconnects.push(structuredClone(input));
      return secondConnection;
    },
  };
  const secondConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        second.push(handshakeResponse(request, {}, "connection-b", capabilities));
      } else if (request.method === "capabilities") {
        second.push(handshakeResponse(request, capabilities, "connection-b", capabilities));
      } else if (request.method === "resume") {
        second.push({
          kind: "response",
          messageId: "resumed-b",
          inReplyTo: request.messageId,
          ok: true,
          streamId: "reconnect-stream",
          replayedThroughSequence: 0,
        });
        second.push({
          kind: "event",
          eventType: "agent.execute.completed",
          streamId: "reconnect-stream",
          sequence: 1,
          runId: "reconnect-run",
          operationId: "reconnect-operation",
          requestId: activeRequestId,
          final: true,
          outcome: "completed",
          payload: {
            result: completedResult("reconnect-session", "reconnect-turn"),
            messages: [],
          },
        });
        second.end();
      }
    },
    receive: () => second,
  };
  return firstConnection;
}

function restartingConnection(reconnects: Array<Record<string, unknown>>, methods: string[]) {
  const first = queue<unknown>();
  const second = queue<unknown>();
  let activeRequestId = "";
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
    ],
  };
  const firstConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      methods.push(String(request.method));
      if (request.method === "hello") {
        first.push(handshakeResponse(request, {}, "restart-connection-a", capabilities, "restart-instance-a"));
      } else if (request.method === "capabilities") {
        first.push(handshakeResponse(request, capabilities, "restart-connection-a", capabilities, "restart-instance-a"));
      } else if (request.method === "execute") {
        activeRequestId = String(request.requestId);
        first.push({
          kind: "response",
          messageId: "restart-accepted",
          inReplyTo: request.messageId,
          requestId: activeRequestId,
          ok: true,
          streamId: "restart-stream",
          cursor: 0,
        });
        first.push({
          kind: "event",
          eventType: "agent.warning",
          streamId: "restart-stream",
          sequence: 0,
          runId: request.runId,
          operationId: request.operationId,
          requestId: activeRequestId,
          final: false,
          payload: {
            type: "warning",
            sessionId: "restart-session",
            turnId: "restart-turn",
            code: "RESTART_TEST",
            message: "first sidecar instance",
          },
        });
        first.end();
      }
    },
    receive: () => first,
    reconnect(input: {
      streamId: string;
      previousBinding: { moduleInstanceId: string; connectionGeneration: string };
      lastAppliedSequence: number;
    }) {
      reconnects.push(structuredClone(input));
      return secondConnection;
    },
  };
  const secondConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      methods.push(String(request.method));
      if (request.method === "hello") {
        second.push(handshakeResponse(request, {}, "restart-connection-b", capabilities, "restart-instance-b"));
      }
    },
    receive: () => second,
  };
  return firstConnection;
}

function replayedModuleCallConnection(responses: Array<Record<string, unknown>>) {
  const first = queue<unknown>();
  const second = queue<unknown>();
  const capabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
    ],
  };
  let runId = "";
  let operationId = "";
  let requestId = "";
  const moduleCall = () => ({
    kind: "request",
    messageId: "replayed-context-call",
    method: "module_call",
    runId,
    operationId,
    requestId,
    module: "context",
    payload: {},
  });
  const firstConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        first.push(handshakeResponse(request, {}, "module-replay-a", capabilities, "module-replay-instance"));
      } else if (request.method === "capabilities") {
        first.push(handshakeResponse(request, capabilities, "module-replay-a", capabilities, "module-replay-instance"));
      } else if (request.method === "execute") {
        runId = String(request.runId);
        operationId = String(request.operationId);
        requestId = String(request.requestId);
        first.push({
          kind: "response",
          messageId: "module-replay-accepted",
          inReplyTo: request.messageId,
          requestId,
          ok: true,
          streamId: "module-replay-stream",
          cursor: 0,
        });
        first.push(moduleCall());
      } else if (request.kind === "response" && request.inReplyTo === "replayed-context-call") {
        throw new Error("simulate lost module response write");
      }
    },
    receive: () => first,
    reconnect() {
      return secondConnection;
    },
  };
  const secondConnection = {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "hello") {
        second.push(handshakeResponse(request, {}, "module-replay-b", capabilities, "module-replay-instance"));
      } else if (request.method === "capabilities") {
        second.push(handshakeResponse(request, capabilities, "module-replay-b", capabilities, "module-replay-instance"));
      } else if (request.method === "resume") {
        second.push({
          kind: "response",
          messageId: "module-replay-resumed",
          inReplyTo: request.messageId,
          ok: true,
          streamId: "module-replay-stream",
          replayedThroughSequence: -1,
        });
        second.push(moduleCall());
      } else if (request.kind === "response" && request.inReplyTo === "replayed-context-call") {
        responses.push(structuredClone(request));
        second.push({
          kind: "event",
          eventType: "agent.execute.completed",
          streamId: "module-replay-stream",
          sequence: 0,
          runId,
          operationId,
          requestId,
          final: true,
          outcome: "completed",
          payload: {
            result: completedResult("module-replay-session", "module-replay-turn"),
            messages: [],
          },
        });
        second.end();
      }
    },
    receive: () => second,
  };
  return firstConnection;
}

function handshakeResponse(
  request: Record<string, unknown>,
  payload: Record<string, unknown>,
  connectionGeneration = "test-sidecar-connection",
  capabilities: Record<string, unknown> = {},
  moduleInstanceId = connectionGeneration.startsWith("connection-") ? "reconnect-sidecar" : "test-sidecar-instance",
) {
  return {
    kind: "response",
    messageId: `response-${request.method}`,
    inReplyTo: request.messageId,
    ok: true,
    protocolVersion: "2.0",
    moduleId: "test-sidecar",
    moduleInstanceId,
    connectionGeneration,
    capabilitiesVersion: String(capabilities.capabilitiesVersion ?? "1"),
    payload,
  };
}

function cancelledResult(sessionId: string, turnId: string) {
  return {
    type: "aborted",
    sessionId,
    turnId,
    stopReason: "aborted_streaming",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}

function completedResult(sessionId: string, turnId: string) {
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}

function queue<T>() {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;
  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
      while (true) {
        const value = values.shift();
        if (value !== undefined) yield value;
        else if (ended) return;
        else yield await new Promise<T>((resolve) => waiters.push((result) => {
          if (result.done) resolve(undefined as never);
          else resolve(result.value);
        }));
      }
    },
  };
}

async function waitForSignal(signal: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
