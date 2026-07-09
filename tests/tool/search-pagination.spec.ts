import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGlobTool } from "../../src/tool/builtin/glob.js";
import { createGrepTool } from "../../src/tool/builtin/grep.js";

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

test("glob result text tells the model when more files are available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-glob-test-"));
  try {
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    await writeFile(join(dir, "c.txt"), "c");

    const result = await createGlobTool().execute({ pattern: "*.txt", limit: 2 }, context(dir));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    assert.match(text, /\[glob pagination\] returned=2 total=3 truncated=true limit=2/);
    assert.match(text, /More files are available/);
    assert.deepEqual((result.data as any).truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grep result text includes next offset when paginated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-grep-test-"));
  try {
    await writeFile(join(dir, "a.txt"), "needle one\nneedle two\nneedle three\n");

    const result = await createGrepTool().execute(
      { pattern: "needle", output_mode: "content", head_limit: 2 },
      context(dir),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    assert.match(text, /\[grep pagination\] returned=2 total=3 offset=0 limit=2 truncated=true/);
    assert.match(text, /Call grep again with offset=2 and head_limit=2/);
    assert.deepEqual((result.data as any).truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
