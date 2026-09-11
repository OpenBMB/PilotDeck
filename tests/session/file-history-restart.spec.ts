import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileHistoryStore } from "../../src/session/filesystem/FileHistoryStore.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";

test("file checkpoint index survives a store restart through transcript replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-restart-"));
  const backupDir = join(root, "backups");
  const transcriptPath = join(root, "session.jsonl");
  const filePath = join(root, "notes.txt");
  const sessionKey = "api_server:s_restart";
  try {
    await writeFile(filePath, "before\n", "utf8");
    const transcript = new JsonlTranscriptWriter({ path: transcriptPath });
    const first = new FileHistoryStore({
      backupDir,
      now: () => new Date("2026-09-09T10:00:00.000Z"),
      onSnapshotRecorded: async (snapshot) => transcript.recordFileSnapshot(sessionKey, "turn-1", {
        messageId: snapshot.messageId,
        trackedFileBackups: snapshot.trackedFileBackups,
        expectedFileStates: snapshot.expectedFileStates,
        snapshotTimestamp: snapshot.timestamp,
      }),
    });
    await first.trackEdit(filePath, "turn-1");
    await writeFile(filePath, "after\n", "utf8");
    await first.markEditCommitted(filePath, "turn-1");

    const persisted = await readTranscript(transcriptPath);
    const snapshotEntries = persisted.entries.filter((entry) => entry.type === "file_snapshot_recorded");
    assert.equal(snapshotEntries.length, 2, "backup capture and post-edit fingerprint are both durable");

    const restarted = new FileHistoryStore({ backupDir });
    restarted.replayFromTranscript(snapshotEntries.map((entry) => ({
      messageId: entry.messageId,
      trackedFileBackups: entry.trackedFileBackups,
      expectedFileStates: entry.expectedFileStates,
      timestamp: entry.snapshotTimestamp,
    })));
    const dryRun = await restarted.getDiffStats("turn-1");
    assert.equal(dryRun.filesChanged, 1);
    const rewound = await restarted.rewind("turn-1");
    assert.deepEqual(rewound.missing, []);
    assert.deepEqual(await readFile(filePath, "utf8"), "before\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file checkpoint refuses to overwrite an external edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-conflict-"));
  const backupDir = join(root, "backups");
  const filePath = join(root, "notes.txt");
  try {
    await writeFile(filePath, "before\n", "utf8");
    const history = new FileHistoryStore({ backupDir });
    await history.trackEdit(filePath, "turn-1");
    await writeFile(filePath, "pilotdeck edit\n", "utf8");
    await history.markEditCommitted(filePath, "turn-1");
    await writeFile(filePath, "external edit\n", "utf8");

    assert.deepEqual(await history.getConflictPaths("turn-1"), [filePath]);
    const result = await history.rewind("turn-1");
    assert.deepEqual(result.conflicts, [filePath]);
    assert.deepEqual(await readFile(filePath, "utf8"), "external edit\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file checkpoint reports a missing backup without changing the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-missing-backup-"));
  const backupDir = join(root, "backups");
  const filePath = join(root, "notes.txt");
  try {
    await writeFile(filePath, "before\n", "utf8");
    const history = new FileHistoryStore({ backupDir });
    await history.trackEdit(filePath, "turn-1");
    await writeFile(filePath, "after\n", "utf8");
    await history.markEditCommitted(filePath, "turn-1");
    const backupName = history.getState().snapshots[0]?.trackedFileBackups[filePath]?.backupFileName;
    assert.ok(backupName, "the test requires a durable backup");
    await rm(join(backupDir, backupName));

    const result = await history.rewind("turn-1");
    assert.deepEqual(result.missing, [filePath]);
    assert.deepEqual(result.filesChanged, []);
    assert.deepEqual(await readFile(filePath, "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
