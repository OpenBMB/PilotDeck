import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { AgentLoopSidecarServer, type SidecarExecutionFactory } from "../../../src/agent/modules/sidecar.js";
import type { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { ModuleCapabilities } from "../../../src/agent/modules/protocol.js";

test("sidecar capabilities do not advertise unsupported stream resume", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });

  const factory: SidecarExecutionFactory = () => {
    throw new Error("capabilities handshake must not start an execution");
  };
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.end(`${JSON.stringify({
    kind: "request",
    messageId: "capabilities-1",
    method: "capabilities",
    payload: {},
  })}\n`);
  await serving;

  const response = lines.find((message) => message.inReplyTo === "capabilities-1");
  assert.equal(response?.ok, true);
  const payload = response?.payload as { methods?: Array<Record<string, unknown>> } | undefined;
  const methods = payload?.methods ?? [];
  assert.equal(methods.find((method) => method.name === "execute")?.resumeSupport, "none");
  assert.equal(methods.find((method) => method.name === "resume")?.enabled, false);
  assert.equal(methods.find((method) => method.name === "ack")?.enabled, false);
  assert.equal(methods.find((method) => method.name === "status")?.enabled, true);
});

test("sidecar assigns a distinct default module instance id to each process instance", () => {
  const ids = sequentialIds();
  const factory: SidecarExecutionFactory = () => {
    throw new Error("instance identity test does not execute a turn");
  };
  const first = new AgentLoopSidecarServer(factory, { uuid: ids });
  const second = new AgentLoopSidecarServer(factory, { uuid: ids });

  assert.match(first.moduleInstanceId, /^pilotdeck-agent-loop-instance-/);
  assert.match(second.moduleInstanceId, /^pilotdeck-agent-loop-instance-/);
  assert.notEqual(first.moduleInstanceId, second.moduleInstanceId);
});

test("resumable sidecar rebinds a live stream without replaying an applied event", async () => {
  const firstInput = new PassThrough();
  const firstOutput = new PassThrough();
  const firstLines = collectLines(firstOutput);
  const secondInput = new PassThrough();
  const secondOutput = new PassThrough();
  const secondLines = collectLines(secondOutput);
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], cancel: true, resumeSupport: "streaming" },
      { name: "cancel", enabled: true },
      { name: "status", enabled: true },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
    ],
  };
  const factory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        yield { type: "warning", sessionId: "resume-session", turnId: "resume-turn", code: "FIRST", message: "first" };
        await terminalGate;
        return {
          result: {
            type: "success",
            sessionId: "resume-session",
            turnId: "resume-turn",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-10T00:00:00.000Z",
            completedAt: "2026-09-10T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const server = new AgentLoopSidecarServer(factory, { capabilities, uuid: sequentialIds() });
  const servingFirst = server.serve(firstInput, firstOutput);
  firstInput.write(`${JSON.stringify({ kind: "request", messageId: "first-hello", method: "hello", payload: {} })}\n`);
  firstInput.write(`${JSON.stringify({ kind: "request", messageId: "first-capabilities", method: "capabilities", payload: {} })}\n`);
  firstInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "first-execute",
    method: "execute",
    runId: "resume-run",
    operationId: "resume-operation",
    requestId: "resume-request",
    payload: {},
  })}\n`);
  await waitFor(() => firstLines.some((message) => message.kind === "event" && message.sequence === 0));

  const accepted = firstLines.find((message) => message.inReplyTo === "first-execute");
  const firstHandshake = firstLines.find((message) => message.inReplyTo === "first-hello");
  assert.equal(typeof accepted?.streamId, "string");
  assert.equal(typeof firstHandshake?.moduleInstanceId, "string");
  assert.equal(typeof firstHandshake?.connectionGeneration, "string");
  const streamId = String(accepted?.streamId);
  const firstBinding = {
    moduleInstanceId: String(firstHandshake?.moduleInstanceId),
    connectionGeneration: String(firstHandshake?.connectionGeneration),
  };

  const servingSecond = server.serve(secondInput, secondOutput);
  secondInput.write(`${JSON.stringify({ kind: "request", messageId: "second-hello", method: "hello", payload: {} })}\n`);
  secondInput.write(`${JSON.stringify({ kind: "request", messageId: "second-capabilities", method: "capabilities", payload: {} })}\n`);
  await waitFor(() => secondLines.some((message) => message.inReplyTo === "second-capabilities"));
  const secondHandshake = secondLines.find((message) => message.inReplyTo === "second-hello");
  assert.notEqual(secondHandshake?.connectionGeneration, firstHandshake?.connectionGeneration);

  secondInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "resume-1",
    method: "resume",
    streamId,
    previousBinding: firstBinding,
    lastAppliedSequence: 0,
  })}\n`);
  await waitFor(() => secondLines.some((message) => message.inReplyTo === "resume-1"));
  releaseTerminal();
  await waitFor(() => secondLines.some((message) => message.kind === "event" && message.final === true));

  const resumed = secondLines.find((message) => message.inReplyTo === "resume-1");
  assert.equal(resumed?.ok, true);
  assert.equal(resumed?.replayedThroughSequence, 0);
  assert.deepEqual(
    secondLines.filter((message) => message.kind === "event").map((message) => message.sequence),
    [1],
  );

  secondInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "ack-1",
    method: "ack",
    streamId,
    lastAppliedSequence: 1,
  })}\n`);
  await waitFor(() => secondLines.some((message) => message.inReplyTo === "ack-1"));

  const thirdInput = new PassThrough();
  const thirdOutput = new PassThrough();
  const thirdLines = collectLines(thirdOutput);
  const servingThird = server.serve(thirdInput, thirdOutput);
  thirdInput.write(`${JSON.stringify({ kind: "request", messageId: "third-hello", method: "hello", payload: {} })}\n`);
  await waitFor(() => thirdLines.some((message) => message.inReplyTo === "third-hello"));
  thirdInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "resume-expired",
    method: "resume",
    streamId,
    previousBinding: {
      moduleInstanceId: String(secondHandshake?.moduleInstanceId),
      connectionGeneration: String(secondHandshake?.connectionGeneration),
    },
    lastAppliedSequence: 0,
  })}\n`);
  await waitFor(() => thirdLines.some((message) => message.inReplyTo === "resume-expired"));
  assert.equal(thirdLines.find((message) => message.inReplyTo === "resume-expired")?.code, "CURSOR_EXPIRED");

  firstInput.end();
  secondInput.end();
  thirdInput.end();
  await Promise.all([servingFirst, servingSecond, servingThird]);
});

