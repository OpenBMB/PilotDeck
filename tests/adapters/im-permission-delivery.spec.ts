import test from "node:test";
import assert from "node:assert/strict";

import { MattermostChannel } from "../../src/adapters/channel/mattermost/MattermostChannel.js";
import { SlackChannel } from "../../src/adapters/channel/slack/SlackChannel.js";

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
