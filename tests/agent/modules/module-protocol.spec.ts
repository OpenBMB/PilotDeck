import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_CAPABILITY_MODULE_METHODS,
  HOST_BUDGET_MODULE_METHODS,
  HOST_CONTEXT_MODULE_METHODS,
  HOST_EVENT_MODULE_METHODS,
  HOST_LIFECYCLE_MODULE_METHODS,
  HOST_MODEL_MODULE_METHODS,
  HOST_PERMISSION_MODULE_METHODS,
  HOST_TURN_MODULE_METHODS,
  readHostCapabilityModuleMethods,
  readHostBudgetModuleMethods,
  readHostContextModuleMethods,
  readHostEventModuleMethods,
  readHostLifecycleModuleMethods,
  readHostModelModuleMethods,
  readHostPermissionModuleMethods,
  readHostTurnModuleMethods,
  validateModuleMessage,
  type ModuleExecuteRequest,
} from "../../../src/agent/modules/protocol.js";
import {
  InProcessModuleAdapter,
  ModuleOperationHost,
} from "../../../src/agent/modules/transport/index.js";

const executeRequest: ModuleExecuteRequest = {
  kind: "request",
  messageId: "message-1",
  method: "execute",
  runId: "run-1",
  operationId: "operation-1",
  requestId: "request-1",
  payload: {},
};

test("Module Protocol defines and normalizes advertised host module operations", () => {
  assert.deepEqual(HOST_CONTEXT_MODULE_METHODS, [
    "prepare_for_model",
    "apply_tool_results",
    "recover_from_model_error",
    "capture_turn",
    "try_auto_compact",
  ]);
  assert.deepEqual(HOST_MODEL_MODULE_METHODS, ["prepare", "stream", "stream_next", "close_stream", "get_metadata"]);
  assert.deepEqual(HOST_BUDGET_MODULE_METHODS, [
    "estimate_request_input",
    "evaluate_request_budget",
    "estimate_usage_cost",
  ]);
  assert.deepEqual(HOST_TURN_MODULE_METHODS, [
    "drain_steer",
    "drain_or_close_steer",
    "persist_compaction",
  ]);
  assert.deepEqual(HOST_CAPABILITY_MODULE_METHODS, ["execute", "execute_batch", "plan_todo"]);
  assert.deepEqual(HOST_PERMISSION_MODULE_METHODS, ["decide"]);
  assert.deepEqual(HOST_LIFECYCLE_MODULE_METHODS, ["dispatch"]);
  assert.deepEqual(HOST_EVENT_MODULE_METHODS, ["emit"]);
  assert.deepEqual(readHostContextModuleMethods(["prepare_for_model", "unknown", "capture_turn"]), [
    "prepare_for_model",
    "capture_turn",
  ]);
  assert.deepEqual(readHostModelModuleMethods(["prepare", "unknown", "stream_next", "close_stream"]), [
    "prepare",
    "stream_next",
    "close_stream",
  ]);
  assert.deepEqual(readHostBudgetModuleMethods(["estimate_usage_cost", "unknown"]), ["estimate_usage_cost"]);
  assert.deepEqual(readHostTurnModuleMethods(["unknown", "persist_compaction"]), ["persist_compaction"]);
  assert.deepEqual(readHostCapabilityModuleMethods(["execute_batch", "unknown", "plan_todo"]), ["execute_batch", "plan_todo"]);
  assert.deepEqual(readHostPermissionModuleMethods(["unknown", "decide"]), ["decide"]);
  assert.deepEqual(readHostLifecycleModuleMethods(["unknown", "dispatch"]), ["dispatch"]);
  assert.deepEqual(readHostEventModuleMethods(["unknown", "emit"]), ["emit"]);
  assert.deepEqual(readHostContextModuleMethods("prepare_for_model"), []);
});

test("Module Protocol v2 validates slim execute and event profiles", () => {
  assert.deepEqual(validateModuleMessage(executeRequest), { ok: true });
  assert.equal(validateModuleMessage({ ...executeRequest, attemptId: "attempt-1" }).ok, false);
  assert.equal(validateModuleMessage({
    kind: "event",
    eventType: "model.delta",
    streamId: "stream-1",
    sequence: 0,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: false,
    payload: {},
  }).ok, true);
  assert.equal(validateModuleMessage({
    kind: "event",
    eventType: "model.delta",
    streamId: "stream-1",
    sequence: 0,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: true,
    payload: {},
  }).ok, false);
});

