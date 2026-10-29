import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceCheckpoints, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { acquireWorkspaceOperation } from "../../src/session/checkpoints/WorkspaceCoordinator.js";
import { runWorkspaceFileOperation } from "../../src/session/checkpoints/workspaceFileOperation.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "pilotdeck-shared-")), workspace = join(base, "project"), home = join(base, "home");
  await mkdir(workspace); await mkdir(home); await writeFile(join(workspace, "shared.txt"), "base");
  const histories: WorkspaceCheckpoints[] = [];
  t.after(async () => { for (const history of histories) await history.finishTurn("incomplete"); await rm(base, { recursive: true, force: true }); });
  const session = async (id: string) => {
    const history = new WorkspaceCheckpoints(workspace, home); histories.push(history);
    await history.beginTurn(id, `turn-${id}`, []);
    const context: PilotDeckToolRuntimeContext = { cwd: workspace, env: process.env, sessionId: id, turnId: `turn-${id}`, fileHistory: history,
      readFileState: new Map(), writeSnapshots: new Map(), permissionMode: "bypassPermissions",
      permissionContext: { mode: "bypassPermissions", cwd: workspace, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } } };
    return { history, context,
      read: (file_path = "shared.txt") => createReadFileTool().execute({ file_path }, context),
      write: (content: string, file_path = "shared.txt") => createWriteFileTool().execute({ file_path, content }, context) };
  };
  return { workspace, home, session, store: await getCheckpointStore(workspace, home) };
}

test("a second turn starts and finishes while the first holds a command lease", async t => {
  const f = await fixture(t), a = await f.session("A"), entered = deferred(), end = deferred();
  const command = a.history.runCommand(async () => { entered.resolve(); await end.promise; });
  await entered.promise;
  try {
    const b = await f.session("B");
    assert.deepEqual((await b.history.finishTurn("complete"))!.changes, []);
    assert.equal(f.store.busy, true);
  } finally { end.resolve(); await command; }
});

test("same-file writers based on one read cannot both overwrite; disjoint files remain parallel", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  await Promise.all([a.read(), b.read()]);
  const result = await Promise.allSettled([a.write("from A"), b.write("from B")]);
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
  const failure = result.find(item => item.status === "rejected") as PromiseRejectedResult;
  assert.match(failure.reason.message, /changed since the last read/);
  const entered = deferred(), end = deferred();
  const holding = a.history.runEdit(join(f.workspace, "shared.txt"), async () => { entered.resolve(); await end.promise; });
  await entered.promise;
  try { await b.write("independent", "other.txt"); assert.equal(await readFile(join(f.workspace, "other.txt"), "utf8"), "independent"); }
  finally { end.resolve(); await holding; }
});

test("undo uses the operation preimage, including another session's edit made after turn start", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  await b.read(); await b.write("B's work");
  const bCheckpoint = (await b.history.finishTurn("complete"))!;
  await a.read(); await a.write("A on B");
  const aCheckpoint = (await a.history.finishTurn("complete"))!;
  assert.equal((await f.store.diff("A", aCheckpoint.id, "shared.txt")).oldContent, "B's work");
  assert.equal((await f.store.preview("B", bCheckpoint.id)).files[0].status, "conflict");
  const restored = await f.store.restore("A", (await f.store.preview("A", aCheckpoint.id)).id);
  assert.equal(await readFile(join(f.workspace, "shared.txt"), "utf8"), "B's work");
  await f.store.restore("A", (await f.store.undoPreview("A", restored.id)).id);
  assert.equal(await readFile(join(f.workspace, "shared.txt"), "utf8"), "A on B");
});

