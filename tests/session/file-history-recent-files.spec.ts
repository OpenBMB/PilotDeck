import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileHistoryStore,
  type FileHistorySnapshotRecordedEntry,
} from "../../src/session/filesystem/FileHistoryStore.js";

async function withStore(
  run: (input: { root: string; store: FileHistoryStore }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pilotdeck-file-history-recent-"));
  try {
    await run({
      root,
      store: new FileHistoryStore({ backupDir: path.join(root, "backups") }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("recent tracked files are empty before edits and for invalid limits", async () => {
  await withStore(async ({ store }) => {
    assert.deepEqual(store.getRecentTrackedFiles(5), []);
    assert.deepEqual(store.getRecentTrackedFiles(0), []);
    assert.deepEqual(store.getRecentTrackedFiles(-1), []);
    assert.deepEqual(store.getRecentTrackedFiles(Number.NaN), []);
    assert.deepEqual(store.getRecentTrackedFiles(Number.POSITIVE_INFINITY), []);
  });
});

test("recent tracked files are absolute, newest first, deduplicated, and limited", async () => {
  await withStore(async ({ root, store }) => {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    const third = path.join(root, "third.txt");
    await Promise.all([
      writeFile(first, "first"),
      writeFile(second, "second"),
      writeFile(third, "third"),
    ]);

    await store.trackEdit(first, "message-1");
    await store.trackEdit(second, "message-2");
    await store.trackEdit(third, "message-3");
    assert.deepEqual(store.getRecentTrackedFiles(3), [third, second, first]);

    await store.trackEdit(first, "message-4");
    assert.deepEqual(store.getRecentTrackedFiles(3), [first, third, second]);
    assert.deepEqual(store.getRecentTrackedFiles(1.9), [first]);
  });
});

test("recent tracked file queries return a copy", async () => {
  await withStore(async ({ root, store }) => {
    const tracked = path.join(root, "tracked.txt");
    await writeFile(tracked, "tracked");
    await store.trackEdit(tracked, "message-1");

    const result = store.getRecentTrackedFiles(5);
    result.length = 0;

    assert.deepEqual(store.getRecentTrackedFiles(5), [tracked]);
  });
});

test("transcript replay rebuilds recent tracked files without reading disk", async () => {
  await withStore(async ({ root, store }) => {
    const first = path.join(root, "missing-first.txt");
    const second = path.join(root, "missing-second.txt");
    const entries: FileHistorySnapshotRecordedEntry[] = [
      replayEntry("message-1", [first], "2026-09-11T00:00:00.000Z"),
      replayEntry("message-2", [second, first], "2026-09-11T00:01:00.000Z"),
    ];

    store.replayFromTranscript(entries);

    assert.deepEqual(store.getRecentTrackedFiles(5), [first, second]);
  });
});

function replayEntry(
  messageId: string,
  filePaths: string[],
  timestamp: string,
): FileHistorySnapshotRecordedEntry {
  return {
    messageId,
    trackedFileBackups: Object.fromEntries(filePaths.map((filePath) => [
      filePath,
      {
        backupFileName: null,
        version: 1,
        backupTime: timestamp,
      },
    ])),
    timestamp,
  };
}
