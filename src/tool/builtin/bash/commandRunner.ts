import { spawn } from "node:child_process";

export type PilotDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called on each stdout chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStdout?: (chunk: string) => void;
  /** Called on each stderr chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStderr?: (chunk: string) => void;
};

export type PilotDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type PilotDeckCommandRunner = {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult>;
};

export class NodeShellCommandRunner implements PilotDeckCommandRunner {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      function killProcessGroup() {
        const pid = child.pid;
        if (!pid) return;
        if (process.platform === "win32") {
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }, 3000).unref();
        } else {
          try { process.kill(-pid, "SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
          }, 3000).unref();
        }
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup();
      }, options.timeoutMs);

      const onAbort = () => {
        if (settled) return;
        killProcessGroup();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      function cleanup() {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.onStdout) {
          try {
            options.onStdout(chunk);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (options.onStderr) {
          try {
            options.onStderr(chunk);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.on("error", (error) => {
        cleanup();
        if (options.signal?.aborted) {
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: true,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        reject(error);
      });
      child.on("close", (exitCode) => {
        cleanup();
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
