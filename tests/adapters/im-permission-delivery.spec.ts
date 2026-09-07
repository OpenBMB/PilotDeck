import test from "node:test";
import assert from "node:assert/strict";

import { MattermostChannel } from "../../src/adapters/channel/mattermost/MattermostChannel.js";
import { SlackChannel } from "../../src/adapters/channel/slack/SlackChannel.js";
import { HomeAssistantChannel } from "../../src/adapters/channel/homeassistant/HomeAssistantChannel.js";

test("Mattermost reports failed permission prompt delivery", async () => {
  const channel = new MattermostChannel();
  (channel as any).rest = async () => {
    throw new Error("post unavailable");
  };

  assert.equal(await (channel as any).sendReply({ channelId: "channel-1" }, "permission prompt"), false);
});

test("Slack reports failed permission prompt delivery", async () => {
  const channel = new SlackChannel();
  (channel as any).app = {
    client: {
      chat: {
        postMessage: async () => {
          throw new Error("post unavailable");
        },
      },
    },
  };

  assert.equal(await (channel as any).sendReply({ channelId: "channel-1" }, "permission prompt"), false);
});

test("Home Assistant reports failed permission prompt delivery", async () => {
  const channel = new HomeAssistantChannel();
  (channel as any).ws = {
    readyState: 1,
    send: () => {
      throw new Error("socket closed");
    },
  };

  assert.equal(await (channel as any).sendReply("conversation.chat", "permission prompt"), false);
});

test("Home Assistant waits for the service result before confirming delivery", async () => {
  const channel = new HomeAssistantChannel();
  let sentId: number | undefined;
  (channel as any).ws = {
    readyState: 1,
    send: (raw: string) => {
      sentId = JSON.parse(raw).id;
    },
  };

  const delivery = (channel as any).sendReply("conversation.chat", "permission prompt");
  await Promise.resolve();
  assert.ok(sentId !== undefined);
  const result = (channel as any).onRawMessage(JSON.stringify({
    type: "result",
    id: sentId,
    success: false,
    error: { code: "service_not_found" },
  }));
  await result;
  assert.equal(await delivery, false);
});
