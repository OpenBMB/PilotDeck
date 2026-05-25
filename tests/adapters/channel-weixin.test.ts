import test from "node:test";
import assert from "node:assert/strict";
import { WeixinSessionMapper } from "../../src/adapters/channel/weixin/WeixinSessionMapper.js";
import { WeixinChannel } from "../../src/adapters/channel/weixin/WeixinChannel.js";
import { renderWeixinEvent } from "../../src/adapters/channel/weixin/weixin-render.js";
import type { GatewayEvent } from "../../src/gateway/index.js";

test("WeixinSessionMapper uses general session until /new switches the chat", () => {
  let index = 0;
  const mapper = new WeixinSessionMapper(undefined, () => `uuid-${++index}`);

  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "hello" }), {
    sessionKey: "weixin:chat=chat-1:general",
    message: "hello",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "/new" }), {
    sessionKey: "weixin:chat=chat-1:s_uuid-1",
    command: "new",
    message: "",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "next" }), {
    sessionKey: "weixin:chat=chat-1:s_uuid-1",
    message: "next",
  });
});

test("WeixinChannel channelKey is weixin", () => {
  const channel = new WeixinChannel({ credentialsPath: "/tmp/nonexistent-creds.json" });
  assert.strictEqual(channel.channelKey, "weixin");
});

test("WeixinChannel start without credentials triggers login flow", { timeout: 3000 }, async () => {
  const channel = new WeixinChannel({ credentialsPath: "/tmp/nonexistent-weixin-creds.json" });
  const logs: string[] = [];

  // start() will call loginWithQR which makes a real network request.
  // We race it against a short timeout just to verify our code path triggers.
  const startPromise = channel.start({
    gateway: {} as any,
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
    },
  });

  // Wait briefly for the async path to hit our logger
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(logs.some((l) => l.includes("no credentials found")));
  // Don't await startPromise - it hangs waiting for QR scan
});

test("renderWeixinEvent renders text delta and tool events", () => {
  assert.strictEqual(renderWeixinEvent({ type: "assistant_text_delta", text: "hi" }), "hi");
  assert.strictEqual(renderWeixinEvent({ type: "assistant_thinking_delta", text: "..." }), "");
  assert.strictEqual(
    renderWeixinEvent({ type: "tool_call_started", toolCallId: "t1", name: "read_file" }),
    "\n[read_file running]\n",
  );
  assert.strictEqual(
    renderWeixinEvent({ type: "tool_call_finished", toolCallId: "t1", ok: true, toolName: "read_file" } as GatewayEvent),
    "\n[read_file done]\n",
  );
  assert.strictEqual(
    renderWeixinEvent({ type: "error", message: "oops", code: "x", recoverable: false }),
    "\n错误：oops\n",
  );
  assert.strictEqual(renderWeixinEvent({ type: "turn_started", runId: "r1" }), undefined);
});
