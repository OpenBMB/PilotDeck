import assert from "node:assert/strict";
import test from "node:test";

import { createDurableModelInvokerPort } from "../../../src/agent/modules/llm/durableModelInvokerPort.js";
import { createDurableToolPort } from "../../../src/agent/modules/capability/durableToolPort.js";
import { createDurableContextRuntime } from "../../../src/agent/modules/context/durableContextRuntime.js";
import { AgentSessionEventRecorder } from "../../../src/agent/session/AgentSessionEventRecorder.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { SessionEventDraft } from "../../../src/session/events/SessionEventStore.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import type { AgentContextRuntime, ContextMaterialization } from "../../../src/context/index.js";

const context = {
  sessionId: "session-durable",
  turnId: "turn-1",
  runId: "run-1",
};

const request: CanonicalModelRequest = {
  provider: "provider-a",
  model: "model-a",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
};

const result: AgentTurnResult = {
  type: "success",
  sessionId: context.sessionId,
  turnId: context.turnId,
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-09-06T00:00:00.000Z",
  completedAt: "2026-09-06T00:00:01.000Z",
};

test("durable model and tool decorators commit facts before returning them to AgentLoop", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  const observed: string[] = [];
  await recorder.startTurn(context.sessionId, context.turnId);

  const model = createDurableModelInvokerPort({
    async prepare() {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      observed.push("model-dispatched");
      yield { type: "text_delta", text: "hi", raw: { provider: "secret" } };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-1", name: "lookup", input: {}, raw: { provider: "secret" } },
        raw: { provider: "secret" },
      };
    },
  }, recorder);
  const prepared = await model.prepare({ request, context });
  for await (const event of model.stream({ prepared, context })) {
    observed.push(`model-visible:${event.type}`);
  }

  const tools = createDurableToolPort({
    list: () => [],
    async executeAll(calls) {
      observed.push("tool-dispatched");
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "done" }],
        startedAt: "2026-09-06T00:00:00.000Z",
        completedAt: "2026-09-06T00:00:01.000Z",
      }));
    },
  }, recorder);
  await tools.executeAll(
    [{ id: "call-1", name: "lookup", input: {}, raw: { provider: "secret" } }],
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      cwd: "/tmp",
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        rules: { allow: [], deny: [], ask: [] },
        cwd: "/tmp",
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
      },
    },
    context,
  );
  await recorder.completeTurn(result);

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "model_request",
    "model_stream_event",
    "model_stream_event",
    "tool_call",
    "tool_result",
    "step_completed",
    "turn_result",
  ]);
  assert.deepEqual(observed, [
    "model-dispatched",
    "model-visible:text_delta",
    "model-visible:tool_call_end",
    "tool-dispatched",
  ]);
  const streamEntries = transcript.entries.filter((entry) => entry.type === "model_stream_event");
  assert.equal(JSON.stringify(streamEntries).includes("raw"), false);
  const callEntry = transcript.entries.find((entry) => entry.type === "tool_call");
  assert.equal(JSON.stringify(callEntry).includes("raw"), false);
});

test("durable tool decorator preserves an optional host catalog refresh", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  let refreshes = 0;
  const tools = createDurableToolPort({
    list: () => [],
    async refresh() {
      refreshes += 1;
      return [];
    },
    async executeAll() { return []; },
  }, recorder);

  assert.equal(typeof tools.refresh, "function");
  await tools.refresh?.();
  assert.equal(refreshes, 1);
});

test("durable tool decorator does not settle late results after turn cancellation", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);
  await recorder.recordModelRequest(context.sessionId, context.turnId, {
    request,
    provider: request.provider,
    model: request.model,
  });
  const controller = new AbortController();
  const tools = createDurableToolPort({
    list: () => [],
    async executeAll(calls) {
      controller.abort("turn cancelled");
      return calls.map((call) => ({
        type: "error" as const,
        toolCallId: call.id,
        toolName: call.name,
        error: { code: "tool_execution_failed" as const, message: "cancelled while running" },
        content: [{ type: "text" as const, text: "cancelled while running" }],
        startedAt: "2026-09-06T00:00:00.000Z",
        completedAt: "2026-09-06T00:00:01.000Z",
      }));
    },
  }, recorder);

  await tools.executeAll(
    [{ id: "call-1", name: "lookup", input: {} }],
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      cwd: "/tmp",
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        rules: { allow: [], deny: [], ask: [] },
        cwd: "/tmp",
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
      },
    },
    { ...context, abortSignal: controller.signal },
  );

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "model_request",
    "tool_call",
  ]);
});

