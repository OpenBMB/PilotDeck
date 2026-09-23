import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayEvent } from "../protocol/types.js";

export type RunRegistryState = "accepted" | "running" | "completed" | "failed" | "aborted" | "interrupted";

export type RunRegistryRecord = {
  projectKey?: string;
  sessionKey: string;
  runId: string;
  ownerPid?: number;
  state: RunRegistryState;
  revision: number;
  lastSeq: number;
  requestMaterial: string;
  acceptedAt: string;
  updatedAt: string;
  result?: GatewayEvent;
};

export type RunRegistryEvent = { seq: number; event: GatewayEvent };

export type RunRegistryAcceptInput = Omit<RunRegistryRecord, "ownerPid" | "state" | "revision" | "lastSeq" | "acceptedAt" | "updatedAt" | "result">;

export type RunRegistryPort = {
  accept(input: RunRegistryAcceptInput): Promise<{ record: RunRegistryRecord; duplicate: boolean }>;
  append(input: { sessionKey: string; runId: string; projectKey?: string; event: GatewayEvent }): Promise<void>;
  get(input: { sessionKey: string; runId: string; projectKey?: string }): Promise<RunRegistryRecord | undefined>;
  events(input: { sessionKey: string; runId: string; projectKey?: string; afterSeq?: number; limit?: number }): Promise<RunRegistryEvent[]>;
  markOrphansInterrupted(): Promise<void>;
};

export class RunRegistryError extends Error {
  constructor(readonly code: "conflict" | "not_found" | "terminal", message: string) {
    super(message);
    this.name = "RunRegistryError";
  }
}

type Snapshot = { schemaVersion: 1; records: RunRegistryRecord[]; events: Record<string, RunRegistryEvent[]> };

const FILE_LOCK_TIMEOUT_MS = 30_000;
const FILE_LOCK_STALE_MS = 60_000;

/**
 * Durable registry backed by an atomically replaced snapshot.
 *
 * The lock and reload on every mutation are intentional: a Gateway restart or
 * a deployment handoff can briefly involve two processes sharing the same
 * persistent volume. In-memory serialization alone would let their snapshots
 * overwrite one another.
 */
