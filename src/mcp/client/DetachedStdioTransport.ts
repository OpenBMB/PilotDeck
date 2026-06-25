/**
 * DetachedStdioTransport
 *
 * A drop-in replacement for `StdioClientTransport` that spawns the child
 * process with `detached: true`, creating a dedicated process group.
 *
 * WHY: The SDK's StdioClientTransport spawns with detached=false (default),
 * putting the child in the parent's process group. When McpClient.close()
 * calls `kill(-pid, SIGKILL)`, the kernel targets the process group whose
 * PGID == pid. Since the child is NOT the group leader, PGID != PID, so
 * the kill hits a non-existent group and fails with ESRCH (silently caught).
 *
 * RESULT: tsx's grandchildren (playwright-mcp, Chromium) are orphaned.
 *
 * FIX: With `detached: true`, tsx becomes its own process group leader
 * (PGID == PID). All descendants inherit this group. Now `kill(-pid, SIGKILL)`
 * atomically wipes the entire tree.
 */

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Mirrors the StdioServerParameters shape the SDK uses. */
interface SpawnParams {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: string;
}

/** Minimal shape we need from the spawned child process. */
interface ChildProc {
  pid: number | null;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Minimal default-env helper, replicated from the SDK to avoid
 * relying on non-public export paths.
 */
const INHERITED_KEYS =
  process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

function getDefaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_KEYS) {
    const v = process.env[k];
    if (v !== undefined && !v.startsWith("()")) env[k] = v;
  }
  return env;
}

/** UTF-8 encode a JSON-RPC message for the stdin pipe. */
function encode(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg), "utf-8");
}

/**
 * Simple streaming JSON-RPC reader. Accumulates chunks and yields complete
 * JSON objects (one per line-delimited message, matching the MCP stdio
 * framing convention).
 */
class LineDelimitedReadBuffer {
  private _buffer = "";

  append(chunk: Buffer): void {
    this._buffer += chunk.toString("utf-8");
  }

  readMessage(): JSONRPCMessage | null {
    const nl = this._buffer.indexOf("\n");
    if (nl === -1) return null;
    const line = this._buffer.slice(0, nl);
    this._buffer = this._buffer.slice(nl + 1);
    try {
      return JSON.parse(line) as JSONRPCMessage;
    } catch {
      return null; // skip malformed lines
    }
  }

  clear(): void {
    this._buffer = "";
  }
}

export class DetachedStdioTransport implements Transport {
  private _process: ChildProc | null = null;
  private _readBuffer = new LineDelimitedReadBuffer();
  private _stderrPassThrough: import("node:stream").PassThrough | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** The PID of the detached child process group leader. */
  get pid(): number | null {
    return this._process?.pid ?? null;
  }

  get stderr() {
    return this._stderrPassThrough ?? this._process?.stderr ?? null;
  }

  constructor(private readonly params: SpawnParams) {
    if (params.stderr === "pipe" || params.stderr === "overlapped") {
      this._stderrPassThrough = new (require("node:stream").PassThrough)();
    }
  }

  async start(): Promise<void> {
    if (this._process) {
      throw new Error("DetachedStdioTransport already started!");
    }

    return new Promise<void>((resolve, reject) => {
      // Build stdio array with explicit typing to avoid TS intersection issues
      const stderrMode: import("node:child_process").IOType | "overlapped" | undefined =
        (this.params.stderr as import("node:child_process").IOType | "overlapped" | undefined) ?? "inherit";
      const stdio: import("node:child_process").StdioOptions = [
        "pipe",   // stdin
        "pipe",   // stdout
        stderrMode,
      ];

      const child = spawn(this.params.command, this.params.args ?? [], {
        env: { ...getDefaultEnv(), ...this.params.env },
        stdio,
        shell: false,
        windowsHide: process.platform === "win32",
        cwd: this.params.cwd,
        // ★ The entire point of this class:
        detached: true,
      }) as unknown as ChildProc;

      this._process = child;

      child.on("error", (error) => {
        reject(error as Error);
        this.onerror?.(error as Error);
      });

      child.on("spawn", () => resolve());

      child.on("close", () => {
        this._process = null;
        this.onclose?.();
      });

      child.stdin?.on("error", (error) => this.onerror?.(error as Error));

      child.stdout?.on("data", (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this._processReadBuffer();
      });

      child.stdout?.on("error", (error) => this.onerror?.(error as Error));

      if (this._stderrPassThrough && child.stderr) {
        child.stderr.pipe(this._stderrPassThrough);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._process?.stdin) throw new Error("Not connected");
    return new Promise<void>((resolve) => {
      if (this._process!.stdin!.write(encode(message))) {
        resolve();
      } else {
        this._process!.stdin!.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    if (!this._process) return;
    const proc = this._process;
    this._process = null;

    const closed = new Promise<void>((r) => proc.once("close", () => r()));

    try { proc.stdin?.end(); } catch { /* ignore */ }

    // Give it 2s to exit gracefully after stdin EOF
    await Promise.race([closed, sleep(2000)]);

    if (proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      await Promise.race([closed, sleep(2000)]);
    }

    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }

    this._readBuffer.clear();
  }

  private _processReadBuffer(): void {
    while (true) {
      const msg = this._readBuffer.readMessage();
      if (msg === null) break;
      this.onmessage?.(msg);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}
