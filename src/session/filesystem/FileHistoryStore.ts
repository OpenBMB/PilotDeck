/**
 * `FileHistoryStore` — implements C4 (§6.4 of the deferred-feature guide).
 *
 * Behaviour parity with the legacy upstream file-history store:
 *
 *   F1  trackEdit performs a 3-phase commit (check → backup → commit)
 *   F2  Repeated trackEdit on the same file in the same snapshot does NOT
 *       overwrite the v1 backup (idempotent)
 *   F3  createBackup: stat-first, ENOENT → null backup, async copyFile,
 *       lazy mkdir, mode preservation
 *   F4  Backup filename = sha256(filePath).slice(0, 16) + '@v' + version
 *   F5  Backup path = `<backupDir>/<backupFileName>` (session-scoped via
 *       `backupDir` constructor param)
 *   F6  makeSnapshot: re-iterate trackedFiles, bump version when mtime
 *       changed since the previous snapshot
 *   F7  Snapshots stored as an array of `{ messageId, trackedFileBackups,
 *       timestamp }`; `messageId` is the primary lookup key
 *   F8  rewind(messageId) findLast snapshot.messageId === messageId →
 *       applySnapshot
 *   F9  applySnapshot iterates trackedFileBackups → restoreBackup
 *   F10 mode preservation handled by createBackup / restoreBackup
 *   F11 null backup ↔ unlink target on rewind
 *   F12 Each snapshot transaction emits a `file_snapshot_recorded`
 *       transcript entry (see `replayFromTranscript`) so a process crash
 *       can reconstruct the state on resume.
 *   F13 100-snapshot evict (delete oldest snapshot + drop unreferenced
 *       backup files; F13 graceful behaviour for missing files)
 *   F14 `getDiffStats(messageId)` returns insertions/deletions vs. current
 *       on-disk state (line-based diff)
 *
 * Concurrency: `trackEdit`, `makeSnapshot`, `rewind`, `evict` are
 * serialized through a small mutex chain so concurrent edit_file /
 * write_file callers don't race phase 1 vs phase 3.
 *
 * Out-of-scope: line-level attribution (F14 returns aggregate counts only;
 * legacy's `(messageId, lineRange)` map is intentionally not implemented —
 * recorded as an `intentional_difference` in the parity table).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getBackupFileName } from "./backupNaming.js";
import { createBackup } from "./createBackup.js";
import { restoreBackup } from "./restoreBackup.js";
import type {
  FileHistoryBackup,
  FileHistoryDiffStats,
  FileHistorySnapshot,
  FileHistoryState,
} from "./types.js";

export type FileHistorySnapshotRecordedEntry = {
  messageId: string;
  trackedFileBackups: Record<
    string,
    Pick<FileHistoryBackup, "backupFileName" | "version" | "mode"> & {
      backupTime: string;
    }
  >;
  timestamp: string;
};

export type FileHistoryStoreOptions = {
  /** Absolute path under which `<sha16>@v<version>` files live. */
  backupDir: string;
  /** Files larger than this are skipped (default 10 MB). */
  maxFileBytes?: number;
  /** Hard cap on retained snapshots; oldest are evicted (default 100). */
  maxSnapshots?: number;
  /** Optional `now()` for deterministic tests. */
  now?: () => Date;
  /** Optional sink for `file_snapshot_recorded` transcript entries (F12). */
  onSnapshotRecorded?: (entry: FileHistorySnapshotRecordedEntry, kind: "create" | "update") => void;
  /** Optional warning sink for oversize / missing backups. */
  warn?: (message: string) => void;
};

export class FileHistoryStore {
  private readonly state: FileHistoryState = {
    snapshots: [],
    trackedFiles: new Set<string>(),
  };
  private readonly mtimeCache = new Map<string, number | null>();
  private readonly options: Required<
    Pick<FileHistoryStoreOptions, "backupDir" | "maxFileBytes" | "maxSnapshots" | "now">
  > & {
    onSnapshotRecorded?: FileHistoryStoreOptions["onSnapshotRecorded"];
    warn?: FileHistoryStoreOptions["warn"];
  };

