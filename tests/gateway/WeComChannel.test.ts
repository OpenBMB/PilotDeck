import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { WeComChannel } from "../../src/adapters/channel/wecom/WeComChannel.js";
import { qrScanForWeComBotInfo } from "../../src/cli/commands/gatewaySetup.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

test("WeComChannel subscribes with device_id and replies with markdown response mode", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "open", text_batch_delay_ms: 1 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);

  const subscribe = ws.sent.find((payload) => payload.cmd === "aibot_subscribe");
  assert.equal(subscribe?.body?.bot_id, "bot-1");
  assert.equal(subscribe?.body?.secret, "secret-1");
  assert.equal(typeof subscribe?.body?.device_id, "string");
  assert.ok(String(subscribe?.body?.device_id).length > 0);

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "inbound-1" },
    body: {
      msgid: "msg-1",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: "hello" },
    },
  });

  await waitUntil(() => ws.sent.some((payload) => payload.cmd === "aibot_respond_msg"));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].sessionKey, "wecom:dm=user-1:general");
  assert.equal(captured[0].channelKey, "wecom");
  assert.equal(captured[0].message, "hello");

  const reply = ws.sent.find((payload) => payload.cmd === "aibot_respond_msg");
  assert.equal(reply?.headers?.req_id, "inbound-1");
  assert.equal(reply?.body?.msgtype, "markdown");
  assert.equal(reply?.body?.markdown?.content, "agent reply");

  await handle.stop("test");
});

test("WeComChannel accepts legacy aibot_callback payloads", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "open", text_batch_delay_ms: 1 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);

  ws.emitJson({
    cmd: "aibot_callback",
    headers: { req_id: "legacy-inbound-1" },
    body: {
      msgid: "legacy-msg-1",
      from: { userid: "legacy-user-1" },
      msgtype: "text",
      text: { content: "hello legacy" },
    },
  });

  await waitUntil(() => ws.sent.some((payload) => payload.cmd === "aibot_respond_msg"));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].sessionKey, "wecom:dm=legacy-user-1:general");
  assert.equal(captured[0].channelKey, "wecom");
  assert.equal(captured[0].message, "hello legacy");

  const reply = ws.sent.find((payload) => payload.cmd === "aibot_respond_msg");
  assert.equal(reply?.headers?.req_id, "legacy-inbound-1");
  assert.equal(reply?.body?.msgtype, "markdown");
  assert.equal(reply?.body?.markdown?.content, "agent reply");

  await handle.stop("test");
});

test("WeComChannel deduplicates msgid and enforces allowlist policy", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "allowlist", allow_from: ["allowed-user"], text_batch_delay_ms: 1 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "blocked-1" },
    body: {
      msgid: "blocked-msg",
      from: { userid: "blocked-user" },
      msgtype: "text",
      text: { content: "blocked" },
    },
  });
  await nextTick();
  assert.equal(captured.length, 0);

  const allowedPayload = {
    cmd: "aibot_msg_callback",
    headers: { req_id: "allowed-1" },
    body: {
      msgid: "allowed-msg",
      from: { userid: "allowed-user" },
      msgtype: "text",
      text: { content: "allowed" },
    },
  };
  ws.emitJson(allowedPayload);
  await waitUntil(() => captured.length === 1);
  ws.emitJson({ ...allowedPayload, headers: { req_id: "allowed-duplicate" } });
  await nextTick();
  assert.equal(captured.length, 1);

  await handle.stop("test");
});

test("WeComChannel maps group sessions per sender and strips leading mention", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", group_policy: "open", text_batch_delay_ms: 1 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "group-1" },
    body: {
      msgid: "group-msg",
      chatid: "group-chat",
      chattype: "group",
      from: { userid: "user-2" },
      msgtype: "text",
      text: { content: "@PilotDeck hello group" },
    },
  });

  await waitUntil(() => captured.length === 1);
  assert.equal(captured[0].sessionKey, "wecom:group=group-chat:user=user-2:general");
  assert.equal(captured[0].message, "hello group");

  await handle.stop("test");
});

test("WeComChannel batches rapid text chunks from the same DM sender", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "open", text_batch_delay_ms: 20 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "batch-1" },
    body: {
      msgid: "batch-msg-1",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: "part 1" },
    },
  });
  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "batch-2" },
    body: {
      msgid: "batch-msg-2",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: "part 2" },
    },
  });

  await nextTick();
  assert.equal(captured.length, 0);
  await waitUntil(() => captured.length === 1);
  assert.equal(captured[0].message, "part 1\npart 2");

  const reply = ws.sent.find((payload) => payload.cmd === "aibot_respond_msg");
  assert.equal(reply?.headers?.req_id, "batch-2");

  await handle.stop("test");
});

