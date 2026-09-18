/**
 * Background subagent execution through the real AgentLoop.
 *
 * Fixture: a fake router scripts the PARENT model responses; the CHILD
 * subagent (same router, discriminated by `request.metadata.subagentId`)
 * blocks on a gate that only the parent's independent `open_gate` tool
 * opens. This proves the parent makes independent progress while the child
 * runs, and that the child's report is joined before the parent's final
 * answer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../../src/model/index.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { BackgroundTaskRuntime } from "../../../src/task/runtime/BackgroundTaskRuntime.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";
import {
  ToolRegistry,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../../src/agent/loop/AgentLoop.js";
import { mapAgentEvent } from "../../../src/gateway/client/InProcessGateway.js";

const CHILD_REPORT = [
  "Scope: gated probe",
  "Result: CHILD-REPORT-MARKER",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

function textResponse(text: string | ((request: CanonicalModelRequest) => string)) {
  return async function* (request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: typeof text === "function" ? text(request) : text };
    yield { type: "message_end", finishReason: "stop" };
  };
}

function toolCallResponse(id: string, name: string, input: unknown) {
  return async function* (): AsyncIterable<CanonicalModelEvent> {
    yield { type: "message_start", role: "assistant" };
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_delta", id, delta: JSON.stringify(input) };
    yield { type: "tool_call_end", toolCall: { id, name, input } };
    yield { type: "message_end", finishReason: "tool_call" };
  };
}

type HarnessOptions = {
  parentResponses: Array<(request: CanonicalModelRequest) => AsyncIterable<CanonicalModelEvent>>;
  childBehavior: (
    request: CanonicalModelRequest,
    signal: AbortSignal | undefined,
  ) => AsyncIterable<CanonicalModelEvent>;
  extraTools?: PilotDeckToolDefinition[];
  backgroundTasks?: BackgroundTaskRuntime;
};

function createHarness(options: HarnessOptions) {
  const parentRequests: CanonicalModelRequest[] = [];
  const childRequests: CanonicalModelRequest[] = [];
  let parentIndex = 0;
  const pendingEvents: AgentEvent[] = [];
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: request.metadata?.subagentId !== undefined,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (_decision, request, context) {
      if (request.metadata?.subagentId !== undefined) {
        childRequests.push(request);
        yield* options.childBehavior(request, context.abortSignal);
        return;
      }
      const index = parentIndex++;
      const handler = options.parentResponses[index];
      if (!handler) throw new Error(`no scripted parent response for request ${index}`);
      parentRequests.push(request);
      yield* handler(request);
    },
    stream: async function* () {
      yield { type: "text_delta", text: "" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  } as AgentRouterRuntime;

  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  for (const tool of options.extraTools ?? []) registry.register(tool);
  const scheduler = new ConcurrentToolScheduler(
    new ToolRuntime(registry, new PermissionRuntime()),
    registry,
  );

  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "test-model",
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
    eventEmitter: (event) => { pendingEvents.push(event); },
    drainEvents: () => pendingEvents.splice(0),
    tools: { registry, scheduler },
    ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
  };

  const createLoop = () => new AgentLoop(config, dependencies);
  const runLoop = async (
    overrides: Partial<AgentLoopInput> = {},
  ): Promise<{
    result: AgentLoopRunResult["result"];
    messages: CanonicalMessage[];
    events: AgentEvent[];
    durable: CanonicalMessage[];
    parentRequests: CanonicalModelRequest[];
  }> => {
    const loop = createLoop();
    const events: AgentEvent[] = [];
    const durable: CanonicalMessage[] = [];
    const iterator = loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "Run the probe" }] }],
      onDurableMessage: (message) => {
        durable.push(message);
      },
      ...overrides,
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return { result: next.value.result, messages: next.value.messages, events, durable, parentRequests };
      }
      events.push(next.value);
    }
  };

  return { createLoop, runLoop, parentRequests, childRequests, pendingEvents };
}

function backgroundAgentCall(id: string) {
  return toolCallResponse(id, "agent", {
    description: "gated probe",
    prompt: "wait for the gate, then report",
    subagent_type: "general-purpose",
    run_in_background: true,
  });
}

function resultMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.filter((message) => message.metadata?.purpose === "background_subagent_result");
}

test("background child joins at the terminal boundary: parent progresses independently, report enters the final model request and durable transcript", async () => {
  const gate1 = createGate(); // opened by the parent's independent tool while the child runs
  const gate2 = createGate(); // opened by the test once the parent reaches the terminal join
  const gateTool: PilotDeckToolDefinition = {
    name: "open_gate",
    description: "opens the child's gate",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => {
      gate1.open();
      return { content: [{ type: "text", text: "gate opened" }] };
    },
  };
  const harness = createHarness({
    parentResponses: [
      backgroundAgentCall("call-bg"),
      toolCallResponse("call-gate", "open_gate", {}),
      textResponse("main kept working"),
      textResponse((request) =>
        resultMessages(request.messages).some((message) =>
          JSON.stringify(message.content).includes("CHILD-REPORT-MARKER"),
        )
          ? "final answer: child reported CHILD-REPORT-MARKER"
          : "final answer: MISSING child report",
      ),
    ],
    childBehavior: async function* (_request, signal) {
      await Promise.race([
        Promise.all([gate1.promise, gate2.promise]),
        new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
      ]);
      yield* textResponse(CHILD_REPORT)(_request);
    },
    extraTools: [gateTool],
    backgroundTasks: new BackgroundTaskRuntime(),
  });

  const { result, events, durable, parentRequests } = await harness.runLoop({
    onAgentStatusMessage: (status) => {
      // The parent reached its terminal answer with the child still pending:
      // the loop must be waiting (and cancellable) right now.
      if (status.event === "waiting_background_subagents") {
        gate2.open();
      }
    },
  });

  // Parent made four model calls; the last one depends on the child report.
  assert.equal(parentRequests.length, 4);
  assert.ok(events.some(
    (event) => event.type === "turn_continued" && event.reason === "background_subagent_results",
  ));
  assert.equal(result.type, "success");
  assert.match(result.finalMessage ? JSON.stringify(result.finalMessage.content) : "", /CHILD-REPORT-MARKER/);

  // Report is delivered exactly once, durably, with ids/status and untrusted framing.
  const delivered = durable.filter((message) => message.metadata?.purpose === "background_subagent_result");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.metadata?.status, "completed");
  assert.match(JSON.stringify(delivered[0]?.content), /CHILD-REPORT-MARKER/);
  assert.match(JSON.stringify(delivered[0]?.content), /UNTRUSTED TOOL OUTPUT/);
  assert.equal(events.filter((event) => event.type === "background_subagent_result").length, 1);

  // Background ownership must preserve upstream live/history reconciliation.
  const parentText = events.filter(event => event.type === "model_event" && event.event.type === "text_delta");
  assert.ok(parentText.length > 0);
  for (const event of parentText) {
    assert.ok(event.type === "model_event" && event.blockId);
    assert.equal(event.timeline?.turnId, "turn-1");
    const block = durable.flatMap(message => message.content).find(block =>
      block.type === "text" && block.blockId === event.blockId);
    assert.ok(block?.timeline);
    assert.equal(block.timeline.id, event.timeline?.id);
    assert.equal(block.timeline.order, event.timeline?.order);
  }
  const childText = events.find(event => event.type === "subagent_model_event" && event.event.type === "text_delta");
  assert.ok(childText?.type === "subagent_model_event" && childText.blockId);
  assert.ok(childText.timeline);
  assert.notEqual(childText.timeline.turnId, "turn-1", "child timeline must remain distinct from its parent");
  const childWire = mapAgentEvent(childText, "turn-1")[0];
  assert.ok(childWire?.type === "agent_status");
  assert.equal(childWire.detail?.blockId, childText.blockId);
  assert.deepEqual(childWire.timeline, childText.timeline);

  // The queued tool call returned a stable taskId (=== subagentId) retrievable via the runtime.
  const queuedResult = events.find(
    (event) => event.type === "tool_result" && event.result.toolName === "agent",
  );
  assert.ok(queuedResult && queuedResult.type === "tool_result" && queuedResult.result.type === "success");
  const queuedData = queuedResult.result.data as { taskId?: string; subagentId?: string };
  assert.ok(queuedData?.taskId);
  assert.equal(queuedData.taskId, queuedData.subagentId);
});

test("sync agent calls are unchanged: run_in_background omitted blocks and returns the report inline", async () => {
  const harness = createHarness({
    parentResponses: [
      toolCallResponse("call-sync", "agent", {
        description: "sync probe",
        prompt: "report immediately",
        subagent_type: "general-purpose",
      }),
      textResponse("done"),
    ],
    childBehavior: textResponse(CHILD_REPORT),
    backgroundTasks: new BackgroundTaskRuntime(),
  });
  const { result, events, durable } = await harness.runLoop();

  assert.equal(result.type, "success");
  const agentResult = events.find(
    (event) => event.type === "tool_result" && event.result.toolName === "agent",
  );
  assert.ok(agentResult && agentResult.type === "tool_result");
  assert.match(JSON.stringify(agentResult.result.content), /CHILD-REPORT-MARKER/);
  assert.equal(durable.filter((m) => m.metadata?.purpose === "background_subagent_result").length, 0);
});

test("a completed child report is delivered exactly once across multiple model-call boundaries", async () => {
  const backgroundTasks = new BackgroundTaskRuntime();
  const harness = createHarness({
    parentResponses: [
      backgroundAgentCall("call-bg"),
      toolCallResponse("call-noop", "noop", {}),
      textResponse("final"),
    ],
    childBehavior: textResponse(CHILD_REPORT),
    extraTools: [
      {
        name: "noop",
        description: "no-op",
        kind: "custom",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async () => {
          const task = backgroundTasks.list({ kind: "agent" })[0];
          assert.ok(task);
          await backgroundTasks.waitFor(task.taskId);
          return { content: [{ type: "text", text: "noop" }] };
        },
      },
    ],
    backgroundTasks,
  });
  const { result, durable, parentRequests } = await harness.runLoop();

  assert.equal(result.type, "success");
  assert.equal(parentRequests.length, 3);
  assert.ok(parentRequests.every(request => resultMessages(request.messages).length <= 1));
  assert.equal(resultMessages(parentRequests.at(-1)!.messages).length, 1);
  assert.equal(durable.filter((m) => m.metadata?.purpose === "background_subagent_result").length, 1);
});

test("user stop during the terminal join cancels owned children and leaves no orphans", async () => {
  const backgroundTasks = new BackgroundTaskRuntime();
  const harness = createHarness({
    parentResponses: [backgroundAgentCall("call-bg"), textResponse("stopping")],
    childBehavior: async function* (_request, signal) {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    },
    backgroundTasks,
  });
  const controller = new AbortController();
  const { result, events } = await harness.runLoop({
    abortSignal: controller.signal,
    onAgentStatusMessage: (status) => {
      if (status.event === "waiting_background_subagents") {
        controller.abort(new Error("user-cancel"));
      }
    },
  });

  assert.equal(result.type, "aborted");
  const agentTask = backgroundTasks
    .list({ kind: "agent" })
    .find((task) => task.type === "local_agent");
  assert.ok(agentTask);
  assert.equal(agentTask.status, "cancelled");
  assert.equal(backgroundTasks.list({ status: "running" }).length, 0);
  const childEnd = events.findIndex((event) => event.type === "subagent_completed");
  const parentEnd = events.findIndex((event) => event.type === "turn_completed");
  assert.ok(childEnd >= 0 && childEnd < parentEnd, "cancelled child status must reach the UI before the parent ends");
  assert.equal(harness.pendingEvents.length, 0, "no events may leak into another turn");
});

test("returning the public iterator early cancels background children through the timeline wrapper", async () => {
  const backgroundTasks = new BackgroundTaskRuntime();
  const started = createGate();
  let childAborted = false;
  const harness = createHarness({
    backgroundTasks,
    parentResponses: [backgroundAgentCall("abandoned-child")],
    childBehavior: async function* (_request, signal) {
      started.open();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => { childAborted = true; reject(signal?.reason ?? new Error("aborted")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const iterator = harness.createLoop().run({
    sessionId: "session-1", turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "start a child" }] }],
  });
  try {
    for await (const event of iterator) {
      if (event.type === "tool_result" && event.result.toolName === "agent") {
        await started.promise;
        break;
      }
    }
    assert.equal(childAborted, true);
    assert.equal(backgroundTasks.list({ kind: "agent" })[0]?.status, "cancelled");
    assert.equal(backgroundTasks.list({ status: "running" }).length, 0);
    assert.equal(harness.pendingEvents.length, 0);
  } finally {
    await iterator.return(undefined as never);
  }
});

test("maxTurns cap is respected: no extra model calls, limit surfaced, children cancelled", async () => {
  const gate = createGate();
  const backgroundTasks = new BackgroundTaskRuntime();
  const harness = createHarness({
    parentResponses: [backgroundAgentCall("call-bg"), textResponse("wrapping up")],
    childBehavior: async function* (_request, signal) {
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
      ]);
      yield* textResponse(CHILD_REPORT)(_request);
    },
    backgroundTasks,
  });
  const { result, parentRequests } = await harness.runLoop({ maxTurns: 2 });
  void gate;

  assert.equal(parentRequests.length, 2); // no extra model calls beyond the cap
  assert.equal(result.type, "max_turns"); // NOT a silent success
  const agentTask = backgroundTasks.list({ kind: "agent" })[0];
  assert.ok(agentTask);
  assert.equal(agentTask.status, "cancelled");
});

test("a failed child delivers its failed status and the parent can reference it", async () => {
  const gate1 = createGate();
  const gate2 = createGate();
  const harness = createHarness({
    parentResponses: [
      backgroundAgentCall("call-bg"),
      toolCallResponse("call-gate", "open_gate", {}),
      textResponse("main continues"),
      textResponse((request) =>
        JSON.stringify(request.messages).includes("gate exploded")
          ? "final answer: child failed with gate exploded"
          : "final answer: missing failure",
      ),
    ],
    childBehavior: async function* (_request, signal) {
      await Promise.race([
        Promise.all([gate1.promise, gate2.promise]),
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
      ]);
      throw new Error("gate exploded");
    },
    extraTools: [
      {
        name: "open_gate",
        description: "opens the child's gate",
        kind: "custom",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async () => {
          gate1.open();
          return { content: [{ type: "text", text: "gate opened" }] };
        },
      },
    ],
    backgroundTasks: new BackgroundTaskRuntime(),
  });
  const { result, durable } = await harness.runLoop({
    onAgentStatusMessage: (status) => {
      if (status.event === "waiting_background_subagents") {
        gate2.open();
      }
    },
  });

  assert.equal(result.type, "success");
  const delivered = durable.filter((m) => m.metadata?.purpose === "background_subagent_result");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.metadata?.status, "failed");
  assert.match(JSON.stringify(delivered[0]?.content), /gate exploded/);
  assert.match(result.finalMessage ? JSON.stringify(result.finalMessage.content) : "", /gate exploded/);
});

test("run_in_background without a background backend returns unsupported_tool and never runs silently", async () => {
  const harness = createHarness({
    parentResponses: [backgroundAgentCall("call-bg"), textResponse("acknowledged")],
    childBehavior: textResponse(CHILD_REPORT),
    // no backgroundTasks wired
  });
  const { result, events } = await harness.runLoop();

  const agentResult = events.find(
    (event) => event.type === "tool_result" && event.result.toolName === "agent",
  );
  assert.ok(agentResult && agentResult.type === "tool_result" && agentResult.result.type === "error");
  assert.equal(agentResult.result.error.code, "unsupported_tool");
  assert.match(agentResult.result.error.message, /run_in_background/);
  assert.equal(result.type, "success");
});


test("queue capacity errors are returned immediately without advertising a phantom task", async (t) => {
  const gate = createGate();
  const backgroundTasks = new BackgroundTaskRuntime({ maxRunningAgentTasks: 1 });
  await backgroundTasks.startManaged({ subagentId: "unrelated-task", label: "existing work", run: () => gate.promise.then(() => "done") });
  t.after(async () => { gate.open(); await backgroundTasks.waitFor("unrelated-task"); });
  const harness = createHarness({
    backgroundTasks,
    parentResponses: [backgroundAgentCall("capacity-call"), textResponse("Could not queue work.")],
    childBehavior: textResponse(CHILD_REPORT),
  });
  const run = await harness.runLoop();
  const result = run.events.find(event => event.type === "tool_result" && event.result.toolName === "agent");
  assert.ok(result?.type === "tool_result" && result.result.type === "error");
  assert.match(result.result.error.message, /capacity/);
  assert.equal(resultMessages(run.durable).length, 0);
  assert.equal(harness.childRequests.length, 0);
  assert.equal(backgroundTasks.get("unrelated-task")?.status, "running", "unowned work must not be cancelled");
});

test("late events from a non-cooperative cancelled child cannot enter a later parent turn", async () => {
  class FastStopRuntime extends BackgroundTaskRuntime {
    override stop(taskId: string): Promise<void> { return super.stop(taskId, { graceMs: 1 }); }
  }
  const started = createGate(), release = createGate(), returned = createGate();
  const backgroundTasks = new FastStopRuntime();
  const controller = new AbortController();
  const harness = createHarness({
    backgroundTasks,
    parentResponses: [backgroundAgentCall("late-child"), textResponse("waiting")],
    childBehavior: async function* (request) {
      started.open();
      try { await release.promise; yield* textResponse(CHILD_REPORT)(request); }
      finally { returned.open(); }
    },
  });
  try {
    const run = await harness.runLoop({
      abortSignal: controller.signal,
      onAgentStatusMessage: async status => {
        if (status.event === "waiting_background_subagents") { await started.promise; controller.abort(); }
      },
    });
    assert.equal(run.result.type, "aborted");
    assert.ok(run.events.some(event => event.type === "subagent_completed" && event.aborted), "logical cancellation must complete the child UI status");
    release.open();
    await returned.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.pendingEvents.length, 0, "late completion must be suppressed after this parent run closes");
  } finally { release.open(); }
});
