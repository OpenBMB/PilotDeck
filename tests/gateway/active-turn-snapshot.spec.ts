import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayTurnReplayStore } from "../../src/gateway/client/GatewayTurnReplayStore.js";
import type { GatewayTurnReplayStorePort } from "../../src/gateway/client/GatewayTurnReplayStorePort.js";
import type { TelemetryClient } from "../../src/telemetry/index.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

class FakeTextWebSocketConnection {
  readonly sent: unknown[] = [];
  private messageHandler?: (message: string) => void;
  private closeHandler?: () => void;

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void { this.closeHandler = handler; }

  sendText(message: string): void {
    this.sent.push(JSON.parse(message));
  }

  close(): void {}

  dispatch(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }

  closeFromPeer(): void {
    this.closeHandler?.();
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("status-only active turn snapshots omit buffered events", async () => {
  let cloneCount = 0;
  const store = new GatewayTurnReplayStore({
    cloneEvent: (event) => {
      cloneCount += 1;
      return structuredClone(event);
    },
  });
  const gateway = new InProcessGateway({} as SessionRouter, { turnReplayStore: store });
  const event: GatewayEvent = { type: "assistant_text_delta", text: "still running" };
  store.start("cron:status-only", "run-1");
  store.record("cron:status-only", event);

  const statusOnly = await gateway.getActiveTurnSnapshot({ sessionKey: "cron:status-only", includeEvents: false });
  assert.equal(statusOnly.active, true);
  assert.deepEqual(statusOnly.events, []);
  assert.equal(cloneCount, 1, "status-only polling must not clone buffered events");

  store.start("cron:active", "run-1");
  store.record("cron:active", event);

  const replay = await gateway.getActiveTurnSnapshot({ sessionKey: "cron:active" });
  assert.deepEqual(replay.events, [event]);
  assert.notEqual(replay.events[0], event, "default replay remains a defensive copy");
  assert.equal(cloneCount, 3);
});

test("Gateway consumes an injected turn replay provider", async () => {
  const snapshots: unknown[] = [];
  const store: GatewayTurnReplayStorePort = {
    start() {},
    record() {},
    retainTerminal() {},
    clearTerminal() {},
    withRunId: (_sessionKey, event) => event,
    snapshot(input) {
      snapshots.push(input);
      return { active: false, sessionKey: input.sessionKey, events: [] };
    },
    dispose() {},
  };
  const gateway = new InProcessGateway({} as SessionRouter, { turnReplayStore: store });

  assert.deepEqual(await gateway.getActiveTurnSnapshot({ sessionKey: "injected", includeEvents: false }), {
    active: false,
    sessionKey: "injected",
    events: [],
  });
  assert.deepEqual(snapshots, [{ sessionKey: "injected", includeEvents: false }]);
});

test("Gateway consumes an injected turn telemetry attribution resolver", async () => {
  const resolved: unknown[] = [];
  const errors: Array<{ error: unknown; input: unknown }> = [];
  const gateway = new InProcessGateway({
    beginTurn: () => true,
    getOrCreate: async () => { throw new Error("setup failed"); },
    endTurn: () => undefined,
  } as unknown as SessionRouter, {
    telemetry: {
      trackError(error: unknown, input: unknown) { errors.push({ error, input }); },
    } as unknown as TelemetryClient,
    turnTelemetryContextResolver: {
      resolve(input) {
        resolved.push(input);
        return { ownerModule: "always_on", executionKind: "always_on", phase: "injected" };
      },
    },
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "telemetry-injected",
    channelKey: "cli",
    message: "hello",
  })) {
    // The setup error is transformed into a terminal Gateway event.
  }

  assert.deepEqual(resolved, [{ sessionKey: "telemetry-injected", channelKey: "cli", message: "hello" }]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0]?.error as Error).message, "setup failed");
  assert.deepEqual(errors[0]?.input, {
    module: "session",
    ownerModule: "always_on",
    executionKind: "always_on",
    phase: "injected",
    loopStage: "loop_end",
    errorCategory: "loop_error",
    sessionId: "telemetry-injected",
    metadata: {
      runId: (errors[0]?.input as { metadata: { runId: string } }).metadata.runId,
      channelKey: "cli",
    },
  });
});

