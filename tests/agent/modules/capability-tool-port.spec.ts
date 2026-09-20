import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostCapabilityToolPort,
  createPermissionAwareToolPort,
  createPermissionToolAuthorizationPort,
  createToolSchedulerPort,
} from "../../../src/agent/modules/capability/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../../src/tool/index.js";

const runtimeContext = {
  sessionId: "s",
  turnId: "t",
  cwd: "/tmp",
  permissionMode: "default" as const,
  permissionContext: {
    mode: "default" as const,
    rules: { allow: [], deny: [], ask: [] },
    cwd: "/tmp",
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: false,
  },
};
const executionContext = { sessionId: "s", turnId: "t", runId: "run-1" };

function tool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  };
}

test("native capability provider adapts ToolScheduler to ToolPort", async () => {
  const tools = [tool("lookup")];
  const calls: string[] = [];
  const port = createToolSchedulerPort(
    { list: () => tools },
    {
      async executeAll(toolCalls) {
        calls.push(...toolCalls.map((call) => call.id));
        return [];
      },
    },
  );

  assert.equal(port.list(), tools);
  await port.executeAll([{ id: "call-1", name: "lookup", input: {} }], runtimeContext, executionContext);
  assert.deepEqual(calls, ["call-1"]);
});

test("native capability provider bounds one-shot child budget by operation deadline", async () => {
  const observed: PilotDeckToolRuntimeContext[] = [];
  const port = createToolSchedulerPort(
    { list: () => [] },
    {
      async executeAll(_calls, context) {
        observed.push(context);
        return [];
      },
    },
  );
  const now = "2026-09-11T00:00:00.000Z";
  const deadline = "2026-09-11T00:00:02.000Z";
  const call = [{ id: "call-1", name: "agent", input: {} }];

  const configured = { ...runtimeContext, now: () => new Date(now), subagentTimeoutMs: 10_000 };
  await port.executeAll(call, configured, { ...executionContext, operationDeadline: deadline });
  assert.equal(observed.pop()?.subagentTimeoutMs, 2_000);

  const shorterConfigured = { ...runtimeContext, now: () => new Date(now), subagentTimeoutMs: 500 };
  await port.executeAll(call, shorterConfigured, { ...executionContext, operationDeadline: deadline });
  assert.strictEqual(observed.pop(), shorterConfigured);

  const defaultBudget = { ...runtimeContext, now: () => new Date(now) };
  await port.executeAll(call, defaultBudget, { ...executionContext, operationDeadline: "2026-09-11T02:00:00.000Z" });
  assert.strictEqual(observed.pop(), defaultBudget);

  const malformed = { ...runtimeContext, now: () => new Date(now), subagentTimeoutMs: 10_000 };
  await port.executeAll(call, malformed, { ...executionContext, operationDeadline: "not-a-date" });
  assert.strictEqual(observed.pop(), malformed);

  const expired = { ...runtimeContext, now: () => new Date(now), subagentTimeoutMs: 10_000 };
  await port.executeAll(call, expired, { ...executionContext, operationDeadline: "2026-09-10T23:59:59.999Z" });
  assert.equal(observed.pop()?.subagentTimeoutMs, 0);
});

test("host capability consumer runs concurrency-safe calls in parallel and preserves order", async () => {
  const started: number[] = [];
  const port = createHostCapabilityToolPort(async (request) => {
    started.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const name = String(request.payload.name);
    return { kind: "response", messageId: `response-${name}`, inReplyTo: "call", ok: true, payload: { type: "success", toolCallId: String(request.payload.toolCallId), toolName: name, content: [], startedAt: "now", completedAt: "now" } };
  }, { tools: [tool("one"), tool("two")] });

  const results = await port.executeAll(
    [{ id: "call-1", name: "one", input: {} }, { id: "call-2", name: "two", input: {} }],
    runtimeContext,
    executionContext,
  );
  assert.equal(results[0]?.toolName, "one");
  assert.equal(results[1]?.toolName, "two");
  assert.equal(started.length, 2);
});

test("host capability consumer projects output truncation to the host tool", async () => {
  let context: Record<string, unknown> | undefined;
  const port = createHostCapabilityToolPort(async (request) => {
    context = request.payload.context as Record<string, unknown>;
    return { kind: "response", messageId: "response", inReplyTo: "call", ok: true, payload: { type: "success", toolCallId: "call-1", toolName: "lookup", content: [], startedAt: "now", completedAt: "now" } };
  }, { tools: [tool("lookup")] });

  await port.executeAll(
    [{ id: "call-1", name: "lookup", input: {} }],
    { ...runtimeContext, outputTruncated: true },
    executionContext,
  );
  assert.equal(context?.outputTruncated, true);
});

