import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSessionStore,
  InMemorySessionStore,
  SessionStoreError,
  createSessionStoreFromAdapter,
  importSessionToStore,
  forkSession,
  deleteSession,
  listSubagents,
  getSessionMessages,
  getSubagentMessages,
} from "../src/index.js";

test("InMemorySessionStore mirrors, deduplicates and summarizes sessions", async () => {
  const store = new InMemorySessionStore();
  const key = { projectKey: "project", sessionId: "session" };
  await store.append(key, [
    { type: "accepted_input", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z", messages: [{ content: [{ type: "text", text: "first" }] }] },
    { type: "session_metadata", metadata: { title: "Title", tag: "tag" } },
  ]);
  await store.append(key, [{ type: "accepted_input", uuid: "u1", text: "duplicate" }]);
  assert.equal((await store.load(key))?.length, 2);
  assert.deepEqual((await store.listSessions("project"))?.map((entry) => entry.sessionId), ["session"]);
  const summary = (await store.listSessionSummaries("project"))?.[0];
  assert.equal(summary?.data.title, "Title");
  assert.equal(summary?.data.firstPrompt, "first");
});

test("importSessionToStore appends deterministic batches and subpaths", async () => {
  const store = new InMemorySessionStore();
  const entries = Array.from({ length: 5 }, (_, index) => ({ type: "message", uuid: `u${index}` }));
  await importSessionToStore("session", store, entries, { projectKey: "project", subpath: "agent-1", batchSize: 2 });
  assert.equal((await store.load({ projectKey: "project", sessionId: "session", subpath: "agent-1" }))?.length, 5);
  assert.deepEqual(await store.listSubkeys({ projectKey: "project", sessionId: "session" }), ["agent-1"]);
});

test("host persistence adapter backs the SDK event mirror without owning Gateway state", async () => {
  const records = new Map<string, any>();
  const storageKey = (key: { projectKey: string; sessionId: string; subpath?: string }) =>
    `${key.projectKey}\0${key.sessionId}\0${key.subpath ?? ""}`;
  const store = createSessionStoreFromAdapter({
    read: async (key) => structuredClone(records.get(storageKey(key)) ?? null),
    write: async (snapshot) => { records.set(storageKey(snapshot.key), structuredClone(snapshot)); },
    listSessions: async (projectKey) => [...records.values()]
      .filter((snapshot) => snapshot.key.projectKey === projectKey && !snapshot.key.subpath)
      .map((snapshot) => ({ sessionId: snapshot.key.sessionId, mtime: snapshot.mtime })),
    listSubkeys: async (key) => [...records.values()]
      .filter((snapshot) => snapshot.key.projectKey === key.projectKey
        && snapshot.key.sessionId === key.sessionId && snapshot.key.subpath)
      .map((snapshot) => snapshot.key.subpath),
    delete: async (key) => { records.delete(storageKey(key)); },
  });
  const key = { projectKey: "embedded-project", sessionId: "session" };

  await Promise.all([
    store.append(key, [{ type: "sdk_event", uuid: "one", text: "one" }]),
    store.append(key, [{ type: "sdk_event", uuid: "two", text: "two" }]),
  ]);
  await store.append(key, [{ type: "sdk_event", uuid: "one", text: "duplicate" }]);
  await store.append({ ...key, subpath: "agent" }, [{ type: "sdk_event", uuid: "child", text: "child" }]);

  assert.deepEqual((await store.load(key))?.map((entry) => entry.uuid).sort(), ["one", "two"]);
  assert.equal((await store.listSessionSummaries!(key.projectKey))[0]?.data.summaryHint, "two");
  assert.deepEqual(await store.listSubkeys!({ projectKey: key.projectKey, sessionId: key.sessionId }), ["agent"]);
  assert.equal(records.size, 2, "the adapter receives only SDK snapshots, never Gateway transcript artifacts");

  records.set(storageKey(key), { schemaVersion: 1, key, mtime: 1, entries: [{ type: "" }] });
  await assert.rejects(() => store.load(key), (error: unknown) =>
    error instanceof SessionStoreError && error.code === "SESSION_STORE_INVALID");
  await store.delete!(key);
  assert.equal(records.has(storageKey(key)), false);
});

test("FileSessionStore persists a versioned local mirror across SDK instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-store-"));
  try {
    const key = { projectKey: "/workspace/project", sessionId: "session-1" };
    const first = new FileSessionStore({ rootDir: root });
    await first.append(key, [
      { type: "accepted_input", uuid: "entry-1", timestamp: "2026-09-09T00:00:00.000Z", text: "first prompt" },
      { type: "session_metadata", uuid: "entry-2", metadata: { title: "Persisted title" } },
    ]);
    await first.append({ ...key, subpath: "subagent-1" }, [
      { type: "sdk_event", uuid: "child-1", event: { type: "assistant.message", text: "child output" } },
    ]);

    const reloaded = new FileSessionStore({ rootDir: root });
    await reloaded.append(key, [{ type: "accepted_input", uuid: "entry-1", text: "duplicate" }]);
    assert.equal((await reloaded.load(key))?.length, 2);
    assert.deepEqual(await reloaded.listSessions("/workspace/project"), [{ sessionId: "session-1", mtime: (await reloaded.listSessions("/workspace/project"))[0]!.mtime }]);
    assert.deepEqual(await reloaded.listSubkeys(key), ["subagent-1"]);
    assert.equal((await reloaded.listSessionSummaries("/workspace/project"))[0]?.data.title, "Persisted title");
    assert.equal((await reloaded.load({ ...key, subpath: "subagent-1" }))?.[0]?.uuid, "child-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileSessionStore imports versioned snapshots with explicit conflict policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-import-"));
  try {
    const source = new FileSessionStore({ rootDir: join(root, "source") });
    const key = { projectKey: "project", sessionId: "session" };
    await source.append(key, [
      { type: "sdk_event", uuid: "one", text: "one" },
      { type: "sdk_event", uuid: "two", text: "two" },
    ]);
    const snapshot = await source.exportSession(key);
    assert.ok(snapshot);
    assert.equal(snapshot.schemaVersion, 1);

    const target = new FileSessionStore({ rootDir: join(root, "target") });
    assert.deepEqual(await target.importSession(snapshot), {
      mode: "reject",
      imported: 2,
      skipped: 0,
      mtime: (await target.exportSession(key))!.mtime,
    });
    await assert.rejects(() => target.importSession(snapshot), (error: unknown) =>
      error instanceof SessionStoreError && error.code === "SESSION_STORE_CONFLICT");
    assert.deepEqual(await target.importSession(snapshot, { mode: "append" }), {
      mode: "append",
      imported: 0,
      skipped: 2,
      mtime: (await target.exportSession(key))!.mtime,
    });
    assert.deepEqual(await target.importSession({
      ...snapshot,
      entries: [{ type: "sdk_event", uuid: "replacement", text: "replacement" }],
    }, { mode: "replace" }), {
      mode: "replace",
      imported: 1,
      skipped: 0,
      mtime: (await target.exportSession(key))!.mtime,
    });
    assert.deepEqual((await target.load(key))?.map((entry) => entry.uuid), ["replacement"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileSessionStore fails closed for malformed persisted snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-invalid-"));
  try {
    const store = new FileSessionStore({ rootDir: root });
    const key = { projectKey: "project", sessionId: "session" };
    const projectDir = join(root, `project-${Buffer.from(key.projectKey).toString("base64url")}`);
    const sessionDir = join(projectDir, `session-${Buffer.from(key.sessionId).toString("base64url")}`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), "{not json", "utf8");
    await assert.rejects(() => store.load(key), (error: unknown) =>
      error instanceof SessionStoreError && error.code === "SESSION_STORE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore is an append-only mirror; Gateway remains authoritative for transcript, fork and delete", async () => {
  class GatewayWebSocket {
    static requests: Array<{ method: string; params: any }> = [];
    static OPEN = 1;
    readyState = 0;
    private listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string) {
      queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
    }
    addEventListener(name: string, handler: (event: any) => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
    }
    send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") {
        this.emit("message", { data: JSON.stringify({ type: "hello_ok", protocolVersion: "1.1", serverVersion: "test", serverInfo: { mode: "remote" } }) });
        return;
      }
      GatewayWebSocket.requests.push(frame);
      if (frame.method === "read_session_messages") {
        this.respond(frame, {
          messages: [{ type: "assistant.message", text: "from gateway", entryId: "gateway-entry", agentId: "agent-1" }],
        });
        return;
      }
      if (frame.method === "read_subagent_messages") {
        this.respond(frame, { messages: [{ type: "assistant.message", text: "gateway subagent" }] });
        return;
      }
      if (frame.method === "fork_session") {
        this.respond(frame, { newSessionKey: "gateway-fork" });
        return;
      }
      if (frame.method === "delete_session") {
        this.respond(frame, { ok: true });
      }
    }
    close(): void { this.readyState = 3; this.emit("close", {}); }
    private respond(frame: { id: string }, result: unknown): void {
      this.emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result }) });
    }
    private emit(name: string, event: any): void { for (const handler of this.listeners.get(name) ?? []) handler(event); }
  }
  (globalThis as any).WebSocket = GatewayWebSocket;
  const store = new InMemorySessionStore();
  await store.append({ projectKey: "project", sessionId: "s1" }, [
    { type: "sdk_event", uuid: "e1", event: { type: "assistant.message", text: "one" } },
    { type: "sdk_event", uuid: "e2", event: { type: "result" } },
  ]);
  await store.append({ projectKey: "project", sessionId: "s1", subpath: "agent-1" }, [
    { type: "sdk_event", uuid: "a1", event: { type: "assistant.message", text: "sub" } },
  ]);
  const options = { projectKey: "project", sessionStore: store, gatewayUrl: "ws://gateway", authToken: "token" };
  assert.equal((await getSessionMessages("s1", options))[0]?.text, "from gateway");
  assert.deepEqual(await listSubagents("s1", options), ["agent-1"]);
  assert.equal((await getSubagentMessages("s1", "agent-1", options))[0]?.text, "gateway subagent");
  const fork = await forkSession("s1", options);
  assert.equal(fork.sessionId, "gateway-fork");
  assert.equal(await store.load({ projectKey: "project", sessionId: "gateway-fork" }), null);
  await deleteSession("s1", options);
  assert.equal(await store.load({ projectKey: "project", sessionId: "s1" }), null);
  assert.equal(await store.load({ projectKey: "project", sessionId: "s1", subpath: "agent-1" }), null);
  assert.deepEqual(GatewayWebSocket.requests.map((request) => request.method), [
    "read_session_messages",
    "read_session_messages",
    "read_subagent_messages",
    "read_session_messages",
    "fork_session",
    "delete_session",
  ]);
});
