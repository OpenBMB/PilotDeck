import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
  createAgentLoopSidecarRuntimeFactory,
  createTcpAgentLoopSidecarConnectionFactory,
} from "../../../src/agent/index.js";
import {
  createAgentLoopDeploymentFactory,
  resolveAgentLoopDeploymentProfile,
} from "../../../src/cli/AgentLoopDeploymentProfile.js";
import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createAgentSession } from "../../../src/agent/session/createAgentSession.js";
import type { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { SidecarExecutionFactory } from "../../../src/agent/modules/transport/agentLoopSidecarServer.js";
import type { ModuleCapabilities, ModelInvokerPort, ToolPort } from "../../../src/agent/modules/protocol.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import type { PermissionDecision } from "../../../src/permission/index.js";
import { GatewayElicitationBus } from "../../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../../../src/gateway/permission/GatewayPermissionBus.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";

test("TCP sidecar provider reconnects one live stream without duplicating the host terminal", async (t) => {
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const sidecarFactory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        yield {
          type: "warning",
          sessionId: "tcp-session",
          turnId: "tcp-turn",
          code: "TCP_RECONNECT",
          message: "first connection",
        };
        await terminalGate;
        return {
          result: completedResult("tcp-session", "tcp-turn"),
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(sidecarFactory, { capabilities }));
  const address = await tcpServer.listen({ port: 0 });
  t.after(async () => {
    releaseTerminal();
    await tcpServer.close();
  });

  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(address);
  const resumeInputs: Array<Record<string, unknown>> = [];
  let dropAfterSequenceZero = true;
  const runtimeFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      return {
        send: (message) => active.send(message),
        async *receive() {
          for await (const message of active.receive()) {
            yield message;
            if (dropAfterSequenceZero && isSequenceZeroEvent(message)) {
              dropAfterSequenceZero = false;
              await active.close?.("test_connection_drop");
              return;
            }
          }
        },
        async reconnect(reconnectInput) {
          resumeInputs.push(structuredClone(reconnectInput));
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return active;
        },
        close: (reason) => active.close?.(reason),
      };
    },
    uuid: deterministicIds(),
  });
  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "tcp-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: runtimeFactory,
  });

  const submitted = collect(session.submit({ type: "text", text: "resume over TCP" }, {
    turnId: "tcp-turn",
    execution: { runId: "tcp-run", operationId: "tcp-operation" },
  }));
  await waitFor(() => resumeInputs.length === 1);
  releaseTerminal();
  const events = await submitted;

  assert.equal(resumeInputs.length, 1);
  assert.equal(resumeInputs[0]?.lastAppliedSequence, 0);
  assert.match(String(resumeInputs[0]?.streamId), /^stream-/);
  const previousBinding = resumeInputs[0]?.previousBinding as Record<string, unknown> | undefined;
  assert.match(String(previousBinding?.moduleInstanceId), /^pilotdeck-agent-loop-instance-/);
  assert.match(String(previousBinding?.connectionGeneration), /^pilotdeck-agent-loop-instance-/);
  assert.equal(events.filter((event) => event.type === "warning").length, 1);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  assert.deepEqual(
    transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_")).map((entry) => entry.type),
    ["agent_loop_operation_started", "agent_loop_operation_accepted", "agent_loop_operation_terminal"],
  );
});

