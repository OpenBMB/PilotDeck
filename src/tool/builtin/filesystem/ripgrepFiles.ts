import {
  isIgnoredPath,
  normalizeRelativePath,
  runRipgrep,
  splitRipgrepLines,
} from "./ripgrep.js";

const DEFAULT_LIMIT = 1_000;

export type RipgrepFilesInput = {
  cwd: string;
  pattern: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type RipgrepFilesResult = {
  files: string[];
  count: number;
  truncated: boolean;
};

export async function ripgrepFiles(input: RipgrepFilesInput): Promise<RipgrepFilesResult> {
  const stdout = await runRipgrep({
    cwd: input.cwd,
    args: ["--files", "--hidden", "--no-ignore", "--glob", input.pattern, "."],
    env: input.env,
    signal: input.signal,
    toolName: "glob",
  });
  const limit = input.limit ?? DEFAULT_LIMIT;
  const files = splitRipgrepLines(stdout)
    .map(normalizeRelativePath)
    .filter((line) => !isIgnoredPath(line))
    .sort();
  const selected = files.slice(0, limit);
  return {
    files: selected,
    count: files.length,
    truncated: selected.length < files.length,
  };
}
