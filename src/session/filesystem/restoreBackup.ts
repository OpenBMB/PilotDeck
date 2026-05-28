import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileHistoryBackup } from "./types.js";

export type RestoreBackupOptions = {
  filePath: string;
  backup: FileHistoryBackup;
  backupDir: string;
};

export type RestoreBackupResult = {
  /** "restored" — file content + mode restored from backup file. */
  /** "deleted" — null backup observed, file unlinked (F11). */
  /** "missing" — backup file referenced but absent on disk; skipped gracefully. */
  outcome: "restored" | "deleted" | "missing";
};

/**
 * F9 + F10 + F11 — apply a single backup entry:
 *
 *   - `null backupFileName` → unlink the target (it didn't exist at backup
 *     time). Missing target is OK — desired end state is "absent".
 *   - non-null & backup file present → `mkdir -p` parent, `copyFile`, then
 *     `chmod` to preserve the recorded mode.
 *   - non-null & backup file absent (manually deleted, etc.) → return
 *     `missing` so the caller can `warn` rather than throw (F13 graceful).
 */
export async function restoreBackup(
  options: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const { filePath, backup, backupDir } = options;
  if (backup.backupFileName === null) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    return { outcome: "deleted" };
  }

  const backupPath = path.join(backupDir, backup.backupFileName);
  try {
    await fs.access(backupPath);
  } catch (err) {
    if (isNotFoundError(err)) return { outcome: "missing" };
    throw err;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.copyFile(backupPath, filePath);
  if (typeof backup.mode === "number" && process.platform !== "win32") {
    await fs.chmod(filePath, backup.mode & 0o777);
  }
  return { outcome: "restored" };
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}