test("TCP sidecar process restart reconciles through the host without replaying execute", async (t) => {
  let releaseFirstExecution!: () => void;
  const firstExecution = new Promise<void>((resolve) => { releaseFirstExecution = resolve; });
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const firstFactory: SidecarExecutionFactory = () => ({
    loop: {
      async *run() {
        yield {
          type: "warning",
          sessionId: "tcp-restart-session",
          turnId: "tcp-restart-turn",
          code: "TCP_RESTART",
          message: "first sidecar instance",
        };
        await firstExecution;
        return { result: completedResult("tcp-restart-session", "tcp-restart-turn"), messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const first = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(firstFactory, {
    capabilities,
    moduleInstanceId: "tcp-restart-instance-a",
  }));
  const address = await first.listen({ port: 0 });
  let replacement: AgentLoopSidecarTcpServer | undefined;
  t.after(async () => {
    releaseFirstExecution();
    await first.close();
    await replacement?.close();
  });

  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(address);
  const reconnects: Array<Record<string, unknown>> = [];
  const statusQueries: Array<Record<string, unknown>> = [];
  let restartAfterSequenceZero = true;
  let executeCalls = 0;
  const runtimeFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      return {
        send(message) {
          if ((message as { method?: unknown }).method === "execute") executeCalls += 1;
          return active.send(message);
        },
        async *receive() {
          for await (const message of active.receive()) {
            yield message;
            if (restartAfterSequenceZero && isSequenceZeroEvent(message)) {
              restartAfterSequenceZero = false;
              await first.close();
              replacement = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(firstFactory, {
                capabilities,
                moduleInstanceId: "tcp-restart-instance-b",
              }));
              await replacement.listen({ host: address.host, port: address.port });
              return;
            }
          }
        },
        async reconnect(reconnectInput) {
          reconnects.push(structuredClone(reconnectInput));
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return active;
        },
        close: (reason) => active.close?.(reason),
      };
    },
    reconcileResultUnknown: async (input) => {
      statusQueries.push(structuredClone(input));
      return {
        outcome: "completed",
        result: completedResult("tcp-restart-session", "tcp-restart-turn"),
        messages: [{ role: "assistant", content: [{ type: "text", text: "host reconciliation" }] }],
      };
    },
    uuid: deterministicIds(),
  });
  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "tcp-restart-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: runtimeFactory,
  });

  const events = await collect(session.submit({ type: "text", text: "restart TCP sidecar" }, {
    turnId: "tcp-restart-turn",
    execution: { runId: "tcp-restart-run", operationId: "tcp-restart-operation" },
  }));

  assert.equal(reconnects.length, 1);
  assert.equal(executeCalls, 1);
  assert.equal(statusQueries.length, 1);
  assert.equal(statusQueries[0]?.code, "SIDECAR_INSTANCE_RESTARTED");
  const restartBinding = statusQueries[0]?.binding as {
    moduleInstanceId?: unknown;
    connectionGeneration?: unknown;
  } | undefined;
  assert.equal(restartBinding?.moduleInstanceId, "tcp-restart-instance-a");
  assert.match(String(restartBinding?.connectionGeneration), /^tcp-restart-instance-a-/);
  assert.equal(events.filter((event) => event.type === "warning").length, 1);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
  assert.deepEqual(
    transcript.entries
      .filter((entry) => entry.type === "agent_loop_operation_terminal")
      .map((entry) => entry.outcome),
    ["result_unknown", "completed"],
  );
});

