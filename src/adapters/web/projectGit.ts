/**
 * Structured Git status / diff for the Web Files+Git panels.
 *
 * Phase 4 minimum: read-only status + diff. Commit / push / branch
 * mutation requires permission gating + transcript audit and is deferred.
 */

import { spawn } from "node:child_process";

export type GitFileStatus = {
  path: string;
  /** Two-character porcelain status code, e.g. " M", "??", "MM". */
  index: string;
  workTree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

export type GitStatusResult = {
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
};

export type GitDiffResult = {
  path?: string;
  diff: string;
};

export type ProjectGitServiceOptions = {
  projectRoot: string;
  /** Override for tests. */
  runner?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
};

export class ProjectGitService {
  private readonly run: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

  constructor(private readonly options: ProjectGitServiceOptions) {
    this.run = options.runner ?? this.defaultRunner.bind(this);
  }

  async status(): Promise<GitStatusResult> {
    const { stdout } = await this.run(["status", "--porcelain=v2", "--branch"]);
    return parsePorcelainV2(stdout);
  }

  async diff(path?: string): Promise<GitDiffResult> {
    const args = ["diff", "--unified=3"];
    if (path) {
      args.push("--", path);
    }
    const { stdout } = await this.run(args);
    return { path, diff: stdout };
  }

  private async defaultRunner(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return await new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.options.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }
}

export function parsePorcelainV2(input: string): GitStatusResult {
  const lines = input.split("\n");
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: GitFileStatus[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (line.startsWith("? ")) {
      const path = line.slice(2);
      files.push({
        path,
        index: "?",
        workTree: "?",
        staged: false,
        unstaged: true,
        untracked: true,
      });
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const tokens = line.split(" ");
      const xy = tokens[1] ?? "  ";
      const indexStatus = xy[0] ?? " ";
      const workTreeStatus = xy[1] ?? " ";
      const path = tokens.slice(8).join(" ");
      files.push({
        path,
        index: indexStatus,
        workTree: workTreeStatus,
        staged: indexStatus !== "." && indexStatus !== " ",
        unstaged: workTreeStatus !== "." && workTreeStatus !== " ",
        untracked: false,
      });
    }
  }

  return { branch, ahead, behind, files };
}
