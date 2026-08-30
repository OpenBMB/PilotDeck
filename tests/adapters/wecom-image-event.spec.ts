import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("WeCom sends path-only media reference attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-wecom-media-"));
  const path = join(dir, "report.pdf");
  await writeFile(path, Buffer.from("pdf-bytes"));
  try {
    const channel = new WeComChannel({ botKey: "test" }) as any;
    const sent: Array<{ fileName: string; data: Buffer }> = [];
    channel.sendPreparedMedia = async (_chatId: string, prepared: any) => {
      sent.push({ fileName: prepared.fileName, data: prepared.data });
      return true;
    };
    channel.sendReply = async () => undefined;

    await channel.sendEventMedia("chat-1", {
      type: "assistant_attachment",
      attachment: {
        type: "file",
        path,
        name: "report.pdf",
        mimeType: "application/pdf",
        source: "media_reference",
      },
    }, {});

    assert.deepEqual(sent, [{ fileName: "report.pdf", data: Buffer.from("pdf-bytes") }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
