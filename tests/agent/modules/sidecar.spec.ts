import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AgentLoopSidecarServer, type SidecarExecutionFactory } from "../../../src/agent/modules/sidecar.js";
import type { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { PilotDeckToolDefinition } from "../../../src/tool/index.js";

test("sidecar server round-trips host module calls and emits one terminal event", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.method === "module_call") {
        input.write(`${JSON.stringify({
          kind: "response",
          messageId: "host-response",
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: true,
          final: true,
          outcome: "completed",
          payload: { events: [{ type: "text_delta", text: "host" }] },
        })}\n`);
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });

  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        const response = await callModule({
          runId: "run-1",
          operationId: "op-1",
          requestId: "module-1",
          module: "model",
          payload: {},
        });
        assert.equal(response.ok, true);
        yield { type: "warning", sessionId: "session-1", turnId: "turn-1", code: "TEST", message: "ok" };
        return {
          result: {
            type: "success",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-02T00:00:00.000Z",
            completedAt: "2026-09-02T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const server = new AgentLoopSidecarServer(factory, { moduleId: "test-sidecar" });
  const serving = server.serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "hello-1", method: "hello", payload: {} })}\n`);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-1",
    method: "execute",
    runId: "run-1",
    operationId: "op-1",
    requestId: "request-1",
    payload: {},
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.end();
  await serving;

  assert.equal(lines.some((message) => message.kind === "response" && message.inReplyTo === "hello-1"), true);
  assert.equal(lines.some((message) => message.kind === "request" && message.method === "module_call"), true);
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "completed");
});

test("sidecar abort releases a pending module call", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.kind === "request" && message.method === "module_call") {
        input.write(`${JSON.stringify({
          kind: "request",
          messageId: "cancel-1",
          method: "cancel",
          runId: "run-1",
          operationId: "op-1",
          requestId: "request-1",
          reason: "test",
        })}\n`);
        input.end();
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        await callModule({ runId: "run-1", operationId: "op-1", requestId: "module-1", module: "model", payload: {} });
        return { result: { type: "success" }, messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "execute-1", method: "execute", runId: "run-1", operationId: "op-1", requestId: "request-1", payload: {} })}\n`);
  await serving;
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "cancelled");
});

test("sidecar maps max_turns to a failed protocol outcome with the original result", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) lines.push(JSON.parse(line) as Record<string, unknown>);
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        return {
          result: {
            type: "max_turns",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "max_turns",
            usage: { inputTokens: 1 },
            permissionDenials: [],
            turns: 2,
            startedAt: "2026-09-02T00:00:00.000Z",
            completedAt: "2026-09-02T00:00:00.001Z",
            errors: [{ code: "agent_max_turns_reached", message: "limit" }],
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "execute-1", method: "execute", runId: "run-1", operationId: "op-1", requestId: "request-1", payload: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.end();
  await serving;
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "failed");
  assert.equal(terminal?.code, "agent_max_turns_reached");
  assert.deepEqual((terminal?.payload as Record<string, unknown>)?.result, {
    type: "max_turns",
    sessionId: "session-1",
    turnId: "turn-1",
    stopReason: "max_turns",
    usage: { inputTokens: 1 },
    permissionDenials: [],
    turns: 2,
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:00.001Z",
    errors: [{ code: "agent_max_turns_reached", message: "limit" }],
  });
});

test("sidecar keeps the AgentLoop error contract when a host model module fails", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.kind === "request" && message.method === "module_call") {
        input.write(`${JSON.stringify({
          kind: "response",
          messageId: "model-failed",
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: false,
          code: "provider_unavailable",
          error: { message: "Host provider is unavailable." },
        })}\n`);
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        await callModule({
          runId: "run-1",
          operationId: "op-1",
          requestId: "model-1",
          module: "model",
          payload: {},
        });
        return {
          result: {
            type: "error",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "model_error",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "now",
            completedAt: "now",
            errors: [{ code: "agent_model_error", message: "The model request failed." }],
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "execute-1", method: "execute", runId: "run-1", operationId: "op-1", requestId: "request-1", payload: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.end();
  await serving;

  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "failed");
  assert.equal(terminal?.code, "agent_model_error");
});

