import { execFile } from "node:child_process";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { CronTask } from "../protocol/types.js";

const execute = promisify(execFile);

/** Worktrees start from committed HEAD; never stage or commit the user's checkout. */
export async function prepareCronWorkspace(task: CronTask, runId: string, root: string): Promise<string> {
  const cwd = task.workspaceCwd ?? task.projectKey;
  if (!cwd) throw new Error("Cron task has no workspace.");
  if (task.workspaceMode !== "worktree") return cwd;
  const { stdout } = await execute("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
  const target = resolve(root, task.taskId.replace(/[^A-Za-z0-9_-]/g, "-"));
  const existing = await lstat(target).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Cron task worktree path is unavailable.");
    const { stdout: actual } = await execute("git", ["-C", target, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    if (await realpath(actual.trim()) !== await realpath(target)) throw new Error("Cron task worktree is invalid.");
    return target;
  }
  await mkdir(dirname(target), { recursive: true });
  await execute("git", ["-C", stdout.trim(), "worktree", "add", "--detach", target, "HEAD"], { timeout: 30_000 });
  return target;
}