test("WeComChannel keeps group text batches isolated per sender", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", group_policy: "open", text_batch_delay_ms: 5 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "group-batch-1" },
    body: {
      msgid: "group-batch-msg-1",
      chatid: "group-chat",
      chattype: "group",
      from: { userid: "user-a" },
      msgtype: "text",
      text: { content: "@PilotDeck alpha" },
    },
  });
  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "group-batch-2" },
    body: {
      msgid: "group-batch-msg-2",
      chatid: "group-chat",
      chattype: "group",
      from: { userid: "user-b" },
      msgtype: "text",
      text: { content: "@PilotDeck beta" },
    },
  });

  await waitUntil(() => captured.length === 2);
  assert.deepEqual(
    captured.map((input) => input.message).sort(),
    ["alpha", "beta"],
  );
  assert.ok(captured.some((input) => input.sessionKey === "wecom:group=group-chat:user=user-a:general"));
  assert.ok(captured.some((input) => input.sessionKey === "wecom:group=group-chat:user=user-b:general"));

  await handle.stop("test");
});

test("WeComChannel uses split delay for chunks near the WeCom split threshold", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: {
      secret: "secret-1",
      dm_policy: "open",
      text_batch_delay_ms: 1,
      text_batch_split_delay_ms: 50,
    },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];
  const longChunk = "x".repeat(3900);

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "split-delay-1" },
    body: {
      msgid: "split-delay-msg-1",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: longChunk },
    },
  });

  await sleep(10);
  assert.equal(captured.length, 0);
  await waitUntil(() => captured.length === 1);
  assert.equal(captured[0].message, longChunk);

  await handle.stop("test");
});

test("WeComChannel dispatches slash commands without text batching delay", async () => {
  FakeWebSocket.reset();
  const captured: GatewaySubmitTurnInput[] = [];
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "open", text_batch_delay_ms: 1000 },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
  });

  const handle = await channel.start({ gateway: fakeGateway(captured), logger: noopLogger });
  const ws = FakeWebSocket.instances[0];

  ws.emitJson({
    cmd: "aibot_msg_callback",
    headers: { req_id: "slash-1" },
    body: {
      msgid: "slash-msg-1",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: "/new" },
    },
  });

  await waitUntil(
    () => ws.sent.some((payload) => payload.cmd === "aibot_respond_msg" && payload.body?.markdown?.content === "已创建新会话。"),
    100,
  );
  assert.equal(captured.length, 0);

  await handle.stop("test");
});

test("WeComChannel reconnects after an unexpected close", async () => {
  FakeWebSocket.reset();
  const channel = new WeComChannel({
    botKey: "bot-1",
    extra: { secret: "secret-1", dm_policy: "open" },
    webSocketCtor: FakeWebSocket,
    uuid: sequenceUuid(),
    reconnectBackoffMs: [1],
  });

  const handle = await channel.start({ gateway: fakeGateway([]), logger: noopLogger });
  FakeWebSocket.instances[0].close();

  await waitUntil(() => FakeWebSocket.instances.length === 2);
  assert.equal(FakeWebSocket.instances[1].sent[0].cmd, "aibot_subscribe");

  await handle.stop("test");
});

test("qrScanForWeComBotInfo polls WeCom QR result and returns bot credentials", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("/generate")) {
      return jsonResponse({
        data: {
          scode: "scan-code",
          auth_url: "https://work.weixin.qq.com/scan",
        },
      });
    }
    return jsonResponse({
      data: {
        status: "success",
        bot_info: {
          botid: "bot-from-qr",
          secret: "secret-from-qr",
        },
      },
    });
  }) as typeof fetch;

  const credentials = await qrScanForWeComBotInfo({
    fetchImpl,
    sleep: async () => undefined,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  assert.deepEqual(credentials, { botId: "bot-from-qr", secret: "secret-from-qr" });
  assert.equal(calls.length, 2);
});

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<Record<string, any>> = [];
  readyState = 0;

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(raw: string): void {
    const payload = JSON.parse(raw) as Record<string, any>;
    this.sent.push(payload);
    const reqId = payload.headers?.req_id;
    if (reqId) {
      queueMicrotask(() => {
        this.emitJson({ headers: { req_id: reqId }, body: { errcode: 0 } });
      });
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  emitJson(payload: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(payload));
  }
}

function fakeGateway(captured: GatewaySubmitTurnInput[]): Gateway {
  return {
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      captured.push(input);
      yield { type: "assistant_text_delta", text: "agent reply" };
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
  } as unknown as Gateway;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

function sequenceUuid(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await nextTick();
  }
  assert.ok(predicate(), "condition was not met before timeout");
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  } as Response;
}
