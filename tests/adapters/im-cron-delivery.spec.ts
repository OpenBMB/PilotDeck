import assert from "node:assert/strict";
import test from "node:test";

import { FeishuChannel } from "../../src/adapters/channel/feishu/FeishuChannel.js";
import {
  deliverChatCronResult,
  parseChatIdFromSessionKey,
} from "../../src/adapters/channel/protocol/ImCronDelivery.js";
import type { CronResultDelivery } from "../../src/cron/index.js";

const DELIVERY: CronResultDelivery = {
  taskId: "task-1",
  runId: "run-1",
  sessionKey: "feishu:chat=chat-1:general",
  channelKey: "cron",
  originSessionKey: "feishu:chat=chat-1:general",
  originChannelKey: "feishu",
  outcome: "completed",
  text: "cron result",
};

test("IM cron session keys require a channel match and a complete session suffix", () => {
  const sessionId = "s_12345678-1234-1234-1234-123456789abc";

  assert.equal(parseChatIdFromSessionKey("feishu:chat=chat:with:colons:general", "feishu"), "chat:with:colons");
  assert.equal(parseChatIdFromSessionKey(`feishu:chat=chat-1:${sessionId}`, "feishu"), "chat-1");

  for (const invalid of [
    undefined,
    "weixin:chat=chat-1:general",
    "feishu:chat=:general",
    "feishu:chat=chat-1",
    "feishu:chat=chat-1:s_not-a-session-id",
    "feishu:chat=chat-1:general:extra",
  ]) {
    assert.equal(parseChatIdFromSessionKey(invalid, "feishu"), undefined, invalid);
  }
});

test("IM cron delivery uses the origin session and routes only to the origin channel", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = (chatId: string, text: string) => {
    sent.push({ chatId, text });
  };

  assert.equal(await deliverChatCronResult(DELIVERY, "feishu", send), true);
  assert.deepEqual(sent, [{ chatId: "chat-1", text: "cron result" }]);

  assert.equal(await deliverChatCronResult(DELIVERY, "weixin", send), false);
  assert.equal(await deliverChatCronResult({ ...DELIVERY, originSessionKey: undefined }, "feishu", send), true);
  assert.equal(await deliverChatCronResult({ ...DELIVERY, originChannelKey: undefined }, "feishu", send), true);
  assert.equal(sent.length, 3);
});

test("IM cron delivery reports transport rejection and propagates transport errors", async () => {
  assert.equal(await deliverChatCronResult(DELIVERY, "feishu", async () => false), false);

  const failure = new Error("send failed");
  await assert.rejects(
    deliverChatCronResult(DELIVERY, "feishu", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("Feishu cron delivery uses its outbound text transport", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const channel = new FeishuChannel({
    send: async (message) => {
      sent.push(message);
    },
  });

  assert.equal(await channel.deliverCronResult(DELIVERY), true);
  assert.deepEqual(sent, [{ chatId: "chat-1", text: "cron result" }]);
});
