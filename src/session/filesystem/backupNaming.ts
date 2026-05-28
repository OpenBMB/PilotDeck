import { createHash } from "node:crypto";

/**
 * F4 — backup filename derived from `sha256(filePath).slice(0, 16) + '@v' +
 * version`. Hashing the *path* (not the content) means re-edits of the same
 * file produce a stable namespace where each version gets its own file. The
 * 16-hex-char prefix is collision-resistant for project-scale workloads
 * (~10^9 files would still have negligible collision probability).
 */
export function getBackupFileName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

/** Inverse helper: extract the version number from a known backup filename. */
export function parseBackupVersion(backupFileName: string): number | null {
  const match = /@v(\d+)$/.exec(backupFileName);
  if (!match) return null;
  const v = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}