test("A-B-A edits are separate owned segments and cannot roll back B's work", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  await a.read(); await a.write("A1");
  await b.read(); await b.write("B1");
  await a.read(); await a.write("A2");
  const checkpoint = (await a.history.finishTurn("complete"))!;
  const diff = await f.store.diff("A", checkpoint.id, "shared.txt");
  assert.deepEqual(diff.segments!.map(segment => [segment.oldContent, segment.newContent]), [["base", "A1"], ["B1", "A2"]]);
  assert.equal(diff.oldContent, "B1");
  assert.equal((await f.store.preview("A", checkpoint.id)).files[0].status, "unprotected");
  assert.equal(await readFile(join(f.workspace, "shared.txt"), "utf8"), "A2");
});

test("a queued cancellation neither waits for the owner nor executes a late write", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B"), entered = deferred(), end = deferred();
  const command = a.history.runCommand(async () => { entered.resolve(); await end.promise; });
  await entered.promise;
  const abort = new AbortController(); let executed = false;
  const pending = b.history.runEdit(join(f.workspace, "shared.txt"), async () => { executed = true; }, abort.signal);
  abort.abort();
  try { await assert.rejects(pending, { code: "ABORTED" }); assert.equal(executed, false); }
  finally { end.resolve(); await command; }
  assert.equal(executed, false); assert.equal(f.store.busy, false);
});

test("nested file tools can complete even after a conflicting independent writer queues", async t => {
  const f = await fixture(t), a = await f.session("A");
  let queued!: Promise<() => void>;
  await a.history.runCommand(async () => {
    queued = acquireWorkspaceOperation(join(f.workspace, "shared.txt"), { kind: "file", owner: {} });
    await a.read(); await a.write("nested");
  });
  (await queued)(); assert.equal(f.store.busy, false);
});

test("Web saves share conflict protection and another writer returning identical bytes still blocks undo", async t => {
  const f = await fixture(t), a = await f.session("A");
  await a.read(); await a.write("A");
  const checkpoint = (await a.history.finishTurn("complete"))!;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  await assert.rejects(runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "shared.txt", content: "stale", expectedHash: hash("base") }), { code: "FILE_CHANGED" });
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "shared.txt", content: "B", expectedHash: hash("A") });
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "shared.txt", content: "A", expectedHash: hash("B") });
  assert.equal((await f.store.preview("A", checkpoint.id)).files[0].status, "conflict");
});

test("restoring one file preserves another session's file and a stale preview changes nothing", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  await a.write("A", "a.txt"); await b.write("B", "b.txt");
  const checkpoint = (await a.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(change => change.path), ["a.txt"]);
  const plan = await f.store.preview("A", checkpoint.id);
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "a.txt", content: "user" });
  await assert.rejects(f.store.restore("A", plan.id), { code: "STALE_PLAN" });
  assert.equal(await readFile(join(f.workspace, "a.txt"), "utf8"), "user");
  assert.equal(await readFile(join(f.workspace, "b.txt"), "utf8"), "B");
});

test("branch invalidation rejects stale tool reads and restore previews even when bytes stay identical", async t => {
  const f = await fixture(t), a = await f.session("A"), b = await f.session("B");
  await a.read(); await a.write("A"); await b.read();
  const checkpoint = (await a.history.finishTurn("complete"))!;
  const plan = await f.store.preview("A", checkpoint.id);
  await f.store.invalidateWorkspace();
  await assert.rejects(b.write("stale branch"), /changed since the last read/);
  await b.read(); await b.write("current branch");
  await assert.rejects(f.store.restore("A", plan.id), { code: "STALE_PLAN" });
  assert.equal((await f.store.preview("A", checkpoint.id)).files[0].status, "conflict");
});

test("an upload cancellation arriving before publication is registered cannot perform a late mutation", async t => {
  const f = await fixture(t), requestId = randomUUID();
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "create", path: "cancelled.txt", requestId, cancel: true });
  await assert.rejects(runWorkspaceFileOperation(f.workspace, f.home, { operation: "create", path: "cancelled.txt", requestId }), { code: "ABORTED" });
  await assert.rejects(readFile(join(f.workspace, "cancelled.txt")), { code: "ENOENT" });
});