test("TCP sidecar replays a pending permission module call after interaction reconnect", async (t) => {
  const sessionId = "tcp-interaction-session";
  const turnId = "tcp-interaction-turn";
  const interactionRequestId = "tcp-interaction-permission";
  const firstBinding = { connectionId: "interaction-connection-a", generation: 1 };
  const secondBinding = { connectionId: "interaction-connection-b", generation: 2 };
  const permissionBus = new GatewayPermissionBus();
  permissionBus.reconnect(sessionId, firstBinding);
  let permissionCalls = 0;
  let moduleResponses = 0;
  const permission = {
    decide: async (_tool: unknown, _input: unknown, _context: unknown, toolCallId: string): Promise<PermissionDecision> => {
      permissionCalls += 1;
      return new Promise<PermissionDecision>((resolve, reject) => {
        permissionBus.register(sessionId, {
          requestId: interactionRequestId,
          toolCallId,
          toolName: "write_file",
          resolve: (decision) => resolve(decision.decision === "allow"
            ? { type: "allow", reason: { type: "runtime", message: "Approved after reconnect." } }
            : {
                type: "deny",
                reason: { type: "runtime", message: "Denied after reconnect." },
                message: decision.reason ?? "Denied after reconnect.",
              }),
          reject,
        }, {
          payload: { path: "note.txt", content: "pending interaction" },
        });
      });
    },
  };
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const sidecarFactory: SidecarExecutionFactory = ({ request, callModule }) => ({
    loop: {
      async *run() {
        const response = await callModule({
          runId: request.runId,
          operationId: request.operationId,
          requestId: "tcp-interaction-module-request",
          module: "permission",
          payload: {
            operation: "decide",
            toolCallId: "tcp-interaction-tool-call",
            tool: { name: "write_file" },
            input: { path: "note.txt", content: "pending interaction" },
            context: {},
          },
        });
        if (!response.ok) throw new Error("Host permission module did not settle successfully.");
        moduleResponses += 1;
        return { result: completedResult(sessionId, turnId), messages: [] };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(sidecarFactory, { capabilities }));
  const address = await tcpServer.listen({ port: 0 });
  t.after(() => tcpServer.close());

  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(address);
  const reconnects: Array<Record<string, unknown>> = [];
  let closeActiveConnection: (() => Promise<void>) | undefined;
  const runtimeFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      closeActiveConnection = async () => { await active.close?.("interaction_pending_disconnect"); };
      return {
        send: (message) => active.send(message),
        receive: () => active.receive(),
        async reconnect(reconnectInput) {
          reconnects.push(structuredClone(reconnectInput));
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return active;
        },
        close: (reason) => active.close?.(reason),
      };
    },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId,
    config: config(),
    dependencies: {
      router: {} as never,
      ports: {
        model: noopModel(),
        tools: {
          list: () => [{
            name: "write_file",
            description: "Write a file after permission approval.",
            kind: "custom",
            inputSchema: { type: "object" },
            isReadOnly: () => false,
            isConcurrencySafe: () => false,
            execute: async () => ({ content: [] }),
          }],
          executeAll: async () => [],
        },
      },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
      permission: permission as never,
    },
    agentLoopFactory: runtimeFactory,
  });

  const submitted = collect(session.submit({ type: "text", text: "wait for approval across reconnect" }, {
    turnId,
    execution: { runId: "tcp-interaction-run", operationId: "tcp-interaction-operation" },
  }));
  await waitFor(() => permissionCalls === 1);
  assert.ok(closeActiveConnection, "the accepted sidecar connection must be available to disconnect");
  await closeActiveConnection();

  assert.equal(permissionBus.disconnect(sessionId, firstBinding), true);
  assert.equal(permissionBus.reconnect(sessionId, secondBinding, firstBinding).outcome, "reconnected");
  assert.equal(permissionBus.consume(sessionId, interactionRequestId, firstBinding), undefined);
  const current = permissionBus.consume(sessionId, interactionRequestId, secondBinding);
  assert.ok(current, "only the replacement interaction binding may answer the pending permission");
  current.resolve({ requestId: interactionRequestId, decision: "deny", outcome: "reconnect" });

  const events = await withTimeout(submitted, "pending module call replay");
  assert.equal(permissionCalls, 1, "replayed module_call must reuse the completed host response");
  assert.equal(moduleResponses, 1, "the sidecar must settle the original module call exactly once");
  assert.equal(reconnects.length, 1);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
});

