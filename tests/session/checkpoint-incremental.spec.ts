import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, WorkspaceCheckpoints, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import type { FileVersion } from "../../src/session/checkpoints/types.js";

async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "checkpoint-incremental-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace"), home = join(base, "home");
  await fs.mkdir(workspace); await fs.mkdir(home);
  const store = await getCheckpointStore(workspace, home);
  // Avoid depending on how long fsync takes to cross the current-ms guard.
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 1000);
  return { workspace, home, store, file: (name: string) => join(workspace, name),
    history: new WorkspaceCheckpoints(workspace, home) };
}

function fileVersion(version: FileVersion) {
  assert.equal(version.kind, "file");
  return version as Extract<FileVersion, { kind: "file" }>;
}

async function prime(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.capture("session", "prime", "before");
  // The first reuse independently verifies newly written backup objects.
  return f.store.capture("session", "prime", "after");
}

async function supportsReuse(t: test.TestContext, file: string) {
  const info = await fs.lstat(file, { bigint: true });
  if (info.ino <= 0n || info.ctimeNs % 1_000_000n === 0n) {
    t.skip("This filesystem uses the conservative full-read fallback.");
    return false;
  }
  return true;
}

test("unchanged captures reuse workspace contents and verified objects across turns", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  if (!await supportsReuse(t, f.file("a.txt"))) return;
  const baseline = await prime(f);
  if (!await supportsReuse(t, join(f.store.directory, "objects", fileVersion(baseline.files["a.txt"]).hash))) return;
  const sourceReads = t.mock.method(f.store, "captureFile");
  const objectReads = t.mock.method(f.store, "readObject");
  const repeated = await f.store.capture("other-session", "other-turn", "before");
  assert.deepEqual(repeated.files, baseline.files);
  assert.equal(sourceReads.mock.callCount(), 0);
  assert.equal(objectReads.mock.callCount(), 0);
  // Mutating a returned manifest must not poison the private version cache.
  fileVersion(repeated.files["a.txt"]).hash = "0".repeat(64);
  assert.deepEqual((await f.store.capture("session", "next", "after")).files, baseline.files);
  // Explicit file backups/conflict checks and restore reads never use that hint.
  await f.store.captureFile("a.txt", false);
  assert.equal(sourceReads.mock.callCount(), 1);
  await f.store.readObject(fileVersion(baseline.files["a.txt"]).hash);
  assert.equal(objectReads.mock.callCount(), 1);
});

test("same-size external edits with restored mtimes, replacement, deletion and creation invalidate reuse", async t => {
  const f = await fixture(t);
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  for (const name of ["edit.txt", "replace.txt", "delete.txt", "stable.txt"]) {
    await fs.writeFile(f.file(name), "AAAA");
    await fs.utimes(f.file(name), fixedTime, fixedTime);
  }
  const before = await prime(f);
  await fs.writeFile(f.file("edit.txt"), "BBBB");
  await fs.utimes(f.file("edit.txt"), fixedTime, fixedTime);
  await fs.writeFile(f.file("replacement"), "CCCC");
  await fs.utimes(f.file("replacement"), fixedTime, fixedTime);
  await fs.rename(f.file("replacement"), f.file("replace.txt"));
  await fs.unlink(f.file("delete.txt"));
  await fs.writeFile(f.file("new.txt"), "new");
  const after = await f.store.capture("session", "edit", "after");
  assert.deepEqual((await f.store.changes(before, after)).map(change => change.path),
    ["delete.txt", "edit.txt", "new.txt", "replace.txt"]);
  assert.equal(fileVersion(after.files["edit.txt"]).hash, createHash("sha256").update("BBBB").digest("hex"));
  assert.equal(fileVersion(after.files["replace.txt"]).hash, createHash("sha256").update("CCCC").digest("hex"));
  assert.equal(after.files["delete.txt"], undefined);
  assert.deepEqual(after.files["stable.txt"], before.files["stable.txt"]);
  await fs.writeFile(f.file("delete.txt"), "recreated");
  assert.equal(fileVersion((await f.store.capture("session", "recreate", "after")).files["delete.txt"]).size, 9);
});

