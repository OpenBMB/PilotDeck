import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";

test("Office attachments are reported unsupported before size checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-resolver-"));
  try {
    const filePath = join(root, "sample.docx");
    await writeFile(filePath, Buffer.from("PK".padEnd(128, "x")));

    const result = await new AttachmentResolver({ maxFileBytes: 1 }).resolve({ type: "file", path: filePath });

    assert.equal(result.blocks.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "attachment_unsupported");
    assert.equal(result.diagnostics[0]?.severity, "warning");
    assert.match(result.diagnostics[0]?.message ?? "", /read_file cannot inspect this format directly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("original name classifies text staged under an opaque upload ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-resolver-"));
  try {
    const filePath = join(root, "file-0-opaque-upload-id");
    await writeFile(filePath, "心理学科百年纪念会材料");

    const result = await new AttachmentResolver().resolve({
      type: "file",
      path: filePath,
      name: "纪念会材料.md",
    });

    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.blocks.length, 1);
    assert.match(result.blocks[0]?.type === "text" ? result.blocks[0].text : "", /心理学科百年纪念会材料/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