function collectLines(output: PassThrough): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  return lines;
}

function sequentialIds(): () => string {
  let index = 0;
  return () => `id-${index++}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sidecar message.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("sidecar resume replays a pending module call and fences a stale host response", async () => {
  const firstInput = new PassThrough();
  const firstOutput = new PassThrough();
  const firstLines = collectLines(firstOutput);
  const secondInput = new PassThrough();
  const secondOutput = new PassThrough();
  const secondLines = collectLines(secondOutput);
  let settledCalls = 0;
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const factory: SidecarExecutionFactory = ({ request, callModule }) => ({
    loop: {
      async *run() {
        const response = await callModule({
          runId: request.runId,
          operationId: request.operationId,
          requestId: "pending-module-request",
          module: "permission",
          payload: { operation: "decide", toolCallId: "pending-module-tool", tool: { name: "write_file" }, input: {}, context: {} },
        });
        assert.equal(response.ok, true);
        settledCalls += 1;
        return {
          result: {
            type: "success",
            sessionId: "pending-module-session",
            turnId: "pending-module-turn",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-11T00:00:00.000Z",
            completedAt: "2026-09-11T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const server = new AgentLoopSidecarServer(factory, { capabilities, uuid: sequentialIds() });
  const servingFirst = server.serve(firstInput, firstOutput);
  firstInput.write(`${JSON.stringify({ kind: "request", messageId: "pending-hello-a", method: "hello", payload: {} })}\n`);
  firstInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "pending-execute",
    method: "execute",
    runId: "pending-module-run",
    operationId: "pending-module-operation",
    requestId: "pending-execute-request",
    payload: {},
  })}\n`);
  await waitFor(() => firstLines.some((message) => message.kind === "request" && message.method === "module_call"));

  const accepted = firstLines.find((message) => message.inReplyTo === "pending-execute");
  const firstHandshake = firstLines.find((message) => message.inReplyTo === "pending-hello-a");
  const originalCall = firstLines.find((message) => message.kind === "request" && message.method === "module_call");
  assert.equal(typeof accepted?.streamId, "string");
  assert.equal(typeof originalCall?.messageId, "string");
  const streamId = String(accepted?.streamId);
  const originalMessageId = String(originalCall?.messageId);

  const servingSecond = server.serve(secondInput, secondOutput);
  secondInput.write(`${JSON.stringify({ kind: "request", messageId: "pending-hello-b", method: "hello", payload: {} })}\n`);
  await waitFor(() => secondLines.some((message) => message.inReplyTo === "pending-hello-b"));
  secondInput.write(`${JSON.stringify({
    kind: "request",
    messageId: "pending-resume",
    method: "resume",
    streamId,
    previousBinding: {
      moduleInstanceId: String(firstHandshake?.moduleInstanceId),
      connectionGeneration: String(firstHandshake?.connectionGeneration),
    },
    lastAppliedSequence: -1,
  })}\n`);
  await waitFor(() => secondLines.some((message) => message.inReplyTo === "pending-resume"));
  await waitFor(() => secondLines.some((message) => message.kind === "request" && message.method === "module_call"));
  const replayed = secondLines.find((message) => message.kind === "request" && message.method === "module_call");
  assert.equal(replayed?.messageId, originalMessageId);

  // The old connection no longer owns this stream, so its late response must
  // not resolve the pending call after the replacement binding is installed.
  firstInput.write(`${JSON.stringify({
    kind: "response",
    messageId: "stale-host-response",
    inReplyTo: originalMessageId,
    requestId: "pending-module-request",
    ok: true,
    payload: { decision: { type: "allow" } },
  })}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(settledCalls, 0);

  secondInput.write(`${JSON.stringify({
    kind: "response",
    messageId: "current-host-response",
    inReplyTo: originalMessageId,
    requestId: "pending-module-request",
    ok: true,
    payload: { decision: { type: "allow" } },
  })}\n`);
  await waitFor(() => secondLines.some((message) => message.kind === "event" && message.final === true));
  assert.equal(settledCalls, 1);
  assert.equal(secondLines.filter((message) => message.kind === "request" && message.method === "module_call").length, 1);

  firstInput.end();
  secondInput.end();
  await Promise.all([servingFirst, servingSecond]);
});

test("sidecar status returns the live snapshot of an accepted execution", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.inReplyTo === "execute-status" && message.ok === true) {
        input.write(`${JSON.stringify({
          kind: "request",
          messageId: "status-1",
          method: "status",
          requestId: "request-status",
        })}\n`);
      }
      if (message.inReplyTo === "status-1") {
        releaseExecution();
        input.end();
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        await executionGate;
        return {
          result: {
            type: "success",
            sessionId: "session-status",
            turnId: "turn-status",
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-10T00:00:00.000Z",
            completedAt: "2026-09-10T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-status",
    method: "execute",
    runId: "run-status",
    operationId: "operation-status",
    requestId: "request-status",
    payload: {},
  })}\n`);
  await serving;

  const status = lines.find((message) => message.inReplyTo === "status-1");
  assert.equal(status?.ok, true);
  assert.deepEqual(status?.payload, {
    runId: "run-status",
    operationId: "operation-status",
    state: "running",
    requestIds: ["request-status"],
    cancelRequested: false,
    updatedAt: (status?.payload as { updatedAt?: string } | undefined)?.updatedAt,
  });
  assert.equal(typeof (status?.payload as { updatedAt?: unknown } | undefined)?.updatedAt, "string");
});

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

