import test from "node:test";
import assert from "node:assert/strict";

import {
  GatewayBrowserClient,
  type WebSocketLike,
} from "../../src/web/client/GatewayBrowserClient.js";
import type { WebGatewayEvent, WebSubmitTurnInput } from "../../src/web/client/protocol.js";

type SocketEvent = { data?: unknown; code?: number; reason?: string };
type Listener = (event: SocketEvent) => void;

/**
 * Minimal `WebSocketLike` double. It answers the `hello` handshake so
 * `connect()` resolves, and exposes `emit` so a test can drive frames and
 * transport closes deterministically.
 */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  private readonly listeners = new Map<string, Listener[]>();

  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; protocolVersion?: number };
    if (frame.type !== "hello") {
      return;
    }
    queueMicrotask(() => {
      this.emit("message", {
        data: JSON.stringify({
          type: "hello_ok",
          protocolVersion: frame.protocolVersion,
          serverInfo: { mode: "in_process" },
          capabilities: [],
        }),
      });
    });
  }

  close(): void {}

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TURN: WebSubmitTurnInput = {
  sessionKey: "web:s_stream",
  channelKey: "web",
  message: "hello",
};

async function connectedClient(streamId: string): Promise<{
  client: GatewayBrowserClient;
  socket: FakeSocket;
}> {
  const socket = new FakeSocket();
  const client = new GatewayBrowserClient({
    url: "ws://gateway.test/ws",
    token: "test-token",
    webSocketFactory: () => socket,
    newId: () => streamId,
  });
  queueMicrotask(() => socket.emit("open"));
  await client.connect();
  return { client, socket };
}

function eventFrame(id: string, seq: number, final: boolean, event: unknown): SocketEvent {
  return { data: JSON.stringify({ type: "event", id, seq, final, event }) };
}

/**
 * Asserts that `promise` rejects, but bounded in time. A regression of the
 * dropped-response bug leaves the stream pending forever; `assert.rejects`
 * alone would hang the file and cancel every test after it, so this reports
 * the hang as an ordinary assertion failure instead.
 */
async function rejectsWithin(promise: Promise<unknown>, ms: number): Promise<Error> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then(
        () => "settled" as const,
        (error: Error) => error,
      ),
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), ms);
      }),
    ]);
    if (outcome === "pending") {
      assert.fail(`stream did not settle within ${ms}ms — the consumer would hang forever`);
    }
    if (outcome === "settled") {
      assert.fail("stream completed cleanly instead of surfacing the failure");
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

test("a parked stream consumer sees a malformed transport close as a failure", async () => {
  const { client, socket } = await connectedClient("req-close");
  const iterator = client.submitTurn(TURN)[Symbol.asyncIterator]();

  // Park a consumer on `next()` before the transport dies — the ordering the
  // browser hits in production, and the one that used to resolve `done: true`.
  const parked = iterator.next();
  socket.emit("close", { code: 1002, reason: "protocol error" });

  await assert.rejects(parked, /Gateway WebSocket closed \(code=1002/);
});

test("an error response addressed to a stream id fails that stream", async () => {
  const { client, socket } = await connectedClient("req-error");
  const iterator = client.submitTurn(TURN)[Symbol.asyncIterator]();
  const parked = iterator.next();

  // `GatewayWsConnection` reports a throwing turn as an error `response`
  // carrying the stream's own id.
  socket.emit("message", {
    data: JSON.stringify({
      type: "response",
      id: "req-error",
      ok: false,
      error: { code: "gateway_request_failed", message: "upstream model error" },
    }),
  });

  const error = (await rejectsWithin(parked, 500)) as Error & { code?: string };
  assert.equal(error.message, "upstream model error");
  assert.equal(error.code, "gateway_request_failed");
});

test("a normally completed stream still ends without an error", async () => {
  const { client, socket } = await connectedClient("req-ok");
  const events: WebGatewayEvent[] = [];

  const stream = client.submitTurn(TURN);
  socket.emit("message", eventFrame("req-ok", 1, false, { type: "assistant_delta", text: "hi" }));
  socket.emit("message", eventFrame("req-ok", 2, true, { type: "turn_completed", usage: {}, finishReason: "completed" }));

  for await (const event of stream) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "assistant_delta");
});

test("an unparked stream failure is delivered once, then reports completion", async () => {
  // Locks in the single-delivery semantics kept deliberately in `next()`
  // (OpenBMB/PilotDeck#128): the error must not be re-thrown forever by an
  // iterator that outlives the loop which already observed it.
  const { client, socket } = await connectedClient("req-once");
  const iterator = client.submitTurn(TURN)[Symbol.asyncIterator]();

  socket.emit("close", { code: 1006, reason: "abnormal closure" });

  await assert.rejects(iterator.next(), /Gateway WebSocket closed \(code=1006/);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("a parked stream failure is delivered once, then reports completion", async () => {
  // Same invariant on the ordering the browser actually hits: the rejection
  // goes to the parked waiter, so it must not be queued up a second time for
  // the following read.
  const { client, socket } = await connectedClient("req-parked-once");
  const iterator = client.submitTurn(TURN)[Symbol.asyncIterator]();

  const parked = iterator.next();
  socket.emit("close", { code: 1006, reason: "abnormal closure" });

  await assert.rejects(parked, /Gateway WebSocket closed \(code=1006/);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("a malformed error envelope still settles the stream instead of throwing", async () => {
  // `handleMessage` runs inside the socket's message listener, and this path
  // now reads `frame.error` for stream ids — a missing envelope must degrade
  // to a default error rather than throw out of the handler.
  const { client, socket } = await connectedClient("req-malformed");
  const iterator = client.submitTurn(TURN)[Symbol.asyncIterator]();
  const parked = iterator.next();

  socket.emit("message", {
    data: JSON.stringify({ type: "response", id: "req-malformed", ok: false }),
  });

  const error = (await rejectsWithin(parked, 500)) as Error & { code?: string };
  assert.equal(error.code, "gateway_request_failed");
});
