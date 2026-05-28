import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { AlwaysOnError } from "../protocol/errors.js";
import type { WorkspaceHandle } from "../protocol/types.js";
import type { WorkspaceProvider, WorkspacePrepareInput, WorkspacePublishOutput } from "./WorkspaceProvider.js";

export type GitWorktreeProviderOptions = {
  baseDir: string;
  /** When true, refuses to prepare on a dirty worktree. Default true. */
  refuseDirty?: boolean;
  /** Override `git` executable path (tests). */
  gitBin?: string;
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
};

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly id = "git-worktree" as const;
  readonly priority = 1;

  constructor(private readonly options: GitWorktreeProviderOptions) {}

  async isApplicable(projectRoot: string): Promise<boolean> {
    const top = await runGit(this.git(), ["-C", projectRoot, "rev-parse", "--show-toplevel"]).catch(() => undefined);
    if (!top || top.exitCode !== 0) return false;
    const head = await runGit(this.git(), ["-C", projectRoot, "rev-parse", "HEAD"]).catch(() => undefined);
    if (!head || head.exitCode !== 0) return false;
    if (this.options.refuseDirty !== false) {
      const status = await runGit(this.git(), ["-C", projectRoot, "status", "--porcelain"]).catch(() => undefined);
      if (!status || status.exitCode !== 0) return false;
      if (status.stdout.trim().length > 0) return false;
    }
    return true;
  }

  async prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle> {
    const top = await runGit(this.git(), ["-C", input.projectRoot, "rev-parse", "--show-toplevel"]);
    expectOk(top, "git rev-parse --show-toplevel");
    const repoRoot = top.stdout.trim();
    const branchRes = await runGit(this.git(), ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    expectOk(branchRes, "git rev-parse --abbrev-ref HEAD");
    const baseBranch = branchRes.stdout.trim();
    const commitRes = await runGit(this.git(), ["-C", repoRoot, "rev-parse", "HEAD"]);
    expectOk(commitRes, "git rev-parse HEAD");
    const baseCommit = commitRes.stdout.trim();

    const worktreePath = resolve(this.options.baseDir, input.runId);
    const branchName = `always-on/${input.runId}`;
    const add = await runGit(this.git(), [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      baseCommit,
    ]);
    if (add.exitCode !== 0) {
      throw new AlwaysOnError(
        "workspace_prepare_failed",
        `git worktree add failed: ${add.stderr || add.stdout}`,
        { repoRoot, worktreePath },
      );
    }

    this.options.onWorktreeCreated?.(input.runId, worktreePath);
    return {
      runId: input.runId,
      projectKey: input.projectRoot,
      strategy: this.id,
      cwd: worktreePath,
      metadata: { repoRoot, baseBranch, baseCommit, branchName },
    };
  }

  async publish(handle: WorkspaceHandle): Promise<WorkspacePublishOutput> {
    const repoRoot = handle.metadata.repoRoot ?? handle.cwd;
    const diff = await runGit(this.git(), ["-C", handle.cwd, "diff", "--stat"]).catch(() => undefined);
    return {
      diff: diff && diff.exitCode === 0 ? diff.stdout : undefined,
      commit: undefined,
      // intentionally do not push or commit; caller can layer that on later.
      ...(repoRoot ? {} : {}),
    };
  }

  async dispose(handle: WorkspaceHandle, options: { keep: boolean }): Promise<void> {
    if (options.keep) return;
    this.options.onWorktreeRemoved?.(handle.cwd);
    const repoRoot = handle.metadata.repoRoot ?? handle.cwd;
    const remove = await runGit(this.git(), [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      handle.cwd,
    ]).catch(() => undefined);
    if (!remove || remove.exitCode !== 0) {
      await rm(handle.cwd, { recursive: true, force: true });
      await runGit(this.git(), ["-C", repoRoot, "worktree", "prune"]).catch(() => undefined);
    }
    const branchName = handle.metadata.branchName as string | undefined;
    if (branchName) {
      await runGit(this.git(), ["-C", repoRoot, "branch", "-D", branchName]).catch(() => undefined);
    }
  }

  private git(): string {
    return this.options.gitBin ?? "git";
  }
}

type GitResult = { exitCode: number; stdout: string; stderr: string };

async function runGit(bin: string, args: string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function expectOk(result: GitResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new AlwaysOnError(
      "workspace_prepare_failed",
      `${label} failed: ${result.stderr || result.stdout}`,
    );
  }
}