test("default sidecar server preserves a host model preparation through AgentLoop request normalization", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  const modelCalls: Array<{ operation?: string; preparationId?: string; request?: unknown }> = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.kind === "request" && message.method === "module_call") {
        const payload = message.payload as Record<string, unknown>;
        modelCalls.push({
          operation: payload.operation as string | undefined,
          preparationId: payload.preparationId as string | undefined,
          request: structuredClone(payload.request),
        });
        if (payload.operation === "prepare") {
          input.write(`${JSON.stringify({
            kind: "response",
            messageId: "host-prepared",
            inReplyTo: message.messageId,
            requestId: message.requestId,
            ok: true,
            payload: {
              prepared: {
                request: payload.request,
                provider: "host-provider",
                model: "host-model",
              },
            },
          })}\n`);
        } else {
          input.write(`${JSON.stringify({
            kind: "response",
            messageId: "host-streamed",
            inReplyTo: message.messageId,
            requestId: message.requestId,
            ok: true,
            payload: {
              events: [
                { type: "text_delta", text: "host done" },
                { type: "message_end", finishReason: "stop" },
              ],
            },
          })}\n`);
        }
      }
      if (message.kind === "event" && message.final === true) input.end();
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });

  const serving = new AgentLoopSidecarServer(createSidecarExecution).serve(input, output);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-model-preparation",
    method: "execute",
    runId: "run-model-preparation",
    operationId: "operation-model-preparation",
    requestId: "request-model-preparation",
    sessionId: "session-model-preparation",
    turnId: "turn-model-preparation",
    payload: {
      agent: { provider: "provider-a", model: "model-a" },
      hostModules: { model: { methods: ["prepare", "stream"] } },
      messages: [{ role: "user", content: "preserve the host preparation" }],
    },
  })}\n`);
  await serving;

  assert.deepEqual(modelCalls.map((call) => call.operation), ["prepare", "stream"]);
  assert.equal(typeof modelCalls[0]?.preparationId, "string");
  assert.equal(modelCalls[1]?.preparationId, modelCalls[0]?.preparationId);
  assert.equal((modelCalls[1]?.request as { provider?: string } | undefined)?.provider, "host-provider");
  assert.equal((modelCalls[1]?.request as { model?: string } | undefined)?.model, "host-model");
  assert.deepEqual(
    (modelCalls[1]?.request as { messages?: unknown } | undefined)?.messages,
    (modelCalls[0]?.request as { messages?: unknown } | undefined)?.messages,
  );
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "completed");
});

test("sidecar retry keeps operation identity and clears a recovered module failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  const moduleCalls: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.kind === "request" && message.method === "module_call") {
        moduleCalls.push(message);
        const failed = moduleCalls.length === 1;
        input.write(`${JSON.stringify({
          kind: "response",
          messageId: failed ? "host-response-failed" : "host-response-ok",
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: !failed,
          final: true,
          outcome: failed ? "result_unknown" : "completed",
          ...(failed ? { code: "MODEL_TEMPORARY_FAILURE", error: { message: "temporary" } } : { payload: { events: [] } }),
        })}\n`);
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });

  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        const first = await callModule({
          runId: "run-1",
          operationId: "op-1",
          requestId: "module-1",
          module: "model",
          payload: { request: { messages: [{ role: "user", content: [{ type: "text", text: "stable" }] }] } },
        });
        assert.equal(first.ok, false);
        assert.equal(first.outcome, "result_unknown");
        const second = await callModule({
          runId: "run-1",
          operationId: "op-1",
          requestId: "module-2",
          module: "model",
          payload: { request: { messages: [{ role: "user", content: [{ type: "text", text: "stable" }] }] } },
        });
        assert.equal(second.ok, true);
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
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
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

  assert.equal(moduleCalls.length, 2);
  assert.notEqual(moduleCalls[0]?.requestId, moduleCalls[1]?.requestId);
  assert.equal(moduleCalls[0]?.runId, moduleCalls[1]?.runId);
  assert.equal(moduleCalls[0]?.operationId, moduleCalls[1]?.operationId);
  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "completed");
  assert.equal("code" in (terminal ?? {}), false);
  assert.equal("error" in (terminal ?? {}), false);
});

test("sidecar terminal preserves the AgentLoop error instead of replacing it with a host failure", async () => {
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
          messageId: "host-response-failed",
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: false,
          final: true,
          outcome: "failed",
          code: "provider_unavailable",
          error: { message: "temporary provider failure", retryable: true },
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
            turns: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
            errors: [{ code: "agent_model_error", message: "temporary provider failure" }],
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
  assert.deepEqual(terminal?.error, {
    code: "agent_model_error",
    message: "temporary provider failure",
  });
  assert.deepEqual((terminal?.payload as Record<string, unknown> | undefined)?.moduleFailure, {
    code: "provider_unavailable",
    message: "temporary provider failure",
  });
});

test("sidecar emits result_unknown when a capability acknowledgement is fenced", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = collectLines(output);
  const factory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        throw Object.assign(new Error("host lost the capability acknowledgement"), { code: "RESULT_UNKNOWN" });
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-fenced",
    method: "execute",
    runId: "fenced-run",
    operationId: "fenced-operation",
    requestId: "fenced-request",
    payload: {},
  })}\n`);
  await waitFor(() => lines.some((message) => message.kind === "event" && message.final === true));
  input.end();
  await serving;

  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "result_unknown");
  assert.equal(terminal?.code, "RESULT_UNKNOWN");
  assert.deepEqual(terminal?.error, {
    code: "RESULT_UNKNOWN",
    message: "host lost the capability acknowledgement",
  });
});

