import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentSession } from "../../src/agent/index.js";
import {
  InProcessGateway,
  PILOTDECK_GATEWAY_PROTOCOL_VERSION,
  SessionRouter,
} from "../../src/gateway/index.js";
import type { Gateway, GatewayEvent } from "../../src/gateway/protocol/types.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";

test("InProcessGateway rejects a second turn while the session is busy", async () => {
  const gate = deferred<void>();
  const gateway = gatewayWithSession(blockingSession(gate));
  const first = gateway.submitTurn(turn("run-1", "one"))[Symbol.asyncIterator]();

  assert.equal((await first.next()).value?.type, "turn_started");
  const busyEvents = await collect(gateway.submitTurn(turn("run-2", "two")));
  assert.equal(busyEvents.some(event => event.type === "agent_status" && event.event === "session_busy"), true);
  assert.equal(busyEvents.some(event => event.type === "error" && event.code === "session_busy"), true);

  gate.resolve();
  await first.next();
});

test("abortTurn resolves only after the active turn has fully unwound", async () => {
  const gate = deferred<void>();
  const gateway = gatewayWithSession(blockingSession(gate, () => gate.resolve()));
  const drain = collect(gateway.submitTurn(turn("run-1", "one")));
  await immediate();

  await gateway.abortTurn({ sessionKey: "session-1", runId: "run-1" });
  const replacement = await collect(gateway.submitTurn(turn("run-2", "two")));

  assert.equal(replacement.some((event) => event.type === "error" && event.code === "session_busy"), false);
  await drain;
});

test("active turn snapshots retain the current run and streamed events", async () => {
  const gate = deferred<void>();
  const session = blockingSession(gate, () => gate.resolve(), [
    {
      type: "model_event",
      sessionId: "session-1",
      turnId: "run-1",
      event: { type: "text_delta", text: "partial" },
    },
  ]);
  const gateway = gatewayWithSession(session);
  const iterator = gateway.submitTurn(turn("run-1", "one"))[Symbol.asyncIterator]();

  await iterator.next();
  await iterator.next();
  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: "session-1" });

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.runId, "run-1");
  assert.deepEqual(snapshot.events, [
    { type: "turn_started", runId: "run-1" },
    { type: "assistant_text_delta", text: "partial", runId: "run-1" },
  ]);

  gate.resolve();
  await collectIterator(iterator);
  assert.deepEqual(await gateway.getActiveTurnSnapshot({ sessionKey: "session-1" }), {
    active: false,
    sessionKey: "session-1",
    events: [],
  });
});

test("active turn replay removes resolved interactive requests", async () => {
  const gate = deferred<void>();
  const gateway = gatewayWithSession(blockingSession(gate));
  const iterator = gateway.submitTurn(turn("run-1", "one"))[Symbol.asyncIterator]();
  await iterator.next();

  gateway.getPermissionBus().register("session-1", {
    requestId: "perm-1",
    toolCallId: "tool-1",
    toolName: "bash",
    resolve: () => undefined,
    reject: () => undefined,
  });
  gateway.getPermissionBus().register("session-1", {
    requestId: "perm-2",
    toolCallId: "tool-2",
    toolName: "read_file",
    resolve: () => undefined,
    reject: () => undefined,
  });
  gateway.getElicitationBus().register("session-1", {
    requestId: "ask-1",
    toolCallId: "tool-3",
    toolName: "ask_user_question",
    resolve: () => undefined,
    reject: () => undefined,
  });
  const interactiveEvents: GatewayEvent[] = [
    { type: "permission_request", requestId: "perm-1", toolName: "bash", payload: {} },
    { type: "permission_request", requestId: "perm-2", toolName: "read_file", payload: {} },
    {
      type: "elicitation_request",
      requestId: "ask-1",
      toolCallId: "tool-3",
      toolName: "ask_user_question",
      questions: [],
    },
  ];
  for (const event of interactiveEvents) {
    assert.equal(gateway.emitForSession("session-1", event), true);
  }

  await gateway.permissionDecide({ sessionKey: "session-1", requestId: "perm-1", decision: "allow" });
  await gateway.respondElicitation({
    sessionKey: "session-1",
    requestId: "ask-1",
    answer: { type: "answered", answers: {} },
  });
  gateway.emitForSession("session-1", {
    type: "elicitation_cancelled",
    requestId: "ask-1",
    reason: "answered",
  });

  const replay = await gateway.getActiveTurnSnapshot({ sessionKey: "session-1" });
  assert.deepEqual(replay.events.map(eventKey), ["turn_started", "permission_request:perm-2"]);

  gate.resolve();
  await collectIterator(iterator);
});

