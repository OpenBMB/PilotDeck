import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionMetaStore, SessionMeta } from "./SessionMetaStore.js";
import { sanitizeSessionIdForPath } from "./ProjectSessionStorage.js";

let tmp: string;
let chatDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "meta-test-"));
  chatDir = join(tmp, "chats");
  await import("node:fs/promises").then((fs) => fs.mkdir(chatDir, { recursive: true }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("SessionMetaStore", () => {
  it("load() returns null when no meta file exists", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:abc123" });
    expect(store.metaPath).toBeTruthy();
    const meta = await store.load();
    expect(meta).toBeNull();
  });

  it("load() returns null when the meta file contains invalid JSON", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:abc123" });
    await writeFile(store.metaPath, "{ this is not : valid json,,", "utf8");
    const meta = await store.load();
    expect(meta).toBeNull();
  });

  it("load() returns parsed meta with customTitle only", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:titleonly" });
    const expected: SessionMeta = { customTitle: "My Custom Title" };
    await writeFile(store.metaPath, JSON.stringify(expected), "utf8");
    const meta = await store.load();
    expect(meta).toEqual(expected);
  });

  it("load() returns parsed meta with customTitle and forkedFrom", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:full" });
    const expected: SessionMeta = {
      customTitle: "Forked Session",
      forkedFrom: {
        sessionId: "web:parent",
        entryId: "entry-42",
        forkedAt: "2025-01-15T10:30:00.000Z",
      },
    };
    await writeFile(store.metaPath, JSON.stringify(expected), "utf8");
    const meta = await store.load();
    expect(meta).toEqual(expected);
  });

  it("load() strips out malformed forkedFrom but keeps the rest", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:malformed" });
    // forkedFrom missing entryId, missing forkedAt, and one with a wrong type
    const bad = {
      customTitle: "Still Here",
      forkedFrom: { sessionId: "web:parent" }, // missing entryId + forkedAt
    };
    await writeFile(store.metaPath, JSON.stringify(bad), "utf8");
    const meta = await store.load();
    expect(meta).toEqual({ customTitle: "Still Here" });
    expect(meta?.forkedFrom).toBeUndefined();

    // Also check a case where sessionId is not a string
    const bad2 = {
      customTitle: "Still Here 2",
      forkedFrom: { sessionId: 123, entryId: "e", forkedAt: "f" },
    };
    await writeFile(store.metaPath, JSON.stringify(bad2), "utf8");
    const meta2 = await store.load();
    expect(meta2).toEqual({ customTitle: "Still Here 2" });
  });

  it("save() then load() round-trips the meta", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:roundtrip" });
    const original: SessionMeta = {
      customTitle: "Round Trip",
      forkedFrom: {
        sessionId: "web:src",
        entryId: "src-entry-1",
        forkedAt: "2025-02-01T00:00:00.000Z",
      },
    };
    await store.save(original);
    const loaded = await store.load();
    expect(loaded).toEqual(original);
  });

  it("save() writes to a .tmp file then renames; .tmp does not remain", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:atomic" });
    const tmpPath = `${store.metaPath}.tmp`;
    const meta: SessionMeta = { customTitle: "Atomic Write" };
    await store.save(meta);

    // Final file exists and has the correct content
    const onDisk = JSON.parse(await readFile(store.metaPath, "utf8"));
    expect(onDisk).toEqual(meta);

    // The .tmp file must NOT remain
    await expect(stat(tmpPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remove() deletes the file", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:remove" });
    await store.save({ customTitle: "Doomed" });
    // Sanity check: file exists
    await expect(stat(store.metaPath)).resolves.toBeDefined();

    await store.remove();
    await expect(stat(store.metaPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remove() is idempotent — does not throw if file is already absent", async () => {
    const store = new SessionMetaStore({ chatDir, sessionId: "web:never" });
    // File does not exist; remove() must not throw.
    await expect(store.remove()).resolves.toBeUndefined();

    // Calling remove() a second time must also not throw.
    await expect(store.remove()).resolves.toBeUndefined();
  });

  it("uses <chatDir>/<safeId>.meta.json as the on-disk path", () => {
    const sessionId = "web:s_abc123";
    const store = new SessionMetaStore({ chatDir, sessionId });
    const expectedSafe = sanitizeSessionIdForPath(sessionId);
    expect(store.metaPath).toBe(resolve(chatDir, `${expectedSafe}.meta.json`));
  });

  it("sanitizes a TUI-style sessionId into a flat meta filename", () => {
    const sessionId = "tui:project=/Users/foo:default";
    const store = new SessionMetaStore({ chatDir, sessionId });
    const expectedSafe = sanitizeSessionIdForPath(sessionId);

    // On macOS/Linux the sanitizer only strips `/` and `\`; on Windows it
    // also strips `:`. Either way the raw `/` must be gone so the meta
    // file lives as a single flat filename inside chatDir (not a deep
    // directory tree).
    expect(expectedSafe).not.toContain("/");
    expect(expectedSafe).not.toContain("\\");
    expect(store.metaPath).toBe(resolve(chatDir, `${expectedSafe}.meta.json`));
    // And the resulting path must live directly inside chatDir (single segment).
    expect(store.metaPath.startsWith(resolve(chatDir))).toBe(true);

    // Sanity-check: the leading/trailing dash trimming also applies.
    expect(expectedSafe === expectedSafe.replace(/^-+|-+$/g, "") || expectedSafe === "session").toBe(true);
  });
});
