import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import {
  GatewayWsClient,
  InProcessGateway,
  RemoteGateway,
  SessionRouter,
  startGatewayServer,
  type GatewayEvent,
  type GatewayServer,
} from "../../src/gateway/index.js";

test("Gateway server exposes health and enforces WebSocket authentication", async (t) => {
  const stack = await startStack(t, completedSession());

  const health = await fetch(`${stack.server.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const invalid = new GatewayWsClient({ url: stack.server.wsUrl, token: "wrong-token" });
  await assert.rejects(() => invalid.connect(), /auth_failed|code 4003/);

  const info = await stack.remote.describeServer();
  assert.equal(info.mode, "in_process");
});

test("Gateway server streams a complete turn with paired lifecycle events", async (t) => {
  const stack = await startStack(t, completedSession("hello over websocket"));

  const events = await collect(stack.remote.submitTurn(turn("run-1", "hello")));

  assert.deepEqual(events.map(event => event.type), [
    "turn_started",
    "assistant_text_delta",
    "turn_completed",
  ]);
  assert.equal(events.every(event => event.runId === "run-1"), true);
  assert.equal((events[1] as Extract<GatewayEvent, { type: "assistant_text_delta" }>).text, "hello over websocket");
});

test("Gateway server rejects a busy session and accepts a turn after remote abort", async (t) => {
  const session = firstTurnBlocksUntilAbort();
  const stack = await startStack(t, session);
  const first = stack.remote.submitTurn(turn("run-1", "first"))[Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.type, "turn_started");

  const busy = await collect(stack.remote.submitTurn(turn("run-2", "busy")));
  assert.equal(busy.some(event => event.type === "error" && event.code === "session_busy"), true);

  await stack.remote.abortTurn({ sessionKey: "session-1", runId: "run-1", reason: "test" });
  assert.equal((await first.next()).value?.type, "turn_completed");
  assert.equal((await first.next()).done, true);
  const replacement = await collect(stack.remote.submitTurn(turn("run-3", "replacement")));
  assert.equal(replacement.some(event => event.type === "error" && event.code === "session_busy"), false);
  assert.equal(replacement.at(-1)?.type, "turn_completed");
});

test("closing a real WebSocket aborts its in-flight turn and server shutdown releases the port", async (t) => {
  const aborted = deferred<void>();
  const gate = deferred<void>();
  const stack = await startStack(t, blockingSession(gate, () => {
    aborted.resolve();
    gate.resolve();
  }));
  const iterator = stack.remote.submitTurn(turn("run-1", "wait"))[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "turn_started");

  stack.client.close();
  await aborted.promise;
  await stack.server.close();
  stack.closed = true;

  await assert.rejects(() => fetch(`${stack.server.url}/health`));
});

async function startStack(t: test.TestContext, session: AgentSession) {
  const gateway = new InProcessGateway(new SessionRouter({ createSession: async () => session }));
  const server = await startGatewayServer({ gateway, host: "127.0.0.1", port: 0, token: "test-token" });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  await client.connect();
  const stack: {
    gateway: InProcessGateway;
    server: GatewayServer;
    client: GatewayWsClient;
    remote: RemoteGateway;
    closed: boolean;
  } = { gateway, server, client, remote: new RemoteGateway(client), closed: false };
  t.after(async () => {
    client.close();
    if (!stack.closed) await server.close();
  });
  return stack;
}

function completedSession(text = "done"): AgentSession {
  return {
    abort: () => undefined,
    snapshot: snapshot,
    replay: async function* () {},
    submit: async function* (_input: AgentInput, options: AgentSubmitOptions) {
      const turnId = options.turnId ?? "generated";
      yield started(turnId);
      yield {
        type: "model_event",
        sessionId: "session-1",
        turnId,
        event: { type: "text_delta", text },
      } satisfies AgentEvent;
      yield completed(turnId);
    },
  } as unknown as AgentSession;
}

function firstTurnBlocksUntilAbort(): AgentSession {
  const gate = deferred<void>();
  let submits = 0;
  return {
    abort: () => gate.resolve(),
    snapshot,
    replay: async function* () {},
    submit: async function* (_input: AgentInput, options: AgentSubmitOptions) {
      submits += 1;
      const turnId = options.turnId ?? "generated";
      yield started(turnId);
      if (submits === 1) await gate.promise;
      yield completed(turnId);
    },
  } as unknown as AgentSession;
}

function blockingSession(gate: ReturnType<typeof deferred<void>>, abort: () => void): AgentSession {
  return {
    abort,
    snapshot,
    replay: async function* () {},
    submit: async function* (_input: AgentInput, options: AgentSubmitOptions) {
      const turnId = options.turnId ?? "generated";
      yield started(turnId);
      await gate.promise;
      yield completed(turnId);
    },
  } as unknown as AgentSession;
}

function snapshot() {
  return {
    sessionId: "session-1",
    messages: [],
    usage: {},
    permissionDenials: [],
    status: "idle" as const,
    abortController: new AbortController(),
  };
}

function started(turnId: string): AgentEvent {
  return { type: "turn_started", sessionId: "session-1", turnId };
}

function completed(turnId: string): AgentEvent {
  return {
    type: "turn_completed",
    sessionId: "session-1",
    turnId,
    result: {
      type: "success",
      sessionId: "session-1",
      turnId,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

function turn(runId: string, message: string) {
  return { sessionKey: "session-1", channelKey: "web" as const, message, runId };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
