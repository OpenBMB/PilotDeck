import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function textOf(result: Awaited<ReturnType<ReturnType<typeof createReadFileTool>["execute"]>>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("read_file auto-pages large text files instead of failing", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-large-"));
  try {
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index + 1} ${"x".repeat(80)}`);
    await writeFile(join(projectRoot, "large.txt"), lines.join("\n"));

    const result = await createReadFileTool().execute({ file_path: "large.txt" }, context(projectRoot));
    const text = textOf(result);

    assert.match(text, /^1\|line-1/m);
    assert.match(text, /Continue with read_file\({ file_path: "large\.txt", offset: \d+, limit: \d+ }\)/);
    assert.equal((result.data as { autoPaged?: boolean }).autoPaged, true);
    assert.ok((result.data as { nextOffset?: number }).nextOffset! > 1);
    assert.equal(result.metadata?.truncated, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file explicit limit reads a large file range without auto paging", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-range-"));
  try {
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index + 1} ${"x".repeat(80)}`);
    await writeFile(join(projectRoot, "large.txt"), lines.join("\n"));

    const result = await createReadFileTool().execute({ file_path: "large.txt", offset: 3000, limit: 3 }, context(projectRoot));
    const text = textOf(result);

    assert.match(text, /^3000\|line-3000/m);
    assert.match(text, /^3002\|line-3002/m);
    assert.doesNotMatch(text, /^3003\|line-3003/m);
    assert.equal((result.data as { autoPaged?: boolean }).autoPaged, false);
    assert.equal((result.data as { nextOffset?: number }).nextOffset, 3003);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file auto-shrinks oversized persisted tool-result ref ranges", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-ref-autopage-"));
  try {
    const refPath = join(projectRoot, ".pilotdeck", "tool-results", "refs", "result-0001.txt");
    await mkdir(join(projectRoot, ".pilotdeck", "tool-results", "refs"), { recursive: true });
    await writeFile(refPath, Array.from({ length: 300 }, (_, index) => `line-${index + 1} ${"x".repeat(1200)}`).join("\n"));

    const result = await createReadFileTool().execute({
      file_path: ".pilotdeck/tool-results/refs/result-0001.txt",
      offset: 1,
      limit: 200,
    }, context(projectRoot));
    const text = textOf(result);

    assert.match(text, /^1\|line-1/m);
    assert.match(text, /persisted tool result was too large for the requested range/);
    assert.match(text, /Continue with read_file\({ file_path: "\.pilotdeck\/tool-results\/refs\/result-0001\.txt", offset: \d+, limit: \d+ }\)/);
    assert.equal((result.data as { autoPaged?: boolean }).autoPaged, true);
    assert.ok((result.data as { endLine?: number }).endLine! < 200);
    assert.ok((result.data as { nextOffset?: number }).nextOffset! > 1);
    assert.equal(result.metadata?.truncated, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file keeps explicit oversized ordinary file ranges strict", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-ordinary-strict-"));
  try {
    await writeFile(join(projectRoot, "large.txt"), Array.from({ length: 300 }, (_, index) => `line-${index + 1} ${"x".repeat(1200)}`).join("\n"));

    await assert.rejects(
      () => createReadFileTool().execute({ file_path: "large.txt", offset: 1, limit: 200 }, context(projectRoot)),
      /exceeds the text token budget/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file explicit limit records a ranged snapshot for follow-up edits", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-range-edit-"));
  try {
    await writeFile(join(projectRoot, "target.txt"), "alpha\nbeta\ngamma\n");
    const runtimeContext = context(projectRoot);

    await createReadFileTool().execute({ file_path: "target.txt", offset: 2, limit: 1 }, runtimeContext);
    const edited = await createEditFileTool().execute({
      file_path: "target.txt",
      old_string: "beta",
      new_string: "BETA",
    }, runtimeContext);

    const text = edited.content[0]?.type === "text" ? edited.content[0].text : "";
    assert.match(text, /Updated target\.txt/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file auto-paged large files record a ranged snapshot for follow-up edits", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-autopage-edit-"));
  try {
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index + 1} ${"x".repeat(80)}`);
    await writeFile(join(projectRoot, "large.txt"), lines.join("\n"));
    const runtimeContext = context(projectRoot);

    await createReadFileTool().execute({ file_path: "large.txt" }, runtimeContext);
    const edited = await createEditFileTool().execute({
      file_path: "large.txt",
      old_string: "line-1 ",
      new_string: "LINE-1 ",
    }, runtimeContext);

    const text = edited.content[0]?.type === "text" ? edited.content[0].text : "";
    assert.match(text, /Updated large\.txt/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file returns a head-tail preview for a single oversized line", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-long-line-"));
  try {
    await writeFile(join(projectRoot, "one-line.txt"), `prefix-${"x".repeat(250_000)}-suffix`);

    const result = await createReadFileTool().execute({ file_path: "one-line.txt" }, context(projectRoot));
    const text = textOf(result);

    assert.match(text, /^1\|prefix-/);
    assert.match(text, /-suffix/);
    assert.match(text, /head\/tail preview/);
    assert.match(text, /read_file\({ file_path: "one-line\.txt", offset: 1, limit: 1 }\)/);
    assert.equal((result.data as { autoPaged?: boolean }).autoPaged, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