export class FileRunRegistry implements RunRegistryPort {
  private readonly records = new Map<string, RunRegistryRecord>();
  private readonly eventMap = new Map<string, RunRegistryEvent[]>();
  private readonly ready: Promise<void>;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly lockPath: string;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
    // Recovery is part of the registry readiness contract. Callers must not
    // observe an accepted/running record before startup has fenced it as
    // interrupted after a Gateway restart.
    this.ready = this.initialize();
  }

  private key(input: { sessionKey: string; runId: string; projectKey?: string }): string {
    return `${input.projectKey ?? ""}\0${input.sessionKey}\0${input.runId}`;
  }

  private ownerIsAlive(ownerPid: number | undefined): boolean {
    if (!Number.isInteger(ownerPid) || ownerPid === undefined || ownerPid <= 0) return false;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async snapshotExists(): Promise<boolean> {
    try {
      await stat(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async refreshFromDisk(): Promise<void> {
    try {
      const snapshot = JSON.parse(await readFile(this.path, "utf8")) as Snapshot;
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records) || !snapshot.events) {
        throw new Error("invalid run registry snapshot");
      }
      this.records.clear();
      this.eventMap.clear();
      for (const record of snapshot.records) this.records.set(this.key(record), record);
      for (const [key, events] of Object.entries(snapshot.events)) this.eventMap.set(key, events);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records.clear();
      this.eventMap.clear();
    }
  }

  private async acquireFileLock(): Promise<FileHandle> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > FILE_LOCK_STALE_MS) {
            const lockContents = await readFile(this.lockPath, "utf8").catch(() => "");
            const ownerPid = Number.parseInt(/"pid"\s*:\s*(\d+)/u.exec(lockContents)?.[1] ?? "", 10);
            let ownerAlive = false;
            if (Number.isInteger(ownerPid) && ownerPid > 0) {
              try {
                process.kill(ownerPid, 0);
                ownerAlive = true;
              } catch (probeError) {
                ownerAlive = (probeError as NodeJS.ErrnoException).code !== "ESRCH";
              }
            }
            if (!ownerAlive) {
              await unlink(this.lockPath).catch(() => undefined);
              continue;
            }
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring run registry lock: ${this.lockPath}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const handle = await this.acquireFileLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async initialize(): Promise<void> {
    // A fresh Gateway has no registry file yet. Avoid creating its parent
    // directory during fire-and-forget startup recovery; test and deployment
    // teardown may remove an unused temporary home immediately after boot.
    if (!(await this.snapshotExists())) return;
    try {
      await this.withFileLock(async () => {
        await this.refreshFromDisk();
        let changed = false;
        for (const record of this.records.values()) {
          if (record.state !== "accepted" && record.state !== "running") continue;
          if (this.ownerIsAlive(record.ownerPid)) continue;
          record.state = "interrupted";
          record.revision += 1;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (changed) await this.persist();
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = {
      schemaVersion: 1,
      records: [...this.records.values()],
      events: Object.fromEntries(this.eventMap.entries()),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, this.path);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.withFileLock(async () => {
        await this.refreshFromDisk();
        return operation();
      });
    } finally {
      release();
    }
  }

  async accept(input: RunRegistryAcceptInput): Promise<{ record: RunRegistryRecord; duplicate: boolean }> {
    await this.ready;
    return this.mutate(async () => {
      const key = this.key(input);
      const existing = this.records.get(key);
      if (existing) {
        if (existing.requestMaterial !== input.requestMaterial) throw new RunRegistryError("conflict", `Run ${input.runId} already exists with different request material.`);
        return { record: structuredClone(existing), duplicate: true };
      }
      const now = new Date().toISOString();
      const record: RunRegistryRecord = {
        ...input,
        ownerPid: process.pid,
        state: "accepted",
        revision: 1,
        lastSeq: 0,
        acceptedAt: now,
        updatedAt: now,
      };
      this.records.set(key, record);
      await this.persist();
      return { record: structuredClone(record), duplicate: false };
    });
  }

  async append(input: { sessionKey: string; runId: string; projectKey?: string; event: GatewayEvent }): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const key = this.key(input);
      const record = this.records.get(key);
      if (!record) throw new RunRegistryError("not_found", `Run ${input.runId} is not registered.`);
      if (record.state === "completed" || record.state === "aborted" || record.state === "interrupted") {
        throw new RunRegistryError("terminal", `Run ${input.runId} is already terminal (${record.state}).`);
      }
      const actualKey = this.key(record);
      const events = this.eventMap.get(actualKey) ?? [];
      const next: RunRegistryEvent = { seq: record.lastSeq + 1, event: structuredClone(input.event) };
      events.push(next);
      this.eventMap.set(actualKey, events);
      record.lastSeq = next.seq;
      record.revision += 1;
      record.updatedAt = new Date().toISOString();
      if (input.event.type === "turn_completed") {
        record.state = input.event.finishReason === "aborted_streaming" ? "aborted" : "completed";
        record.result = structuredClone(input.event);
      } else if (input.event.type === "error") {
        record.state = input.event.code === "result_unknown" ? "interrupted" : "failed";
        record.result = structuredClone(input.event);
      } else if (record.state === "accepted") {
        record.state = "running";
      }
      await this.persist();
    });
  }

  async get(input: { sessionKey: string; runId: string; projectKey?: string }): Promise<RunRegistryRecord | undefined> {
    await this.ready;
    await this.mutationChain;
    await this.refreshFromDisk();
    const record = this.records.get(this.key(input));
    return record ? structuredClone(record) : undefined;
  }

  async events(input: { sessionKey: string; runId: string; projectKey?: string; afterSeq?: number; limit?: number }): Promise<RunRegistryEvent[]> {
    await this.ready;
    await this.mutationChain;
    await this.refreshFromDisk();
    const key = this.key(input);
    if (!this.records.has(key)) return [];
    const afterSeq = input.afterSeq ?? 0;
    const limit = input.limit ?? 500;
    return structuredClone((this.eventMap.get(key) ?? []).filter((entry) => entry.seq > afterSeq).slice(0, limit));
  }

  async markOrphansInterrupted(): Promise<void> {
    await this.ready;
    if (!(await this.snapshotExists())) return;
    try {
      await this.mutate(async () => {
        let changed = false;
        for (const record of this.records.values()) {
          if (record.state === "accepted" || record.state === "running") {
            if (this.ownerIsAlive(record.ownerPid)) continue;
            record.state = "interrupted";
            record.revision += 1;
            record.updatedAt = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) await this.persist();
      });
    } catch (error) {
      // Startup recovery is observational. If a temporary home disappears
      // during Gateway teardown, there is no live registry left to recover.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return;
      throw error;
    }
  }
}
