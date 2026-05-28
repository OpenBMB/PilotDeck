/**
 * Session file-history (C4) protocol types. Mirrors the legacy upstream
 * file-history shapes (F1-F14).
 *
 * `FileHistoryBackup`
 *   - `backupFileName: string | null` — null marker means "file did not
 *     exist at the time of trackEdit"; rewind translates that into an
 *     `unlink` (F11).
 *   - `version` — increases when the file is re-tracked across snapshots
 *     (F6 mtime delta detection).
 *
 * `FileHistorySnapshot`
 *   - keyed by `messageId` so `rewind(messageId)` can `findLast` the
 *     matching snapshot (F8). Multiple snapshots can share a `messageId`
 *     when an updateState is layered (F12 `isSnapshotUpdate`).
 *
 * `FileHistoryState`
 *   - in-memory shape held by `FileHistoryStore`. Persistence happens via
 *     transcript entries (`file_snapshot_recorded`) so a process crash
 *     can replay the state on resume.
 */

export type FileHistoryBackup = {
  backupFileName: string | null;
  version: number;
  backupTime: Date;
  /** Original file mode bits (permission preservation, F10). */
  mode?: number;
};

export type FileHistorySnapshot = {
  messageId: string;
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: Date;
};

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
};

export type FileHistoryDiffStats = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};