test("crash recovery retains interrupted command baselines through collection", async t => {
  const f = await fixture(t);
  const before = await f.store.capture("crashed", "turn", "before", []);
  before.journalVersion = 2; before.files = {}; await f.store.save(before);
  const command = await f.store.capture("crashed", "turn", "command");
  command.beforeId = before.id; command.status = "incomplete"; await f.store.save(command);
  await writeFile(join(f.workspace, "shared.txt"), "unknown command result");
  await f.store.prune(1);
  await f.store.recoverInterrupted("crashed");
  const recovered = (await f.store.list("crashed")).find(record => record.phase === "after")!;
  assert.equal(recovered.status, "incomplete");
  assert.equal((await f.store.diff("crashed", recovered.id, "shared.txt")).oldContent, "base");
  assert.equal((await f.store.preview("crashed", recovered.id)).files[0].status, "unprotected");
});

test("crash recovery preserves separate A-B-A operation segments", async t => {
  const f = await fixture(t);
  const before = await f.store.capture("crashed", "turn", "before", []);
  before.journalVersion = 2; before.files = {}; await f.store.save(before);
  const record = async (next: string, createdAt: string) => {
    const preimage = await f.store.captureFile("shared.txt"), beforeRevision = await f.store.revision("shared.txt");
    await writeFile(join(f.workspace, "shared.txt"), next);
    const id = randomUUID(); await f.store.advance("shared.txt", id);
    await f.store.saveEdit({ id, beforeId: before.id, path: "shared.txt", before: preimage, after: await f.store.captureFile("shared.txt"),
      beforeRevision, afterRevision: id, createdAt });
  };
  await record("A1", "2026-01-01T00:00:01Z");
  await writeFile(join(f.workspace, "shared.txt"), "B1"); await f.store.advance("shared.txt");
  await record("A2", "2026-01-01T00:00:02Z");
  await f.store.recoverInterrupted("crashed");
  const recovered = (await f.store.list("crashed")).find(record => record.phase === "after")!;
  const diff = await f.store.diff("crashed", recovered.id, "shared.txt");
  assert.deepEqual(diff.segments!.map(segment => [segment.oldContent, segment.newContent]), [["base", "A1"], ["B1", "A2"]]);
  assert.equal((await f.store.preview("crashed", recovered.id)).files[0].status, "unprotected");
});

test("conversation-only restore does not wait for a writer or depend on the current branch", async t => {
  const f = await fixture(t), a = await f.session("A");
  await a.read(); await a.write("A");
  const checkpoint = (await a.history.finishTurn("complete"))!;
  const plan = await f.store.preview("A", checkpoint.id, "turn", "conversation");
  await f.store.invalidateWorkspace();
  const release = await acquireWorkspaceOperation(f.workspace);
  try {
    const restored = await f.store.restore("A", plan.id);
    assert.deepEqual(restored.applied, []);
    assert.equal(await readFile(join(f.workspace, "shared.txt"), "utf8"), "A");
    assert.deepEqual((await f.store.readCheckpoint(restored.beforeId, "A")).files, {});
  } finally { release(); }
});

test("an upload cancelled during path validation cannot register a new writer", async t => {
  const f = await fixture(t), requestId = randomUUID(), entered = deferred(), resume = deferred();
  const normalize = f.store.normalizeFilePath.bind(f.store);
  f.store.normalizeFilePath = async relative => { entered.resolve(); await resume.promise; return normalize(relative); };
  const pending = runWorkspaceFileOperation(f.workspace, f.home, { operation: "create", path: "cancelled.txt", requestId });
  try {
    await entered.promise;
    await runWorkspaceFileOperation(f.workspace, f.home, { operation: "create", path: "cancelled.txt", requestId, cancel: true });
    resume.resolve();
    await assert.rejects(pending, { code: "ABORTED" });
    await assert.rejects(readFile(join(f.workspace, "cancelled.txt")), { code: "ENOENT" });
  } finally { resume.resolve(); f.store.normalizeFilePath = normalize; }
});
