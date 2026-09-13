import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { GatewayUserDialogRequestEvent } from "../protocol/types.js";
import type {
  GatewayStoredUserDialog,
  GatewayStoredUserDialogAnswer,
  GatewayStoredUserDialogLeaseClaim,
  GatewayStoredUserDialogOwnerClaim,
  GatewayStoredUserDialogResult,
  GatewayUserDialogStore,
  GatewayUserDialogStoreKey,
} from "./GatewayUserDialogStore.js";

type StoredLease = {
  leaseId: string;
  expiresAt: string;
};

type StoredOwner = {
  ownerId: string;
  expiresAt: string;
};

type StoredDialog = GatewayStoredUserDialog & {
  lease?: StoredLease;
  owner?: StoredOwner;
  answer?: GatewayStoredUserDialogAnswer;
};

type StoreRecord = {
  version: 1;
  dialogs: StoredDialog[];
};

export type FileGatewayUserDialogStoreOptions = {
  /** Directory owned by the embedding host for durable pending dialog state. */
  directory: string;
  /** Injectable clock for lease-expiry tests. */
  now?: () => Date;
  /** Injectable source for opaque renderer lease identifiers. */
  uuid?: () => string;
  /** Maximum time an operation waits for another local Gateway process. */
  lockTimeoutMs?: number;
  /** Delay between attempts to acquire a session-specific file lock. */
  lockRetryMs?: number;
  /** Age after which an abandoned lock from a crashed process is reclaimed. */
  staleLockMs?: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_STALE_LOCK_MS = 30_000;
const KEY_PATH_SEGMENT_BYTES = 120;

/**
 * Durable local-filesystem implementation of the complete host dialog-store
 * protocol. It is intended for an embedding host that runs more than one
 * Gateway process on a shared local filesystem.
 *
 * Every state-changing operation is serialized by an atomic per-session lock
 * file, and record writes use a sibling temporary file plus rename. The store
 * remains opt-in: passing no instance to createLocalGateway preserves the
 * historical Gateway journal and in-process renderer behavior.
 */
export class FileGatewayUserDialogStore implements GatewayUserDialogStore {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLockMs: number;

  constructor(options: FileGatewayUserDialogStoreOptions) {
    if (!options.directory.trim()) throw new TypeError("FileGatewayUserDialogStore directory is required.");
    this.directory = resolve(options.directory);
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
    this.staleLockMs = positiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS, "staleLockMs");
  }

  async put(key: GatewayUserDialogStoreKey, dialog: GatewayStoredUserDialog): Promise<void> {
    const path = this.recordPath(key);
    await this.withLock(path, async () => {
      const record = await this.read(path);
      const next = cloneDialog(dialog);
      const index = record.dialogs.findIndex((candidate) => candidate.request.requestId === next.request.requestId);
      if (index < 0) {
        record.dialogs.push(next);
      } else {
        // A duplicate registration of the same request must not lose a
        // renderer lease or a concurrently submitted answer.
        const existing = record.dialogs[index]!;
        record.dialogs[index] = {
          ...next,
          ...(existing.lease ? { lease: cloneLease(existing.lease) } : {}),
          ...(existing.owner ? { owner: cloneOwner(existing.owner) } : {}),
          ...(existing.answer ? { answer: cloneAnswer(existing.answer) } : {}),
        };
      }
      await this.write(path, record);
    });
  }

  async list(key: GatewayUserDialogStoreKey): Promise<readonly GatewayStoredUserDialog[]> {
    const record = await this.read(this.recordPath(key));
    return record.dialogs.map((dialog) => cloneDialog(dialog));
  }

  async remove(key: GatewayUserDialogStoreKey, requestId: string): Promise<void> {
    const path = this.recordPath(key);
    await this.withLock(path, async () => {
      const record = await this.read(path);
      const dialogs = record.dialogs.filter((dialog) => dialog.request.requestId !== requestId);
      if (dialogs.length === record.dialogs.length) return;
      if (dialogs.length === 0) {
        await rm(path, { force: true });
        return;
      }
      await this.write(path, { version: 1, dialogs });
    });
  }

  async clear(key: GatewayUserDialogStoreKey): Promise<void> {
    const path = this.recordPath(key);
    await this.withLock(path, async () => {
      await rm(path, { force: true });
    });
  }

  async listLive(key: GatewayUserDialogStoreKey): Promise<readonly GatewayStoredUserDialog[]> {
    const record = await this.read(this.recordPath(key));
    return record.dialogs
      .filter((dialog) => this.activeOwner(dialog) !== undefined)
      .map((dialog) => cloneDialog(dialog));
  }

  async claimLive(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ttlMs: number; leaseId?: string },
  ): Promise<GatewayStoredUserDialogLeaseClaim> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return { claimed: false, reason: "not_pending" };

      const existing = this.activeLease(dialog);
      if (existing && existing.leaseId !== input.leaseId) {
        return { claimed: false, reason: "claimed", expiresAt: existing.expiresAt };
      }

      const ttlMs = positiveInteger(input.ttlMs, undefined, "ttlMs");
      const lease: StoredLease = {
        leaseId: existing?.leaseId ?? this.uuid(),
        expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
      };
      dialog.lease = lease;
      await this.write(path, record);
      return { claimed: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
    });
  }

  async releaseLive(key: GatewayUserDialogStoreKey, input: { requestId: string; leaseId: string }): Promise<boolean> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return false;
      const active = this.activeLease(dialog);
      if (!active || active.leaseId !== input.leaseId) {
        if (!active && dialog.lease === undefined) await this.write(path, record);
        return false;
      }
      delete dialog.lease;
      await this.write(path, record);
      return true;
    });
  }

  async submitLiveAnswer(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; leaseId?: string; result: GatewayStoredUserDialogResult },
  ): Promise<boolean> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return false;
      const active = this.activeLease(dialog);
      if (active && active.leaseId !== input.leaseId) return false;
      dialog.answer = {
        requestId: input.requestId,
        result: cloneResult(input.result),
        submittedAt: this.now().toISOString(),
      };
      await this.write(path, record);
      return true;
    });
  }

  async takeLiveAnswer(key: GatewayUserDialogStoreKey, requestId: string): Promise<GatewayStoredUserDialogAnswer | undefined> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === requestId);
      if (!dialog?.answer) return undefined;
      const answer = cloneAnswer(dialog.answer);
      delete dialog.answer;
      await this.write(path, record);
      return answer;
    });
  }

  async claimLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string; ttlMs: number },
  ): Promise<GatewayStoredUserDialogOwnerClaim> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return { owned: false, reason: "not_pending" };
      const existing = this.activeOwner(dialog);
      if (existing && existing.ownerId !== input.ownerId) {
        return { owned: false, reason: "owned", expiresAt: existing.expiresAt };
      }
      const owner: StoredOwner = {
        ownerId: input.ownerId,
        expiresAt: new Date(this.now().getTime() + positiveInteger(input.ttlMs, undefined, "ttlMs")).toISOString(),
      };
      dialog.owner = owner;
      await this.write(path, record);
      return { owned: true, ownerId: owner.ownerId, expiresAt: owner.expiresAt };
    });
  }

  async renewLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string; ttlMs: number },
  ): Promise<boolean> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return false;
      const owner = this.activeOwner(dialog);
      if (!owner || owner.ownerId !== input.ownerId) {
        if (!owner && dialog.owner === undefined) await this.write(path, record);
        return false;
      }
      owner.expiresAt = new Date(this.now().getTime() + positiveInteger(input.ttlMs, undefined, "ttlMs")).toISOString();
      await this.write(path, record);
      return true;
    });
  }

  async releaseLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string },
  ): Promise<boolean> {
    const path = this.recordPath(key);
    return this.withLock(path, async () => {
      const record = await this.read(path);
      const dialog = record.dialogs.find((candidate) => candidate.request.requestId === input.requestId);
      if (!dialog) return false;
      const owner = this.activeOwner(dialog);
      if (!owner || owner.ownerId !== input.ownerId) {
        if (!owner && dialog.owner === undefined) await this.write(path, record);
        return false;
      }
      delete dialog.owner;
      await this.write(path, record);
      return true;
    });
  }

  private recordPath(key: GatewayUserDialogStoreKey): string {
    if (!key.projectRoot || !key.pilotHome || !key.sessionId) {
      throw new TypeError("GatewayUserDialogStoreKey requires projectRoot, pilotHome, and sessionId.");
    }
    const encoded = Buffer.from(JSON.stringify([key.projectRoot, key.pilotHome, key.sessionId]), "utf8").toString("base64url");
    const segments = encoded.match(new RegExp(`.{1,${KEY_PATH_SEGMENT_BYTES}}`, "g"));
    if (!segments?.length) throw new Error("Unable to encode GatewayUserDialogStoreKey.");
    return join(this.directory, ...segments, "dialogs.json");
  }

  private async withLock<Value>(path: string, operation: () => Promise<Value>): Promise<Value> {
    const lockPath = `${path}.lock`;
    await this.acquireLock(lockPath);
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async acquireLock(lockPath: string): Promise<void> {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadlineMs = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${this.uuid()}\n`, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      await this.reclaimStaleLock(lockPath);
      if (Date.now() >= deadlineMs) {
        throw new Error(`Timed out waiting for Gateway user-dialog store lock ${lockPath}.`);
      }
      await delay(this.lockRetryMs);
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<void> {
    try {
      const details = await stat(lockPath);
      if (Date.now() - details.mtimeMs < this.staleLockMs) return;
      // The lock owner only holds this file around a local read-modify-write
      // operation. A sufficiently old file is from a crashed process, not a
      // renderer lease; renderer ownership lives in the durable record.
      await rm(lockPath, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async read(path: string): Promise<StoreRecord> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isStoreRecord(parsed)) throw new Error("invalid store record");
      return cloneRecord(parsed);
    } catch (error) {
      if (isMissing(error)) return { version: 1, dialogs: [] };
      throw new Error(`Unable to read Gateway user-dialog store ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async write(path: string, record: StoreRecord): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.${basename(path)}.${this.uuid()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private activeLease(dialog: StoredDialog): StoredLease | undefined {
    const lease = dialog.lease;
    if (!lease) return undefined;
    if (Date.parse(lease.expiresAt) > this.now().getTime()) return lease;
    delete dialog.lease;
    return undefined;
  }

  private activeOwner(dialog: StoredDialog): StoredOwner | undefined {
    const owner = dialog.owner;
    if (!owner) return undefined;
    if (Date.parse(owner.expiresAt) > this.now().getTime()) return owner;
    delete dialog.owner;
    return undefined;
  }
}

function cloneRecord(record: StoreRecord): StoreRecord {
  return {
    version: 1,
    dialogs: record.dialogs.map((dialog) => ({
      ...cloneDialog(dialog),
      ...(dialog.lease ? { lease: cloneLease(dialog.lease) } : {}),
      ...(dialog.owner ? { owner: cloneOwner(dialog.owner) } : {}),
      ...(dialog.answer ? { answer: cloneAnswer(dialog.answer) } : {}),
    })),
  };
}

function cloneDialog(dialog: GatewayStoredUserDialog): GatewayStoredUserDialog {
  return {
    request: structuredClone(dialog.request),
    createdAt: dialog.createdAt,
  };
}

function cloneLease(lease: StoredLease): StoredLease {
  return { leaseId: lease.leaseId, expiresAt: lease.expiresAt };
}

function cloneOwner(owner: StoredOwner): StoredOwner {
  return { ownerId: owner.ownerId, expiresAt: owner.expiresAt };
}

function cloneAnswer(answer: GatewayStoredUserDialogAnswer): GatewayStoredUserDialogAnswer {
  return {
    requestId: answer.requestId,
    result: cloneResult(answer.result),
    submittedAt: answer.submittedAt,
  };
}

function cloneResult(result: GatewayStoredUserDialogResult): GatewayStoredUserDialogResult {
  return result.behavior === "answered"
    ? { behavior: "answered", value: structuredClone(result.value) }
    : { behavior: "cancelled", ...(result.reason ? { reason: result.reason } : {}) };
}

function isStoreRecord(value: unknown): value is StoreRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoreRecord>;
  return record.version === 1
    && Array.isArray(record.dialogs)
    && record.dialogs.every(isStoredDialog)
    && new Set(record.dialogs.map((dialog) => dialog.request.requestId)).size === record.dialogs.length;
}

function isStoredDialog(value: unknown): value is StoredDialog {
  if (!value || typeof value !== "object") return false;
  const dialog = value as Partial<StoredDialog>;
  return isRequest(dialog.request)
    && typeof dialog.createdAt === "string"
    && (dialog.lease === undefined || isLease(dialog.lease))
    && (dialog.owner === undefined || isOwner(dialog.owner))
    && (dialog.answer === undefined || isAnswer(dialog.answer, dialog.request.requestId));
}

function isRequest(value: unknown): value is GatewayUserDialogRequestEvent {
  return Boolean(value && typeof value === "object"
    && (value as { type?: unknown }).type === "user_dialog_request"
    && typeof (value as { requestId?: unknown }).requestId === "string"
    && typeof (value as { dialogKind?: unknown }).dialogKind === "string");
}

function isLease(value: unknown): value is StoredLease {
  return Boolean(value && typeof value === "object"
    && typeof (value as { leaseId?: unknown }).leaseId === "string"
    && typeof (value as { expiresAt?: unknown }).expiresAt === "string"
    && Number.isFinite(Date.parse((value as { expiresAt: string }).expiresAt)));
}

function isOwner(value: unknown): value is StoredOwner {
  return Boolean(value && typeof value === "object"
    && typeof (value as { ownerId?: unknown }).ownerId === "string"
    && typeof (value as { expiresAt?: unknown }).expiresAt === "string"
    && Number.isFinite(Date.parse((value as { expiresAt: string }).expiresAt)));
}

function isAnswer(value: unknown, requestId: string): value is GatewayStoredUserDialogAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<GatewayStoredUserDialogAnswer>;
  if (answer.requestId !== requestId || typeof answer.submittedAt !== "string" || !answer.result) return false;
  const result = answer.result;
  return result.behavior === "answered"
    || (result.behavior === "cancelled" && (result.reason === undefined || typeof result.reason === "string"));
}

function positiveInteger(value: number | undefined, fallback: number | undefined, name: string): number {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST");
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}
