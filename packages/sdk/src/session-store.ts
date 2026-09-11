import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PilotDeckSessionInfo, PilotDeckMessage } from "./types.js";

export type SessionKey = { projectKey: string; sessionId: string; subpath?: string };
export type SessionStoreEntry = Record<string, unknown> & { type: string; uuid?: string; timestamp?: string };
export type SessionStoreFlush = "batched" | "eager";
export type SessionSummaryEntry = { sessionId: string; mtime: number; data: Record<string, unknown> };
export type SessionStoreSnapshot = {
  schemaVersion: 1;
  key: SessionKey;
  mtime: number;
  entries: SessionStoreEntry[];
};
export type SessionStoreImportMode = "reject" | "append" | "replace";
export type SessionStoreImportResult = {
  mode: SessionStoreImportMode;
  imported: number;
  skipped: number;
  mtime: number;
};

/** A local mirror error; it never represents a Gateway or AgentLoop failure. */
export class SessionStoreError extends Error {
  readonly code: "SESSION_STORE_INVALID" | "SESSION_STORE_CONFLICT";

  constructor(code: SessionStoreError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

export type SessionStore = {
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
  delete?(key: SessionKey): Promise<void>;
};

/**
 * Host-provided persistence for the SDK event mirror. This is intentionally
 * snapshot-shaped so an embedded application can use its own database,
 * secure store, or IPC service without exposing Gateway transcript internals.
 *
 * The adapter owns cross-process concurrency and durability. The SDK serializes
 * concurrent appends made through one returned SessionStore instance.
 */
export type SessionStorePersistenceAdapter = {
  read(key: SessionKey): Promise<SessionStoreSnapshot | null>;
  write(snapshot: SessionStoreSnapshot): Promise<void>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
  delete?(key: SessionKey): Promise<void>;
};

const keyOf = (key: SessionKey) => `${key.projectKey}\0${key.sessionId}\0${key.subpath ?? ""}`;
const sessionPrefix = (projectKey: string, sessionId: string) => `${projectKey}\0${sessionId}\0`;

export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, SessionStoreEntry[]>();
  private readonly mtimes = new Map<string, number>();
  private readonly summaries = new Map<string, SessionSummaryEntry>();
  private lastMtime = 0;

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const value = this.entries.get(keyOf(key));
    return value ? structuredClone(value) : null;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const composite = keyOf(key);
    const current = this.entries.get(composite) ?? [];
    const seen = new Set(current.map((entry) => entry.uuid).filter(Boolean));
    for (const entry of structuredClone(entries)) {
      if (entry.uuid && seen.has(entry.uuid)) continue;
      current.push(entry);
      if (entry.uuid) seen.add(entry.uuid);
    }
    this.entries.set(composite, current);
    const now = Math.max(Date.now(), this.lastMtime + 1);
    this.lastMtime = now;
    this.mtimes.set(composite, now);
    if (!key.subpath) {
      const previous = this.summaries.get(composite);
      this.summaries.set(composite, foldSessionSummary(previous, key, entries, { mtime: now }));
    }
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const prefix = `${projectKey}\0`;
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix) && key.endsWith("\0"))
      .map((key) => ({ sessionId: key.slice(prefix.length, -1), mtime: this.mtimes.get(key) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const prefix = `${projectKey}\0`;
    return structuredClone([...this.summaries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, summary]) => summary)
      .sort((a, b) => b.mtime - a.mtime));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const prefix = sessionPrefix(key.projectKey, key.sessionId);
    return [...this.entries.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && candidate.length > prefix.length)
      .map((candidate) => candidate.slice(prefix.length));
  }

  async delete(key: SessionKey): Promise<void> {
    const composite = keyOf(key);
    this.entries.delete(composite);
    this.mtimes.delete(composite);
    this.summaries.delete(composite);
  }
}

/**
 * Creates a SessionStore over host-owned persistence.
 *
 * It stores only the SDK's append-only event mirror. It never reads, writes,
 * restores, or replaces Gateway transcript/session/checkpoint state.
 */