test("TCP sidecar replays a pending capability question after interaction reconnect", async (t) => {
  const sessionId = "tcp-question-session";
  const turnId = "tcp-question-turn";
  const interactionRequestId = "tcp-question-request";
  const firstBinding = { connectionId: "question-connection-a", generation: 1 };
  const secondBinding = { connectionId: "question-connection-b", generation: 2 };
  const elicitationBus = new GatewayElicitationBus();
  elicitationBus.reconnect(sessionId, firstBinding);
  let toolCalls = 0;
  let modelCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "tcp-question-tool-call", name: "ask_user_question", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "question settled" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "ask_user_question",
      description: "Ask a user question through the host interaction channel.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls) {
      toolCalls += 1;
      const call = calls[0];
      assert.ok(call, "the sidecar must send one host capability call");
      const answer = await new Promise<{ type: "answered"; answers: Record<string, string | string[]> } | { type: "cancelled"; reason?: string }>((resolve, reject) => {
        elicitationBus.register(sessionId, {
          requestId: interactionRequestId,
          toolCallId: call.id,
          toolName: call.name,
          resolve,
          reject,
        }, {
          payload: {
            questions: [{
              question: "Continue?",
              header: "Confirm",
              options: [{ label: "Continue", description: "Continue the turn." }],
            }],
          },
        });
      });
      return [{
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: answer.type === "cancelled" ? "cancelled" : "answered" }],
        startedAt: "2026-09-11T00:00:00.000Z",
        completedAt: "2026-09-11T00:00:00.001Z",
      }];
    },
  };
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const sidecarFactory: SidecarExecutionFactory = (input) => createSidecarExecution(input);
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(sidecarFactory, { capabilities }));
  const address = await tcpServer.listen({ port: 0 });
  t.after(() => tcpServer.close());

  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(address);
  const reconnects: Array<Record<string, unknown>> = [];
  let closeActiveConnection: (() => Promise<void>) | undefined;
  const runtimeFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      closeActiveConnection = async () => { await active.close?.("question_pending_disconnect"); };
      return {
        send: (message) => active.send(message),
        receive: () => active.receive(),
        async reconnect(reconnectInput) {
          reconnects.push(structuredClone(reconnectInput));
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return active;
        },
        close: (reason) => active.close?.(reason),
      };
    },
    uuid: deterministicIds(),
  });
  const session = createAgentSession({
    sessionId,
    config: config(),
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: runtimeFactory,
  });

  const submitted = collect(session.submit({ type: "text", text: "wait for a question across reconnect" }, {
    turnId,
    execution: { runId: "tcp-question-run", operationId: "tcp-question-operation" },
  }));
  await waitFor(() => toolCalls === 1);
  assert.ok(closeActiveConnection, "the accepted sidecar connection must be available to disconnect");
  await closeActiveConnection();

  assert.equal(elicitationBus.disconnect(sessionId, firstBinding), true);
  assert.equal(elicitationBus.reconnect(sessionId, secondBinding, firstBinding).outcome, "reconnected");
  assert.equal(elicitationBus.consume(sessionId, interactionRequestId, firstBinding), undefined);
  const current = elicitationBus.consume(sessionId, interactionRequestId, secondBinding);
  assert.ok(current, "only the replacement interaction binding may answer the pending question");
  current.resolve({ type: "cancelled", reason: "answered after reconnect" });

  const events = await withTimeout(submitted, "pending capability question replay");
  assert.equal(toolCalls, 1, "replayed module_call must reuse the completed host capability result");
  assert.equal(modelCalls, 2, "the resumed sidecar must consume the original tool result and continue once");
  assert.equal(reconnects.length, 1);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{ result?: { type?: string } }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "success");
});

test("TCP sidecar replays a plan-mode capability result without repeating its host transition", async (t) => {
  let hostToolCalls = 0;
  let modelCalls = 0;
  const capabilities: ModuleCapabilities = {
    capabilitiesVersion: "2.0",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
      { name: "resume", enabled: true },
      { name: "ack", enabled: true },
      { name: "status", enabled: true },
    ],
  };
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(
    (input) => createSidecarExecution(input),
    { capabilities },
  ));
  const address = await tcpServer.listen({ port: 0 });
  t.after(() => tcpServer.close());

  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "enter-plan", name: "enter_plan_mode", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "plan mode entered" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "enter_plan_mode",
      description: "Enter plan mode.",
      kind: "session",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls) {
      hostToolCalls += 1;
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "plan mode ready" }],
        data: { requestedMode: "plan" },
        startedAt: "2026-09-12T00:00:00.000Z",
        completedAt: "2026-09-12T00:00:00.001Z",
      }));
    },
  };
  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(address);
  const reconnects: Array<Record<string, unknown>> = [];
  let capabilityRequestId: string | undefined;
  let dropFirstCapabilityResponse = true;
  const runtimeFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      return {
        async send(message) {
          const response = message as { kind?: unknown; inReplyTo?: unknown };
          if (
            dropFirstCapabilityResponse
            && response.kind === "response"
            && response.inReplyTo === capabilityRequestId
          ) {
            dropFirstCapabilityResponse = false;
            await active.close?.("drop_plan_mode_response");
            throw new Error("test connection dropped before capability response delivery");
          }
          await active.send(message);
        },
        async *receive() {
          for await (const message of active.receive()) {
            const request = message as { kind?: unknown; method?: unknown; module?: unknown; messageId?: unknown };
            if (
              request.kind === "request"
              && request.method === "module_call"
              && request.module === "capability"
              && typeof request.messageId === "string"
            ) {
              capabilityRequestId = request.messageId;
            }
            yield message;
          }
        },
        async reconnect(reconnectInput) {
          reconnects.push(structuredClone(reconnectInput));
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return active;
        },
        close: (reason) => active.close?.(reason),
      };
    },
    uuid: deterministicIds(),
  });
  const runtimeConfig = config();
  const session = createAgentSession({
    sessionId: "tcp-plan-mode-session",
    config: runtimeConfig,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: runtimeFactory,
  });

  const events = await withTimeout(collect(session.submit({ type: "text", text: "enter plan mode" }, {
    turnId: "tcp-plan-mode-turn",
    allowPlanModeTools: true,
  })), "plan mode capability replay");

  assert.equal(hostToolCalls, 1, "replayed capability module_call must reuse the completed host result");
  assert.equal(reconnects.length, 1);
  assert.equal(runtimeConfig.permissionMode, "plan");
  assert.equal(runtimeConfig.permissionContext.mode, "plan");
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "success");
});

