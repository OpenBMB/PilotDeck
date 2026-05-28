import { promises as fs } from "node:fs";
import path from "node:path";
import { getBackupFileName } from "./backupNaming.js";
import type { FileHistoryBackup } from "./types.js";

export type CreateBackupOptions = {
  filePath: string;
  version: number;
  backupDir: string;
  /** Files larger than this are skipped (returns null backup with `oversize: true`). */
  maxFileBytes?: number;
  now?: () => Date;
};

export type CreateBackupResult = {
  backup: FileHistoryBackup;
  /** Set when the file was skipped because it exceeded `maxFileBytes`. */
  oversize?: boolean;
};

/**
 * F3 — create a session-scoped backup of `filePath`:
 *
 *   1. `stat` the file. ENOENT → return a "null backup" marker (F11). The
 *      file genuinely doesn't exist; rewind will translate this into an
 *      `unlink`.
 *   2. Files exceeding `maxFileBytes` are skipped (returned as null backup
 *      with `oversize: true` so the store can warn — keeps disk usage in
 *      check on big binary blobs).
 *   3. Lazy `mkdir` the backup directory.
 *   4. `copyFile` (async) to `<backupDir>/<sha16(filePath)>@v<version>`.
 *   5. Preserve the original mode via explicit `chmod` (F10).
 */
export async function createBackup(
  options: CreateBackupOptions,
): Promise<CreateBackupResult> {
  const now = options.now ?? (() => new Date());
  let stat;
  try {
    stat = await fs.stat(options.filePath);
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        backup: { backupFileName: null, version: options.version, backupTime: now() },
      };
    }
    throw err;
  }
  if (!stat.isFile()) {
    return {
      backup: { backupFileName: null, version: options.version, backupTime: now() },
    };
  }
  const cap = options.maxFileBytes ?? 10 * 1024 * 1024;
  if (stat.size > cap) {
    return {
      backup: { backupFileName: null, version: options.version, backupTime: now() },
      oversize: true,
    };
  }

  const backupFileName = getBackupFileName(options.filePath, options.version);
  const backupPath = path.join(options.backupDir, backupFileName);
  await fs.mkdir(options.backupDir, { recursive: true });
  await fs.copyFile(options.filePath, backupPath);
  if (process.platform !== "win32") {
    await fs.chmod(backupPath, stat.mode & 0o777);
  }

  return {
    backup: {
      backupFileName,
      version: options.version,
      backupTime: now(),
      mode: stat.mode,
    },
  };
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT",
  );
}
