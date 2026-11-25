import { createRequire } from "node:module";
import { resolveDefaultCommandShell } from "../../../runtime/commandShell.js";
import {
  NodeShellCommandRunner,
  createShellOutputDecoder,
  type PilotDeckCommandOptions,
  type PilotDeckCommandResult,
  type PilotDeckCommandRunner,
} from "./commandRunner.js";

type SandboxOutputEvent = {
  kind: "stdout" | "stderr" | "exit" | "error";
  data?: Buffer;
  exitCode?: number | null;
  error?: string;
};

type NativeSandboxBinding = {
  sandboxBackend(): string;
  startSandboxed(
    options: {
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
      allowNetwork?: boolean;
      windowsVerbatimArguments?: boolean;
    },
    onEvent: (err: Error | null, event: SandboxOutputEvent) => void,
  ): number;
  killSandboxed(id: number): boolean;
};

let cachedBinding: NativeSandboxBinding | null | undefined;

function loadNativeSandbox(): NativeSandboxBinding | null {
  if (cachedBinding !== undefined) {
    return cachedBinding;
  }
  try {
    const require = createRequire(import.meta.url);
    const loaded = require("@pilotdeck/native-sandbox") as NativeSandboxBinding;
    cachedBinding = loaded && typeof loaded.sandboxBackend === "function" ? loaded : null;
  } catch {
    cachedBinding = null;
  }
  return cachedBinding;
}

export function getSandboxBackend(): string {
  const binding = loadNativeSandbox();
  if (!binding) return "unsupported";
  try {
    return binding.sandboxBackend();
  } catch {
    return "unsupported";
  }
}

export function isNativeSandboxAvailable(): boolean {
  return getSandboxBackend() !== "unsupported";
}

export type SandboxedCommandRunnerOptions = {
  allowNetwork?: boolean;
  fallbackRunner?: PilotDeckCommandRunner;
  /** @internal Testing seam to inject a mock native binding. */
  binding?: NativeSandboxBinding | null;
};

const ABORT_FORCE_RESOLVE_MS = 15_000;

export class SandboxedCommandRunner implements PilotDeckCommandRunner {
  private readonly fallback: PilotDeckCommandRunner;
  private readonly allowNetwork: boolean;
  private readonly injectedBinding?: NativeSandboxBinding | null;

  constructor(options: SandboxedCommandRunnerOptions = {}) {
    this.allowNetwork = options.allowNetwork ?? false;
    this.fallback = options.fallbackRunner ?? new NodeShellCommandRunner();
    this.injectedBinding = options.binding;
  }

  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const binding = this.injectedBinding !== undefined ? this.injectedBinding : loadNativeSandbox();
    if (!binding || binding.sandboxBackend() === "unsupported") {
      return this.fallback.run(command, options);
    }

    const startedAt = Date.now();
    const shell = resolveDefaultCommandShell({ env: options.env });
    const env = options.env
      ? Object.fromEntries(
        Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      : undefined;

    return new Promise((resolve, reject) => {
      const stdoutDecoder = createShellOutputDecoder();
      const stderrDecoder = createShellOutputDecoder();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let handleId = 0;
      let forceResolveTimer: ReturnType<typeof setTimeout> | undefined;

      function cleanup() {
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceResolveTimer) clearTimeout(forceResolveTimer);
        options.signal?.removeEventListener("abort", onAbort);
      }

      function forceResolveAfterKill() {
        if (forceResolveTimer) return;
        forceResolveTimer = setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve({
            exitCode: null,
            stdout,
            stderr: stderr + "\n[PilotDeck] Sandboxed process did not exit within 15s after termination; force-resolved.",
            timedOut: true,
            durationMs: Date.now() - startedAt,
          });
        }, ABORT_FORCE_RESOLVE_MS);
        forceResolveTimer.unref();
      }

      function terminate() {
        if (handleId > 0) {
          try {
            binding!.killSandboxed(handleId);
          } catch {
            // Best-effort termination.
          }
        }
        forceResolveAfterKill();
      }

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, options.timeoutMs);

      const onAbort = () => {
        if (settled) return;
        terminate();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        handleId = binding.startSandboxed(
          {
            command: shell.shell,
            args: shell.args(command),
            cwd: options.cwd,
            env,
            allowNetwork: this.allowNetwork,
            windowsVerbatimArguments: shell.windowsVerbatimArguments,
          },
          (err, event) => {
            if (settled) return;
            if (err) {
              cleanup();
              reject(err);
              return;
            }
            if (event.kind === "stdout" && event.data) {
              const text = stdoutDecoder.decode(event.data);
              stdout += text;
              try {
                options.onStdout?.(text);
              } catch {
                // Progress callbacks are fire-and-forget.
              }
              return;
            }
            if (event.kind === "stderr" && event.data) {
              const text = stderrDecoder.decode(event.data);
              stderr += text;
              try {
                options.onStderr?.(text);
              } catch {
                // Progress callbacks are fire-and-forget.
              }
              return;
            }
            if (event.kind === "error") {
              cleanup();
              reject(new Error(event.error ?? "Sandboxed process failed"));
              return;
            }
            if (event.kind === "exit") {
              stdout += stdoutDecoder.flush();
              stderr += stderrDecoder.flush();
              cleanup();
              resolve({
                exitCode: event.exitCode ?? null,
                stdout,
                stderr,
                timedOut,
                durationMs: Date.now() - startedAt,
              });
            }
          },
        );
      } catch (spawnError) {
        cleanup();
        reject(spawnError);
      }
    });
  }
}