test("TCP sidecar active deadline records result_unknown and fails closed without a host resolution", async (t) => {
  let observedAbort = false;
  const sidecarFactory: SidecarExecutionFactory = ({ abortSignal }) => ({
    loop: {
      async *run() {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        observedAbort = true;
        // The server must not publish this apparent success after its own
        // deadline timer has fired. It emits result_unknown instead.
        return {
          result: completedResult("tcp-deadline-session", "tcp-deadline-turn"),
          messages: [],
        };
      },
    } as unknown as AgentLoop,
    input: {} as never,
  });
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(sidecarFactory));
  const address = await tcpServer.listen({ port: 0 });
  t.after(() => tcpServer.close());

  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "tcp-deadline-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: createTcpAgentLoopSidecarConnectionFactory(address),
      uuid: deterministicIds(),
    }),
  });

  const events = await collect(session.submit({ type: "text", text: "expire the active sidecar execution" }, {
    turnId: "tcp-deadline-turn",
    execution: {
      runId: "tcp-deadline-run",
      operationId: "tcp-deadline-operation",
      operationDeadline: new Date(Date.now() + 50).toISOString(),
    },
  }));
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result?: { type?: string; errors?: Array<{ code?: string }> };
  }>;

  assert.equal(observedAbort, true, "the active sidecar execution must receive its deadline abort");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "error");
  assert.equal(terminals[0]?.result?.errors?.[0]?.code, "agent_invalid_state");
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const operationTerminal = operationEntries.at(-1);
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.outcome, "result_unknown");
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.code, "DEADLINE_EXCEEDED");
});

test("TCP sidecar ignores a late host tool success after an active deadline", async (t) => {
  let deadlineTriggered = false;
  let releaseTool!: () => void;
  const releaseToolResult = new Promise<void>((resolve) => { releaseTool = resolve; });
  let toolStarted = false;
  let toolReturned = false;
  const sidecarFactory: SidecarExecutionFactory = (input) => {
    input.abortSignal.addEventListener("abort", () => { deadlineTriggered = true; }, { once: true });
    return createSidecarExecution(input);
  };
  const tcpServer = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(sidecarFactory));
  const address = await tcpServer.listen({ port: 0 });
  t.after(() => tcpServer.close());

  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "request_started", provider: "host-provider", model: "host-model" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "late-tool-call", name: "slow_tool" };
      yield { type: "tool_call_end", toolCall: { id: "late-tool-call", name: "slow_tool", input: {} } };
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
      toolStarted = true;
      await releaseToolResult;
      toolReturned = true;
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "late host success" }],
        startedAt: "2026-09-11T00:00:00.000Z",
        completedAt: "2026-09-11T00:00:00.001Z",
      }));
    },
  };
  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "tcp-late-tool-session",
    config: config("bypassPermissions"),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: createTcpAgentLoopSidecarConnectionFactory(address),
      uuid: deterministicIds(),
    }),
  });

  const submitted = collect(session.submit({ type: "text", text: "run a slow host tool" }, {
    turnId: "tcp-late-tool-turn",
    execution: {
      runId: "tcp-late-tool-run",
      operationId: "tcp-late-tool-operation",
      operationDeadline: new Date(Date.now() + 1_000).toISOString(),
    },
  }));
  await waitFor(() => toolStarted);
  await waitFor(() => deadlineTriggered);
  releaseTool();
  const events = await submitted;
  const operationEntries = transcript.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result?: { type?: string; errors?: Array<{ code?: string }> };
  }>;

  assert.equal(toolReturned, true, "the host tool completion is intentionally late");
  assert.equal(events.filter((event) => event.type === "tool_result").length, 0, "a late host result must not re-enter the closed sidecar turn");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "error");
  assert.equal(terminals[0]?.result?.errors?.[0]?.code, "agent_invalid_state");
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const operationTerminal = operationEntries.at(-1);
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.outcome, "result_unknown");
  assert.equal(operationTerminal?.type === "agent_loop_operation_terminal" && operationTerminal.code, "DEADLINE_EXCEEDED");
});