export function createSessionStoreFromAdapter(adapter: SessionStorePersistenceAdapter): SessionStore {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter requires read() and write().");
  }
  const writes = new Map<string, Promise<void>>();
  const readSnapshot = async (key: SessionKey): Promise<SessionStoreSnapshot | null> => {
    const normalized = normalizeSessionKey(key);
    let value: SessionStoreSnapshot | null;
    try {
      value = await adapter.read(structuredClone(normalized));
    } catch (cause) {
      throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter failed to read a snapshot.", { cause });
    }
    if (value === null) return null;
    const snapshot = validateSnapshot(value);
    if (keyOf(snapshot.key) !== keyOf(normalized)) {
      throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter returned a snapshot for a different key.");
    }
    return snapshot;
  };
  const serialized = async <T>(key: SessionKey, task: () => Promise<T>): Promise<T> => {
    const composite = keyOf(normalizeSessionKey(key));
    const previous = writes.get(composite) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    writes.set(composite, tail);
    void tail.finally(() => {
      if (writes.get(composite) === tail) writes.delete(composite);
    });
    return await result;
  };

  const store: SessionStore = {
    load: async (key) => {
      const snapshot = await readSnapshot(key);
      return snapshot ? structuredClone(snapshot.entries) : null;
    },
    append: async (key, entries) => {
      if (entries.length === 0) return;
      const normalized = normalizeSessionKey(key);
      await serialized(normalized, async () => {
        const current = await readSnapshot(normalized);
        const { entries: merged } = mergeEntries(current?.entries ?? [], entries);
        const snapshot: SessionStoreSnapshot = {
          schemaVersion: 1,
          key: normalized,
          mtime: nextMtime(current?.mtime),
          entries: merged,
        };
        try {
          await adapter.write(structuredClone(snapshot));
        } catch (cause) {
          throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter failed to write a snapshot.", { cause });
        }
      });
    },
  };

  if (adapter.listSessions) {
    store.listSessions = async (projectKey) => {
      if (typeof projectKey !== "string" || !projectKey.trim()) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore projectKey must be a non-empty string.");
      }
      let sessions: Array<{ sessionId: string; mtime: number }>;
      try {
        sessions = await adapter.listSessions!(projectKey);
      } catch (cause) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter failed to list sessions.", { cause });
      }
      if (!Array.isArray(sessions) || sessions.some((session) => !session
        || typeof session.sessionId !== "string" || !session.sessionId.trim()
        || typeof session.mtime !== "number" || !Number.isFinite(session.mtime) || session.mtime < 0)) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter returned an invalid session list.");
      }
      return structuredClone(sessions).sort((left, right) => right.mtime - left.mtime);
    };
    store.listSessionSummaries = async (projectKey) => {
      const summaries = await Promise.all((await store.listSessions!(projectKey)).map(async ({ sessionId, mtime }) => {
        const snapshot = await readSnapshot({ projectKey, sessionId });
        return snapshot ? foldSessionSummary(undefined, snapshot.key, snapshot.entries, { mtime }) : undefined;
      }));
      return summaries
        .filter((summary): summary is SessionSummaryEntry => summary !== undefined)
        .sort((left, right) => right.mtime - left.mtime);
    };
  }
  if (adapter.listSubkeys) {
    store.listSubkeys = async (key) => {
      const normalized = normalizeSessionKey(key);
      let subkeys: string[];
      try {
        subkeys = await adapter.listSubkeys!({ projectKey: normalized.projectKey, sessionId: normalized.sessionId });
      } catch (cause) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter failed to list subkeys.", { cause });
      }
      if (!Array.isArray(subkeys) || subkeys.some((subpath) => typeof subpath !== "string" || !subpath.trim())) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter returned invalid subkeys.");
      }
      return [...new Set(subkeys)].sort((left, right) => left.localeCompare(right));
    };
  }
  if (adapter.delete) {
    store.delete = async (key) => {
      const normalized = normalizeSessionKey(key);
      try {
        await adapter.delete!(structuredClone(normalized));
      } catch (cause) {
        throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore persistence adapter failed to delete a snapshot.", { cause });
      }
    };
  }
  return store;
}

