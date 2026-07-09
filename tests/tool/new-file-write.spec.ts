import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";

function context(cwd: string) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
}

test("write_file can create a new file without a prior read_file call", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-write-new-"));
  try {
    const result = await createWriteFileTool().execute({
      file_path: "new-file.txt",
      content: "hello new file\n",
    }, context(projectRoot));

    assert.match(textOf(result), /Created new-file\.txt/);
    assert.equal(await readFile(join(projectRoot, "new-file.txt"), "utf8"), "hello new file\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("edit_file can create a new file with empty old_string without a prior read_file call", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-edit-new-"));
  try {
    const result = await createEditFileTool().execute({
      file_path: "created-by-edit.txt",
      old_string: "",
      new_string: "created through edit\n",
    }, context(projectRoot));

    assert.match(textOf(result), /Created created-by-edit\.txt/);
    assert.equal(await readFile(join(projectRoot, "created-by-edit.txt"), "utf8"), "created through edit\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
