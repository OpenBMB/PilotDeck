import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";

test("Office attachments use their original name when the stored path is opaque", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-resolver-"));
  try {
    const filePath = join(root, "opaque-upload-id");
    await writeFile(filePath, Buffer.from("PK".padEnd(128, "x")));

    const result = await new AttachmentResolver({ maxFileBytes: 1 }).resolve({
      type: "file",
      path: filePath,
      name: "sample.docx",
    });

    assert.equal(result.blocks.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "attachment_unsupported");
    assert.equal(result.diagnostics[0]?.severity, "info");
    assert.match(result.diagnostics[0]?.message ?? "", /read_file cannot inspect this format directly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