test("refreshConfigBeforeTurn is awaited before a session starts", async () => {
  const order: string[] = [];
  const router = new SessionRouter({
    createSession: async () => {
      order.push("session");
      return completedSession();
    },
  });
  const gateway = new InProcessGateway(router, {
    refreshConfigBeforeTurn: async () => {
      order.push("refresh");
    },
  });

  await collect(gateway.submitTurn(turn("run-1", "one")));
  assert.deepEqual(order, ["refresh", "session"]);
});

test("refreshConfigBeforeTurn failures do not block the turn", async () => {
  const gateway = new InProcessGateway(new SessionRouter({
    createSession: async () => completedSession(),
  }), {
    refreshConfigBeforeTurn: async () => {
      throw new Error("temporary config read failure");
    },
  });

  const events = await collect(gateway.submitTurn(turn("run-1", "one")));
  assert.equal(events.at(-1)?.type, "turn_completed");
});

test("GatewayWsConnection aborts its in-flight session when the socket closes", async () => {
  const turnGate = deferred<void>();
  const abortCalls: string[] = [];
  const gateway = {
    describeServer: async () => ({ protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION }),
    submitTurn: async function* () {
      yield { type: "turn_started", runId: "run-1" } as const;
      await turnGate.promise;
    },
    abortTurn: async ({ sessionKey }: { sessionKey: string }) => {
      abortCalls.push(sessionKey);
      turnGate.resolve();
    },
  } as unknown as Gateway;
  const socket = new MockTextSocket();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    gateway,
    token: "token",
    serverVersion: "test",
  });

  socket.receive(JSON.stringify({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "1",
    token: "token",
  }));
  await immediate();
  socket.receive(JSON.stringify({
    type: "request",
    id: "request-1",
    method: "submit_turn",
    params: turn("run-1", "one"),
  }));
  await immediate();

  socket.disconnect();
  await immediate();
  assert.deepEqual(abortCalls, ["session-1"]);
});

function gatewayWithSession(session: AgentSession): InProcessGateway {
  return new InProcessGateway(new SessionRouter({ createSession: async () => session }));
}

function blockingSession(
  gate: ReturnType<typeof deferred<void>>,
  abort: () => void = () => undefined,
  events: AgentEvent[] = [],
): AgentSession {
  return {
    abort,
    snapshot: () => ({
      sessionId: "session-1",
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
    replay: async function* () {},
    submit: async function* () {
      yield { type: "turn_started", sessionId: "session-1", turnId: "run-1" } satisfies AgentEvent;
      for (const event of events) yield event;
      await gate.promise;
    },
  } as unknown as AgentSession;
}

function completedSession(): AgentSession {
  return {
    abort: () => undefined,
    snapshot: () => ({
      sessionId: "session-1",
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
    replay: async function* () {},
    submit: async function* () {
      yield { type: "turn_started", sessionId: "session-1", turnId: "run-1" } satisfies AgentEvent;
      yield {
        type: "turn_completed",
        sessionId: "session-1",
        turnId: "run-1",
        result: {
          type: "success",
          sessionId: "session-1",
          turnId: "run-1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies AgentEvent;
    },
  } as unknown as AgentSession;
}

function turn(runId: string, message: string) {
  return { sessionKey: "session-1", channelKey: "web", message, runId };
}

function eventKey(event: { type: string; requestId?: string }): string {
  return event.requestId ? `${event.type}:${event.requestId}` : event.type;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function collectIterator<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const values: T[] = [];
  for (;;) {
    const item = await iterator.next();
    if (item.done) return values;
    values.push(item.value);
  }
}

function immediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

class MockTextSocket {
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandlers: Array<() => void> = [];
  readonly sent: string[] = [];

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  sendText(message: string): void {
    this.sent.push(message);
  }

  close(): void {}

  receive(message: string): void {
    this.messageHandler(message);
  }

  disconnect(): void {
    for (const handler of this.closeHandlers) handler();
  }
}
