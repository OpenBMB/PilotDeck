import { spawn } from "node:child_process";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";

const DEFAULT_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

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
  const stdout = await runRipgrepFiles(input);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
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

async function runRipgrepFiles(input: RipgrepFilesInput): Promise<string> {
  const env = input.env ?? process.env;
  const args = ["--files", "--hidden", "--no-ignore", "--glob", input.pattern, "."];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanupAbort = attachAbortHandler(child, input.signal, () => {
      if (settled) return;
      settled = true;
      reject(new PilotDeckToolRuntimeError("tool_aborted", "glob search aborted."));
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      reject(
        new PilotDeckToolRuntimeError(
          "tool_timeout",
          `glob search timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
        ),
      );
    }, DEFAULT_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanupAbort();
      if (settled) return;
      settled = true;
      if (isEnoent(error)) {
        reject(
          new PilotDeckToolRuntimeError(
            "unsupported_tool",
            "glob requires ripgrep (`rg`) to be installed and available on PATH.",
          ),
        );
        return;
      }
      reject(
        new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `ripgrep glob search failed: ${error.message}`,
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      cleanupAbort();
      if (settled) return;
      settled = true;

      if (signal) {
        reject(
          new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            `ripgrep glob search exited via signal ${signal}.`,
          ),
        );
        return;
      }

      if (code === 0 || code === 1) {
        resolve(stdout);
        return;
      }

      const stderrText = stderr.trim();
      reject(
        new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          stderrText.length > 0
            ? `ripgrep glob search failed: ${stderrText}`
            : `ripgrep glob search failed with exit code ${code}.`,
          { exitCode: code, stderr: stderrText || undefined },
        ),
      );
    });
  });
}

function attachAbortHandler(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) {
    return () => {};
  }
  const handler = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    onAbort();
  };
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

function isIgnoredPath(file: string): boolean {
  return file.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function normalizeRelativePath(file: string): string {
  const normalized = file.split(path.sep).join("/");
  const withoutDotPrefix = normalized.replace(/^\.\//, "");
  return path.posix.normalize(withoutDotPrefix);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
