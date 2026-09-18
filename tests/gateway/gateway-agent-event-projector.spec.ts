import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayAgentEventProjector } from "../../src/gateway/client/GatewayAgentEventProjector.js";
import type { GatewayAgentEventProjectorPort } from "../../src/gateway/client/GatewayAgentEventProjectorPort.js";
import type { GatewayAgentEventTelemetryObserverPort } from "../../src/gateway/client/GatewayAgentEventTelemetryObserverPort.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("GatewayAgentEventProjector owns live projection and delegates advisory artifacts", () => {
  const persisted: Array<{ sessionId: string; turnId: string; toolCallId: string; text: string }> = [];
  const projector = new GatewayAgentEventProjector({
    toolResultArtifacts: {
      persist(input) {
        persisted.push(input);
        return "/configured/session-1/turn-1/tool-1.txt";
      },
    },
  });

  const events = projector.project({
    runId: "run-1",
    event: toolResultEvent("large output"),
  });

  assert.deepEqual(persisted, [{
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    text: "large output",
  }]);
  assert.deepEqual(events, [{
    type: "tool_call_finished",
    toolCallId: "tool-1",
    ok: true,
    resultPreview: "large output",
    resultLineCount: 1,
    resultBytes: Buffer.byteLength("large output", "utf8"),
    toolName: "bash",
    resultPath: "/configured/session-1/turn-1/tool-1.txt",
    runId: "run-1",
  }]);
});

test("GatewayAgentEventProjector preserves durable assistant text without streaming metadata", () => {
  const projector = new GatewayAgentEventProjector();

  const projected = projector.project({
    runId: "run-1",
    event: {
      type: "assistant_message",
      sessionId: "session-1",
      turnId: "turn-1",
      message: { role: "assistant", content: [{ type: "text", text: "Durable SOP reply" }] },
    },
  });

  assert.deepEqual(projected, [{ type: "assistant_text_delta", text: "Durable SOP reply", runId: "run-1" }]);
});

test("InProcessGateway consumes its injected Agent event projector", async () => {
  const inputs: Array<{ type: string; runId: string }> = [];
  const projector: GatewayAgentEventProjectorPort = {
    project(input) {
      inputs.push({ type: input.event.type, runId: input.runId });
      return [{
        type: "agent_status",
        event: "injected_projector",
        detail: { sourceType: input.event.type },
        runId: input.runId,
      }];
    },
  };
  const observed: Array<{ type: string; runId: string }> = [];
  const telemetryObserver: GatewayAgentEventTelemetryObserverPort = {
    observe(event, context) {
      observed.push({ type: event.type, runId: context.runId });
    },
  };
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(),
  });
  const gateway = new InProcessGateway(router, {
    uuid: () => "run-injected",
    agentEventProjector: projector,
    agentEventTelemetryObserver: telemetryObserver,
  });

  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "web",
    message: "project this",
  })) {
    events.push(event);
  }

  assert.deepEqual(inputs, [
    { type: "turn_started", runId: "run-injected" },
    { type: "turn_completed", runId: "run-injected" },
  ]);
  assert.deepEqual(observed, inputs);
  assert.deepEqual(events.filter((event) => event.type === "agent_status"), [
    {
      type: "agent_status",
      event: "injected_projector",
      detail: { sourceType: "turn_started" },
      runId: "run-injected",
    },
    {
      type: "agent_status",
      event: "injected_projector",
      detail: { sourceType: "turn_completed" },
      runId: "run-injected",
    },
  ]);
});

function toolResultEvent(text: string): AgentEvent {
  return {
    type: "tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      type: "success",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text }],
      startedAt: "2026-09-10T00:00:00.000Z",
      completedAt: "2026-09-10T00:00:01.000Z",
    },
  };
}

function fakeSession(): AgentSession {
  return {
    async *submit() {
      yield { type: "turn_started", sessionId: "session-1", turnId: "turn-1" };
      yield {
        type: "turn_completed",
        sessionId: "session-1",
        turnId: "turn-1",
        result: {
          type: "success",
          sessionId: "session-1",
          turnId: "turn-1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:01.000Z",
        },
      };
    },
    abort() {},
    snapshot() {
      return {
        sessionId: "session-1",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}
