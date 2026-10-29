import { promises as fs } from "node:fs";
import path from "node:path";
import type { RepositoryOperation } from "./types.js";
import { CheckpointError } from "./WorkspaceCheckpoints.js";

/** Compatibility endpoints execute under the same Gateway lease as modern Git operations. */
export async function runLegacyRepositoryOperation(root: string, input: RepositoryOperation, git: (args: string[]) => Promise<{ stdout: string; stderr: string }>) {
  const action = input.legacyAction;
  const branch = async () => {
    if (!input.branch || input.branch.startsWith("-") || input.branch.includes("\0")) throw new CheckpointError("INVALID_BRANCH", "Invalid branch.");
    await git(["check-ref-format", "--branch", input.branch]); return input.branch;
  };
  const files = () => {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 5000) throw new CheckpointError("INVALID_FILES", "Select files.");
    return input.files.map(file => {
      const relative = path.relative(root, path.resolve(root, file));
      if (!relative || path.isAbsolute(file) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.split(path.sep).includes(".git") || file.includes("\0")) throw new CheckpointError("INVALID_PATH", "Invalid repository path.");
      return file;
    });
  };
  let result: { stdout: string; stderr: string };
  if (action === "initial-commit") {
    if (await git(["rev-parse", "--verify", "HEAD"]).then(() => true, () => false)) throw new CheckpointError("HAS_COMMITS", "Repository already has commits.");
    await git(["add", "."]); result = await git(["commit", "-m", "Initial commit"]);
  } else if (action === "commit") {
    if (!input.message?.trim()) throw new CheckpointError("INVALID_MESSAGE", "Enter a commit message.");
    await git(["--literal-pathspecs", "add", "--", ...files()]); result = await git(["commit", "-m", input.message]);
  } else if (action === "revert-local-commit") {
    await git(["rev-parse", "--verify", "HEAD"]);
    if (await git(["rev-parse", "--verify", "HEAD~1"]).then(() => true, () => false)) result = await git(["reset", "--soft", "HEAD~1"]);
    else result = await git(["update-ref", "-d", "HEAD"]);
  } else if (action === "checkout") result = await git(["checkout", await branch()]);
  else if (action === "create-branch") result = await git(["checkout", "-b", await branch()]);
  else if (action === "delete-branch") result = await git(["branch", "-d", await branch()]);
  else if (action === "discard" || action === "delete-untracked") {
    const selected = files();
    if (selected.length !== 1) throw new CheckpointError("INVALID_FILES", "Select one file.");
    const file = selected[0], status = (await git(["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--", file])).stdout.slice(0, 2);
    if (status === "??") {
      const target = path.resolve(root, file), parent = await fs.realpath(path.dirname(target));
      const relativeParent = path.relative(root, parent);
      if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) throw new CheckpointError("INVALID_PATH", "File resolves outside the repository.");
      await fs.rm(target, { recursive: true }); result = { stdout: "File deleted.", stderr: "" };
    } else if (action === "delete-untracked") throw new CheckpointError("INVALID_FILES", "File is not untracked.");
    else if (status.includes("M") || status.includes("D")) result = await git(["--literal-pathspecs", "restore", "--", file]);
    else if (status.includes("A")) result = await git(["--literal-pathspecs", "reset", "HEAD", "--", file]);
    else throw new CheckpointError("INVALID_FILES", "No changes to discard.");
  } else if (["fetch", "pull", "push", "publish"].includes(action ?? "")) {
    const current = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    let configuredRemote = await git(["config", "--get", `branch.${current}.remote`]).then(value => value.stdout.trim(), () => "");
    if (!configuredRemote) {
      const remotes = (await git(["remote"])).stdout.trim().split(/\r?\n/).filter(Boolean);
      configuredRemote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!configuredRemote) throw new CheckpointError("NO_REMOTE", "Configure a remote repository before publishing.");
    }
    const ref = await git(["config", "--get", `branch.${current}.merge`]).then(value => value.stdout.trim().replace(/^refs\/heads\//, ""), () => current);
    if (configuredRemote.startsWith("-") || ref.startsWith("-")) throw new CheckpointError("INVALID_REMOTE", "Invalid remote.");
    if (action === "fetch") result = await git(["fetch", "--", configuredRemote]);
    else if (action === "pull") result = await git(["pull", "--", configuredRemote, ref]);
    else if (action === "publish") {
      if (await branch() !== current) throw new CheckpointError("INVALID_BRANCH", "The current branch changed.");
      result = await git(["push", "--set-upstream", "--", configuredRemote, current]);
    } else result = await git(["push", "--", configuredRemote, `HEAD:refs/heads/${ref}`]);
  } else throw new CheckpointError("INVALID_ACTION", "Unsupported Git operation.");
  return { success: true, output: result.stdout || result.stderr };
}
