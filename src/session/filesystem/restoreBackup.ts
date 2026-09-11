import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileHistoryBackup, FileHistoryBackupStorage } from "./types.js";

export type RestoreBackupOptions = {
  filePath: string;
  backup: FileHistoryBackup;
  backupDir: string;
  /** Optional host-owned byte store. Omitting it preserves filesystem backup files. */
  backupStorage?: FileHistoryBackupStorage;
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

  const backupBytes = options.backupStorage
    ? await options.backupStorage.read(backup.backupFileName)
    : undefined;
  const backupPath = options.backupStorage ? undefined : path.join(backupDir, backup.backupFileName);
  if (options.backupStorage && !backupBytes) return { outcome: "missing" };
  if (backupPath) {
    try {
      await fs.access(backupPath);
    } catch (err) {
      if (isNotFoundError(err)) return { outcome: "missing" };
      throw err;
    }
  }
  const targetDir = path.dirname(filePath);
  const temporaryPath = path.join(targetDir, `.${path.basename(filePath)}.pilotdeck-rewind-${randomUUID()}`);
  await fs.mkdir(targetDir, { recursive: true });
  try {
    // Copy beside the target so rename is atomic on the same filesystem.
    if (backupBytes) {
      await fs.writeFile(temporaryPath, backupBytes);
    } else if (backupPath) {
      await fs.copyFile(backupPath, temporaryPath);
    }
    if (typeof backup.mode === "number" && process.platform !== "win32") {
      await fs.chmod(temporaryPath, backup.mode & 0o777);
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    // `rename` removes the temporary name on success. On any failed copy or
    // rename, cleanup must not leave a retry-visible partial artifact.
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFoundError(error)) throw error;
    });
  }
  return { outcome: "restored" };
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}
