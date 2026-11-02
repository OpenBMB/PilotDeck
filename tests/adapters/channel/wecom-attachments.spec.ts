import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { WeComChannel, isDeniedDeliverablePath } from "../../../src/adapters/channel/wecom/WeComChannel.js";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChannelAttachment } from "../../../src/gateway/index.js";

test('unified YAML credentials and migration backups cannot be sent as deliverables', () => {
  const previous = process.env.PILOT_HOME, home = join(tmpdir(), 'pd-sensitive-fixture');
  process.env.PILOT_HOME = home;
  try {
    for (const file of ['credentials/web.yaml', 'credentials/gateway.yaml', 'backups/configuration/weixin.bak', 'computer-use/mcp.yaml', 'mcp.yaml', 'weixin-credentials.json']) assert.equal(isDeniedDeliverablePath(join(home, file)), true);
    assert.equal(isDeniedDeliverablePath(join(home, 'projects/demo/workspace/report.pdf')), false);
  } finally { if (previous === undefined) delete process.env.PILOT_HOME; else process.env.PILOT_HOME = previous; }
});

test("WeCom inbound files are marked as registered channel attachments", async () => {
  const channel = new WeComChannel({
    uuid: () => "00000000-0000-4000-8000-000000000001",
  });
  const cacheInboundMedia = (channel as unknown as {
    cacheInboundMedia: (
      kind: "file",
      media: Record<string, unknown>,
    ) => Promise<ChannelAttachment | undefined>;
  }).cacheInboundMedia.bind(channel);

  const attachment = await cacheInboundMedia("file", {
    filename: "report.docx",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    base64: Buffer.from("PKfake-office-document").toString("base64"),
  });

  assert.ok(attachment?.path);
  try {
    assert.equal(attachment.metadata?.channelKey, "wecom");
  } finally {
    await rm(attachment.path, { force: true });
  }
});
