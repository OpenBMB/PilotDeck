import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

export type PilotDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called on each stdout chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStdout?: (chunk: string) => void;
  /** Called on each stderr chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStderr?: (chunk: string) => void;
  /** Called when shell output appears to be waiting for stdin. */
  onInputRequest?: (request: PilotDeckCommandInputRequest) => Promise<PilotDeckCommandInputResponse>;
};

export type PilotDeckCommandInputRequest = {
  prompt: string;
  stream: "stdout" | "stderr";
  secret: boolean;
  outputTail: string;
};

export type PilotDeckCommandInputResponse =
  | { type: "answered"; input: string }
  | { type: "cancelled"; reason?: string };

export type PilotDeckCommandInteraction = {
  prompt: string;
  stream: "stdout" | "stderr";
  secret: boolean;
  answered: boolean;
  cancelledReason?: string;
};

export type PilotDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  interactions?: PilotDeckCommandInteraction[];
  interactiveInputCancelled?: boolean;
  interactiveInputCancelledReason?: string;
};

export type PilotDeckCommandRunner = {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult>;
};

type SpawnShell = typeof spawn;

export class NodeShellCommandRunner implements PilotDeckCommandRunner {
  constructor(private readonly spawnShell: SpawnShell = spawn) {}

  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32";
      const child = this.spawnShell(command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        detached: !isWindows,
        windowsHide: isWindows,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let inputCancelled = false;
      let inputCancelledReason: string | undefined;
      const interactions: PilotDeckCommandInteraction[] = [];
      const promptDetector = createInteractivePromptDetector();

      function resultMetadata() {
        return {
          ...(interactions.length > 0 ? { interactions } : {}),
          ...(inputCancelled ? { interactiveInputCancelled: true } : {}),
          ...(inputCancelledReason ? { interactiveInputCancelledReason: inputCancelledReason } : {}),
        };
      }

      function killProcessGroup() {
        const pid = child.pid;
        if (!pid) return;
        if (process.platform === "win32") {
          try {
            const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.on("error", () => undefined);
            killer.unref();
          } catch { /* best-effort */ }
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
        forceResolveAfterKill();
      }, options.timeoutMs);

      const ABORT_FORCE_RESOLVE_MS = 15_000;

      function forceResolveAfterKill() {
        setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve({
            exitCode: null,
            stdout,
            stderr: stderr + "\n[PilotDeck] Process did not exit within 15s after termination; force-resolved.",
            timedOut: true,
            durationMs: Date.now() - startedAt,
            ...resultMetadata(),
          });
        }, ABORT_FORCE_RESOLVE_MS).unref();
      }

      const onAbort = () => {
        if (settled) return;
        killProcessGroup();
        forceResolveAfterKill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      function cleanup() {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }

      const stdoutDecoder = createShellOutputDecoder();
      const stderrDecoder = createShellOutputDecoder();
      let closeFallback: ReturnType<typeof setTimeout> | undefined;

      function finish(exitCode: number | null) {
        if (closeFallback) {
          clearTimeout(closeFallback);
          closeFallback = undefined;
        }
        stdout += stdoutDecoder.flush();
        stderr += stderrDecoder.flush();
        cleanup();
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
          ...resultMetadata(),
        });
      }

      async function maybeAnswerPrompt(stream: "stdout" | "stderr", text: string) {
        if (settled || !options.onInputRequest || !child.stdin?.writable) return;
        const detected = promptDetector.observe(stream, text);
        if (!detected) return;

        const interaction: PilotDeckCommandInteraction = {
          prompt: detected.prompt,
          stream,
          secret: detected.secret,
          answered: false,
        };
        interactions.push(interaction);

        try {
          const response = await options.onInputRequest({
            prompt: detected.prompt,
            stream,
            secret: detected.secret,
            outputTail: detected.outputTail,
          });
          if (settled) return;
          if (response.type === "cancelled") {
            interaction.cancelledReason = response.reason;
            inputCancelled = true;
            inputCancelledReason = response.reason;
            stderr += `\n[PilotDeck] Interactive input cancelled${response.reason ? `: ${response.reason}` : ""}.`;
            killProcessGroup();
            forceResolveAfterKill();
            return;
          }
          interaction.answered = true;
          child.stdin.write(`${response.input}\n`);
          promptDetector.markAnswered();
        } catch (error) {
          if (settled) return;
          const reason = error instanceof Error ? error.message : String(error);
          interaction.cancelledReason = reason;
          inputCancelled = true;
          inputCancelledReason = reason;
          stderr += `\n[PilotDeck] Interactive input failed: ${reason}`;
          killProcessGroup();
          forceResolveAfterKill();
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.decode(chunk);
        stdout += text;
        if (options.onStdout) {
          try {
            options.onStdout(text);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
        void maybeAnswerPrompt("stdout", text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.decode(chunk);
        stderr += text;
        if (options.onStderr) {
          try {
            options.onStderr(text);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
        void maybeAnswerPrompt("stderr", text);
      });
      child.on("error", (error) => {
        stdout += stdoutDecoder.flush();
        stderr += stderrDecoder.flush();
        cleanup();
        if (options.signal?.aborted) {
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: true,
            durationMs: Date.now() - startedAt,
            ...resultMetadata(),
          });
          return;
        }
        reject(error);
      });
      child.on("exit", (exitCode) => {
        if (process.platform !== "win32" || settled || closeFallback) {
          return;
        }
        closeFallback = setTimeout(() => {
          if (settled) return;
          finish(exitCode);
        }, 250);
        closeFallback.unref();
      });
      child.on("close", (exitCode) => {
        finish(exitCode);
      });
    });
  }
}