test("built sidecar CLI serves Module Protocol over local TCP when configured", async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, [builtSidecarPath()], {
    env: {
      ...process.env,
      PILOTDECK_AGENT_LOOP_TCP_HOST: "127.0.0.1",
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  t.after(async () => {
    await stopChild(child);
  });

  const connect = createTcpAgentLoopSidecarConnectionFactory({ port, connectTimeoutMs: 100 });
  const connection = await connectEventually(connect);
  t.after(async () => {
    await connection.close?.("test_finished");
  });
  const iterator = connection.receive()[Symbol.asyncIterator]();
  await connection.send({ kind: "request", messageId: "tcp-cli-hello", method: "hello", payload: {} });
  const response = await iterator.next();
  assert.equal(response.done, false, stderr || "TCP sidecar closed before hello response.");
  const message = response.value as Record<string, unknown>;
  assert.equal(message.kind, "response");
  assert.equal(message.inReplyTo, "tcp-cli-hello");
  assert.equal(message.protocolVersion, "2.0");
});

for (const crashStage of ["before_effect", "after_effect"] as const) {
test(`built TCP sidecar restart ${crashStage} persists host and operation evidence without replay`, async (t) => {
  const port = await reservePort();
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-built-tcp-restart-"));
  const effectsPath = join(directory, "host-effects.jsonl");
  const transcriptPath = join(directory, "transcript.jsonl");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let child = startBuiltTcpSidecar(port);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  t.after(async () => {
    await stopChild(child);
  });

  const connect = createTcpAgentLoopSidecarConnectionFactory({ port, connectTimeoutMs: 100 });
  const readiness = await connectEventually(connect);
  const originalBinding = await helloBinding(readiness, "tcp-original-hello");
  await readiness.close?.("test_readiness_complete");

  let toolExecutions = 0;
  let replacementBinding: { moduleInstanceId: string; connectionGeneration: string } | undefined;
  const observations: Array<Record<string, unknown>> = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "built-restart-tool", name: "lookup", input: { query: "durable effect" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "lookup",
      description: "Read the durable restart fixture.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls) {
      toolExecutions += 1;
      // Crash precisely on either side of the host's durable effect append.
      // The response cannot cross the socket after the child is replaced, so
      // the caller must preserve result_unknown rather than replaying it.
      if (crashStage === "after_effect") {
        await writeFile(effectsPath, calls.map((call) => JSON.stringify({
          effectId: call.id,
          toolName: call.name,
          committed: true,
        })).join("\n") + "\n", "utf8");
      }
      await stopChild(child);
      child = startBuiltTcpSidecar(port);
      const replacementConnection = await connectEventually(connect);
      replacementBinding = await helloBinding(replacementConnection, "tcp-replacement-hello");
      await replacementConnection.close?.("replacement_readiness_complete");
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "durably committed" }],
        startedAt: "2026-09-20T00:00:00.000Z",
        completedAt: "2026-09-20T00:00:00.001Z",
      }));
    },
  };
  const transcript = new JsonlTranscriptWriter({ path: transcriptPath });
  const profile = resolveAgentLoopDeploymentProfile({
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: "127.0.0.1",
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(port),
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "100",
    },
  });
  const factory = createAgentLoopDeploymentFactory(profile, {
    transportObserver: { observe: (observation) => { observations.push({ ...observation }); } },
  });
  assert.ok(factory, "TCP deployment profile must create the production sidecar factory");
  const session = createAgentSession({
    sessionId: "built-restart-session",
    config: config(),
    transcript,
    dependencies: {
      router: {} as never,
      ports: { model, tools },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: factory,
  });

  const events = await collect(session.submit({ type: "text", text: "restart after effect" }, {
    turnId: "built-restart-turn",
    execution: { runId: "built-restart-run", operationId: "built-restart-operation" },
  }));
  await transcript.close();

  assert.equal(toolExecutions, 1, stderr || "the host capability dispatcher must not replay after child restart");
  const durableEffects = (await readFile(effectsPath, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { effectId: string; toolName: string; committed: boolean });
  assert.equal(
    durableEffects.length,
    crashStage === "after_effect" ? 1 : 0,
    `${crashStage} must preserve the host's durable effect boundary`,
  );
  assert.ok(replacementBinding, "the replacement built child must answer hello");
  assert.notEqual(replacementBinding.moduleInstanceId, originalBinding.moduleInstanceId);
  assert.notEqual(replacementBinding.connectionGeneration, originalBinding.connectionGeneration);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 0);
  const terminals = events.filter((event) => event.type === "turn_completed") as Array<{
    result?: { type?: string; errors?: Array<{ code?: string }> };
  }>;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.result?.type, "error");
  assert.equal(terminals[0]?.result?.errors?.[0]?.code, "agent_invalid_state");
  const persistedEntries = (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; outcome?: string });
  const operationEntries = persistedEntries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.deepEqual(operationEntries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);
  const operationTerminal = operationEntries.at(-1);
  assert.equal(
    operationTerminal?.type === "agent_loop_operation_terminal" ? operationTerminal.outcome : undefined,
    "result_unknown",
  );
  assert.ok(observations.some((observation) => (
    observation.type === "result_unknown_fail_closed"
    && observation.source === "transport_interruption"
  )), JSON.stringify(observations));
});
}