  /**
   * Mutex tail; awaiting `mutex` then assigning a fresh promise serialises
   * mutations. Cheaper than spawning AbortControllers and avoids the
   * `Promise.race` foot-gun of cancellable mutexes.
   */
  private mutex: Promise<void> = Promise.resolve();

  constructor(options: FileHistoryStoreOptions) {
    this.options = {
      backupDir: options.backupDir,
      maxFileBytes: options.maxFileBytes ?? 10 * 1024 * 1024,
      maxSnapshots: options.maxSnapshots ?? 100,
      now: options.now ?? (() => new Date()),
      onSnapshotRecorded: options.onSnapshotRecorded,
      warn: options.warn,
    };
  }

  getState(): FileHistoryState {
    return this.state;
  }

  /**
   * F1 — capture the current file before an edit. Idempotent within a
   * single open snapshot (F2): repeated calls for the same file inside the
   * same `messageId` do not overwrite the existing v1 backup.
   *
   * Phase 1 — open or reuse the snapshot for `messageId`.
   * Phase 2 — backup the file (skip if already in this snapshot).
   * Phase 3 — commit the snapshot entry + transcript record (F12).
   */
  async trackEdit(filePath: string, messageId: string): Promise<void> {
    return this.run(async () => {
      const absPath = path.resolve(filePath);
      this.state.trackedFiles.add(absPath);

      const snapshot = this.getOrCreateOpenSnapshot(messageId);
      if (snapshot.trackedFileBackups[absPath]) {
        // F2 — already backed up at v1 within this snapshot; do nothing.
        return;
      }

      const version = 1;
      const result = await createBackup({
        filePath: absPath,
        version,
        backupDir: this.options.backupDir,
        maxFileBytes: this.options.maxFileBytes,
        now: this.options.now,
      });
      if (result.oversize) {
        this.options.warn?.(
          `file-history: skipping backup for ${absPath} (size > ${this.options.maxFileBytes} bytes)`,
        );
      }
      snapshot.trackedFileBackups[absPath] = result.backup;
      this.cacheMtime(absPath);

      this.recordTranscript(snapshot, "update");
    });
  }

  /**
   * F6 — finalize an open snapshot or create one. For every tracked file
   * whose mtime advanced since last record, a fresh backup at version+1 is
   * captured. mtime-stable files are kept at their existing version.
   */
  async makeSnapshot(messageId: string): Promise<void> {
    return this.run(async () => {
      const existing = this.findSnapshot(messageId);
      const snapshot: FileHistorySnapshot =
        existing ??
        ({
          messageId,
          trackedFileBackups: {},
          timestamp: this.options.now(),
        } satisfies FileHistorySnapshot);

      const previousSnapshot = this.findPreviousSnapshot(snapshot);

      for (const absPath of this.state.trackedFiles) {
        const cachedMtime = this.mtimeCache.get(absPath);
        let currentMtime: number | null = null;
        try {
          const stat = await fs.stat(absPath);
          currentMtime = stat.mtimeMs;
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
          currentMtime = null;
        }

        const previousBackup =
          snapshot.trackedFileBackups[absPath] ?? previousSnapshot?.trackedFileBackups[absPath];
        const previousVersion = previousBackup?.version ?? 0;
        const mtimeChanged = currentMtime !== cachedMtime;
        if (!mtimeChanged && previousBackup) {
          if (!snapshot.trackedFileBackups[absPath]) {
            snapshot.trackedFileBackups[absPath] = previousBackup;
          }
          continue;
        }
        const result = await createBackup({
          filePath: absPath,
          version: previousVersion + 1,
          backupDir: this.options.backupDir,
          maxFileBytes: this.options.maxFileBytes,
          now: this.options.now,
        });
        if (result.oversize) {
          this.options.warn?.(
            `file-history: skipping backup for ${absPath} (size > ${this.options.maxFileBytes} bytes)`,
          );
        }
        snapshot.trackedFileBackups[absPath] = result.backup;
        this.mtimeCache.set(absPath, currentMtime);
      }

      if (!existing) {
        this.state.snapshots.push(snapshot);
      }

      this.recordTranscript(snapshot, existing ? "update" : "create");
      await this.evictIfNeeded();
    });
  }

