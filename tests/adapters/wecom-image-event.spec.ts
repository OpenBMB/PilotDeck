import test from "node:test";
import assert from "node:assert/strict";

import { WeComChannel } from "../../src/adapters/channel/wecom/WeComChannel.js";

test("WeCom sends assistant attachment image events", async () => {
  const channel = new WeComChannel({ botKey: "test" }) as any;
  const sent: Array<{ chatId: string; fileName: string; contentType: string; data: Buffer }> = [];
  channel.sendPreparedMedia = async (chatId: string, prepared: any) => {
    sent.push({ chatId, fileName: prepared.fileName, contentType: prepared.contentType, data: prepared.data });
    return true;
  };
  channel.sendReply = async () => undefined;

  await channel.sendEventMedia("chat-1", {
    type: "assistant_attachment",
    attachment: {
      type: "image",
      content: "aW1hZ2U=",
      mimeType: "image/png",
      name: "screenshot.png",
      source: "tool_result",
    },
  }, {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, "chat-1");
  assert.equal(sent[0]?.contentType, "image/png");
  assert.equal(sent[0]?.data.toString("base64"), "aW1hZ2U=");
});