/**
 * Node.js filesystem-backed SessionStore for an SDK event mirror.
 *
 * This store deliberately persists only the SDK-side observation log. Gateway
 * transcript, active run, permission and fork state remain authoritative at
 * the Gateway and are never restored from this directory.
 */
export class FileSessionStore implements SessionStore {
  private readonly rootDir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: { rootDir: string }) {
    if (!options.rootDir?.trim()) {
      throw new SessionStoreError("SESSION_STORE_INVALID", "FileSessionStore requires a non-empty rootDir.");
    }
    this.rootDir = resolve(options.rootDir);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const snapshot = await this.readSnapshot(key);
    return snapshot ? structuredClone(snapshot.entries) : null;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const path = this.pathFor(key);
    await this.serialized(path, async () => {
      const current = await this.readSnapshotAtPath(path, key);
      const existing = current?.entries ?? [];
      const { entries: merged } = mergeEntries(existing, entries);
      const mtime = nextMtime(current?.mtime);
      await this.writeSnapshotAtPath(path, {
        schemaVersion: 1,
        key: normalizeSessionKey(key),
        mtime,
        entries: merged,
      });
    });
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const projectDir = this.projectDir(projectKey);
    const candidates = await listDirectories(projectDir);
    const sessions = await Promise.all(candidates.map(async (candidate) =>
      await this.readSnapshotAtPath(join(projectDir, candidate, "session.json"))));
    return sessions
      .filter((snapshot): snapshot is SessionStoreSnapshot => snapshot !== null && snapshot.key.projectKey === projectKey && !snapshot.key.subpath)
      .map((snapshot) => ({ sessionId: snapshot.key.sessionId, mtime: snapshot.mtime }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const sessions = await this.listSessions(projectKey);
    const summaries = await Promise.all(sessions.map(async ({ sessionId }) => {
      const snapshot = await this.readSnapshot({ projectKey, sessionId });
      return snapshot ? foldSessionSummary(undefined, snapshot.key, snapshot.entries, { mtime: snapshot.mtime }) : undefined;
    }));
    return summaries
      .filter((summary): summary is SessionSummaryEntry => summary !== undefined)
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const directory = join(this.sessionDir(key), "subpaths");
    const files = await listFiles(directory);
    const snapshots = await Promise.all(files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => await this.readSnapshotAtPath(join(directory, file))));
    return snapshots
      .filter((snapshot): snapshot is SessionStoreSnapshot => snapshot !== null
        && snapshot.key.projectKey === key.projectKey
        && snapshot.key.sessionId === key.sessionId
        && typeof snapshot.key.subpath === "string")
      .map((snapshot) => snapshot.key.subpath!)
      .sort((a, b) => a.localeCompare(b));
  }

  async delete(key: SessionKey): Promise<void> {
    const path = this.pathFor(key);
    await this.serialized(path, async () => {
      await unlink(path).catch((error: unknown) => {
        if (isNotFound(error)) return;
        throw error;
      });
    });
  }

  /** Returns a portable, versioned client-mirror snapshot, or null when absent. */
  async exportSession(key: SessionKey): Promise<SessionStoreSnapshot | null> {
    const snapshot = await this.readSnapshot(key);
    return snapshot ? structuredClone(snapshot) : null;
  }

  /**
   * Imports a client-mirror snapshot. `reject` prevents accidental overwrite;
   * `append` applies UUID de-duplication; `replace` changes only this local
   * mirror and never calls the Gateway.
   */
  async importSession(
    snapshot: SessionStoreSnapshot,
    options: { mode?: SessionStoreImportMode } = {},
  ): Promise<SessionStoreImportResult> {
    const incoming = validateSnapshot(snapshot);
    const mode = options.mode ?? "reject";
    const path = this.pathFor(incoming.key);
    return await this.serialized(path, async () => {
      const current = await this.readSnapshotAtPath(path, incoming.key);
      if (mode === "reject" && current?.entries.length) {
        throw new SessionStoreError(
          "SESSION_STORE_CONFLICT",
          `A local SessionStore mirror already exists for ${incoming.key.sessionId}; choose append or replace explicitly.`,
        );
      }
      const base = mode === "replace" ? [] : current?.entries ?? [];
      const { entries, imported, skipped } = mergeEntries(base, incoming.entries);
      const mtime = Math.max(incoming.mtime, nextMtime(current?.mtime));
      await this.writeSnapshotAtPath(path, {
        schemaVersion: 1,
        key: incoming.key,
        mtime,
        entries,
      });
      return { mode, imported, skipped, mtime };
    });
  }

  private async readSnapshot(key: SessionKey): Promise<SessionStoreSnapshot | null> {
    return await this.readSnapshotAtPath(this.pathFor(key), key);
  }

  private async readSnapshotAtPath(path: string, expectedKey?: SessionKey): Promise<SessionStoreSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new SessionStoreError("SESSION_STORE_INVALID", `Unable to read SessionStore mirror at ${path}.`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SessionStoreError("SESSION_STORE_INVALID", `SessionStore mirror at ${path} is not valid JSON.`, { cause: error });
    }
    const snapshot = validateSnapshot(parsed);
    if (expectedKey && keyOf(snapshot.key) !== keyOf(normalizeSessionKey(expectedKey))) {
      throw new SessionStoreError("SESSION_STORE_INVALID", `SessionStore mirror at ${path} does not match its requested key.`);
    }
    return snapshot;
  }

  private async writeSnapshotAtPath(path: string, snapshot: SessionStoreSnapshot): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw new SessionStoreError("SESSION_STORE_INVALID", `Unable to write SessionStore mirror at ${path}.`, { cause: error });
    }
  }

  private projectDir(projectKey: string): string {
    const normalized = normalizeSessionKey({ projectKey, sessionId: "placeholder" });
    return join(this.rootDir, `project-${encodePathPart(normalized.projectKey)}`);
  }

  private sessionDir(key: { projectKey: string; sessionId: string }): string {
    const normalized = normalizeSessionKey(key);
    return join(this.projectDir(normalized.projectKey), `session-${encodePathPart(normalized.sessionId)}`);
  }

  private pathFor(key: SessionKey): string {
    const normalized = normalizeSessionKey(key);
    const sessionDir = this.sessionDir(normalized);
    return normalized.subpath
      ? join(sessionDir, "subpaths", `${encodePathPart(normalized.subpath)}.json`)
      : join(sessionDir, "session.json");
  }

  private async serialized<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(path) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.writes.set(path, tail);
    void tail.finally(() => {
      if (this.writes.get(path) === tail) this.writes.delete(path);
    });
    return await result;
  }
}

