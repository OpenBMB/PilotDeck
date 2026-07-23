import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("history replay restores structured agent file artifacts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-history-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-history-home-"));
  try {
    const sessionKey = "web:s_file_artifacts";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-07-21T10:00:00.000Z"),
    });
    await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
      id: "artifact-1",
      name: "report.xlsx",
      path: "report.xlsx",
      operation: "created",
      source: "workspace_diff",
      status: "complete",
      size: 42,
      sha256: "a".repeat(64),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      createdAt: "2026-07-21T10:00:00.000Z",
    }]);

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const message = replay.messages.find((item) => item.kind === "file_artifacts");

    assert.ok(message);
    assert.equal(message.role, "assistant");
    assert.equal(message.artifacts?.[0]?.path, "report.xlsx");
    assert.equal(message.artifacts?.[0]?.operation, "created");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("history replay hides Agent file artifacts in general conversations", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-general-artifact-history-"));
  try {
    const sessionKey = "web:s_general_file_artifacts";
    const storage = createAgentProjectSessionStorage({
      projectRoot: pilotHome,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });
    await storage.transcript.recordFileArtifacts(sessionKey, "turn-1", [{
      id: "artifact-1",
      name: "stale-general-artifact.jsonl",
      path: "stale-general-artifact.jsonl",
      operation: "updated",
      source: "workspace_diff",
      status: "complete",
      size: 42,
      sha256: "b".repeat(64),
      mimeType: "application/x-ndjson",
      createdAt: "2026-07-22T10:00:00.000Z",
    }]);

    const replay = await readWebSessionMessages(
      { sessionKey, projectKey: pilotHome },
      { projectRoot: pilotHome, pilotHome },
    );

    assert.equal(replay.messages.some((item) => item.kind === "file_artifacts"), false);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
