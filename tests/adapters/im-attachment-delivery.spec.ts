import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ImAttachmentDelivery } from "../../src/adapters/channel/protocol/ImAttachmentDelivery.js";

test("ImAttachmentDelivery decodes legacy media_reference base64 paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-delivery-"));
  const path = join(dir, "image.png.b64");
  const original = Buffer.from([0, 1, 2, 250, 255]);
  await writeFile(path, original.toString("base64"), "utf8");
  try {
    let prepared: Buffer | undefined;
    const delivery = new ImAttachmentDelivery({
      maxBytes: 100,
      sendPrepared: async (attachment) => { prepared = attachment.buffer; },
      sendTextFallback: async () => undefined,
    });
    assert.equal(await delivery.send({
      type: "image",
      path,
      name: "image.png",
      mimeType: "image/png",
      source: "media_reference",
    }), true);
    assert.deepEqual(prepared, original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