test("host capability consumer fails closed when a side effect result is unknown", async () => {
  const port = createHostCapabilityToolPort(async () => ({
    kind: "response",
    messageId: "response-unknown",
    inReplyTo: "call",
    ok: false,
    final: true,
    outcome: "result_unknown",
    code: "RESULT_UNKNOWN",
    error: { code: "RESULT_UNKNOWN", message: "host lost the tool acknowledgement" },
  }), { tools: [tool("write_file")] });

  await assert.rejects(
    () => port.executeAll(
      [{ id: "call-unknown", name: "write_file", input: {} }],
      runtimeContext,
      executionContext,
    ),
    (error: Error & { code?: string }) => error.code === "RESULT_UNKNOWN",
  );
});

test("host capability consumer gates side effects through the host permission port", async () => {
  const capabilityCalls: Array<Record<string, unknown>> = [];
  const permissionCalls: string[] = [];
  const port = createHostCapabilityToolPort(async (request) => {
    capabilityCalls.push(request as unknown as Record<string, unknown>);
    return {
      kind: "response",
      messageId: "response",
      inReplyTo: "call",
      ok: true,
      payload: { type: "success", toolCallId: String(request.payload.toolCallId), toolName: "write", content: [], startedAt: "now", completedAt: "now" },
    };
  }, {
    tools: [{ ...tool("write"), isReadOnly: () => false }],
    permission: {
      async decide(definedTool) {
        permissionCalls.push(definedTool.name);
        return {
          type: "deny",
          reason: { type: "runtime", message: "host policy denied write" },
          message: "host policy denied write",
        };
      },
    },
  });

  const [result] = await port.executeAll(
    [{ id: "call-1", name: "write", input: {} }],
    runtimeContext,
    executionContext,
  );

  assert.deepEqual(permissionCalls, ["write"]);
  assert.equal(capabilityCalls.length, 0);
  assert.equal(result?.type, "error");
  if (result?.type === "error") {
    assert.equal(result.error.code, "permission_denied");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /TOOL_ERROR\[permission_denied\]\[write\]\[ask_user\]/);
    const recovery = result.metadata?.recovery as { failureClass?: string } | undefined;
    assert.equal(recovery?.failureClass, "ask_user");
  }
});

test("authorization policy is independently composable around raw capability execution", async () => {
  const capabilityCalls: string[] = [];
  const raw = createHostCapabilityToolPort(async (request) => {
    capabilityCalls.push(String(request.payload.name));
    return {
      kind: "response", messageId: "response", inReplyTo: "call", ok: true,
      payload: { type: "success", toolCallId: String(request.payload.toolCallId), toolName: String(request.payload.name), content: [], startedAt: "now", completedAt: "now" },
    };
  }, { tools: [{ ...tool("write"), isReadOnly: () => false }] });
  const authorization = createPermissionToolAuthorizationPort({
    tools: [{ ...tool("write"), isReadOnly: () => false }],
    permission: { async decide() { return { type: "deny", reason: { type: "runtime", message: "blocked" }, message: "blocked" }; } },
  });
  const port = createPermissionAwareToolPort(raw, { authorization });
  const [result] = await port.executeAll([{ id: "call-1", name: "write", input: {} }], runtimeContext, executionContext);
  assert.deepEqual(capabilityCalls, []);
  assert.equal(result?.type, "error");
});

test("host capability consumer keeps permission within the native concurrency phase", async () => {
  const phases: string[] = [];
  const port = createHostCapabilityToolPort(async (request) => {
    const name = String(request.payload.name);
    phases.push(`capability:${name}`);
    return {
      kind: "response",
      messageId: `response-${name}`,
      inReplyTo: "call",
      ok: true,
      payload: { type: "success", toolCallId: String(request.payload.toolCallId), toolName: name, content: [], startedAt: "now", completedAt: "now" },
    };
  }, {
    tools: [tool("parallel"), { ...tool("serial"), isConcurrencySafe: () => false }],
    permission: {
      async decide(definedTool) {
        phases.push(`permission:${definedTool.name}`);
        return { type: "allow", reason: { type: "runtime", message: "allowed" } };
      },
    },
  });

  await port.executeAll(
    [{ id: "call-1", name: "parallel", input: {} }, { id: "call-2", name: "serial", input: {} }],
    runtimeContext,
    executionContext,
  );

  assert.deepEqual(phases, [
    "permission:parallel",
    "capability:parallel",
    "permission:serial",
    "capability:serial",
  ]);
});

