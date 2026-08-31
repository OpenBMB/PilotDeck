import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { materializeMediaReferences } from "../../src/model/request/materializeMediaReferences.js";

test("ToolResultBudget persists oversized base64 media as binary bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-media-binary-"));
  try {
    const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const data = original.toString("base64");
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 4 });
    const applied = await budget.applyToSupplementalMessage({
      role: "user",
      content: [{ type: "image", source: "base64", data, mimeType: "image/png", bytes: original.byteLength }],
    }, "tool-image", { turnId: "turn-1" });
    const reference = applied.content[0];
    assert.equal(reference?.type, "media_reference");
    if (reference?.type !== "media_reference") return;
    assert.match(reference.path, /\.png$/);
    assert.deepEqual(await readFile(reference.path), original);

    const materialized = await materializeMediaReferences([applied]);
    const image = materialized.messages[0]?.content[0];
    assert.equal(image?.type, "image");
    if (image?.type !== "image") return;
    assert.equal(image.data, data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("materializeMediaReferences keeps compatibility with legacy base64 media paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-media-legacy-"));
  const path = join(dir, "image.png.b64");
  const data = Buffer.from("legacy-image").toString("base64");
  await writeFile(path, data, "utf8");
  try {
    const result = await materializeMediaReferences([{
      role: "user",
      content: [{
        type: "media_reference",
        path,
        originalBytes: Buffer.byteLength("legacy-image"),
        preview: "[image omitted]",
        hasMore: true,
        mimeType: "image/png",
        mediaType: "image",
      }],
    }]);
    const image = result.messages[0]?.content[0];
    assert.equal(image?.type, "image");
    if (image?.type !== "image") return;
    assert.equal(image.data, data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