test("Module Protocol v2 validates host-owned module_call requests", () => {
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-budget",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-budget",
    module: "budget",
    payload: { operation: "estimate_usage_cost", provider: "p", model: "m" },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-turn",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-turn",
    module: "turn",
    payload: { operation: "drain_steer" },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-1",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    idempotencyKey: "stable-1",
    module: "capability",
    payload: { name: "lookup", arguments: {} },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-event",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-event",
    module: "event",
    payload: { operation: "emit", event: { type: "instructions_loaded", sessionId: "session-1", turnId: "turn-1", hasSystemPrompt: true } },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-lifecycle",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-lifecycle",
    module: "lifecycle",
    payload: { operation: "dispatch", event: "Stop" },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-2",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-2",
    module: "context",
    payload: { operation: "prepare_for_model", input: {} },
  }), { ok: true });
  assert.deepEqual(validateModuleMessage({
    kind: "event",
    messageId: "event-1",
    eventType: "execute.failed",
    streamId: "stream-1",
    sequence: 1,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: true,
    outcome: "failed",
    code: "DEADLINE_EXCEEDED",
    payload: {},
  }), { ok: true });
});

test("Module Protocol v2 validates control, handshake, response, and error profiles", () => {
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "cancel-1",
    method: "cancel",
    runId: "run-1",
    operationId: "operation-1",
    reason: "user_cancelled",
  }), { ok: true });
  assert.equal(validateModuleMessage({
    kind: "request",
    messageId: "cancel-2",
    method: "cancel",
    runId: "run-1",
    operationId: "operation-1",
  }).ok, false);
  assert.equal(validateModuleMessage({
    kind: "request",
    messageId: "status-1",
    method: "status",
  }).ok, false);
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "resume-1",
    method: "resume",
    streamId: "stream-1",
    previousBinding: { moduleInstanceId: "instance-1", connectionGeneration: "connection-1" },
    lastAppliedSequence: -1,
  }), { ok: true });
  assert.equal(validateModuleMessage({
    kind: "request",
    messageId: "ack-1",
    method: "ack",
    streamId: "stream-1",
    lastAppliedSequence: -1,
  }).ok, false);
  assert.equal(validateModuleMessage({
    kind: "request",
    messageId: "hello-1",
    method: "hello",
  }).ok, false);
  assert.equal(validateModuleMessage({ kind: "response", messageId: "response-1", ok: true }).ok, false);
  assert.equal(validateModuleMessage({
    kind: "error",
    messageId: "error-1",
    code: "BROKEN",
    message: "broken",
    retryability: "sometimes",
  }).ok, false);
});

test("ModuleOperationHost keeps one outcome and rejects stream gaps", () => {
  const host = new ModuleOperationHost(() => new Date("2026-09-02T00:00:00.000Z"));
  host.accept(executeRequest);
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 0), { accepted: true, gap: false });
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 0), { accepted: false, gap: false });
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 2), { accepted: false, gap: true });
  assert.equal(host.recordFinal("operation-1", "request-1", "completed").outcome, "completed");
  assert.equal(host.recordFinal("operation-1", "request-2", "cancelled").outcome, "completed");
});

test("ModuleOperationHost reconciles result_unknown to each final outcome", () => {
  for (const outcome of ["completed", "failed", "cancelled"] as const) {
    const host = new ModuleOperationHost(() => new Date("2026-09-02T00:00:00.000Z"));
    const request = {
      ...executeRequest,
      operationId: `operation-${outcome}`,
      requestId: `request-${outcome}`,
    };
    host.accept(request);
    const resolving = host.recordFinal(request.operationId, request.requestId, "result_unknown");
    assert.equal(resolving.state, "resolving");
    assert.equal(resolving.outcome, "result_unknown");

    const resolved = host.resolve(request.operationId, outcome);
    assert.equal(resolved.state, outcome);
    assert.equal(resolved.outcome, outcome);
  }
});

test("ModuleOperationHost preserves final outcomes and rejects premature reconciliation", () => {
  const host = new ModuleOperationHost(() => new Date("2026-09-02T00:00:00.000Z"));
  host.accept(executeRequest);
  assert.throws(() => host.resolve(executeRequest.operationId, "failed"), /OPERATION_NOT_RESOLVING/);

  const completed = host.recordFinal(executeRequest.operationId, executeRequest.requestId, "completed");
  assert.deepEqual(host.resolve(executeRequest.operationId, "cancelled"), completed);
  assert.deepEqual(host.status(executeRequest.operationId), completed);
});