async function helloBinding(
  connection: Awaited<ReturnType<ReturnType<typeof createTcpAgentLoopSidecarConnectionFactory>>>,
  messageId: string,
): Promise<{ moduleInstanceId: string; connectionGeneration: string }> {
  const iterator = connection.receive()[Symbol.asyncIterator]();
  await connection.send({ kind: "request", messageId, method: "hello", payload: {} });
  const response = await iterator.next();
  assert.equal(response.done, false, "TCP sidecar closed before hello response.");
  const message = response.value as Record<string, unknown>;
  assert.equal(message.kind, "response");
  assert.equal(message.inReplyTo, messageId);
  assert.equal(message.protocolVersion, "2.0");
  assert.equal(typeof message.moduleInstanceId, "string");
  assert.equal(typeof message.connectionGeneration, "string");
  return {
    moduleInstanceId: message.moduleInstanceId as string,
    connectionGeneration: message.connectionGeneration as string,
  };
}

function isSequenceZeroEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const event = value as { kind?: unknown; sequence?: unknown };
  return event.kind === "event" && event.sequence === 0;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for TCP sidecar reconnect.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function config(permissionMode: AgentRuntimeConfig["permissionMode"] = "default"): AgentRuntimeConfig {
  return {
    provider: "host-provider",
    model: "host-model",
    cwd: "/workspace",
    permissionMode,
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: permissionMode, canPrompt: false }),
  };
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

function deterministicIds(): () => string {
  let sequence = 0;
  return () => String(++sequence);
}

function builtSidecarPath(): string {
  return resolve(process.cwd(), "dist/src/cli/pilotdeck-agent-loop-sidecar.js");
}

function startBuiltTcpSidecar(port: number): ChildProcess {
  return spawn(process.execPath, [builtSidecarPath()], {
    env: {
      ...process.env,
      PILOTDECK_AGENT_LOOP_TCP_HOST: "127.0.0.1",
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Unable to reserve a TCP port for sidecar test.");
  return address.port;
}

async function connectEventually(
  connect: ReturnType<typeof createTcpAgentLoopSidecarConnectionFactory>,
): Promise<Awaited<ReturnType<typeof connect>>> {
  const deadline = Date.now() + 2_000;
  let latest: unknown;
  while (Date.now() < deadline) {
    try {
      return await connect({} as never);
    } catch (error) {
      latest = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw latest instanceof Error ? latest : new Error("Timed out connecting to built TCP sidecar.");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