export function foldSessionSummary(
  previous: SessionSummaryEntry | undefined,
  key: SessionKey,
  entries: SessionStoreEntry[],
  options: { mtime?: number } = {},
): SessionSummaryEntry {
  const data = { ...(previous?.data ?? {}) };
  for (const entry of entries) {
    if (data.createdAt === undefined && typeof entry.timestamp === "string") data.createdAt = entry.timestamp;
    if (data.cwd === undefined && typeof entry.cwd === "string") data.cwd = entry.cwd;
    if (entry.type === "session_metadata") {
      const metadata = asRecord(entry.metadata);
      for (const field of ["title", "aiTitle", "tag", "firstPrompt", "lastPrompt", "gitBranch"] as const) {
        if (metadata[field] !== undefined) data[field] = metadata[field];
      }
    }
    const text = extractText(entry);
    if (text) {
      if (data.firstPrompt === undefined) data.firstPrompt = text;
      data.lastPrompt = text;
      data.summaryHint = text;
    }
  }
  return { sessionId: key.sessionId, mtime: options.mtime ?? previous?.mtime ?? 0, data };
}

export async function importSessionToStore(
  sessionId: string,
  store: SessionStore,
  entries: SessionStoreEntry[],
  options: { projectKey: string; subpath?: string; batchSize?: number },
): Promise<void> {
  const size = Math.max(1, Math.floor(options.batchSize ?? 500));
  const key: SessionKey = { projectKey: options.projectKey, sessionId, subpath: options.subpath };
  for (let offset = 0; offset < entries.length; offset += size) {
    await store.append(key, entries.slice(offset, offset + size));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractText(entry: SessionStoreEntry): string | undefined {
  if (typeof entry.text === "string") return entry.text;
  const message = entry.message as PilotDeckMessage | undefined;
  if (message && typeof message.text === "string") return message.text;
  const messages = Array.isArray(entry.messages) ? entry.messages : [];
  for (const item of messages) {
    const record = asRecord(item);
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content.map((block) => asRecord(block).text).find((value): value is string => typeof value === "string");
    if (text) return text;
  }
  return undefined;
}

export function summaryToSessionInfo(summary: SessionSummaryEntry): PilotDeckSessionInfo {
  return { sessionId: summary.sessionId, sessionKey: summary.sessionId, lastModified: summary.mtime, ...summary.data };
}

function normalizeSessionKey(key: SessionKey): SessionKey {
  if (!key || typeof key.projectKey !== "string" || !key.projectKey.trim()) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore projectKey must be a non-empty string.");
  }
  if (typeof key.sessionId !== "string" || !key.sessionId.trim()) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore sessionId must be a non-empty string.");
  }
  if (key.subpath !== undefined && (typeof key.subpath !== "string" || !key.subpath.trim())) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore subpath must be a non-empty string when provided.");
  }
  return {
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath !== undefined ? { subpath: key.subpath } : {}),
  };
}