test("an edit during backup validation cannot reuse the earlier source version", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  const baseline = await prime(f);
  const object = join(f.store.directory, "objects", fileVersion(baseline.files["a.txt"]).hash);
  if (!await supportsReuse(t, f.file("a.txt")) || !await supportsReuse(t, object)) return;
  const lstat = fs.lstat;
  let edited = false;
  t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0], options?: { bigint?: boolean }) => {
    const result = await lstat(target, options as { bigint: true });
    if (!edited && String(target) === object) {
      edited = true;
      await fs.writeFile(f.file("a.txt"), "external");
    }
    return result;
  });
  const after = await f.store.capture("session", "racing-edit", "after");
  assert.equal(edited, true);
  assert.equal(fileVersion(after.files["a.txt"]).hash, createHash("sha256").update("external").digest("hex"));
});

test("failed captures evict old hints and aborted preparation releases the workspace", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  await prime(f);
  const resolveFile = f.store.resolveFile.bind(f.store);
  const failure = t.mock.method(f.store, "resolveFile", async (relative: string) => {
    if (relative === "a.txt") throw new Error("File temporarily unavailable");
    return resolveFile(relative);
  });
  assert.equal((await f.store.capture("session", "failed", "after")).files["a.txt"].kind, "unprotected");
  failure.mock.restore();
  const reads = t.mock.method(f.store, "captureFile");
  assert.equal((await f.store.capture("session", "recovered", "after")).files["a.txt"].kind, "file");
  assert.equal(reads.mock.callCount(), 1);
  await assert.rejects(f.history.beginTurn("session", "aborted", [], AbortSignal.abort()), { code: "ABORTED" });
  assert.equal(f.store.busy, false);
  await f.history.beginTurn("session", "next", []);
  assert.deepEqual((await f.history.finishTurn("complete"))!.changes, []);
  assert.equal(f.store.busy, false);
});

test("permission-only changes survive incremental capture, restore and undo", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "same contents");
  await fs.chmod(f.file("a.txt"), 0o644);
  await prime(f);
  await f.history.beginTurn("session", "mode", []);
  await fs.chmod(f.file("a.txt"), 0o755);
  if (((await fs.stat(f.file("a.txt"))).mode & 0o777) !== 0o755) {
    await f.history.finishTurn("incomplete");
    return t.skip("Executable permission changes are unavailable on this filesystem.");
  }
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(change => change.path), ["a.txt"]);
  const operation = await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
  assert.equal((await fs.stat(f.file("a.txt"))).mode & 0o777, 0o644);
  await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
  assert.equal((await fs.stat(f.file("a.txt"))).mode & 0o777, 0o755);
});

test("a cached nested file cannot bypass replaced-parent symlink checks", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.file("nested"));
  await fs.writeFile(f.file("nested/a.txt"), "original");
  await prime(f);
  await fs.rename(f.file("nested"), join(f.home, "outside"));
  await fs.symlink(join(f.home, "outside"), f.file("nested"), process.platform === "win32" ? "junction" : "dir");
  const capture = await f.store.capture("session", "unsafe", "after");
  assert.equal(capture.files["nested"].kind, "unprotected");
  assert.equal(capture.files["nested/a.txt"], undefined);
  await assert.rejects(f.store.captureFile("nested/a.txt"), { code: "UNSAFE_PATH" });
  await fs.unlink(f.file("nested"));
  await fs.rename(join(f.home, "outside"), f.file("nested"));
  assert.equal(fileVersion((await f.store.capture("session", "safe-again", "after")).files["nested/a.txt"]).size, 8);
});

test("deleted backup objects are recreated from source rather than reused as protection", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  const baseline = await prime(f);
  const version = fileVersion(baseline.files["a.txt"]);
  await fs.unlink(join(f.store.directory, "objects", version.hash));
  const capture = await f.store.capture("session", "missing-object", "before");
  assert.deepEqual(capture.files["a.txt"], version);
  assert.equal((await f.store.readObject(version.hash)).toString(), "original");
});