test("host capability consumer delegates an advertised batch to the host once", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const port = createHostCapabilityToolPort(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    const calls = request.payload.calls as Array<Record<string, unknown>>;
    return {
      kind: "response",
      messageId: "response-batch",
      inReplyTo: "call",
      ok: true,
      payload: {
        results: calls.map((call) => ({
          type: "success",
          toolCallId: call.toolCallId,
          toolName: call.name,
          content: [],
          startedAt: "now",
          completedAt: "now",
        })),
      },
    };
  }, { tools: [tool("one"), tool("two")], methods: ["execute_batch"] });

  const results = await port.executeAll(
    [{ id: "call-1", name: "one", input: {} }, { id: "call-2", name: "two", input: {} }],
    runtimeContext,
    executionContext,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.module, "capability");
  assert.equal((requests[0]?.payload as Record<string, unknown>).operation, "execute_batch");
  assert.deepEqual(results.map((result) => result.toolCallId), ["call-1", "call-2"]);
});

test("authorization preserves one advertised batch across mixed tool concurrency", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const parallel = tool("parallel");
  const serial = { ...tool("serial"), isConcurrencySafe: () => false };
  const raw = createHostCapabilityToolPort(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    const calls = request.payload.calls as Array<Record<string, unknown>>;
    return {
      kind: "response",
      messageId: "response-batch",
      inReplyTo: "call",
      ok: true,
      payload: {
        results: calls.map((call) => ({
          type: "success",
          toolCallId: call.toolCallId,
          toolName: call.name,
          content: [],
          startedAt: "now",
          completedAt: "now",
        })),
      },
    };
  }, { tools: [parallel, serial], methods: ["execute_batch"] });
  const port = createPermissionAwareToolPort(raw, {
    preserveBatch: true,
    authorization: {
      async authorize(call) {
        return call.name === "serial"
          ? { result: { type: "error", toolCallId: call.id, toolName: call.name, error: { code: "permission_denied", message: "blocked" }, content: [], startedAt: "now", completedAt: "now" } }
          : { call };
      },
    },
  });

  const results = await port.executeAll(
    [{ id: "call-1", name: "parallel", input: {} }, { id: "call-2", name: "serial", input: {} }],
    runtimeContext,
    executionContext,
  );

  assert.equal(requests.length, 1);
  assert.equal((requests[0]?.payload as Record<string, unknown>).operation, "execute_batch");
  assert.deepEqual(((requests[0]?.payload as Record<string, unknown>).calls as Array<Record<string, unknown>>).map((call) => call.toolCallId), ["call-1"]);
  assert.deepEqual(results.map((result) => result.toolCallId), ["call-1", "call-2"]);
});

test("host capability consumer uses the sidecar binding when AgentLoop omits operation identity", async () => {
  let received: Record<string, unknown> | undefined;
  const port = createHostCapabilityToolPort(async (request) => {
    received = request as unknown as Record<string, unknown>;
    return {
      kind: "response",
      messageId: "response",
      inReplyTo: "call",
      ok: true,
      payload: { type: "success", toolCallId: "call-1", toolName: "one", content: [], startedAt: "now", completedAt: "now" },
    };
  }, {
    tools: [tool("one")],
    binding: { runId: "bound-run", operationId: "bound-operation", idempotencyKey: "bound-key" },
  });

  await port.executeAll(
    [{ id: "call-1", name: "one", input: {} }],
    runtimeContext,
    { sessionId: "s", turnId: "t", runId: "bound-run" },
  );

  assert.equal(received?.runId, "bound-run");
  assert.equal(received?.operationId, "bound-operation");
  assert.equal(received?.idempotencyKey, "bound-key");
});

test("host capability consumer rejects reordered batch results", async () => {
  const port = createHostCapabilityToolPort(async () => ({
    kind: "response",
    messageId: "response-batch",
    inReplyTo: "call",
    ok: true,
    payload: {
      results: [{ type: "success", toolCallId: "call-2", toolName: "two", content: [], startedAt: "now", completedAt: "now" }],
    },
  }), { methods: ["execute_batch"] });

  await assert.rejects(
    () => port.executeAll(
      [{ id: "call-1", name: "one", input: {} }],
      runtimeContext,
      executionContext,
    ),
    /does not match tool call call-1/,
  );
});
