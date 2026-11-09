import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceCheckpoints, getCheckpointStore } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { runWorkspaceFileOperation } from "../../src/session/checkpoints/workspaceFileOperation.js";
import { runRepositoryOperation } from "../../src/session/checkpoints/repositoryOperation.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { createTaskCreateTool } from "../../src/tool/builtin/taskTools.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

const execute = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fileSymlink(t: test.TestContext, target: string, alias: string): Promise<boolean> {
  try { await fs.symlink(target, alias, "file"); return true; }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("File symlinks require Windows Developer Mode or the symlink privilege."); return false;
  }
}
async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "pilotdeck-review-")), workspace = join(base, "workspace"), home = join(base, "home");
  await fs.mkdir(workspace); await fs.mkdir(home);
  const history = new WorkspaceCheckpoints(workspace, home), store = await getCheckpointStore(workspace, home);
  await history.beginTurn("session", "turn", []);
  t.after(async () => { await history.finishTurn("incomplete"); await fs.rm(base, { recursive: true, force: true }); });
  const context: PilotDeckToolRuntimeContext = { cwd: workspace, env: process.env, sessionId: "session", turnId: "turn", fileHistory: history,
    permissionMode: "bypassPermissions", permissionContext: { mode: "bypassPermissions", cwd: workspace, additionalWorkingDirectories: [], canPrompt: false,
      bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } } };
  return { base, workspace, home, history, store, context };
}

class ServiceChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = 42;
  unref() {}
  finish() { this.emit("exit", 0, null); }
}

test("default background services allow same-chat writes and a second service before either exits", async t => {
  const f = await fixture(t), children: ServiceChild[] = [];
  const runtime = new BackgroundTaskRuntime({ spawn: (() => { const child = new ServiceChild(); children.push(child); return child; }) as never });
  try {
    const tool = createTaskCreateTool(runtime);
    await tool.execute({ command: "development server" }, f.context);
    assert.equal(f.store.busy, false, "A detached service must not retain the directory mutation lease");
    await createWriteFileTool().execute({ file_path: "component.txt", content: "editable while serving" }, f.context);
    await tool.execute({ command: "watcher" }, f.context);
    assert.equal(children.length, 2);
    assert.equal(await fs.readFile(join(f.workspace, "component.txt"), "utf8"), "editable while serving");
  } finally { for (const child of children) child.finish(); }
});

test("finite background writes keep their lease until task completion", async t => {
  const f = await fixture(t), child = new ServiceChild();
  const runtime = new BackgroundTaskRuntime({ spawn: (() => child) as never });
  try {
    const task = await createTaskCreateTool(runtime).execute({ command: "bounded writer", lifecycle: "finite" }, f.context);
    assert.equal(f.store.busy, true);
    const pending = createWriteFileTool().execute({ file_path: "next.txt", content: "after task" }, f.context);
    child.finish();
    await runtime.wait(task.data!.taskId, { timeoutMs: 1000 });
    await pending;
    assert.equal(f.store.busy, false);
    assert.equal(await fs.readFile(join(f.workspace, "next.txt"), "utf8"), "after task");
  } finally { child.finish(); }
});

test("Web mutations accept absolute paths through a registered workspace alias", async t => {
  const f = await fixture(t), alias = join(f.base, "workspace-alias");
  await fs.symlink(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  await runWorkspaceFileOperation(alias, f.home, { operation: "create", path: join(alias, "new.txt") });
  assert.equal(await fs.readFile(join(f.workspace, "new.txt"), "utf8"), "");
});

test("Web saves larger than the backup limit remain writable with stale-save protection", async t => {
  const f = await fixture(t), original = "a".repeat(11 * 1024 * 1024), updated = original.slice(0, -1) + "b";
  await fs.writeFile(join(f.workspace, "large.csv"), original);
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "large.csv", content: updated, expectedHash: hash(original) });
  assert.equal(await fs.readFile(join(f.workspace, "large.csv"), "utf8"), updated);
  await assert.rejects(runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "large.csv", content: original, expectedHash: hash(original) }), { code: "FILE_CHANGED" });
  const checkpoint = (await f.store.list("filesystem:user")).find(item => item.phase === "after" && item.changes?.length)!;
  assert.equal(f.store.summary(checkpoint).changes[0].restorable, false);
});

test("Web saves preserve file symlinks even when the checkpoint cannot back them up", async t => {
  const f = await fixture(t), target = join(f.workspace, "real.txt"), alias = join(f.workspace, "alias.txt");
  await fs.writeFile(target, "original"); if (!await fileSymlink(t, target, alias)) return;
  await runWorkspaceFileOperation(f.workspace, f.home, { operation: "save", path: "alias.txt", content: "updated", expectedHash: hash("original") });
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), "updated");
});

for (const withHistory of [false, true]) test(`authorized file-tool writes update the external symlink target and preserve the link (history=${withHistory})`, async t => {
  const f = await fixture(t), target = join(f.home, "dotfile"), alias = join(f.workspace, "config-link");
  await fs.writeFile(target, "original"); if (!await fileSymlink(t, target, alias)) return;
  const context: PilotDeckToolRuntimeContext = { ...f.context, fileHistory: withHistory ? f.history : undefined,
    currentPermissionDecision: { type: "allow", reason: { type: "runtime", message: "Explicitly authorized external target" } } };
  await createReadFileTool().execute({ file_path: alias }, context);
  await createWriteFileTool().execute({ file_path: alias, content: "updated" }, context);
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), "updated");
});

test("cancelling an upload during its copy cannot publish the destination", async t => {
  const f = await fixture(t), requestId = randomUUID(), staged = join(f.workspace, ".tmp/workspace-upload-test/source.txt");
  await fs.mkdir(join(f.workspace, ".tmp/workspace-upload-test"), { recursive: true }); await fs.writeFile(staged, "upload");
  const copy = fs.copyFile;
  fs.copyFile = async (...args) => {
    await copy(...args);
    await runWorkspaceFileOperation(f.workspace, f.home, { operation: "upload", path: "uploaded.txt", requestId, cancel: true });
  };
  try {
    await assert.rejects(runWorkspaceFileOperation(f.workspace, f.home, { operation: "upload", path: "uploaded.txt", stagedPath: ".tmp/workspace-upload-test/source.txt", requestId }), /abort|cancel/i);
    await assert.rejects(fs.access(join(f.workspace, "uploaded.txt")), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(f.workspace)).filter(name => name.startsWith(".pilotdeck-restore-")), []);
  } finally { fs.copyFile = copy; }
});

test("legacy publish selects an existing non-origin remote for an untracked branch", async t => {
  const f = await fixture(t), remote = join(f.base, "upstream.git");
  const git = async (...args: string[]) => (await execute("git", args, { cwd: f.workspace })).stdout.trim();
  await git("init"); await git("config", "user.name", "Review QA"); await git("config", "user.email", "qa@example.test");
  await fs.writeFile(join(f.workspace, "file.txt"), "initial"); await git("add", "."); await git("commit", "-m", "initial");
  await execute("git", ["init", "--bare", remote]); await git("remote", "add", "upstream", remote); await git("checkout", "-b", "qa/publish");
  await runRepositoryOperation(f.workspace, { operation: "legacy", legacyAction: "publish", branch: "qa/publish" });
  assert.equal(await git("config", "--get", "branch.qa/publish.remote"), "upstream");
  assert.equal(await git("rev-parse", "@{upstream}"), await git("rev-parse", "HEAD"));
});