test("model_request persistence failure prevents provider dispatch", async () => {
  let dispatched = false;
  const transcript = new FailingSessionEventWriter("model_request");
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);
  const model = createDurableModelInvokerPort({
    async prepare() {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      dispatched = true;
      yield { type: "message_end", finishReason: "stop" };
    },
  }, recorder);
  const prepared = await model.prepare({ request, context });

  await assert.rejects(async () => {
    for await (const _event of model.stream({ prepared, context })) {
      // Consume the wrapper so its durable precondition runs.
    }
  }, /model_request persistence failed/);
  assert.equal(dispatched, false);
});

test("tool_call persistence failure prevents tool side effects", async () => {
  let dispatched = false;
  const transcript = new FailingSessionEventWriter("tool_call");
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);
  await recorder.recordModelRequest(context.sessionId, context.turnId, {
    request,
    provider: request.provider,
    model: request.model,
  });
  const tools = createDurableToolPort({
    list: () => [],
    async executeAll() {
      dispatched = true;
      return [];
    },
  }, recorder);

  await assert.rejects(
    () => tools.executeAll(
      [{ id: "call-1", name: "lookup", input: {} }],
      {
        sessionId: context.sessionId,
        turnId: context.turnId,
        cwd: "/tmp",
        permissionMode: "default",
        permissionContext: {
          mode: "default",
          rules: { allow: [], deny: [], ask: [] },
          cwd: "/tmp",
          additionalWorkingDirectories: [],
          canPrompt: false,
          bypassAvailable: false,
        },
      },
      context,
    ),
    /tool_call persistence failed/,
  );
  assert.equal(dispatched, false);
});

test("context and instruction facts are durable before the model request", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);
  const runtime = createDurableContextRuntime(contextRuntime(materialization()), recorder);
  await runtime.prepareForModel(contextInput());

  const model = createDurableModelInvokerPort({
    async prepare() {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_end", finishReason: "stop" };
    },
  }, recorder);
  const prepared = await model.prepare({ request, context });
  for await (const _event of model.stream({ prepared, context })) {
    // Drain the model stream so durable event ordering is observable.
  }

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "context_snapshot",
    "agent_instructions",
    "model_request",
    "model_stream_event",
  ]);
});

test("durable context adapter binds materialization to the recorder admission step", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);
  let receivedStep: number | undefined;
  const runtime = createDurableContextRuntime({
    async prepareForModel(input) {
      receivedStep = input.stepId;
      return {
        messages: [],
        systemPromptParts: [],
        tools: [],
        diagnostics: [],
        boundaries: [],
        materialization: {
          runtimeContexts: [{ name: "cwd", text: "/workspace" }],
        },
      };
    },
  }, recorder);

  const prepared = await runtime.prepareForModel(contextInput());

  assert.equal(receivedStep, 1);
  assert.equal(prepared.materialization?.stepId, 1);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "context_snapshot",
  ]);
  const snapshot = transcript.entries.find((entry) => entry.type === "context_snapshot");
  assert.equal(snapshot?.step, 1);
});

test("durable recorder rejects a context snapshot for the wrong admission step", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  await recorder.startTurn(context.sessionId, context.turnId);

  await assert.rejects(
    () => recorder.recordContextMaterialization(context.sessionId, context.turnId, {
      stepId: 2,
      runtimeContexts: [],
    }),
    /does not match durable admission step 1/,
  );
  assert.deepEqual(transcript.entries.map((entry) => entry.type), ["turn_started"]);
});