test("sidecar does not continue after a host capability result_unknown response", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = collectLines(output);
  let continued = false;
  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        await callModule({
          runId: "unknown-run",
          operationId: "unknown-operation",
          requestId: "unknown-module-request",
          module: "capability",
          payload: { name: "write_file", arguments: {} },
        });
        continued = true;
        return { result: { type: "success" }, messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  output.on("data", () => {
    const call = lines.find((message) => message.kind === "request" && message.method === "module_call");
    if (!call || lines.some((message) => message.inReplyTo === call.messageId)) return;
    input.write(`${JSON.stringify({
      kind: "response",
      messageId: "host-unknown",
      inReplyTo: call.messageId,
      requestId: call.requestId,
      ok: false,
      final: true,
      outcome: "result_unknown",
      code: "RESULT_UNKNOWN",
      error: { code: "RESULT_UNKNOWN", message: "host lost the capability acknowledgement" },
    })}\n`);
  });
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-unknown",
    method: "execute",
    runId: "unknown-run",
    operationId: "unknown-operation",
    requestId: "unknown-request",
    payload: {},
  })}\n`);
  await waitFor(() => lines.some((message) => message.kind === "event" && message.final === true));
  input.end();
  await serving;

  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(continued, false);
  assert.equal(terminal?.outcome, "result_unknown");
  assert.equal(terminal?.code, "RESULT_UNKNOWN");
});

test("sidecar preserves a terminal host capability failure without another model turn", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = collectLines(output);
  let continued = false;
  const factory: SidecarExecutionFactory = ({ callModule }) => ({
    loop: {
      async *run() {
        await callModule({
          runId: "terminal-failure-run",
          operationId: "terminal-failure-operation",
          requestId: "terminal-failure-module-request",
          module: "capability",
          payload: { name: "knowledge_search", arguments: {} },
        });
        continued = true;
        return { result: { type: "success" }, messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  output.on("data", () => {
    const call = lines.find((message) => message.kind === "request" && message.method === "module_call");
    if (!call || lines.some((message) => message.inReplyTo === call.messageId)) return;
    input.write(`${JSON.stringify({
      kind: "response",
      messageId: "host-terminal-failure",
      inReplyTo: call.messageId,
      requestId: call.requestId,
      ok: false,
      final: true,
      outcome: "failed",
      code: "KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED",
      error: { code: "KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED", message: "knowledge budget exhausted" },
    })}\n`);
  });
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-terminal-failure",
    method: "execute",
    runId: "terminal-failure-run",
    operationId: "terminal-failure-operation",
    requestId: "terminal-failure-request",
    payload: {},
  })}\n`);
  await waitFor(() => lines.some((message) => message.kind === "event" && message.final === true));
  input.end();
  await serving;

  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(continued, false);
  assert.equal(terminal?.outcome, "failed");
  assert.equal(terminal?.code, "KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED");
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

