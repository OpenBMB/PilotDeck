import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";

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

// Each contains a String.prototype.replace substitution pattern: $$, $', $`, $&.
const DOLLAR_STRINGS = [
  "\t@echo $$HOME",
  "$$E = mc^2$$",
  "IFS=$'\\n'",
  "prefix $` suffix",
  "return input.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");",
];

for (const replaceAll of [false, true]) {
  for (const newString of DOLLAR_STRINGS) {
    test(`edit_file writes ${JSON.stringify(newString)} literally (replace_all: ${replaceAll})`, async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-edit-literal-"));
      try {
        await writeFile(join(projectRoot, "target.txt"), "before\nPLACEHOLDER\nafter\n");
        const runtimeContext = context(projectRoot);

        await createReadFileTool().execute({ file_path: "target.txt" }, runtimeContext);
        await createEditFileTool().execute({
          file_path: "target.txt",
          old_string: "PLACEHOLDER",
          new_string: newString,
          ...(replaceAll ? { replace_all: true } : {}),
        }, runtimeContext);

        assert.equal(
          await readFile(join(projectRoot, "target.txt"), "utf8"),
          `before\n${newString}\nafter\n`,
        );
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  }
}
