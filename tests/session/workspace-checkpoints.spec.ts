import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink, symlink, chmod, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceCheckpoints, CheckpointStore, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import type { Checkpoint, RestoreOperation } from "../../src/session/checkpoints/types.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";

async function shellEdit(f: Awaited<ReturnType<typeof fixture>>, mutate: () => Promise<void>, exitCode = 0) {
  return createBashTool({ runner: { async run() { await mutate(); return { exitCode, stdout: "", stderr: "", timedOut: false, durationMs: 1 }; } } }).execute({ command: "python mutate.py" }, {
    cwd: f.workspace, sessionId: "session", turnId: "turn", fileHistory: f.history, permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: f.workspace, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
  });
}

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "pilotdeck-checkpoints-"));
  const workspace = join(base, "workspace"), home = join(base, "home");
  await mkdir(workspace); await mkdir(home);
  t.after(() => rm(base, { recursive: true, force: true }));
  const history = new WorkspaceCheckpoints(workspace, home), store = await getCheckpointStore(workspace, home);
  return { workspace, home, history, store, file: (name: string) => join(workspace, name) };
}

test("ordinary folders capture tool edits, shell additions/deletions and binary data; restore can itself be undone", async t => {
  const f = await fixture(t);
  await writeFile(f.file("edited.txt"), "original\n");
  await writeFile(f.file("deleted.txt"), "keep me\n");
  await writeFile(f.file("binary.bin"), Buffer.from([0, 1, 2]));
  await chmod(f.file("edited.txt"), 0o755);
  const originalMode = (await stat(f.file("edited.txt"))).mode & 0o777;
  await f.history.beginTurn("session", "turn", []);
  await f.history.trackEdit(f.file("edited.txt"), "turn");
  await writeFile(f.file("edited.txt"), "first\n");
  await f.history.recordEdit(f.file("edited.txt"), "turn");
  await f.history.trackEdit(f.file("edited.txt"), "turn");
  await writeFile(f.file("edited.txt"), "second\n");
  await f.history.recordEdit(f.file("edited.txt"), "turn");
  await writeFile(f.file("created.txt"), "new\n");
  await unlink(f.file("deleted.txt"));
  await writeFile(f.file("binary.bin"), Buffer.from([0, 3, 4]));
  const summary = (await f.history.finishTurn("complete"))!;
  assert.equal(summary.changes.length, 4);
  assert.equal(summary.changes.find(file => file.path === "edited.txt")?.source, "file_tool");
  assert.equal(summary.changes.find(file => file.path === "deleted.txt")?.operation, "deleted");
  assert.equal((await f.store.diff("session", summary.id, "edited.txt")).oldContent, "original\n");
  assert.equal((await f.store.diff("session", summary.id, "binary.bin")).hunks, null);
  const plan = await f.store.preview("session", summary.id);
  assert.ok(plan.files.every(file => file.status === "ready"));
  const operation = await f.store.restore("session", plan.id);
  assert.equal((await f.store.selectChanges(await f.store.readCheckpoint(summary.id, "session"), "session")).length, 0);
  assert.equal(await readFile(f.file("edited.txt"), "utf8"), "original\n");
  assert.equal((await stat(f.file("edited.txt"))).mode & 0o777, originalMode);
  assert.equal(await readFile(f.file("deleted.txt"), "utf8"), "keep me\n");
  await assert.rejects(readFile(f.file("created.txt")), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.file("binary.bin")), Buffer.from([0, 1, 2]));
  assert.equal((await f.store.restore("session", plan.id)).id, operation.id);
  const restarted = new CheckpointStore(f.store.workspace, f.store.directory);
  const undo = await restarted.undoPreview("session", operation.id);
  await restarted.restore("session", undo.id);
  assert.equal((await restarted.selectChanges(await restarted.readCheckpoint(summary.id, "session"), "session")).length, 4);
  assert.equal(await readFile(f.file("edited.txt"), "utf8"), "second\n");
  assert.equal(await readFile(f.file("created.txt"), "utf8"), "new\n");
  await assert.rejects(readFile(f.file("deleted.txt")), { code: "ENOENT" });
});