test("turn replay provider bounds buffered frames and replaces a retained terminal turn", () => {
  const store = new GatewayTurnReplayStore({ eventLimit: 1 });
  store.start("session-1", "run-1");
  store.record("session-1", { type: "assistant_text_delta", text: "first" });
  store.record("session-1", { type: "assistant_text_delta", text: "second" });

  assert.deepEqual(store.snapshot({ sessionKey: "session-1" }), {
    active: true,
    sessionKey: "session-1",
    runId: "run-1",
    events: [{ type: "assistant_text_delta", text: "second" }],
    truncated: true,
  });

  store.retainTerminal("session-1", "run-1");
  assert.equal(store.snapshot({ sessionKey: "session-1" }).terminal, true);

  store.start("session-1", "run-2");
  assert.deepEqual(store.snapshot({ sessionKey: "session-1" }), {
    active: true,
    sessionKey: "session-1",
    runId: "run-2",
    events: [],
  });
  store.dispose();
});

test("status-only active turn snapshots preserve includeEvents through remote and WebSocket gateways", async () => {
  const input = { sessionKey: "cron:status-only", includeEvents: false };
  const expected = { active: true, sessionKey: input.sessionKey, events: [] };

  let remoteMethod: string | undefined;
  let remoteInput: unknown;
  const remote = new RemoteGateway({
    request: async (method: string, received: unknown) => {
      remoteMethod = method;
      remoteInput = received;
      return expected;
    },
  } as unknown as GatewayWsClient);
  assert.deepEqual(await remote.getActiveTurnSnapshot(input), expected);
  assert.equal(remoteMethod, "active_turn_snapshot");
  assert.deepEqual(remoteInput, input);

  let websocketInput: typeof input | undefined;
  const socket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway: {
      describeServer: async () => ({ mode: "in_process" }),
      getActiveTurnSnapshot: async (received: typeof input) => {
        websocketInput = received;
        return expected;
      },
    } as unknown as Gateway,
  });
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  socket.dispatch({ type: "request", id: "active-turn-status-only", method: "active_turn_snapshot", params: input });
  await flushAsyncWork();

  assert.deepEqual(websocketInput, input);
  assert.deepEqual(socket.sent.at(-1), {
    type: "response",
    id: "active-turn-status-only",
    ok: true,
    result: expected,
  });
});

test("remote gateway exposes the server-issued interaction binding without minting a local replacement", () => {
  const binding = { connectionId: "connection-1", generation: 7 };
  const client = new GatewayWsClient({ url: "ws://gateway.test/ws", token: "token" });
  Object.assign(client as unknown as { hello?: unknown }, {
    hello: { interactionBinding: binding },
  });
  const remote = new RemoteGateway(client);

  assert.deepEqual(client.interactionBinding, binding);
  assert.deepEqual(remote.interactionBinding, binding);
});

test("gateway failure status keeps the attempted run id for live/history deduplication", async () => {
  const router = {
    beginTurn: () => true,
    getOrCreate: async () => {
      throw new Error("project setup failed");
    },
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const recorded: Array<{ turnId: string }> = [];
  const gateway = new InProcessGateway(router, {
    recordAgentStatusMessage: async (input) => {
      recorded.push({ turnId: input.turnId });
      return { recorded: true };
    },
  });
  const events: GatewayEvent[] = [];

  for await (const event of gateway.submitTurn({
    sessionKey: "web:failure",
    channelKey: "web",
    projectKey: "/tmp/project",
    message: "hello",
    runId: "run-failure",
  })) {
    events.push(event);
  }

  assert.deepEqual(recorded, [{ turnId: "run-failure" }]);
  assert.equal(events.find((event) => event.type === "agent_status")?.runId, "run-failure");
  assert.equal(events.find((event) => event.type === "error")?.runId, "run-failure");
});

test("history rereads when its active epoch settles during the disk read", async () => {
  let reads = 0;
  const store = new GatewayTurnReplayStore({ terminalRetentionMs: 60_000 });
  store.start("s", "r");
  const gateway = new InProcessGateway({} as SessionRouter, {
    turnReplayStore: store,
    readSessionMessages: async () => {
      reads += 1;
      if (reads === 1) store.retainTerminal("s", "r");
      return {
        messages: [],
        total: reads,
        session: { sessionKey: "s", sessionId: "s", summary: "test", lastModified: 0 },
      };
    },
  });

  const snapshot = await gateway.readSessionMessages({ sessionKey: "s" });
  assert.equal(reads, 2);
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.stream?.active, false);
  store.dispose();
});

