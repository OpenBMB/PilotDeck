import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";
import type { PilotDeckToolErrorCode, PilotDeckToolResult } from "../../src/tool/index.js";

function toolResult(toolName: string) {
  return {
    type: "success" as const,
    toolCallId: `${toolName}-1`,
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    startedAt: "2026-07-21T10:00:00.000Z",
    completedAt: "2026-07-21T10:00:00.100Z",
  };
}

function failedToolResult(toolName: string, code: PilotDeckToolErrorCode) {
  return {
    type: "error" as const,
    toolCallId: `${toolName}-1`,
    toolName,
    error: { code, message: "Tool did not execute." },
    content: [{ type: "text" as const, text: "Tool did not execute." }],
    startedAt: "2026-07-21T10:00:00.000Z",
    completedAt: "2026-07-21T10:00:00.100Z",
  };
}

function successfulFileResult(toolCallId: string, paths: string[]): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId,
    toolName: "document_generator",
    content: paths.map((path) => ({ type: "file" as const, path })),
    startedAt: "2026-07-21T10:00:00.000Z",
    completedAt: "2026-07-21T10:00:01.000Z",
  };
}

test("file artifacts include every meaningful workspace change without an extension allowlist", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifacts-"));
  const uploadedFile = join(projectRoot, ".tmp", "chat-attachments", "source.xlsx");
  try {
    await mkdir(join(projectRoot, "app"), { recursive: true });
    await mkdir(join(projectRoot, ".tmp", "chat-attachments"), { recursive: true });
    await writeFile(join(projectRoot, "app", "page.tsx"), "before");
    await writeFile(join(projectRoot, "existing.docx"), "before");
    await writeFile(join(projectRoot, "restored.txt"), "original");
    await writeFile(join(projectRoot, "mtime-only.txt"), "unchanged");
    await writeFile(uploadedFile, "upload-before");

    const collector = await FileArtifactCollector.start({
      cwd: projectRoot,
      allowedInputPaths: [uploadedFile],
      now: () => new Date("2026-07-21T10:00:00.000Z"),
    });

    await writeFile(join(projectRoot, "app", "page.tsx"), "after!");
    await writeFile(join(projectRoot, "app", "globals.css"), "body { color: navy; }");
    await writeFile(join(projectRoot, "existing.docx"), "after with more bytes");
    await writeFile(join(projectRoot, "notes.custom"), "unknown extension is still meaningful");
    await writeFile(join(projectRoot, "result.pptx"), "presentation");
    await writeFile(join(projectRoot, ".env.example"), "PUBLIC_URL=http://localhost");
    await mkdir(join(projectRoot, ".github", "workflows"), { recursive: true });
    await writeFile(join(projectRoot, ".github", "workflows", "ci.yml"), "name: CI");
    await writeFile(uploadedFile, "upload-after with more bytes");

    await writeFile(join(projectRoot, "restored.txt"), "temporary change");
    await writeFile(join(projectRoot, "restored.txt"), "original");
    await utimes(join(projectRoot, "mtime-only.txt"), new Date(), new Date());
    await writeFile(join(projectRoot, "created-then-deleted.txt"), "temporary");
    await rm(join(projectRoot, "created-then-deleted.txt"));

    await mkdir(join(projectRoot, ".pilotdeck", "work", "session", "turn", "pptx"), { recursive: true });
    await writeFile(join(projectRoot, ".pilotdeck", "work", "session", "turn", "pptx", "deck.mjs"), "builder");
    await mkdir(join(projectRoot, ".next", "static"), { recursive: true });
    await writeFile(join(projectRoot, ".next", "static", "bundle.js"), "generated bundle");
    await writeFile(join(projectRoot, ".pilotdeck_build.mjs"), "build program");
    await writeFile(join(projectRoot, ".env"), "API_KEY=secret");
    await writeFile(join(projectRoot, "private.pem"), "secret key");

    collector.observeToolResult(toolResult("bash"));
    const artifacts = await collector.finish("incomplete");

    const expectedPaths = [
      ".env.example",
      ".github/workflows/ci.yml",
      ".tmp/chat-attachments/source.xlsx",
      "app/globals.css",
      "app/page.tsx",
      "existing.docx",
      "notes.custom",
      "result.pptx",
    ].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(artifacts.map((artifact) => artifact.path), expectedPaths);
    assert.equal(artifacts.find((artifact) => artifact.path === "app/page.tsx")?.operation, "updated");
    assert.equal(artifacts.find((artifact) => artifact.path === "app/globals.css")?.operation, "created");
    assert.equal(artifacts.find((artifact) => artifact.path === "notes.custom")?.mimeType, undefined);
    assert.ok(artifacts.every((artifact) => artifact.status === "incomplete"));
    assert.ok(artifacts.every((artifact) => artifact.sha256.length === 64));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("file artifact collection ignores workspace changes when no mutating tool ran", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-no-tool-"));
  try {
    await mkdir(join(projectRoot, "app"), { recursive: true });
    await writeFile(join(projectRoot, "app", "page.tsx"), "before");

    const collector = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "app", "page.tsx"), "changed outside the agent turn");
    await writeFile(join(projectRoot, "app", "external.txt"), "external file");

    assert.deepEqual(await collector.finish("complete"), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read-only tool results do not enable workspace-diff artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-readonly-tool-"));
  try {
    await writeFile(join(projectRoot, "notes.txt"), "before");

    const collector = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "notes.txt"), "changed outside a read-only tool");
    collector.observeToolResult(toolResult("read_file"));

    assert.deepEqual(await collector.finish("complete"), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("unexecuted mutating tool errors do not enable workspace-diff artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-denied-tool-"));
  try {
    await writeFile(join(projectRoot, "notes.txt"), "before");

    const collector = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "notes.txt"), "changed outside a denied tool");
    collector.observeToolResult(failedToolResult("bash", "permission_denied"));

    assert.deepEqual(await collector.finish("complete"), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("unavailable mutating tools do not enable workspace-diff artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-unavailable-tool-"));
  try {
    await writeFile(join(projectRoot, "notes.txt"), "before");

    const collector = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "notes.txt"), "changed before an unavailable tool");
    collector.observeToolResult(failedToolResult("optional_writer", "tool_unavailable"));

    assert.deepEqual(await collector.finish("complete"), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("mutating tool execution failures still enable workspace-diff artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-failed-tool-"));
  try {
    await writeFile(join(projectRoot, "notes.txt"), "before");

    const collector = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "notes.txt"), "changed before a tool failure");
    collector.observeToolResult(failedToolResult("bash", "tool_execution_failed"));

    assert.deepEqual(
      (await collector.finish("complete")).map((artifact) => artifact.path),
      ["notes.txt"],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("file artifact fingerprints are reused for unchanged files across scans and turns", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-cache-"));
  const trackedFile = join(projectRoot, "report.txt");
  let hashCalls = 0;
  const hashFile = async (filePath: string) => {
    hashCalls += 1;
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  };

  try {
    await writeFile(trackedFile, "before");
    await mkdir(join(projectRoot, ".venv", "lib"), { recursive: true });
    await writeFile(join(projectRoot, ".venv", "lib", "dependency.py"), "ignored");

    const firstTurn = await FileArtifactCollector.start({ cwd: projectRoot, hashFile });
    assert.equal(hashCalls, 1, "the initial scan hashes only non-excluded workspace files");
    assert.deepEqual(await firstTurn.finish("complete"), []);
    assert.equal(hashCalls, 1, "the final scan reuses an unchanged baseline fingerprint");

    const secondTurn = await FileArtifactCollector.start({ cwd: projectRoot, hashFile });
    assert.equal(hashCalls, 1, "the next turn reuses the cached workspace fingerprint");

    await writeFile(trackedFile, "after with a different size");
    secondTurn.observeToolResult(toolResult("bash"));
    const artifacts = await secondTurn.finish("complete");

    assert.equal(hashCalls, 2, "only the changed file is re-hashed");
    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["report.txt"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("concurrent collectors in one workspace keep only files explicitly reported by their own turns", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-concurrent-"));
  try {
    const firstTurn = await FileArtifactCollector.start({ cwd: projectRoot });
    const secondTurn = await FileArtifactCollector.start({ cwd: projectRoot });

    await writeFile(join(projectRoot, "first.txt"), "first turn");
    await writeFile(join(projectRoot, "second.txt"), "second turn");
    await writeFile(join(projectRoot, "shared.txt"), "shared result");
    await writeFile(join(projectRoot, "unreported.txt"), "unknown owner");

    firstTurn.observeToolResult(successfulFileResult("first-call", ["first.txt", "shared.txt"]));
    secondTurn.observeToolResult(successfulFileResult("second-call", ["second.txt", "shared.txt"]));

    const firstArtifacts = await firstTurn.finish("complete");
    const secondArtifacts = await secondTurn.finish("complete");

    assert.deepEqual(
      firstArtifacts.map((artifact) => artifact.path),
      ["first.txt", "shared.txt"],
    );
    assert.deepEqual(
      secondArtifacts.map((artifact) => artifact.path),
      ["second.txt", "shared.txt"],
    );
    assert.ok(firstArtifacts.every((artifact) => artifact.source === "tool"));
    assert.ok(secondArtifacts.every((artifact) => artifact.source === "tool"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("concurrent collectors in separate workspaces retain independent workspace diffs", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-project-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-project-b-"));
  try {
    const firstTurn = await FileArtifactCollector.start({ cwd: firstRoot });
    const secondTurn = await FileArtifactCollector.start({ cwd: secondRoot });

    await writeFile(join(firstRoot, "first.txt"), "first project");
    await writeFile(join(secondRoot, "second.txt"), "second project");
    firstTurn.observeToolResult(toolResult("bash"));
    secondTurn.observeToolResult(toolResult("bash"));

    const firstArtifacts = await firstTurn.finish("complete");
    const secondArtifacts = await secondTurn.finish("complete");

    assert.deepEqual(firstArtifacts.map((artifact) => artifact.path), ["first.txt"]);
    assert.deepEqual(secondArtifacts.map((artifact) => artifact.path), ["second.txt"]);
    assert.equal(firstArtifacts[0]?.source, "workspace_diff");
    assert.equal(secondArtifacts[0]?.source, "workspace_diff");
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("disposing an unfinished collector removes it from workspace concurrency tracking", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-dispose-"));
  try {
    const unfinishedTurn = await FileArtifactCollector.start({ cwd: projectRoot });
    unfinishedTurn.dispose();

    const nextTurn = await FileArtifactCollector.start({ cwd: projectRoot });
    await writeFile(join(projectRoot, "detected.txt"), "workspace diff remains enabled");
    nextTurn.observeToolResult(toolResult("bash"));

    const artifacts = await nextTurn.finish("complete");

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["detected.txt"]);
    assert.equal(artifacts[0]?.source, "workspace_diff");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