test("same-size backup corruption with a restored mtime is detected before reuse or writes", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  const baseline = await prime(f);
  const object = join(f.store.directory, "objects", fileVersion(baseline.files["a.txt"]).hash);
  const metadata = await fs.stat(object);
  await fs.writeFile(object, "CORRUPT!");
  await fs.utimes(object, metadata.atime, metadata.mtime);
  const capture = await f.store.capture("session", "corrupt", "before");
  assert.equal(capture.files["a.txt"].kind, "unprotected");
  await f.history.beginTurn("session", "cannot-write", []);
  try {
    await assert.rejects(f.history.trackEdit(f.file("a.txt"), "cannot-write"), { code: "CORRUPT_BACKUP" });
    assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "original");
  } finally { await f.history.finishTurn("incomplete"); }
});

test("replacing an object also invalidates its verified identity", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  const baseline = await prime(f);
  const object = join(f.store.directory, "objects", fileVersion(baseline.files["a.txt"]).hash);
  const metadata = await fs.stat(object);
  await fs.writeFile(join(f.home, "replacement"), "CORRUPT!");
  await fs.utimes(join(f.home, "replacement"), metadata.atime, metadata.mtime);
  await fs.rename(join(f.home, "replacement"), object);
  assert.equal((await f.store.capture("session", "replaced-object", "after")).files["a.txt"].kind, "unprotected");
});

test("restore validates cached backup bytes before changing files", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "before");
  const baseline = await prime(f);
  await f.history.beginTurn("session", "edit", []);
  await fs.writeFile(f.file("a.txt"), "after!");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  const plan = await f.store.preview("session", checkpoint.id);
  const original = fileVersion(baseline.files["a.txt"]);
  await fs.writeFile(join(f.store.directory, "objects", original.hash), "broken");
  await assert.rejects(f.store.restore("session", plan.id), { code: "CORRUPT_BACKUP" });
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "after!");
});

test("warmed captures preserve tool and command edits, stale-preview conflicts, restore and undo", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  await fs.writeFile(f.file("stable.txt"), "unchanged");
  await prime(f);
  await f.history.beginTurn("session", "edit", []);
  const finishCommand = await f.history.trackCommand();
  await fs.writeFile(f.file("a.txt"), "shell edit");
  await fs.writeFile(f.file("new.bin"), Buffer.from([0, 1, 2]));
  await f.history.trackEdit(f.file("a.txt"), "edit");
  await fs.writeFile(f.file("a.txt"), "tool edit");
  await f.history.recordEdit(f.file("a.txt"), "edit");
  await finishCommand();
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(change => change.path), ["a.txt", "new.bin"]);
  const plan = await f.store.preview("session", checkpoint.id);
  const restored = await f.store.restore("session", plan.id);
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "original");
  await assert.rejects(fs.readFile(f.file("new.bin")), { code: "ENOENT" });
  await f.store.restore("session", (await f.store.undoPreview("session", restored.id)).id);
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "tool edit");
  assert.deepEqual(await fs.readFile(f.file("new.bin")), Buffer.from([0, 1, 2]));
  const stale = await f.store.preview("session", checkpoint.id);
  await fs.writeFile(f.file("a.txt"), "manual edit");
  await assert.rejects(f.store.restore("session", stale.id), { code: "STALE_PLAN" });
  assert.equal((await f.store.preview("session", checkpoint.id)).files.find(file => file.path === "a.txt")?.status, "conflict");
  assert.equal(await fs.readFile(f.file("stable.txt"), "utf8"), "unchanged");
});

test("pruning invalidates verified objects and a restarted store never trusts process-local hints", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "original");
  const baseline = await prime(f);
  const original = fileVersion(baseline.files["a.txt"]);
  // Unsaved captures have no retained manifest references.
  await f.store.prune();
  await assert.rejects(f.store.readObject(original.hash), { code: "ENOENT" });
  assert.deepEqual((await f.store.capture("session", "after-prune", "before")).files, baseline.files);
  const restarted = new CheckpointStore(f.store.workspace, f.store.directory);
  const reads = t.mock.method(restarted, "captureFile");
  assert.deepEqual((await restarted.capture("session", "restart", "before")).files, baseline.files);
  assert.equal(reads.mock.callCount(), 1);
});

