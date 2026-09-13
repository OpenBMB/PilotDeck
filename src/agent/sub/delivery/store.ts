/**
 * Archival of delivery attempts under
 * `<cwd>/.pilotdeck/deliveries/<subagentId>/attempt-<n>.json`.
 *
 * Guarantees:
 * - The host owns `version` and `delivery_file` in the stored record; a child
 *   record cannot override either.
 * - Writes are atomic (temp file + rename in the same directory), so readers
 *   never observe a partial record and re-saving the same attempt (e.g. to
 *   attach a finished review) is safe.
 * - The persistence boundary is enforced with realpaths: unsafe subagent ids,
 *   symlinked parents escaping the workspace, and archive-style traversal
 *   paths are rejected; payloads are capped at 1 MiB.
 * - No memory/session coupling: plain functions over the filesystem.
 */

import path from "node:path";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/** Hard cap for one stored delivery record. */
export const MAX_DELIVERY_RECORD_BYTES = 1024 * 1024;

/** Safe ids: short, filesystem-friendly, no separators or leading dots. */
const SUBAGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function persistenceError(message: string, cause?: unknown): Error {
  return new Error(`saveDelivery: ${message}`, cause === undefined ? undefined : { cause });
}

export type SaveDeliveryOptions = {
  /** Workspace root; deliveries are stored under `<cwd>/.pilotdeck/deliveries`. */
  cwd: string;
  /** Untrusted subagent identifier; validated against a strict allow-list. */
  subagentId: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Arbitrary JSON record; `version`/`delivery_file` are host-controlled. */
  record: Record<string, unknown>;
};

/**
 * Serializes a record exactly as {@link saveDelivery} persists it, host-owned
 * keys included. Runners use this to measure (and bound) a payload before
 * attempting a save, so an oversized delivery degrades into a persisted,
 * bounded failure receipt instead of a save-time throw. The archive cap
 * itself is unchanged and still enforced by {@link saveDelivery}.
 */
export function serializeDeliveryRecord(record: Record<string, unknown>, deliveryFile: string): string {
  return JSON.stringify({ ...record, version: 1, delivery_file: deliveryFile }, null, 2) ?? "";
}

/**
 * Stores one delivery attempt atomically and returns the absolute file path.
 * Throws (descriptive persistence errors) on invalid ids/records, oversized
 * payloads, symlink escapes, or filesystem failures.
 */
export async function saveDelivery(options: SaveDeliveryOptions): Promise<string> {
  const { cwd, subagentId, attempt, record } = options;

  if (typeof subagentId !== "string" || !SUBAGENT_ID_RE.test(subagentId)) {
    throw persistenceError(
      `unsafe subagentId ${JSON.stringify(String(subagentId))}: expected 1-128 chars of [A-Za-z0-9._-] without leading dot`,
    );
  }
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw persistenceError(`attempt must be a positive integer, got ${String(attempt)}`);
  }
  if (!isPlainObject(record)) {
    throw persistenceError("record must be a plain JSON object");
  }

  const resolvedCwd = path.resolve(cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(resolvedCwd);
  } catch (error) {
    throw persistenceError(`workspace root is not accessible: ${resolvedCwd}`, error);
  }

  // Check each existing parent before creating the next directory. A pre-existing
  // symlink must never cause even a mkdir outside the intended archive.
  let current = realCwd;
  for (const segment of [".pilotdeck", "deliveries", subagentId]) {
    current = path.join(current, segment);
    try { await mkdir(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw persistenceError("could not create delivery directory", error);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw persistenceError("delivery directory is not a regular directory; symlink archive parents are forbidden");
    const actual = await realpath(current);
    if (!isPathWithinRoot(actual, realCwd)) throw persistenceError("delivery directory escapes the workspace");
  }
  const realTargetDir = current;

  const deliveryFile = path.join(realTargetDir, `attempt-${attempt}.json`);
  // Host-owned keys always win; a record can never spoof version/delivery_file.
  let payload: string;
  try {
    payload = serializeDeliveryRecord(record, deliveryFile);
  } catch (error) {
    throw persistenceError("record is not JSON-serializable", error);
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_DELIVERY_RECORD_BYTES) {
    throw persistenceError(`record exceeds the ${MAX_DELIVERY_RECORD_BYTES}-byte storage limit`);
  }

  // Atomic write: temp file in the same directory, then rename over the target
  // (rename over an existing file is atomic on POSIX and Windows).
  const tempFile = path.join(realTargetDir, `attempt-${attempt}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tempFile, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tempFile, deliveryFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw persistenceError(`could not persist delivery record at ${deliveryFile}`, error);
  }
  return deliveryFile;
}