test("file-tool paths follow actual filesystem casing and restore each physical file once", async t => {
  const f = await fixture(t);
  await mkdir(f.file("Docs"));
  await writeFile(f.file("Docs/Report.txt"), "before\n");
  const insensitive = await readFile(f.file("docs/report.txt")).then(() => true, () => false);
  if (!insensitive) {
    // Linux and case-sensitive macOS/Windows folders may contain both names.
    await writeFile(f.file("Docs/report.txt"), "other before\n");
    await f.history.beginTurn("session", "turn", []);
    for (const name of ["Docs/Report.txt", "Docs/report.txt"]) {
      await f.history.trackEdit(f.file(name), "turn");
      await writeFile(f.file(name), "after\n");
      await f.history.recordEdit(f.file(name), "turn", "after\n");
    }
    const checkpoint = (await f.history.finishTurn("complete"))!;
    assert.equal(checkpoint.changes.length, 2);
    await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
    assert.equal(await readFile(f.file("Docs/Report.txt"), "utf8"), "before\n");
    assert.equal(await readFile(f.file("Docs/report.txt"), "utf8"), "other before\n");
    return;
  }
  await f.history.beginTurn("session", "turn", []);
  await f.history.trackEdit(f.file("docs/report.txt"), "turn");
  await writeFile(f.file("docs/report.txt"), "first\n");
  await f.history.recordEdit(f.file("DOCS/REPORT.txt"), "turn", "first\n");
  await f.history.trackEdit(f.file("Docs/REPORT.txt"), "turn");
  await writeFile(f.file("Docs/Report.txt"), "last\n");
  await f.history.recordEdit(f.file("Docs/Report.txt"), "turn", "last\n");
  await f.history.trackEdit(f.file("docs/new.txt"), "turn");
  await writeFile(f.file("docs/new.txt"), "created\n");
  await f.history.recordEdit(f.file("DOCS/NEW.txt"), "turn", "created\n");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(file => file.path).sort(), ["Docs/Report.txt", "Docs/new.txt"].sort());
  const plan = await f.store.preview("session", checkpoint.id);
  const restored = await f.store.restore("session", plan.id, ["docs/report.txt", "DOCS/NEW.txt"]);
  assert.equal(restored.status, "complete"); assert.equal(restored.applied.length, 2);
  assert.equal(await readFile(f.file("Docs/Report.txt"), "utf8"), "before\n");
  await assert.rejects(readFile(f.file("Docs/new.txt")), { code: "ENOENT" });
  const undo = await f.store.undoPreview("session", restored.id);
  await f.store.restore("session", undo.id);
  assert.equal(await readFile(f.file("Docs/Report.txt"), "utf8"), "last\n");
  assert.equal(await readFile(f.file("Docs/new.txt"), "utf8"), "created\n");
  const aliasStore = await getCheckpointStore(f.workspace.toUpperCase(), f.home);
  assert.equal(aliasStore, f.store);
});

test("mixed shell and file-tool edits preserve the entire turn boundary, including newly created files", async t => {
  for (const order of ["shell-tool", "tool-shell"]) for (const created of [false, true]) {
    const f = await fixture(t);
    if (!created) await writeFile(f.file("a.txt"), "A");
    await f.history.beginTurn("session", "turn", []);
    if (order === "shell-tool") await shellEdit(f, () => writeFile(f.file("a.txt"), "B"));
    await f.history.trackEdit(f.file("a.txt"), "turn");
    await writeFile(f.file("a.txt"), order === "shell-tool" ? "C" : "B");
    await f.history.recordEdit(f.file("a.txt"), "turn", order === "shell-tool" ? "C" : "B");
    if (order === "tool-shell") await shellEdit(f, () => writeFile(f.file("a.txt"), "C"));
    const checkpoint = (await f.history.finishTurn("complete"))!;
    const diff = await f.store.diff("session", checkpoint.id, "a.txt");
    assert.equal(diff.oldContent, created ? "" : "A"); assert.equal(diff.newContent, "C");
    const plan = await f.store.preview("session", checkpoint.id); assert.equal(plan.files[0].status, "ready");
    const operation = await f.store.restore("session", plan.id);
    if (created) await assert.rejects(readFile(f.file("a.txt")), { code: "ENOENT" });
    else assert.equal(await readFile(f.file("a.txt"), "utf8"), "A");
    await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
    assert.equal(await readFile(f.file("a.txt"), "utf8"), "C");
  }
});