test("warm restore rejects same-size edits with restored mtimes and the next turn uses the restored contents", async t => {
  const f = await fixture(t), fixed = new Date("2020-01-01T00:00:00Z");
  await fs.writeFile(f.file("a.txt"), "AAAA"); await fs.utimes(f.file("a.txt"), fixed, fixed);
  await prime(f);
  await f.history.beginTurn("session", "first", []);
  await fs.writeFile(f.file("a.txt"), "BBBB"); await fs.utimes(f.file("a.txt"), fixed, fixed);
  const first = (await f.history.finishTurn("complete"))!;
  const preview = await f.store.preview("session", first.id);
  await fs.writeFile(f.file("a.txt"), "CCCC"); await fs.utimes(f.file("a.txt"), fixed, fixed);
  await assert.rejects(f.store.restore("session", preview.id), { code: "STALE_PLAN" });
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "CCCC");
  assert.equal((await f.store.preview("session", first.id)).files[0].status, "conflict");
  await fs.writeFile(f.file("a.txt"), "BBBB"); await fs.utimes(f.file("a.txt"), fixed, fixed);
  await f.store.restore("session", (await f.store.preview("session", first.id)).id);
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "AAAA");
  await f.history.beginTurn("session", "after-restore", []);
  await fs.writeFile(f.file("a.txt"), "DDDD");
  const second = (await f.history.finishTurn("complete"))!;
  assert.equal((await f.store.diff("session", second.id, "a.txt")).oldContent, "AAAA");
  const operation = await f.store.restore("session", (await f.store.preview("session", second.id)).id);
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "AAAA");
  await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
  assert.equal(await fs.readFile(f.file("a.txt"), "utf8"), "DDDD");
});

test("independent workspaces and backup homes cannot share a cached file version", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file("a.txt"), "workspace one");
  await prime(f);
  const otherRoot = join(f.home, "other-workspace");
  await fs.mkdir(otherRoot); await fs.writeFile(join(otherRoot, "a.txt"), "workspace two");
  const other = await getCheckpointStore(otherRoot, f.home);
  const alternateHome = await getCheckpointStore(f.workspace, join(f.home, "another-home"));
  for (const store of [other, alternateHome]) {
    const captured = await store.capture("session", "separate", "before");
    const version = fileVersion(captured.files["a.txt"]);
    assert.equal((await store.readObject(version.hash)).toString(), store === other ? "workspace two" : "workspace one");
    assert.notEqual(store.directory, f.store.directory);
  }
});

for (const reason of ["coarse timestamps", "missing identity", "current clock tick"]) {
  test(`${reason} conservatively fall back to content reads`, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.file("a.txt"), "original");
    await prime(f);
    if (reason === "current clock tick") {
      const info = await fs.lstat(f.file("a.txt"), { bigint: true });
      t.mock.method(Date, "now", () => Number(info.ctimeNs / 1_000_000n));
    } else {
      const lstat = fs.lstat;
      t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0], options?: { bigint?: boolean }) => {
        const info = await lstat(target, options as { bigint: true });
        if (String(target) !== join(f.store.workspace, "a.txt") || !options?.bigint) return info;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info,
          reason === "missing identity" ? { ino: 0n } : { ctimeNs: info.ctimeNs / 1_000_000n * 1_000_000n });
      });
    }
    const reads = t.mock.method(f.store, "captureFile");
    await f.store.capture("session", "fallback", "after");
    assert.equal(reads.mock.callCount(), 1);
  });
}

test("cached files still count toward the workspace byte budget", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 27; index++) {
    const handle = await fs.open(f.file(`${String(index).padStart(2, "0")}.bin`), "w");
    try { await handle.truncate(10 * 1024 * 1024); } finally { await handle.close(); }
  }
  const before = await prime(f);
  const after = await f.store.capture("session", "budget", "after");
  assert.deepEqual(after.files, before.files);
  assert.equal(Object.values(after.files).filter(file => file.kind === "file").length, 26);
  assert.equal(Object.values(after.files).filter(file => file.kind === "unprotected").length, 1);
});