test("sidecar supplies the canonical max_turns code when the result has no error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) lines.push(JSON.parse(line) as Record<string, unknown>);
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = async () => ({
    loop: {
      async *run() {
        return {
          result: {
            type: "max_turns",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "max_turns",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "now",
            completedAt: "now",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "execute-1", method: "execute", runId: "run-1", operationId: "op-1", requestId: "request-1", payload: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.end();
  await serving;
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "failed");
  assert.equal(terminal?.code, "agent_max_turns_reached");
});

test("sidecar aborts a generic execution at its deadline", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) lines.push(JSON.parse(line) as Record<string, unknown>);
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = ({ abortSignal }) => ({
    loop: {
      async *run() {
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
        return { result: { type: "success", sessionId: "s", turnId: "t", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "now", completedAt: "now" }, messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({ kind: "request", messageId: "execute-1", method: "execute", runId: "run-1", operationId: "op-1", requestId: "request-1", operationDeadline: new Date(Date.now() + 20).toISOString(), payload: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  input.end();
  await serving;
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "failed");
  assert.equal(terminal?.code, "DEADLINE_EXCEEDED");
});

test("sidecar tool port runs concurrency-safe calls in parallel and preserves order", async () => {
  const started: number[] = [];
  const tools: PilotDeckToolDefinition[] = ["one", "two"].map((name) => ({
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  }));
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async (request) => {
    started.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 25));
    const name = String(request.payload.name);
    return { kind: "response", messageId: `response-${name}`, inReplyTo: "call", ok: true, payload: { type: "success", toolCallId: String(request.payload.toolCallId), toolName: name, content: [], startedAt: "now", completedAt: "now" } };
  }, { tools });
  const results = await ports.tools.executeAll(
    [{ id: "call-1", name: "one", input: {} }, { id: "call-2", name: "two", input: {} }],
    { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
    { sessionId: "s", turnId: "t", runId: "run-1" },
  );
  assert.equal(results[0]?.toolName, "one");
  assert.equal(results[1]?.toolName, "two");
  assert.equal(started.length, 2);
});

test("sidecar tool port delegates an advertised batch to the host once", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const tools: PilotDeckToolDefinition[] = ["one", "two"].map((name) => ({
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  }));
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async (request) => {
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
  }, { tools, capabilityMethods: ["execute_batch"] });

  const results = await ports.tools.executeAll(
    [{ id: "call-1", name: "one", input: {} }, { id: "call-2", name: "two", input: {} }],
    { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
    { sessionId: "s", turnId: "t", runId: "run-1" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.module, "capability");
  assert.equal((requests[0]?.payload as Record<string, unknown>).operation, "execute_batch");
  assert.deepEqual(results.map((result) => result.toolCallId), ["call-1", "call-2"]);
});

test("sidecar tool port applies a host permission allow and forwards its rewritten input", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const tool: PilotDeckToolDefinition = {
    name: "write",
    description: "write",
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [] }),
  };
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    if (request.module === "permission") {
      return {
        kind: "response",
        messageId: "permission-response",
        inReplyTo: "permission-call",
        ok: true,
        payload: { decision: { type: "allow", updatedInput: { approved: true } } },
      };
    }
    return {
      kind: "response",
      messageId: "capability-response",
      inReplyTo: "capability-call",
      ok: true,
      payload: {
        type: "success",
        toolCallId: String(request.payload.toolCallId),
        toolName: "write",
        content: [],
        startedAt: "now",
        completedAt: "now",
      },
    };
  }, { tools: [tool], permissionMethods: ["decide"] });

  const [result] = await ports.tools.executeAll(
    [{ id: "call-1", name: "write", input: { approved: false } }],
    { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
    { sessionId: "s", turnId: "t", runId: "run-1" },
  );

  assert.equal(result?.type, "success");
  assert.deepEqual(requests.map((request) => request.module), ["permission", "capability"]);
  assert.deepEqual((requests[1]?.payload as Record<string, unknown>).arguments, { approved: true });
});

test("sidecar host permission denial cannot be bypassed by capability batch dispatch", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    return {
      kind: "response",
      messageId: "permission-response",
      inReplyTo: "permission-call",
      ok: true,
      payload: { decision: { type: "deny", message: "Denied by host." } },
    };
  }, { capabilityMethods: ["execute_batch"], permissionMethods: ["decide"] });

  const [result] = await ports.tools.executeAll(
    [{ id: "call-1", name: "restricted", input: {} }],
    { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
    { sessionId: "s", turnId: "t", runId: "run-1" },
  );

  assert.equal(result?.type, "error");
  assert.equal(result?.type === "error" && result.error.code, "permission_denied");
  assert.deepEqual(requests.map((request) => request.module), ["permission"]);
});

test("sidecar normalizes a bare host capability error into the native recovery projection", async () => {
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async () => ({
    kind: "response",
    messageId: "capability-response",
    inReplyTo: "capability-call",
    ok: true,
    payload: {
      type: "error",
      toolCallId: "call-1",
      toolName: "lookup",
      error: { code: "HOST_BACKEND_ERROR", message: "Host backend failed." },
      content: [{ type: "text", text: "Host backend failed." }],
      startedAt: "now",
      completedAt: "now",
    },
  }));

  const [result] = await ports.tools.executeAll(
    [{ id: "call-1", name: "lookup", input: {} }],
    { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
    { sessionId: "s", turnId: "t", runId: "run-1" },
  );

  assert.equal(result?.type, "error");
  assert.equal(result?.type === "error" && result.error.code, "tool_execution_failed");
  assert.equal(result?.type === "error" && result.content[0]?.type === "text" && result.content[0].text.startsWith("TOOL_ERROR[tool_execution_failed]"), true);
  assert.equal(result?.type === "error" && typeof result.metadata?.recovery, "object");
});

test("sidecar tool port rejects reordered batch results", async () => {
  const { createSidecarPorts } = await import("../../../src/agent/modules/sidecar.js");
  const ports = createSidecarPorts(async () => ({
    kind: "response",
    messageId: "response-batch",
    inReplyTo: "call",
    ok: true,
    payload: {
      results: [{ type: "success", toolCallId: "call-2", toolName: "two", content: [], startedAt: "now", completedAt: "now" }],
    },
  }), { capabilityMethods: ["execute_batch"] });

  await assert.rejects(
    () => ports.tools.executeAll(
      [{ id: "call-1", name: "one", input: {} }],
      { sessionId: "s", turnId: "t", cwd: "/tmp", permissionMode: "default", permissionContext: { mode: "default", rules: { allow: [], deny: [], ask: [] }, cwd: "/tmp", additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false } },
      { sessionId: "s", turnId: "t", runId: "run-1" },
    ),
    /does not match tool call call-1/,
  );
});
