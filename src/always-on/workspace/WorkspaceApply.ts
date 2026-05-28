/**
 * Workspace apply & dispose helpers.
 *
 * These are standalone functions (not tied to a provider instance) so
 * that `DiscoveryPlanService` can call them through dependency injection
 * without needing the full provider registry at construction time.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

export type WorkspaceDiff = {
  diff: string;
  fileCount: number;
  truncated: boolean;
};

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

async function runProcess(bin: string, args: string[]): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdin?.end();
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

const MAX_INLINE_DIFF_CHARS = 80_000;

/**
 * Generate a diff of the changes in an isolated workspace relative to
 * its baseline. Works for both git-worktree (via `git diff`) and
 * snapshot-copy (via POSIX `diff -ruN`).
 */
export async function generateWorkspaceDiff(
  strategy: string,
  workspaceCwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<WorkspaceDiff> {
  if (strategy === "git-worktree") {
    return generateGitWorktreeDiff(workspaceCwd, gitBin);
  }
  return generateSnapshotCopyDiff(workspaceCwd, projectRoot);
}

async function generateGitWorktreeDiff(
  workspaceCwd: string,
  gitBin: string,
): Promise<WorkspaceDiff> {
  const addAll = await runProcess(gitBin, ["-C", workspaceCwd, "add", "-A"]);
  if (addAll.exitCode !== 0) {
    return { diff: "", fileCount: 0, truncated: false };
  }

  const statResult = await runProcess(gitBin, [
    "-C", workspaceCwd, "diff", "--cached", "HEAD", "--stat",
  ]);
  const fileCount = statResult.exitCode === 0
    ? (statResult.stdout.match(/\n/g) || []).length - 1
    : 0;

  const diffResult = await runProcess(gitBin, [
    "-C", workspaceCwd, "diff", "--cached", "HEAD",
  ]);
  if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
    return { diff: "", fileCount: Math.max(fileCount, 0), truncated: false };
  }

  const fullDiff = diffResult.stdout;
  if (fullDiff.length > MAX_INLINE_DIFF_CHARS) {
    return {
      diff: fullDiff.slice(0, MAX_INLINE_DIFF_CHARS),
      fileCount: Math.max(fileCount, 0),
      truncated: true,
    };
  }
  return { diff: fullDiff, fileCount: Math.max(fileCount, 0), truncated: false };
}

async function generateSnapshotCopyDiff(
  workspaceCwd: string,
  projectRoot: string,
): Promise<WorkspaceDiff> {
  const result = await runProcess("diff", [
    "-ruN",
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=.pilotdeck",
    "--exclude=.pilotdeck-always-on",
    projectRoot,
    workspaceCwd,
  ]);

  // diff exits 1 when differences found, 0 when identical, >1 on error
  if (result.exitCode > 1) {
    return { diff: "", fileCount: 0, truncated: false };
  }

  const fullDiff = result.stdout;
  const fileCount = (fullDiff.match(/^diff /gm) || []).length;

  if (fullDiff.length > MAX_INLINE_DIFF_CHARS) {
    return {
      diff: fullDiff.slice(0, MAX_INLINE_DIFF_CHARS),
      fileCount,
      truncated: true,
    };
  }
  return { diff: fullDiff, fileCount, truncated: false };
}

/**
 * Apply uncommitted changes from a git worktree back to the original
 * project root using `git diff` + `git apply --3way`.
 */
export async function applyWorktreeToProject(
  worktreeCwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<{ applied: boolean; diff?: string; error?: string }> {
  // Stage everything in the worktree so `diff HEAD` captures new files too.
  const addAll = await runProcess(gitBin, ["-C", worktreeCwd, "add", "-A"]);
  if (addAll.exitCode !== 0) {
    return { applied: false, error: `git add -A failed: ${addAll.stderr}` };
  }

  const diffResult = await runProcess(gitBin, [
    "-C", worktreeCwd,
    "diff", "--cached", "HEAD",
    "--binary",
  ]);
  if (diffResult.exitCode !== 0) {
    return { applied: false, error: `git diff failed: ${diffResult.stderr}` };
  }

  const patch = diffResult.stdout;
  if (!patch.trim()) {
    return { applied: true, diff: "" };
  }

  // Pipe the diff into `git apply --3way` in the original project root.
  const applyResult = await new Promise<ProcessResult>((resolve) => {
    const child = spawn(gitBin, ["-C", projectRoot, "apply", "--3way"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    child.stdin?.write(patch);
    child.stdin?.end();
  });

  if (applyResult.exitCode !== 0) {
    return {
      applied: false,
      diff: patch,
      error: `git apply failed: ${applyResult.stderr || applyResult.stdout}`,
    };
  }

  return { applied: true, diff: patch };
}

/**
 * Remove an isolated workspace from disk.
 *
 * For git-worktree: `git worktree remove --force`, fallback to rm + prune.
 * For snapshot-copy: plain `rm -rf`.
 */
export async function disposeWorkspace(
  strategy: string,
  cwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<void> {
  if (strategy === "git-worktree") {
    const remove = await runProcess(gitBin, [
      "-C", projectRoot,
      "worktree", "remove", "--force", cwd,
    ]).catch(() => undefined);

    if (!remove || remove.exitCode !== 0) {
      await rm(cwd, { recursive: true, force: true });
      await runProcess(gitBin, ["-C", projectRoot, "worktree", "prune"]).catch(
        () => undefined,
      );
    }
    return;
  }

  // snapshot-copy or unknown: just rm.
  await rm(cwd, { recursive: true, force: true });
}
