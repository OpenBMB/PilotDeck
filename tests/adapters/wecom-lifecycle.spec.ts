import assert from "node:assert/strict";
import test from "node:test";

import type { Gateway, GatewayEvent } from "../../src/gateway/index.js";
import { WeComChannel } from "../../src/adapters/channel/wecom/WeComChannel.js";

test("WeCom public start performs subscribe handshake and sends heartbeat only while open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeWebSocket[] = [];
  const channel = new WeComChannel({
    botKey: "bot",
    extra: { secret: "secret", websocket_url: "ws://fake", dm_policy: "open", text_batch_delay_ms: 0 },
    webSocketCtor: class extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    },
    uuid: sequenceUuid(),
  });
  const gateway = idleGateway();
  const handle = await channel.start({ gateway });
  t.after(() => handle.stop("test cleanup"));

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.sent[0]?.cmd, "aibot_subscribe");
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(sockets[0]!.sent.some((payload) => payload.cmd === "ping"), true);
});

test("WeCom public callback submits a turn and pairs the reply with the inbound request", async (t) => {
  const sockets: FakeWebSocket[] = [];
  const calls: Array<{ sessionKey: string; message: string }> = [];
  const settled = deferred<void>();
  const channel = new WeComChannel({
    botKey: "bot",
    extra: { secret: "secret", websocket_url: "ws://fake", dm_policy: "open", text_batch_delay_ms: 0 },
    webSocketCtor: class extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    },
    uuid: sequenceUuid(),
  });
  const gateway = gatewayFrom(async function* (input) {
    calls.push({ sessionKey: input.sessionKey, message: input.message });
    settled.resolve();
    yield { type: "assistant_text_delta", text: "hello from gateway" } satisfies GatewayEvent;
    yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
  });
  const handle = await channel.start({ gateway });
  t.after(() => handle.stop("test cleanup"));

  sockets[0]!.receive({
    cmd: "aibot_msg_callback",
    headers: { req_id: "inbound-1" },
    body: { msgid: "message-1", chatid: "chat-1", chattype: "single", from: { userid: "user-1" }, msgtype: "text", text: { content: "hello" } },
  });
  await withTimeout(settled.promise);
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(calls, [{ sessionKey: "wecom:dm=user-1:general", message: "hello" }]);
  const response = sockets[0]!.sent.find(payload => payload.cmd === "aibot_respond_msg");
  assert.equal(response?.headers.req_id, "inbound-1");
  assert.equal((response?.body as { markdown?: { content?: string } }).markdown?.content, "hello from gateway");
});

test("WeCom permission replies resolve through the public callback without a second turn", async (t) => {
  const sockets: FakeWebSocket[] = [];
  const permission = deferred<void>();
  const turns: string[] = [];
  const decisions: unknown[] = [];
  const channel = new WeComChannel({
    botKey: "bot",
    extra: { secret: "secret", websocket_url: "ws://fake", dm_policy: "open", text_batch_delay_ms: 0 },
    webSocketCtor: class extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    },
    uuid: sequenceUuid(),
  });
  const gateway = gatewayFrom(async function* (input) {
    turns.push(input.message);
    yield { type: "permission_request", requestId: "perm-1", toolName: "bash", payload: { command: "echo ok" } } satisfies GatewayEvent;
    await permission.promise;
    yield { type: "assistant_text_delta", text: "continued" } satisfies GatewayEvent;
    yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
  }, async input => { decisions.push(input); permission.resolve(); });
  const handle = await channel.start({ gateway });
  t.after(() => handle.stop("test cleanup"));

  sockets[0]!.receive(callback("message-2", "inbound-2", "run permission"));
  await waitFor(() => sockets[0]!.sent.some(payload => payload.cmd === "aibot_respond_msg" && String((payload.body as any).markdown?.content).includes("回复 1")));
  sockets[0]!.receive(callback("message-3", "inbound-3", "1"));
  await waitFor(() => decisions.length === 1);
  assert.deepEqual(turns, ["run permission"]);
  assert.equal((decisions[0] as { requestId: string }).requestId, "perm-1");
  assert.equal(sockets[0]!.sent.filter(payload => payload.cmd === "aibot_subscribe").length, 1);
});