test("instruction baseline, changes, and restored state avoid redundant events", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript);
  const baseline = materialization([
    { scope: "project", path: "/workspace/PILOTDECK.md", content: "one" },
    { scope: "local", path: "/workspace/PILOTDECK.local.md", content: "local" },
  ]);
  const changed = materialization([
    { scope: "project", path: "/workspace/PILOTDECK.md", content: "two" },
  ]);

  await recordContextStep(recorder, "turn-1", baseline);
  await recordContextStep(recorder, "turn-2", baseline);
  await recordContextStep(recorder, "turn-3", changed);

  const instructionEntries = transcript.entries.filter((entry) => entry.type === "agent_instructions");
  assert.equal(instructionEntries.length, 2);
  assert.equal(instructionEntries[0]?.baseline, true);
  assert.deepEqual(instructionEntries[1]?.changes, [
    {
      action: "remove",
      scope: "local",
      path: "/workspace/PILOTDECK.local.md",
    },
    {
      action: "replace",
      scope: "project",
      path: "/workspace/PILOTDECK.md",
      content: "two",
    },
  ]);

  const restoredTranscript = new InMemoryTranscriptWriter();
  const restoredRecorder = new AgentSessionEventRecorder(restoredTranscript, {
    restoredEntries: transcript.entries,
  });
  await recordContextStep(restoredRecorder, "turn-4", changed);
  assert.equal(
    restoredTranscript.entries.filter((entry) => entry.type === "agent_instructions").length,
    0,
  );
});

test("context persistence failure prevents preparation and a partial instruction failure can retry", async () => {
  const failingContext = new FailingSessionEventWriter("context_snapshot");
  const failingContextRecorder = new AgentSessionEventRecorder(failingContext);
  await failingContextRecorder.startTurn(context.sessionId, context.turnId);
  const blocked = createDurableContextRuntime(contextRuntime(materialization()), failingContextRecorder);
  await assert.rejects(() => blocked.prepareForModel(contextInput()), /context_snapshot persistence failed/);

  const retryTranscript = new FailOnceSessionEventWriter("agent_instructions");
  const retryRecorder = new AgentSessionEventRecorder(retryTranscript);
  await retryRecorder.startTurn(context.sessionId, context.turnId);
  const onceWrapped = createDurableContextRuntime(contextRuntime(materialization()), retryRecorder);
  const runtime = createDurableContextRuntime(onceWrapped, retryRecorder);
  await assert.rejects(() => runtime.prepareForModel(contextInput()), /agent_instructions persistence failed/);
  await runtime.prepareForModel(contextInput());

  assert.deepEqual(retryTranscript.entries.map((entry) => entry.type), [
    "turn_started",
    "step_started",
    "context_snapshot",
    "agent_instructions",
  ]);
});

class FailingSessionEventWriter extends InMemoryTranscriptWriter {
  constructor(private readonly failingType: SessionEventDraft["type"]) {
    super();
  }

  override recordSessionEvent(
    sessionId: string,
    turnId: string,
    event: SessionEventDraft,
  ): Promise<void> {
    if (event.type === this.failingType) {
      return Promise.reject(new Error(`${event.type} persistence failed`));
    }
    return super.recordSessionEvent(sessionId, turnId, event);
  }
}

class FailOnceSessionEventWriter extends InMemoryTranscriptWriter {
  private failed = false;

  constructor(private readonly failingType: SessionEventDraft["type"]) {
    super();
  }

  override recordSessionEvent(
    sessionId: string,
    turnId: string,
    event: SessionEventDraft,
  ): Promise<void> {
    if (!this.failed && event.type === this.failingType) {
      this.failed = true;
      return Promise.reject(new Error(`${event.type} persistence failed`));
    }
    return super.recordSessionEvent(sessionId, turnId, event);
  }
}

function contextRuntime(value: ContextMaterialization): AgentContextRuntime {
  return {
    async prepareForModel() {
      return {
        messages: [],
        systemPromptParts: [],
        tools: [],
        diagnostics: [],
        boundaries: [],
        materialization: value,
      };
    },
  };
}

function materialization(
  instructionLayers: ContextMaterialization["instructionLayers"] = [
    { scope: "project", path: "/workspace/PILOTDECK.md", content: "follow rules" },
  ],
): ContextMaterialization {
  return {
    promptGeneration: 3,
    runtimeContexts: [{ name: "cwd", text: "/workspace" }],
    instructionLayers,
  };
}

function contextInput() {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
  };
}

async function recordContextStep(
  recorder: AgentSessionEventRecorder,
  turnId: string,
  value: ContextMaterialization,
): Promise<void> {
  await recorder.startTurn(context.sessionId, turnId);
  await recorder.recordContextMaterialization(context.sessionId, turnId, value);
  await recorder.recordModelRequest(context.sessionId, turnId, {
    request,
    provider: request.provider,
    model: request.model,
  });
  await recorder.completeTurn({ ...result, turnId });
}