test("gateway status writes stay with a published session instead of the history fallback", async () => {
  const liveWrites: string[] = [];
  const fallbackWrites: string[] = [];
  const router = {
    recordAgentStatusMessage: async (_sessionKey: string, turnId: string) => {
      liveWrites.push(turnId);
      return { owner: "live" as const, recorded: true };
    },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    recordAgentStatusMessage: async (input) => {
      fallbackWrites.push(input.turnId);
      return { recorded: true };
    },
  });

  assert.deepEqual(await gateway.recordAgentStatusMessage({
    sessionKey: "live-session",
    turnId: "turn-1",
    status: { event: "context_budget", kind: "status", text: "context_budget" },
  }), { recorded: true });
  assert.deepEqual(liveWrites, ["turn-1"]);
  assert.deepEqual(fallbackWrites, []);
});

test("gateway status writes use history only when no session is published", async () => {
  const fallbackWrites: string[] = [];
  const router = {
    recordAgentStatusMessage: async () => ({ owner: "not_live" as const, recorded: false }),
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    recordAgentStatusMessage: async (input) => {
      fallbackWrites.push(input.turnId);
      return { recorded: true };
    },
  });

  assert.deepEqual(await gateway.recordAgentStatusMessage({
    sessionKey: "cold-session",
    turnId: "turn-1",
    status: { event: "context_budget", kind: "status", text: "context_budget" },
  }), { recorded: true });
  assert.deepEqual(fallbackWrites, ["turn-1"]);
});

test("websocket reconnect receives a new binding and replays only the current interaction requests", async () => {
  const socket = new FakeTextWebSocketConnection();
  const calls: Array<{ sessionKey: string; previousBinding?: unknown; nextBinding?: unknown }> = [];
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway: {
      describeServer: async () => ({ mode: "in_process" }),
      reconnectInteraction: (input: import("../../src/gateway/protocol/types.js").GatewayReconnectInteractionInput) => {
        calls.push(input);
        return { outcome: "reconnected", binding: input.nextBinding, requests: [] };
      },
    } as unknown as Gateway,
  });
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  const binding = (socket.sent.at(-1) as { interactionBinding?: unknown }).interactionBinding;
  assert.ok(binding);
  socket.dispatch({
    type: "request",
    id: "reconnect-1",
    method: "reconnect_interaction",
    params: { sessionKey: "session-1", previousBinding: { connectionId: "old", generation: 1 } },
  });
  await flushAsyncWork();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sessionKey, "session-1");
  assert.deepEqual(calls[0]?.nextBinding, binding);
  assert.deepEqual((socket.sent.at(-1) as { result: { outcome: string } }).result, {
    outcome: "reconnected",
    binding,
    requests: [],
  });
});

