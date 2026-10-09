import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CheckpointError } from "./WorkspaceCheckpoints.js";
import { ensurePilotProjectGitIgnore } from "../../pilot/paths.js";

const execute = promisify(execFile);
import type { RepositoryOperation } from "./types.js";
export type { RepositoryOperation } from "./types.js";

export async function repositoryRoot(workspace: string): Promise<string> {
  return (await execute("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, timeout: 10_000 })).stdout.trim();
}

export async function runRepositoryOperation(workspace: string, input: RepositoryOperation) {
  const git = (args: string[], cwd = workspace) => execute("git", args, { cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (input.operation === "init") {
    const result = await git(["init"]);
    ensurePilotProjectGitIgnore(workspace);
    return { success: true, output: result.stdout };
  }
  const root = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
  const files = () => {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 5000) throw new CheckpointError("INVALID_FILES", "Select files to stage or unstage.");
    return input.files.map(file => {
      if (typeof file !== "string" || !file || file.includes("\0") || path.isAbsolute(file)) throw new CheckpointError("INVALID_PATH", "Invalid repository path.");
      const relative = path.relative(root, path.resolve(root, file));
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).includes(".git")) throw new CheckpointError("INVALID_PATH", "File is outside the repository.");
      return file;
    });
  };
  try {
    let args: string[];
    switch (input.operation) {
      case "stage": args = ["--literal-pathspecs", "add", "--", ...files()]; break;
      case "unstage": {
        const hasHead = await git(["rev-parse", "--verify", "HEAD"], root).then(() => true, () => false);
        args = hasHead ? ["--literal-pathspecs", "restore", "--staged", "--", ...files()] : ["--literal-pathspecs", "rm", "--cached", "-f", "--ignore-unmatch", "--", ...files()];
        break;
      }
      case "commit": {
        if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 20_000) throw new CheckpointError("INVALID_MESSAGE", "Enter a commit message.");
        if (!input.expectedIndexTree || !/^[a-f0-9]{40,64}$/.test(input.expectedIndexTree)) throw new CheckpointError("INDEX_CHANGED", "Refresh and review the staging area before committing.");
        if ((await git(["write-tree"], root)).stdout.trim() !== input.expectedIndexTree) throw new CheckpointError("INDEX_CHANGED", "The staging area changed. Refresh and review it before committing.");
        args = ["commit", "-m", input.message]; break;
      }
      case "checkout": {
        if (typeof input.branch !== "string" || input.branch.startsWith("-") || input.branch.includes("\0")) throw new CheckpointError("INVALID_BRANCH", "Invalid branch.");
        await git(["check-ref-format", "--branch", input.branch], root);
        args = ["checkout", input.branch]; break;
      }
      case "push": {
        const hasUpstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root).then(() => true, () => false);
        if (hasUpstream) {
          const branch = (await git(["symbolic-ref", "--short", "HEAD"], root)).stdout.trim();
          const remote = (await git(["config", "--get", `branch.${branch}.remote`], root)).stdout.trim();
          const target = (await git(["config", "--get", `branch.${branch}.merge`], root)).stdout.trim();
          args = ["push", "--", remote, `HEAD:${target}`];
        } else {
          const remotes = (await git(["remote"], root)).stdout.trim().split("\n").filter(Boolean);
          const remote = remotes.includes("origin") ? "origin" : remotes[0];
          if (!remote) throw new CheckpointError("NO_REMOTE", "Configure a remote repository before pushing.");
          args = ["push", "--set-upstream", "--", remote, "HEAD"];
        }
        break;
      }
      case "fetch": args = ["fetch"]; break;
      case "remote": {
        if (typeof input.remoteUrl !== "string" || !input.remoteUrl.trim() || input.remoteUrl.startsWith("-") || /[\s\0]/.test(input.remoteUrl)) throw new CheckpointError("INVALID_REMOTE", "Enter a valid remote URL.");
        if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(input.remoteUrl)) throw new CheckpointError("INVALID_REMOTE", "Use an HTTPS or SSH remote URL.");
        const hasOrigin = await git(["remote", "get-url", "origin"], root).then(() => true, () => false);
        args = ["remote", hasOrigin ? "set-url" : "add", "origin", input.remoteUrl]; break;
      }
      default: throw new CheckpointError("INVALID_ACTION", "Unsupported Git operation.");
    }
    const result = await git(args, root);
    return { success: true, output: result.stdout || result.stderr };
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    const details = error as Error & { stderr?: string };
    throw new CheckpointError("GIT_FAILED", details.stderr?.trim() || details.message);
  }
}