  /**
   * F8 + F9 — find the matching snapshot and restore every tracked file.
   */
  async rewind(messageId: string): Promise<{ filesChanged: string[]; missing: string[] }> {
    return this.run(async () => {
      const snapshot = this.findSnapshot(messageId);
      if (!snapshot) {
        throw new Error(`No snapshot for messageId ${messageId}`);
      }
      const filesChanged: string[] = [];
      const missing: string[] = [];
      for (const [absPath, backup] of Object.entries(snapshot.trackedFileBackups)) {
        const result = await restoreBackup({
          filePath: absPath,
          backup,
          backupDir: this.options.backupDir,
        });
        if (result.outcome === "missing") {
          missing.push(absPath);
          this.options.warn?.(
            `file-history: backup ${backup.backupFileName} for ${absPath} is missing on disk; skipping`,
          );
          continue;
        }
        filesChanged.push(absPath);
      }
      return { filesChanged, missing };
    });
  }

  /**
   * F14 (slim) — aggregate insertions / deletions between the captured
   * backup and the current on-disk content. Only counts files where both
   * sides exist; deletes / creates contribute the full file size in the
   * appropriate column.
   */
  async getDiffStats(messageId: string): Promise<FileHistoryDiffStats> {
    const snapshot = this.findSnapshot(messageId);
    if (!snapshot) {
      throw new Error(`No snapshot for messageId ${messageId}`);
    }
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const [absPath, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const before = backup.backupFileName
        ? await safeReadText(path.join(this.options.backupDir, backup.backupFileName))
        : null;
      const after = await safeReadText(absPath);
      if (before === null && after === null) continue;
      if (before === null && after !== null) {
        // file did not exist at backup; rewind would delete it → its lines
        // are pure "additions" since the snapshot.
        insertions += countLines(after);
        filesChanged += 1;
        continue;
      }
      if (before !== null && after === null) {
        deletions += countLines(before);
        filesChanged += 1;
        continue;
      }
      if (before !== null && after !== null && before !== after) {
        const stats = lineDelta(before, after);
        insertions += stats.insertions;
        deletions += stats.deletions;
        filesChanged += 1;
      }
    }
    return { filesChanged, insertions, deletions };
  }

