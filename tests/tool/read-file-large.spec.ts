import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { hasBinaryExtension } from "../../src/tool/builtin/filesystem/fileTypeSafety.js";
import { readFileInRange } from "../../src/tool/builtin/filesystem/readFileInRange.js";

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

test("read_file rejects Office container files during validation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-office-"));
  try {
    await writeFile(join(projectRoot, "sample.docx"), Buffer.from("PK".padEnd(128, "x")));

    const tool = createReadFileTool();
    const result = await tool.validateInput?.({ file_path: "sample.docx" }, context(projectRoot));

    assert.equal(result?.ok, false);
    if (result?.ok === false) {
      assert.equal(result.issues[0]?.path, "file_path");
      assert.match(result.issues[0]?.message ?? "", /binary files are not supported/);
    }
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

test("read_file classifies common Office formats as binary", () => {
  for (const extension of ["xlsx", "xls", "docx", "doc", "pptx", "ppt", "ods", "odt", "odp"]) {
    assert.equal(hasBinaryExtension(`sample.${extension}`), true, `expected .${extension} to be binary`);
  }
});

test("read_file rejects ranged binary input instead of hanging", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-binary-range-"));
  try {
    const filePath = join(projectRoot, "unknown.payload");
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x61, 0x62, 0x63]));

    await assert.rejects(
      () => readFileInRange(filePath, 1, 20),
      /appears to be a binary file/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read_file range honors an aborted signal", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-read-aborted-range-"));
  try {
    const filePath = join(projectRoot, "large.txt");
    await writeFile(filePath, Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n"));
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => readFileInRange(filePath, 1, 20, controller.signal),
      (error: unknown) => error instanceof Error
        && error.name === "PilotDeckToolRuntimeError"
        && (error as { code?: string }).code === "tool_aborted",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