function validateSnapshot(value: unknown): SessionStoreSnapshot {
  if (!value || typeof value !== "object") {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore snapshot must be an object.");
  }
  const record = value as Partial<SessionStoreSnapshot>;
  if (record.schemaVersion !== 1) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore snapshot has an unsupported schemaVersion.");
  }
  const key = normalizeSessionKey(record.key as SessionKey);
  const mtime = record.mtime;
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime < 0) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore snapshot mtime must be a non-negative finite number.");
  }
  if (!Array.isArray(record.entries) || record.entries.some((entry) => !isSessionStoreEntry(entry))) {
    throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore snapshot entries must be typed entry objects.");
  }
  return {
    schemaVersion: 1,
    key,
    mtime,
    entries: structuredClone(record.entries),
  };
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return !!value
    && typeof value === "object"
    && typeof (value as { type?: unknown }).type === "string"
    && (value as { type: string }).type.trim().length > 0;
}

function mergeEntries(existing: SessionStoreEntry[], incoming: SessionStoreEntry[]): {
  entries: SessionStoreEntry[];
  imported: number;
  skipped: number;
} {
  const entries = structuredClone(existing);
  const seen = new Set(entries.map((entry) => entry.uuid).filter((uuid): uuid is string => typeof uuid === "string"));
  let imported = 0;
  let skipped = 0;
  for (const entry of incoming) {
    if (!isSessionStoreEntry(entry)) {
      throw new SessionStoreError("SESSION_STORE_INVALID", "SessionStore entries must contain a non-empty type.");
    }
    if (entry.uuid && seen.has(entry.uuid)) {
      skipped += 1;
      continue;
    }
    entries.push(structuredClone(entry));
    imported += 1;
    if (entry.uuid) seen.add(entry.uuid);
  }
  return { entries, imported, skipped };
}

function nextMtime(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}

function encodePathPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new SessionStoreError("SESSION_STORE_INVALID", `Unable to list SessionStore directory ${path}.`, { cause: error });
  }
}

async function listFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new SessionStoreError("SESSION_STORE_INVALID", `Unable to list SessionStore directory ${path}.`, { cause: error });
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