test("InProcessModuleAdapter emits accepted, ordered events and a final outcome", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: {
      capabilitiesVersion: "2.0",
      methods: [{ name: "execute", profiles: ["streaming"], resumeSupport: "streaming", retry: "safe" }],
    },
    async *execute() {
      yield { eventType: "model.delta", payload: { text: "hello" } };
    },
  }, { moduleId: "model", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[1]?.kind, "event");
  assert.equal(messages[1]?.final, false);
  assert.equal(messages[2]?.kind, "event");
  assert.equal(messages[2]?.final, true);
  assert.equal(messages[2]?.outcome, "completed");
});

test("InProcessModuleAdapter emits a single final response for unary/tool profiles", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: {
      capabilitiesVersion: "2.0",
      methods: [{ name: "execute", profiles: ["unary", "tool"], resumeSupport: "none", retry: "safe" }],
    },
    async *execute() {
      yield { eventType: "tool.result", payload: { value: 42 }, final: true, outcome: "completed" as const };
    },
  }, { moduleId: "tool", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[0]?.final, true);
  assert.equal(messages[0]?.outcome, "completed");
});

test("InProcessModuleAdapter rejects an expired deadline before dispatch", async () => {
  let dispatched = false;
  const adapter = new InProcessModuleAdapter({
    capabilities: { capabilitiesVersion: "2.0", methods: [{ name: "execute", profiles: ["unary"] }] },
    async *execute() {
      dispatched = true;
      yield { eventType: "tool.result", payload: {} };
    },
  }, { moduleId: "tool", now: () => new Date("2026-09-02T00:00:00.000Z"), uuid: () => "fixed" });
  const messages = [];
  for await (const message of adapter.execute({
    ...executeRequest,
    operationDeadline: "2026-09-01T00:00:00.000Z",
  })) messages.push(message);
  assert.equal(dispatched, false);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[0]?.outcome, "failed");
});

test("InProcessModuleAdapter exposes status, resume, ack, and immutable completion", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: {
      capabilitiesVersion: "2.0",
      methods: [{ name: "execute", profiles: ["streaming"], resumeSupport: "streaming" }],
    },
    async *execute() {
      yield { eventType: "model.delta", payload: { text: "hello" } };
    },
  }, { moduleId: "model", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  const streamId = messages[0]?.kind === "response" ? messages[0].streamId : undefined;
  assert.equal(typeof streamId, "string");

  const status = adapter.status({
    kind: "request",
    messageId: "status-1",
    method: "status",
    requestId: executeRequest.requestId,
  });
  assert.equal(status.ok, true);
  assert.equal((status.payload as { state?: string }).state, "completed");

  const replay = adapter.resume({
    kind: "request",
    messageId: "resume-1",
    method: "resume",
    streamId: streamId!,
    previousBinding: {
      moduleInstanceId: adapter.moduleInstanceId,
      connectionGeneration: adapter.connectionGeneration,
    },
    lastAppliedSequence: 0,
  });
  assert.ok(Array.isArray(replay));
  assert.deepEqual(replay.map((event) => event.sequence), [1]);

  const ack = adapter.ack({
    kind: "request",
    messageId: "ack-1",
    method: "ack",
    streamId: streamId!,
    lastAppliedSequence: 1,
  });
  assert.equal(ack.ok, true);

  const cancel = adapter.cancel({
    kind: "request",
    messageId: "cancel-1",
    method: "cancel",
    runId: executeRequest.runId,
    operationId: executeRequest.operationId,
    reason: "late_cancel",
  });
  assert.equal((cancel.payload as { state?: string }).state, "completed");
});

test("InProcessModuleAdapter keeps result_unknown operations resolving", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: { capabilitiesVersion: "2.0", methods: [{ name: "execute", profiles: ["unary"] }] },
    async *execute() {
      yield { eventType: "execute.unknown", payload: {}, final: true, outcome: "result_unknown" as const };
    },
  }, { moduleId: "side-effect", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[0]?.kind === "response" ? messages[0].outcome : undefined, "result_unknown");

  const status = adapter.status({
    kind: "request",
    messageId: "status-1",
    method: "status",
    requestId: executeRequest.requestId,
  });
  assert.equal((status.payload as { state?: string }).state, "resolving");
});
