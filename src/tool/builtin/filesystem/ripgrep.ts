import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";

const require = createRequire(import.meta.url);
const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

export const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export type RipgrepRunInput = {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  toolName: "glob" | "grep";
};

export async function runRipgrep(input: RipgrepRunInput): Promise<string> {
  const env = input.env ?? process.env;
  const args = [...input.args];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(rgPath, args, {
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
      reject(new PilotDeckToolRuntimeError("tool_aborted", `${input.toolName} search aborted.`));
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), DEFAULT_KILL_GRACE_MS).unref();
      reject(
        new PilotDeckToolRuntimeError(
          "tool_timeout",
          `${input.toolName} search timed out after ${DEFAULT_TIMEOUT_MS}ms.`,
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
            `${input.toolName} requires ripgrep (\`rg\`) to be installed and available on PATH.`,
          ),
        );
        return;
      }
      reject(
        new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `ripgrep ${input.toolName} search failed: ${error.message}`,
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
            `ripgrep ${input.toolName} search exited via signal ${signal}.`,
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
            ? `ripgrep ${input.toolName} search failed: ${stderrText}`
            : `ripgrep ${input.toolName} search failed with exit code ${code}.`,
          { exitCode: code, stderr: stderrText || undefined },
        ),
      );
    });
  });
}

export function splitRipgrepLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function normalizeRelativePath(file: string): string {
  const normalized = file.split(path.sep).join("/");
  const withoutDotPrefix = normalized.replace(/^\.\//, "");
  return path.posix.normalize(withoutDotPrefix);
}

export function isIgnoredPath(file: string): boolean {
  return file.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
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
    setTimeout(() => child.kill("SIGKILL"), DEFAULT_KILL_GRACE_MS).unref();
    onAbort();
  };
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