test("commands record failed mutations and preserve external edits between or after commands", async t => {
  const f = await fixture(t); await writeFile(f.file("a.txt"), "A"); await f.history.beginTurn("session", "turn", []);
  await assert.rejects(shellEdit(f, () => writeFile(f.file("a.txt"), "B"), 1));
  await writeFile(f.file("a.txt"), "manual");
  await shellEdit(f, () => writeFile(f.file("a.txt"), "C"));
  const checkpoint = (await f.history.finishTurn("incomplete"))!;
  assert.equal(checkpoint.changes[0].restorable, false);
  await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
  assert.equal(await readFile(f.file("a.txt"), "utf8"), "C");
  const g = await fixture(t); await writeFile(g.file("a.txt"), "A"); await g.history.beginTurn("session", "turn", []);
  await shellEdit(g, () => writeFile(g.file("a.txt"), "B")); await writeFile(g.file("a.txt"), "manual");
  const recorded = (await g.history.finishTurn("complete"))!;
  assert.equal((await g.store.diff("session", recorded.id, "a.txt")).newContent, "B");
  assert.equal((await g.store.preview("session", recorded.id)).files[0].status, "conflict");
});

test("unchanged unprotected files do not become changes; symlink and oversized-file mutations remain visible", async t => {
  const f = await fixture(t); await writeFile(f.file(".git"), "gitdir: /fixture\n");
  await writeFile(f.file("large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await mkdir(join(f.home, "outside"));
  await symlink(join(f.home, "outside"), f.file("link"), process.platform === "win32" ? "junction" : "dir");
  await f.history.beginTurn("session", "turn", []);
  assert.equal((await f.history.finishTurn("complete"))!.changes.length, 0);
  await f.history.beginTurn("session", "turn2", []);
  await writeFile(f.file("large.bin"), Buffer.alloc(10 * 1024 * 1024 + 2));
  await unlink(f.file("link")); await mkdir(join(f.home, "other"));
  await symlink(join(f.home, "other"), f.file("link"), process.platform === "win32" ? "junction" : "dir");
  const changes = (await f.history.finishTurn("complete"))!.changes;
  assert.deepEqual(changes.map(change => change.path), ["large.bin", "link"]);
  assert.ok(changes.every(change => !change.restorable));
});

test("old duplicate checkpoint and restore-plan spellings cannot cause a partial restore", async t => {
  const f = await fixture(t);
  await writeFile(f.file("Report.txt"), "before\n");
  if (!await readFile(f.file("report.txt")).then(() => true, () => false)) return t.skip("Requires a case-insensitive filesystem; distinct-name behavior is tested separately.");
  await f.history.beginTurn("session", "turn", []);
  await f.history.trackEdit(f.file("Report.txt"), "turn");
  await writeFile(f.file("Report.txt"), "after\n");
  await f.history.recordEdit(f.file("Report.txt"), "turn");
  const summary = (await f.history.finishTurn("complete"))!;
  const checkpoint = await f.store.readCheckpoint(summary.id, "session"), change = checkpoint.changes![0];
  checkpoint.changes!.push({ ...change, path: "report.txt", source: "observed" });
  await writeFile(join(f.store.directory, "manifests", `${checkpoint.id}.json`), JSON.stringify(checkpoint));
  assert.equal((await f.store.readCheckpoint(checkpoint.id, "session")).changes!.length, 1);
  assert.equal((await f.store.list("session")).find(item => item.id === checkpoint.id)!.changes!.length, 1);
  const plan = await f.store.preview("session", checkpoint.id);
  plan.files.push({ ...plan.files[0], path: "report.txt" });
  await writeFile(join(f.store.directory, "plans", `${plan.id}.json`), JSON.stringify(plan));
  const operation = await f.store.restore("session", plan.id);
  assert.equal(operation.applied.length, 1); assert.equal(operation.status, "complete");
  assert.equal(await readFile(f.file("Report.txt"), "utf8"), "before\n");
  await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
  const stale = await f.store.preview("session", checkpoint.id);
  stale.files.push({ ...stale.files[0], path: "report.txt", target: { kind: "absent" } });
  await writeFile(join(f.store.directory, "plans", `${stale.id}.json`), JSON.stringify(stale));
  await assert.rejects(f.store.restore("session", stale.id), { code: "STALE_PLAN" });
  assert.equal(await readFile(f.file("Report.txt"), "utf8"), "after\n");
});

test("case-only shell renames are compared by filesystem identity", async t => {
  const f = await fixture(t);
  await writeFile(f.file("Report.txt"), "before\n");
  if (!await readFile(f.file("report.txt")).then(() => true, () => false)) return t.skip("Case-sensitive renames are separate created/deleted files.");
  await f.history.beginTurn("session", "turn", []);
  await rename(f.file("Report.txt"), f.file("report.txt"));
  await writeFile(f.file("report.txt"), "after\n");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.equal(checkpoint.changes.length, 1);
  const operation = await f.store.restore("session", (await f.store.preview("session", checkpoint.id)).id);
  assert.equal(operation.status, "complete");
  assert.equal(await readFile(f.file("report.txt"), "utf8"), "before\n");
});

test("recorded internal work files remain part of whole-turn restore and undo, while runtime data stays intact", async t => {
  const f = await fixture(t);
  await mkdir(f.file(".pilotdeck/work"), { recursive: true });
  await writeFile(f.file(".pilotdeck/.gitignore"), "*\n");
  await writeFile(f.file(".pilotdeck/runtime.json"), "keep runtime data");
  await writeFile(f.file(".pilotdeck/work/patch.py"), "original script");
  await writeFile(f.file("report.pptx"), Buffer.from([0, 1, 2]));
  await f.history.beginTurn("session", "turn", []);
  for (const [name, content] of [[".pilotdeck/work/patch.py", "updated script"], [".pilotdeck/work/new.py", "new script"]]) {
    await f.history.trackEdit(f.file(name), "turn");
    await writeFile(f.file(name), content);
    await f.history.recordEdit(f.file(name), "turn");
  }
  await writeFile(f.file("report.pptx"), Buffer.from([0, 3, 4]));
  const checkpoint = (await f.history.finishTurn("complete"))!;
  assert.deepEqual(checkpoint.changes.map(file => file.path).sort(), [".pilotdeck/work/new.py", ".pilotdeck/work/patch.py", "report.pptx"]);
  const plan = await f.store.preview("session", checkpoint.id);
  assert.ok(plan.files.every(file => file.status === "ready"));
  const operation = await f.store.restore("session", plan.id);
  assert.equal(await readFile(f.file(".pilotdeck/work/patch.py"), "utf8"), "original script");
  await assert.rejects(readFile(f.file(".pilotdeck/work/new.py")), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.file("report.pptx")), Buffer.from([0, 1, 2]));
  const restarted = new CheckpointStore(f.store.workspace, f.store.directory);
  const undo = await restarted.undoPreview("session", operation.id);
  await restarted.restore("session", undo.id);
  assert.equal(await readFile(f.file(".pilotdeck/work/patch.py"), "utf8"), "updated script");
  assert.equal(await readFile(f.file(".pilotdeck/work/new.py"), "utf8"), "new script");
  assert.deepEqual(await readFile(f.file("report.pptx")), Buffer.from([0, 3, 4]));
  assert.equal(await readFile(f.file(".pilotdeck/.gitignore"), "utf8"), "*\n");
  assert.equal(await readFile(f.file(".pilotdeck/runtime.json"), "utf8"), "keep runtime data");
});

test("conflicts preserve later edits and a stale preview fails before any file is changed", async t => {
  const f = await fixture(t);
  await writeFile(f.file("a.txt"), "before"); await writeFile(f.file("b.txt"), "before");
  await f.history.beginTurn("session", "turn", []);
  await writeFile(f.file("a.txt"), "agent"); await writeFile(f.file("b.txt"), "agent");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  await writeFile(f.file("a.txt"), "manual edit");
  const plan = await f.store.preview("session", checkpoint.id);
  assert.equal(plan.files.find(file => file.path === "a.txt")?.status, "conflict");
  assert.equal(plan.files.find(file => file.path === "b.txt")?.status, "ready");
  await writeFile(f.file("b.txt"), "newer edit");
  await assert.rejects(f.store.restore("session", plan.id), { code: "STALE_PLAN" });
  assert.equal(await readFile(f.file("a.txt"), "utf8"), "manual edit");
  assert.equal(await readFile(f.file("b.txt"), "utf8"), "newer edit");
});

test("tool postimages describe the content actually written even if an external writer wins before recording", async t => {
  const f = await fixture(t);
  await writeFile(f.file("a.txt"), "before"); await f.history.beginTurn("session", "turn", []);
  await f.history.trackEdit(f.file("a.txt"), "turn");
  await writeFile(f.file("a.txt"), "tool content"); await writeFile(f.file("a.txt"), "other writer content");
  await f.history.recordEdit(f.file("a.txt"), "turn", "tool content");
  const summary = (await f.history.finishTurn("complete"))!;
  assert.equal((await f.store.diff("session", summary.id, "a.txt")).newContent, "tool content");
  assert.equal((await f.store.preview("session", summary.id)).files[0].status, "conflict");
  assert.ok(f.store.directory.startsWith(join(f.home, "checkpoints")));
});

test("symbolic links, replaced directories, oversized files and cross-session requests cannot be restored", async t => {
  const f = await fixture(t);
  await mkdir(f.file("nested")); await writeFile(f.file("nested/a.txt"), "original");
  await writeFile(f.file("large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await writeFile(join(f.home, "outside.txt"), "outside");
  let fileSymlink = true;
  try { await symlink(join(f.home, "outside.txt"), f.file("link.txt"), "file"); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    fileSymlink = false;
    t.diagnostic("File symlink check unavailable without Windows Developer Mode; directory junction safety is still exercised.");
  }
  await f.history.beginTurn("session", "turn", []);
  await assert.rejects(f.history.trackEdit(f.file("large.bin"), "turn"), { code: "BACKUP_UNAVAILABLE" });
  await writeFile(f.file("nested/a.txt"), "agent");
  const checkpoint = (await f.history.finishTurn("incomplete"))!;
  assert.equal(checkpoint.status, "incomplete"); assert.ok(checkpoint.unprotected >= (fileSymlink ? 2 : 1));
  await assert.rejects(f.store.preview("other-session", checkpoint.id), { code: "CHECKPOINT_MISMATCH" });
  const plan = await f.store.preview("session", checkpoint.id);
  await rm(f.file("nested"), { recursive: true }); await symlink(f.home, f.file("nested"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.restore("session", plan.id), { code: "UNSAFE_PATH" });
  await assert.rejects(f.store.captureFile("../outside.txt"), { code: "INVALID_PATH" });
});

test("undo recovers a file applied before a process exited without recording its completed write", async t => {
  const f = await fixture(t);
  await writeFile(f.file("a.txt"), "before");
  await f.history.beginTurn("session", "turn", []); await writeFile(f.file("a.txt"), "after");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  const plan = await f.store.preview("session", checkpoint.id);
  const operation = await f.store.restore("session", plan.id);
  const interrupted: RestoreOperation = { ...operation, status: "applying", applied: [], pendingPath: "a.txt" };
  await writeFile(join(f.store.directory, "operations", `${operation.id}.json`), JSON.stringify(interrupted));
  await assert.rejects(f.store.restore("session", plan.id), { code: "RESTORE_INTERRUPTED" });
  const undo = await new CheckpointStore(f.store.workspace, f.store.directory).undoPreview("session", operation.id);
  assert.equal(undo.files[0].status, "ready");
  await f.store.restore("session", undo.id);
  assert.equal(await readFile(f.file("a.txt"), "utf8"), "after");
});

test("leases coordinate overlapping folders while independent folders remain usable", async t => {
  const f = await fixture(t);
  const nested = new CheckpointStore(join(f.workspace, "nested"), join(f.home, "nested-store"));
  const independent = new CheckpointStore(join(f.home, "separate"), join(f.home, "separate-store"));
  const release = await f.store.acquire();
  assert.equal(nested.busy, true); assert.equal(independent.busy, false);
  let acquired = false;
  const queued = nested.acquire().then(releaseNested => { acquired = true; return releaseNested; });
  await Promise.resolve(); assert.equal(acquired, false);
  const releaseIndependent = await independent.acquire(); releaseIndependent();
  release(); (await queued)(); assert.equal(f.store.busy, false);
});

test("interrupted Agent turns recover durable file-tool edits and protect edits with unknown post-crash versions", async t => {
  const f = await fixture(t);
  await writeFile(f.file("tool.txt"), "before tool"); await writeFile(f.file("shell.txt"), "before shell");
  const before = await f.store.capture("session", "interrupted", "before", []); await f.store.save(before);
  await writeFile(f.file("tool.txt"), "after tool");
  await f.store.saveEdit({ id: randomUUID(), beforeId: before.id, path: "tool.txt", before: before.files["tool.txt"], after: await f.store.captureFile("tool.txt") });
  await writeFile(f.file("shell.txt"), "unknown edit after crash");
  const restarted = new CheckpointStore(f.store.workspace, f.store.directory);
  await restarted.recoverInterrupted("session");
  const recovered = (await restarted.list("session")).find(record => record.phase === "after")!;
  assert.equal(recovered.status, "incomplete");
  assert.equal(restarted.summary(recovered).changes.find(change => change.path === "shell.txt")?.restorable, false);
  const plan = await restarted.preview("session", recovered.id);
  assert.equal(plan.files.find(file => file.path === "tool.txt")?.status, "ready");
  assert.equal(plan.files.find(file => file.path === "shell.txt")?.status, "unprotected");
  await restarted.restore("session", plan.id);
  assert.equal(await readFile(f.file("tool.txt"), "utf8"), "before tool");
  assert.equal(await readFile(f.file("shell.txt"), "utf8"), "unknown edit after crash");
  await restarted.recoverInterrupted("session");
  assert.equal((await restarted.list("session")).filter(record => record.phase === "after").length, 1);
});

test("session comparison follows physical edits even when a conversation branch is hidden", async t => {
  const f = await fixture(t);
  await writeFile(f.file("a.txt"), "one\n");
  await f.history.beginTurn("session", "one", []); await writeFile(f.file("a.txt"), "two\n"); await f.history.finishTurn("complete");
  await f.history.beginTurn("session", "two", []); await writeFile(f.file("a.txt"), "three\n");
  const checkpoint = (await f.history.finishTurn("complete"))!;
  const latest = await f.store.readCheckpoint(checkpoint.id, "session");
  const full = await f.store.diff("session", latest.id, "a.txt", "session");
  assert.equal(full.oldContent, "one\n"); assert.equal(full.newContent, "three\n");
  const active = await f.store.diff("session", latest.id, "a.txt", "session", new Set(["two"]));
  assert.equal(active.oldContent, "one\n"); assert.equal(active.newContent, "three\n");
  const operation = await f.store.restore("session", (await f.store.preview("session", latest.id)).id);
  const reverted = await f.store.diff("session", latest.id, "a.txt", "session", new Set(["one"]));
  assert.equal(reverted.oldContent, "one\n"); assert.equal(reverted.newContent, "two\n");
  await f.store.restore("session", (await f.store.undoPreview("session", operation.id)).id);
  assert.equal((await f.store.diff("session", latest.id, "a.txt", "session", new Set(["one"]))).newContent, "three\n");
});

test("retention removes unused content but keeps backups referenced by restore operations", async t => {
  const f = await fixture(t);
  const checkpoints: Checkpoint[] = [];
  for (let index = 0; index < 4; index++) {
    const before = await f.store.capture("session", `turn-${index}`, "before", []); await f.store.save(before);
    await writeFile(f.file("a.txt"), `version-${index}`);
    const after = await f.store.capture("session", `turn-${index}`, "after");
    after.beforeId = before.id; after.changes = await f.store.changes(before, after); await f.store.save(after); checkpoints.push(after);
  }
  const orphan = await f.store.putObject(Buffer.from(randomUUID()));
  const plan = await f.store.preview("session", checkpoints[3].id); const operation = await f.store.restore("session", plan.id);
  await f.store.prune(2);
  const retained = await f.store.list("session");
  assert.equal(retained.filter(item => item.phase === "after").length, 2);
  await assert.rejects(f.store.readObject(orphan), { code: "ENOENT" });
  const undo = await f.store.undoPreview("session", operation.id); await f.store.restore("session", undo.id);
  assert.equal(await readFile(f.file("a.txt"), "utf8"), "version-3");
});