test("SDK permission resources can answer a prompt from a separate control connection", async (t) => {
  const gateway = new InProcessGateway({ sessionCount: () => 0 } as unknown as SessionRouter);
  t.after(() => gateway.dispose("test_dispose"));
  let resolved: unknown;
  gateway.getPermissionBus().register("sdk-permission", {
    requestId: "permission-1",
    toolCallId: "call-1",
    toolName: "write_file",
    resolve: (decision) => { resolved = decision; },
    reject: (error) => assert.fail(error.message),
  });

  const runSocket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(runSocket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway,
  });
  runSocket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "sdk",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  runSocket.dispatch({
    type: "request",
    id: "bind-run",
    method: "reconnect_interaction",
    params: { sessionKey: "sdk-permission" },
  });
  await flushAsyncWork();
  assert.equal((runSocket.sent.at(-1) as { result: { outcome: string } }).result.outcome, "initial");
  assert.equal(gateway.getPermissionBus().hasPending("sdk-permission", "permission-1"), true);

  const controlSocket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(controlSocket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway,
  });
  controlSocket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "sdk",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  controlSocket.dispatch({
    type: "request",
    id: "answer-permission",
    method: "permission_decide",
    params: { sessionKey: "sdk-permission", requestId: "permission-1", decision: "allow" },
  });
  await flushAsyncWork();

  assert.deepEqual((controlSocket.sent.at(-1) as { result: unknown }).result, { delivered: true });
  assert.deepEqual(resolved, {
    requestId: "permission-1",
    decision: "allow",
    remember: undefined,
    reason: undefined,
  });
});

test("websocket disconnect preserves a pending question for a new binding and rejects an old reply", async () => {
  const gateway = new InProcessGateway({ sessionCount: () => 0 } as unknown as SessionRouter);
  let resolved = 0;
  gateway.getElicitationBus().register("session-reconnect", {
    requestId: "question-1",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => { resolved += 1; },
    reject: () => undefined,
  }, {
    payload: { questions: [{ question: "Continue?" }] },
  });

  const firstSocket = new FakeTextWebSocketConnection();
  const firstConnection = new GatewayWsConnection(firstSocket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway,
  });
  void firstConnection;
  firstSocket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  const firstBinding = (firstSocket.sent.at(-1) as {
    interactionBinding: { connectionId: string; generation: number };
  }).interactionBinding;
  firstSocket.dispatch({
    type: "request",
    id: "initial-reconnect",
    method: "reconnect_interaction",
    params: { sessionKey: "session-reconnect" },
  });
  await flushAsyncWork();
  assert.equal((firstSocket.sent.at(-1) as { result: { outcome: string } }).result.outcome, "initial");

  firstSocket.closeFromPeer();
  await flushAsyncWork();
  assert.equal(gateway.getInteractionBinding("session-reconnect"), undefined);

  const secondSocket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(secondSocket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway,
  });
  secondSocket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  const secondBinding = (secondSocket.sent.at(-1) as {
    interactionBinding: { connectionId: string; generation: number };
  }).interactionBinding;
  secondSocket.dispatch({
    type: "request",
    id: "resume-reconnect",
    method: "reconnect_interaction",
    params: { sessionKey: "session-reconnect", previousBinding: firstBinding },
  });
  await flushAsyncWork();
  const replay = (secondSocket.sent.at(-1) as {
    result: { outcome: string; binding: unknown; requests: Array<{ requestId: string }> };
  }).result;
  assert.equal(replay.outcome, "reconnected");
  assert.deepEqual(replay.binding, secondBinding);
  assert.deepEqual(replay.requests.map((request) => request.requestId), ["question-1"]);

  firstSocket.dispatch({
    type: "request",
    id: "late-reply",
    method: "elicitation_respond",
    params: {
      sessionKey: "session-reconnect",
      requestId: "question-1",
      answer: { type: "cancelled", reason: "late" },
    },
  });
  await flushAsyncWork();
  assert.deepEqual((firstSocket.sent.at(-1) as { result: unknown }).result, { delivered: false });

  secondSocket.dispatch({
    type: "request",
    id: "current-reply",
    method: "elicitation_respond",
    params: {
      sessionKey: "session-reconnect",
      requestId: "question-1",
      answer: { type: "cancelled", reason: "reconnected" },
    },
  });
  await flushAsyncWork();
  assert.deepEqual((secondSocket.sent.at(-1) as { result: unknown }).result, { delivered: true });
  assert.equal(resolved, 1);
});
