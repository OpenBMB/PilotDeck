import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareCronWorkspace } from "../../src/cron/runtime/CronWorkspace.js";
import type { CronTask } from "../../src/cron/protocol/types.js";

const execute = promisify(execFile);

test("isolated scheduled work starts at committed HEAD and leaves the user's branch and dirty files untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-worktree-"));
  const git = (...args: string[]) => execute("git", ["-C", root, ...args]);
  try {
    await git("init", "-q");
    await git("config", "user.name", "Scheduler QA");
    await git("config", "user.email", "scheduler@example.invalid");
    await writeFile(join(root, "report.txt"), "Committed input");
    await git("add", "report.txt");
    await git("commit", "-qm", "Synthetic baseline");
    const branch = (await git("branch", "--show-current")).stdout;
    const head = (await git("rev-parse", "HEAD")).stdout;
    await writeFile(join(root, "report.txt"), "Uncommitted user work");
    const task = { taskId: "synthetic-task", projectKey: root, executionMode: "persistent", workspaceMode: "worktree" } as CronTask;
    const cwd = await prepareCronWorkspace(task, "synthetic-run", join(root, "worktrees"));
    assert.equal(await readFile(join(cwd, "report.txt"), "utf8"), "Committed input");
    assert.equal(await readFile(join(root, "report.txt"), "utf8"), "Uncommitted user work");
    assert.equal((await git("branch", "--show-current")).stdout, branch);
    assert.equal((await git("rev-parse", "HEAD")).stdout, head);
    await writeFile(join(cwd, "report.txt"), "Task-owned progress");
    const nextCwd = await prepareCronWorkspace(task, "other-run", join(root, "worktrees"));
    assert.equal(nextCwd, cwd);
    assert.equal(await readFile(join(nextCwd, "report.txt"), "utf8"), "Task-owned progress");
  } finally { await rm(root, { recursive: true, force: true }); }
});
