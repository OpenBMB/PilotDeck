import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";

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