test("WeCom socket close aborts active turns, stops heartbeat, and reconnects unless stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeWebSocket[] = [];
  const aborts: unknown[] = [];
  const gate = deferred<void>();
  const channel = new WeComChannel({
    botKey: "bot",
    extra: { secret: "secret", websocket_url: "ws://fake", dm_policy: "open", text_batch_delay_ms: 0 },
    reconnectBackoffMs: [10],
    webSocketCtor: class extends FakeWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    },
    uuid: sequenceUuid(),
  });
  const gateway = gatewayFrom(async function* () {
    yield { type: "turn_started", runId: "run-1" } satisfies GatewayEvent;
    await gate.promise;
  });
  (gateway as any).abortTurn = async (input: unknown) => { aborts.push(input); gate.resolve(); };
  const handle = await channel.start({ gateway });
  t.after(() => handle.stop("test cleanup"));
  sockets[0]!.receive(callback("message-4", "inbound-4", "long"));
  await new Promise<void>(resolve => setImmediate(resolve));
  sockets[0]!.close();
  await waitFor(() => aborts.length === 1);
  assert.equal((aborts[0] as { sessionKey: string }).sessionKey, "wecom:dm=user-1:general");
  const sentBefore = sockets[0]!.sent.length;
  t.mock.timers.tick(30_000);
  assert.equal(sockets[0]!.sent.length, sentBefore);
  t.mock.timers.tick(10);
  await waitFor(() => sockets.length === 2);
  await handle.stop("intentional stop");
  sockets[1]!.close();
  t.mock.timers.tick(10);
  assert.equal(sockets.length, 2);
});

function callback(messageId: string, reqId: string, text: string) {
  return { cmd: "aibot_msg_callback", headers: { req_id: reqId }, body: { msgid: messageId, chatid: "chat-1", chattype: "single", from: { userid: "user-1" }, msgtype: "text", text: { content: text } } };
}

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, any>> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(public readonly url: string) {
    queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
  }

  once(event: string, listener: (...args: any[]) => void) { this.on(event, listener, true); }
  on(event: string, listener: (...args: any[]) => void, once = false) {
    const wrapped = once ? (...args: any[]) => { this.off(event, wrapped); listener(...args); } : listener;
    const entries = this.listeners.get(event) ?? [];
    entries.push(wrapped);
    this.listeners.set(event, entries);
  }
  off(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener)); }
  send(raw: string) {
    const payload = JSON.parse(raw) as Record<string, any>;
    this.sent.push(payload);
    const reqId = payload.headers?.req_id;
    if (reqId && payload.cmd !== "aibot_msg_callback" && payload.cmd !== "ping") {
      queueMicrotask(() => this.receive({ cmd: payload.cmd, headers: { req_id: reqId }, body: { errcode: 0 } }));
    }
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  receive(payload: Record<string, any>) { this.emit("message", Buffer.from(JSON.stringify(payload))); }
  private emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
}

function sequenceUuid() { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function gatewayFrom(submitTurn: Gateway["submitTurn"], permissionDecide?: (input: any) => Promise<unknown>): Gateway {
  return {
    submitTurn,
    permissionDecide: async (input: any) => { await permissionDecide?.(input); return { delivered: true }; },
    respondElicitation: async () => undefined,
  } as unknown as Gateway;
}
function idleGateway(): Gateway { return gatewayFrom(async function* () {}); }
async function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> { return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]); }
async function waitFor(predicate: () => boolean, ms = 1_000): Promise<void> { const start = Date.now(); while (!predicate()) { if (Date.now() - start > ms) throw new Error("timeout"); await new Promise<void>(resolve => setImmediate(resolve)); } }