test("sidecar classifies a matching host timeout cancel as result_unknown", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.inReplyTo === "execute-timeout" && message.ok === true) {
        input.write(`${JSON.stringify({
          kind: "request",
          messageId: "cancel-timeout",
          method: "cancel",
          runId: "run-timeout",
          operationId: "op-timeout",
          requestId: "request-timeout",
          reason: "timeout:run-timeout",
        })}\n`);
        input.end();
      }
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = ({ abortSignal }) => ({
    loop: {
      async *run() {
        if (!abortSignal.aborted) {
          await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return {
          result: {
            type: "aborted",
            sessionId: "session-timeout",
            turnId: "turn-timeout",
            stopReason: "aborted_streaming",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-18T00:00:00.000Z",
            completedAt: "2026-09-18T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-timeout",
    method: "execute",
    runId: "run-timeout",
    operationId: "op-timeout",
    requestId: "request-timeout",
    payload: {},
  })}\n`);
  await serving;

  const terminal = lines.find((message) => message.kind === "event" && message.final === true);
  assert.equal(terminal?.outcome, "result_unknown");
  assert.equal(terminal?.code, "DEADLINE_EXCEEDED");
});

test("sidecar fences stale cancel and duplicate execute against the active operation identity", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  let factoryCalls = 0;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      lines.push(message);
      if (message.inReplyTo === "execute-1" && message.ok === true) {
        input.write(`${JSON.stringify({
          kind: "request",
          messageId: "stale-cancel",
          method: "cancel",
          runId: "old-run",
          operationId: "operation-1",
          requestId: "request-1",
          reason: "stale",
        })}\n`);
        input.write(`${JSON.stringify({
          kind: "request",
          messageId: "duplicate-execute",
          method: "execute",
          runId: "run-1",
          operationId: "operation-1",
          requestId: "request-2",
          payload: {},
        })}\n`);
      }
      if (
        message.inReplyTo === "stale-cancel" || message.inReplyTo === "duplicate-execute"
      ) {
        const staleCancel = lines.find((candidate) => candidate.inReplyTo === "stale-cancel");
        const duplicate = lines.find((candidate) => candidate.inReplyTo === "duplicate-execute");
        if (staleCancel && duplicate) {
          input.write(`${JSON.stringify({
            kind: "request",
            messageId: "matching-cancel",
            method: "cancel",
            runId: "run-1",
            operationId: "operation-1",
            requestId: "request-1",
            reason: "current",
          })}\n`);
        }
      }
      if (message.inReplyTo === "matching-cancel") input.end();
    }
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = ({ abortSignal }) => ({
    loop: {
      async *run() {
        factoryCalls += 1;
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
        return {
          result: {
            type: "aborted",
            sessionId: "session-1",
            turnId: "turn-1",
            stopReason: "aborted_streaming",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-10T00:00:00.000Z",
            completedAt: "2026-09-10T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.write(`${JSON.stringify({
    kind: "request",
    messageId: "execute-1",
    method: "execute",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    payload: {},
  })}\n`);
  await serving;

  assert.equal(factoryCalls, 1);
  const staleCancel = lines.find((message) => message.inReplyTo === "stale-cancel");
  assert.equal(staleCancel?.ok, false);
  assert.equal(staleCancel?.code, "OPERATION_IDENTITY_MISMATCH");
  const duplicate = lines.find((message) => message.inReplyTo === "duplicate-execute");
  assert.equal(duplicate?.ok, false);
  assert.equal(duplicate?.code, "OPERATION_ALREADY_ACTIVE");
  const matchingCancel = lines.find((message) => message.inReplyTo === "matching-cancel");
  assert.equal(matchingCancel?.ok, true);
  assert.deepEqual(matchingCancel?.payload, { operationId: "operation-1", cancelled: true });
  const terminals = lines.filter((message) => message.kind === "event" && message.final === true);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.outcome, "cancelled");
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

test("sidecar rejects an execute whose deadline expires before it starts", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  let factoryCalls = 0;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (const line of buffered.split("\n").slice(0, -1)) lines.push(JSON.parse(line) as Record<string, unknown>);
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
  });
  const factory: SidecarExecutionFactory = () => {
    factoryCalls += 1;
    throw new Error("expired execute must not start");
  };
  const serving = new AgentLoopSidecarServer(factory).serve(input, output);
  input.end(`${JSON.stringify({
    kind: "request",
    messageId: "expired-execute",
    method: "execute",
    runId: "run-1",
    operationId: "op-1",
    requestId: "request-1",
    operationDeadline: "2026-09-01T00:00:00.000Z",
    payload: {},
  })}\n`);
  await serving;

  assert.equal(factoryCalls, 0);
  const rejection = lines.find((message) => message.inReplyTo === "expired-execute");
  assert.equal(rejection?.ok, false);
  assert.equal(rejection?.final, true);
  assert.equal(rejection?.outcome, "failed");
  assert.equal(rejection?.code, "DEADLINE_EXCEEDED");
});

test("sidecar resolves an active deadline as result_unknown for the host operation owner", async () => {
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
  assert.equal(terminal?.outcome, "result_unknown");
  assert.equal(terminal?.code, "DEADLINE_EXCEEDED");
  assert.deepEqual(terminal?.payload, {});
});