type DetectedPrompt = {
  prompt: string;
  secret: boolean;
  outputTail: string;
};

function createInteractivePromptDetector(): {
  observe(stream: "stdout" | "stderr", text: string): DetectedPrompt | undefined;
  markAnswered(): void;
} {
  let tail = "";
  let waitingForAnswer = false;

  return {
    observe(stream, text) {
      tail = `${tail}${text}`.slice(-2000);
      if (waitingForAnswer) return undefined;
      const detected = detectInteractivePrompt(tail);
      if (!detected) return undefined;
      waitingForAnswer = true;
      return { ...detected, outputTail: tail };
    },
    markAnswered() {
      waitingForAnswer = false;
      tail = "";
    },
  };
}

export function detectInteractivePrompt(outputTail: string): { prompt: string; secret: boolean } | undefined {
  const normalized = outputTail.replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const last = (lines.at(-1) ?? "").trim();
  const previous = (lines.at(-2) ?? "").trim();
  const candidate = last.length > 0 ? last : previous;
  if (!candidate || candidate.length > 240) return undefined;

  const secret =
    /\b(password|passphrase|passcode|token|api[ _-]?key|secret|otp|verification code|auth(?:entication)? code)\b/i.test(candidate);
  const explicitInput =
    /(?:[:：]\s*$|\?\s*$)/.test(candidate) &&
    /\b(username|user name|login|email|password|passphrase|passcode|token|api[ _-]?key|secret|otp|verification code|auth(?:entication)? code|enter|input|confirm|continue|yes\/no)\b/i.test(candidate);
  const sshHostKey = /\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i.test(candidate);
  const sudoPassword = /\[sudo\]\s+password\s+for\s+.+:\s*$/i.test(candidate);

  if (!secret && !explicitInput && !sshHostKey && !sudoPassword) return undefined;
  if (/^\s*(warning|error|failed):/i.test(candidate) && !secret && !sshHostKey) return undefined;
  return { prompt: candidate, secret };
}

export type ShellOutputDecoder = {
  decode(chunk: Buffer): string;
  flush(): string;
};

export function createShellOutputDecoder(): ShellOutputDecoder {
  if (process.platform !== "win32") {
    const decoder = new TextDecoder("utf-8");
    return {
      decode: (chunk) => decoder.decode(chunk, { stream: true }),
      flush: () => decoder.decode(),
    };
  }

  return createWindowsShellOutputDecoder();
}

export function decodeShellOutput(chunk: Buffer): string {
  if (process.platform !== "win32") {
    return chunk.toString("utf8");
  }
  const decoder = createWindowsShellOutputDecoder();
  return decoder.decode(chunk) + decoder.flush();
}

function createWindowsShellOutputDecoder(): ShellOutputDecoder {
  let mode: "unknown" | "utf8" | "gb18030" = "unknown";
  let pending = Buffer.alloc(0);
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  let gb18030Decoder: TextDecoder | undefined;

  return {
    decode: (chunk) => {
      if (mode === "utf8") {
        return utf8Decoder.decode(chunk, { stream: true });
      }
      if (mode === "gb18030") {
        gb18030Decoder ??= new TextDecoder("gb18030");
        return gb18030Decoder.decode(chunk, { stream: true });
      }

      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      if (!hasNonAsciiByte(pending)) {
        const text = pending.toString("utf8");
        pending = Buffer.alloc(0);
        return text;
      }

      const utf8Status = inspectUtf8(pending);
      if (utf8Status === "incomplete") {
        return "";
      }
      if (utf8Status === "valid") {
        mode = "utf8";
        const text = utf8Decoder.decode(pending, { stream: true });
        pending = Buffer.alloc(0);
        return text;
      }

      mode = "gb18030";
      gb18030Decoder = new TextDecoder("gb18030");
      const text = gb18030Decoder.decode(pending, { stream: true });
      pending = Buffer.alloc(0);
      return text;
    },
    flush: () => {
      if (mode === "utf8") {
        return utf8Decoder.decode();
      }
      if (mode === "gb18030") {
        return gb18030Decoder?.decode() ?? "";
      }
      const text = pending.toString("utf8");
      pending = Buffer.alloc(0);
      return text;
    },
  };
}

function hasNonAsciiByte(chunk: Buffer): boolean {
  return chunk.some((byte) => byte >= 0x80);
}

function inspectUtf8(chunk: Buffer): "valid" | "incomplete" | "invalid" {
  for (let i = 0; i < chunk.length; i += 1) {
    const byte = chunk[i]!;
    if (byte <= 0x7f) continue;

    let expectedContinuation = 0;
    let minCodePoint = 0;
    let codePoint = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      expectedContinuation = 1;
      minCodePoint = 0x80;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      expectedContinuation = 2;
      minCodePoint = 0x800;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      expectedContinuation = 3;
      minCodePoint = 0x10000;
      codePoint = byte & 0x07;
    } else {
      return "invalid";
    }

    if (i + expectedContinuation >= chunk.length) {
      return "incomplete";
    }

    for (let offset = 1; offset <= expectedContinuation; offset += 1) {
      const continuation = chunk[i + offset]!;
      if ((continuation & 0xc0) !== 0x80) {
        return "invalid";
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return "invalid";
    }

    i += expectedContinuation;
  }
  return "valid";
}