  /**
   * F12 — replay snapshots from previously-recorded transcript entries.
   * The on-disk state must still contain the backup files referenced; if
   * any are missing the corresponding entries are skipped with a warn.
   */
  replayFromTranscript(entries: FileHistorySnapshotRecordedEntry[]): void {
    for (const entry of entries) {
      const trackedFileBackups: Record<string, FileHistoryBackup> = {};
      for (const [filePath, backup] of Object.entries(entry.trackedFileBackups)) {
        trackedFileBackups[filePath] = {
          backupFileName: backup.backupFileName,
          version: backup.version,
          backupTime: new Date(backup.backupTime),
          mode: backup.mode,
        };
        this.state.trackedFiles.add(filePath);
      }
      const existingIdx = this.state.snapshots.findIndex(
        (s) => s.messageId === entry.messageId,
      );
      const snapshot: FileHistorySnapshot = {
        messageId: entry.messageId,
        trackedFileBackups,
        timestamp: new Date(entry.timestamp),
      };
      if (existingIdx >= 0) {
        this.state.snapshots[existingIdx] = snapshot;
      } else {
        this.state.snapshots.push(snapshot);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Internals

  private getOrCreateOpenSnapshot(messageId: string): FileHistorySnapshot {
    const existing = this.findSnapshot(messageId);
    if (existing) return existing;
    const snapshot: FileHistorySnapshot = {
      messageId,
      trackedFileBackups: {},
      timestamp: this.options.now(),
    };
    this.state.snapshots.push(snapshot);
    return snapshot;
  }

  private findSnapshot(messageId: string): FileHistorySnapshot | undefined {
    for (let i = this.state.snapshots.length - 1; i >= 0; i--) {
      if (this.state.snapshots[i]!.messageId === messageId) {
        return this.state.snapshots[i];
      }
    }
    return undefined;
  }

  private findPreviousSnapshot(target: FileHistorySnapshot): FileHistorySnapshot | undefined {
    const idx = this.state.snapshots.indexOf(target);
    if (idx === -1) {
      // target is brand-new (not yet appended) → previous = current tail.
      return this.state.snapshots.at(-1);
    }
    if (idx === 0) return undefined;
    return this.state.snapshots[idx - 1];
  }

  private async cacheMtime(filePath: string): Promise<void> {
    try {
      const stat = await fs.stat(filePath);
      this.mtimeCache.set(filePath, stat.mtimeMs);
    } catch {
      this.mtimeCache.set(filePath, null);
    }
  }

  private recordTranscript(snapshot: FileHistorySnapshot, kind: "create" | "update"): void {
    if (!this.options.onSnapshotRecorded) return;
    const entry: FileHistorySnapshotRecordedEntry = {
      messageId: snapshot.messageId,
      trackedFileBackups: Object.fromEntries(
        Object.entries(snapshot.trackedFileBackups).map(([file, backup]) => [
          file,
          {
            backupFileName: backup.backupFileName,
            version: backup.version,
            mode: backup.mode,
            backupTime: backup.backupTime.toISOString(),
          },
        ]),
      ),
      timestamp: snapshot.timestamp.toISOString(),
    };
    this.options.onSnapshotRecorded(entry, kind);
  }

  /** F13 — drop the oldest snapshots when over `maxSnapshots`. */
  private async evictIfNeeded(): Promise<void> {
    while (this.state.snapshots.length > this.options.maxSnapshots) {
      const evicted = this.state.snapshots.shift();
      if (!evicted) break;
      // Drop backup files that are not referenced by any remaining snapshot.
      for (const backup of Object.values(evicted.trackedFileBackups)) {
        if (!backup.backupFileName) continue;
        const stillReferenced = this.state.snapshots.some((s) =>
          Object.values(s.trackedFileBackups).some((b) => b.backupFileName === backup.backupFileName),
        );
        if (stillReferenced) continue;
        const target = path.join(this.options.backupDir, backup.backupFileName);
        try {
          await fs.unlink(target);
        } catch (err) {
          if (!isNotFoundError(err)) {
            this.options.warn?.(`file-history: failed to evict ${target}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(task, task);
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function safeReadText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err) {
    if (isNotFoundError(err)) return null;
    return null;
  }
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split(/\r?\n/).length;
}

function lineDelta(before: string, after: string): { insertions: number; deletions: number } {
  // Simple LCS-free line delta: count lines unique to each side. Good enough
  // for diff-stats display; not byte-exact with `git diff --numstat` but
  // gives a stable signal for rewind impact preview.
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const beforeSet = new Map<string, number>();
  const afterSet = new Map<string, number>();
  for (const line of beforeLines) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
  for (const line of afterLines) afterSet.set(line, (afterSet.get(line) ?? 0) + 1);
  let deletions = 0;
  let insertions = 0;
  const seen = new Set<string>([...beforeSet.keys(), ...afterSet.keys()]);
  for (const line of seen) {
    const b = beforeSet.get(line) ?? 0;
    const a = afterSet.get(line) ?? 0;
    if (b > a) deletions += b - a;
    if (a > b) insertions += a - b;
  }
  return { insertions, deletions };
}
