/**
 * `BackgroundTaskRuntime` — the central registry + spawn / kill orchestrator
 * for C5 background bash tasks (§6.5). Mirrors the legacy upstream
 * LocalShellTask behaviour (T1-T11).
 *
 * Process model:
 *   - `start(spec)` spawns a *detached* child via `spawn(command, { shell:
 *     true, detached: true })` and immediately calls `child.unref()` so the
 *     PilotDeck process can exit without waiting for the child. (T11)
 *   - stdout / stderr are piped into a `TaskOutputStore` (1 MB ring buffer
 *     + optional disk spill). The runtime never blocks on the stream — the
 *     child runs free until either it exits or `stop` is called.
 *   - `stop(taskId)` issues SIGTERM and, after `graceMs` (default 5000),
 *     escalates to SIGKILL.
 *   - `killForAgent(agentId)` and `killAll()` provide the SessionRouter
 *     hooks the cron-PR coordination notes call for (priority window
 *     200-299, see §6.5.5 step 7 of the deferred-feature guide).
 *
 * Platform support: macOS, Linux, and Windows. On Windows, `child.kill()`
 * maps SIGTERM/SIGKILL to TerminateProcess; `detached` creates a new
 * console group rather than a Unix process group.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TaskOutputStore } from "../storage/TaskOutputStore.js";
import type {
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckTaskOutputSlice,
} from "../protocol/types.js";

export type BackgroundTaskRuntimeOptions = {
  /** Optional dir under which to spill output (default: in-memory only). */
  diskSpillDir?: string;
  /** Override `now()` for deterministic tests. */
  now?: () => Date;
  /** Override the spawn function (used by tests). */
  spawn?: typeof spawn;
  /** Hard cap on simultaneous tasks (default: 32). */
  maxTasks?: number;
};

export type StartTaskSpec = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  kind?: PilotDeckBackgroundTaskKind;
};

export type StopTaskOptions = {
  graceMs?: number;
};

type RuntimeEntry = {
  task: PilotDeckBackgroundBashTask;
  child?: ChildProcess;
  output: TaskOutputStore;
  /** Resolved when the child has fully exited (success, failure, or kill). */
  done: Promise<void>;
};

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_TASKS = 32;

export class BackgroundTaskRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly options: Required<
    Pick<BackgroundTaskRuntimeOptions, "now" | "spawn" | "maxTasks">
  > &
    Pick<BackgroundTaskRuntimeOptions, "diskSpillDir">;

  constructor(options: BackgroundTaskRuntimeOptions = {}) {
    this.options = {
      now: options.now ?? (() => new Date()),
      spawn: options.spawn ?? spawn,
      maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
      diskSpillDir: options.diskSpillDir,
    };
  }

  list(filter: PilotDeckBackgroundTaskListFilter = {}): PilotDeckBackgroundBashTask[] {
    const result: PilotDeckBackgroundBashTask[] = [];
    for (const entry of this.entries.values()) {
      if (filter.agentId && entry.task.agentId !== filter.agentId) continue;
      if (filter.kind && entry.task.kind !== filter.kind) continue;
      if (filter.status) {
        const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!wanted.includes(entry.task.status)) continue;
      }
      result.push(entry.task);
    }
    return result;
  }

  get(taskId: string): PilotDeckBackgroundBashTask | undefined {
    return this.entries.get(taskId)?.task;
  }

  /**
   * Spawn the command in the background. Resolves once the child has been
   * forked (typically <10 ms). `task.status` flips to `running` on spawn
   * and `completed` / `failed` / `cancelled` later via the `exit` listener.
   */
  async start(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask> {
    if (this.entries.size >= this.options.maxTasks) {
      throw new Error(
        `BackgroundTaskRuntime: max tasks (${this.options.maxTasks}) exceeded.`,
      );
    }

    const taskId = randomUUID();
    const startedAt = this.options.now();
    const task: PilotDeckBackgroundBashTask = {
      taskId,
      type: "local_bash",
      agentId: spec.agentId,
      kind: spec.kind ?? "bash",
      command: spec.command,
      cwd: spec.cwd,
      status: "pending",
      completionStatusSentInAttachment: false,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
      interrupted: false,
      startedAt,
      outputBytes: 0,
    };

    const output = new TaskOutputStore({
      taskId,
      diskSpillDir: this.options.diskSpillDir,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    let child: ChildProcess;
    try {
      child = this.options.spawn(spec.command, {
        cwd: spec.cwd,
        env: spec.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child.unref();
    } catch (err) {
      task.status = "failed";
      task.endedAt = this.options.now();
      const message = err instanceof Error ? err.message : String(err);
      output.append(Buffer.from(`spawn error: ${message}\n`));
      task.outputBytes = output.totalBytes();
      this.entries.set(taskId, { task, output, done: Promise.resolve() });
      resolveDone();
      return task;
    }

    task.status = "running";
    task.pid = typeof child.pid === "number" ? child.pid : undefined;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      output.append(chunk);
      task.outputBytes = output.totalBytes();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output.append(chunk);
      task.outputBytes = output.totalBytes();
    });
    child.on("error", (err: Error) => {
      output.append(Buffer.from(`error: ${err.message}\n`));
      task.outputBytes = output.totalBytes();
    });
    child.on("exit", (code, signal) => {
      task.endedAt = this.options.now();
      task.exitCode = code ?? null;
      task.outputBytes = output.totalBytes();
      if (task.interrupted || signal === "SIGTERM" || signal === "SIGKILL") {
        task.status = "cancelled";
      } else if (typeof code === "number" && code === 0) {
        task.status = "completed";
      } else {
        task.status = "failed";
      }
      resolveDone();
    });

    this.entries.set(taskId, { task, child, output, done });
    return task;
  }

  /**
   * Stop a task: SIGTERM, wait `graceMs`, then SIGKILL if still alive.
   * Idempotent: stopping an already-finished task is a no-op.
   */
  async stop(taskId: string, options: StopTaskOptions = {}): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    const { task, child, done } = entry;
    if (task.status !== "running") return;
    if (!child) return;
    task.interrupted = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // child already exited
    }
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited between the timer firing and kill()
          }
          resolve();
        }, graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await done;
  }

  /** Kill every task created with `agentId`. */
  async killForAgent(agentId: string): Promise<void> {
    const targets = [...this.entries.values()].filter(
      (e) => e.task.agentId === agentId && e.task.status === "running",
    );
    await Promise.all(targets.map((e) => this.stop(e.task.taskId)));
  }

  /** Kill every running task (intended for SessionRouter onSessionEnd). */
  async killAll(): Promise<void> {
    const targets = [...this.entries.values()].filter((e) => e.task.status === "running");
    await Promise.all(targets.map((e) => this.stop(e.task.taskId)));
  }

  getOutput(taskId: string, offset: number, maxBytes?: number): PilotDeckTaskOutputSlice {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    return entry.output.readSlice(offset, maxBytes);
  }

  /** Convenience used in tests: `await runtime.waitFor(taskId)`. */
  async waitFor(taskId: string): Promise<PilotDeckBackgroundBashTask> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    await entry.done;
    return entry.task;
  }
}
