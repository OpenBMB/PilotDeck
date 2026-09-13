/**
 * `BackgroundTaskRuntime` — the central registry + spawn / kill orchestrator
 * for C5 background bash tasks (§6.5). Mirrors the legacy upstream
 * LocalShellTask behaviour (T1-T11).
 *
 * Process model:
 *   - `start(spec)` uses the shared command-shell resolver. POSIX children
 *     are detached for process-group cleanup; Windows children stay attached
 *     and hidden so GUI builds do not flash console windows.
 *   - stdout / stderr are piped into a `TaskOutputStore` (1 MB ring buffer
 *     + optional disk spill). The runtime never blocks on the stream — the
 *     child runs free until either it exits or `stop` is called.
 *   - `stop(taskId)` issues SIGTERM and, after `graceMs` (default 5000),
 *     escalates to SIGKILL.
 *   - `killForAgent(agentId)` and `killAll()` provide the SessionRouter
 *     hooks the cron-PR coordination notes call for (priority window
 *     200-299, see §6.5.5 step 7 of the deferred-feature guide).
 *
 * Platform support: macOS, Linux, and Windows. Windows process trees are
 * stopped with `taskkill /T /F` so shell descendants are not orphaned.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TaskOutputStore } from "../storage/TaskOutputStore.js";
import { resolveDefaultCommandShell } from "../../runtime/commandShell.js";
import type {
  PilotDeckBackgroundAgentTask,
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTask,
  PilotDeckBackgroundTaskStatus,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckTaskOutputSlice,
} from "../protocol/types.js";

export type BackgroundTaskCompletionEvent = {
  sessionId?: string;
  taskId: string;
  kind?: PilotDeckBackgroundTaskKind;
  status: Extract<PilotDeckBackgroundTaskStatus, "completed" | "failed" | "cancelled">;
  exitCode?: number | null;
  outputPreview: string;
  totalBytes: number;
  startedAt: string;
  endedAt: string;
  subagentId?: string;
  originTurnId?: string;
};

export type BackgroundTaskCompletionHandler = (event: BackgroundTaskCompletionEvent) => void;

export type BackgroundTaskRuntimeOptions = {
  /** Optional dir under which to spill output (default: in-memory only). */
  diskSpillDir?: string;
  /** Override `now()` for deterministic tests. */
  now?: () => Date;
  /** Override the spawn function (used by tests). */
  spawn?: typeof spawn;
  /** Hard cap on simultaneous bash tasks (default: 32). Bash tasks only — managed agent tasks are bounded by `maxRunningAgentTasks`. */
  maxTasks?: number;
  /** Hard cap on simultaneous managed (`local_agent`) tasks (default: 8). */
  maxRunningAgentTasks?: number;
  /** Max retained terminal managed task records; the oldest are pruned first (default: 32). */
  maxRetainedAgentTasks?: number;
  /** Optional completion sink for hosts that want one-shot background task notifications. */
  onCompletion?: BackgroundTaskCompletionHandler;
  /** Maximum bytes included in completion output previews (default: 4000). */
  completionPreviewBytes?: number;
};

export type StartTaskSpec = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  agentId?: string;
  kind?: PilotDeckBackgroundTaskKind;
};

export type StartManagedTaskSpec = {
  /**
   * Stable task id — the caller's subagentId. The same id is used by the
   * `agent` tool result, the `task_*` tools, and result delivery. Must be
   * unique among live tasks.
   */
  subagentId: string;
  /** Human-readable label (the `agent` tool `description`). */
  label: string;
  sessionId?: string;
  agentId?: string;
  originTurnId?: string;
  subagentType?: string;
  /**
   * The managed work. Resolves with the final report (appended to the task's
   * output store); rejects to fail the task. Cancellation is cooperative:
   * the signal aborts on `stop`, but a callback that ignores it is
   * force-cancelled after the stop grace window — no hard guarantee.
   */
  run: (signal: AbortSignal) => Promise<string>;
};

export type StopTaskOptions = {
  graceMs?: number;
};

export type WaitTaskOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type WaitTaskResult = {
  task: PilotDeckBackgroundTask;
  timedOut: boolean;
  outcome: "completed" | "timeout" | "aborted";
  waitedMs: number;
};

type RuntimeEntry = {
  task: PilotDeckBackgroundTask;
  child?: ChildProcess;
  output: TaskOutputStore;
  /** Managed (`local_agent`) tasks: cooperative cancellation handle. */
  controller?: AbortController;
  /** Managed tasks: idempotent forced-cancel used after the stop grace window. */
  requestCancel?: () => void;
  /** Resolved when the child has fully exited (success, failure, or kill). */
  done: Promise<void>;
};

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_TASKS = 32;
const DEFAULT_MAX_RUNNING_AGENT_TASKS = 8;
const DEFAULT_MAX_RETAINED_AGENT_TASKS = 32;
const DEFAULT_COMPLETION_PREVIEW_BYTES = 4_000;

function isTerminalTaskStatus(status: PilotDeckBackgroundTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class BackgroundTaskRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly options: Required<
    Pick<
      BackgroundTaskRuntimeOptions,
      "now" | "spawn" | "maxTasks" | "maxRunningAgentTasks" | "maxRetainedAgentTasks"
    >
  > &
    Pick<BackgroundTaskRuntimeOptions, "diskSpillDir" | "onCompletion" | "completionPreviewBytes">;

  constructor(options: BackgroundTaskRuntimeOptions = {}) {
    this.options = {
      now: options.now ?? (() => new Date()),
      spawn: options.spawn ?? spawn,
      maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
      maxRunningAgentTasks: options.maxRunningAgentTasks ?? DEFAULT_MAX_RUNNING_AGENT_TASKS,
      maxRetainedAgentTasks: options.maxRetainedAgentTasks ?? DEFAULT_MAX_RETAINED_AGENT_TASKS,
      diskSpillDir: options.diskSpillDir,
      onCompletion: options.onCompletion,
      completionPreviewBytes: options.completionPreviewBytes ?? DEFAULT_COMPLETION_PREVIEW_BYTES,
    };
  }

  list(filter: PilotDeckBackgroundTaskListFilter = {}): PilotDeckBackgroundTask[] {
    const result: PilotDeckBackgroundTask[] = [];
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

  get(taskId: string): PilotDeckBackgroundTask | undefined {
    return this.entries.get(taskId)?.task;
  }

  async wait(taskId: string, options: WaitTaskOptions = {}): Promise<WaitTaskResult | undefined> {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;

    const startedAt = Date.now();
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 0));
    const timeoutPromise = timeoutMs > 0
      ? new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), timeoutMs).unref?.();
        })
      : undefined;
    let abortHandler: (() => void) | undefined;
    const abortPromise = options.abortSignal
      ? new Promise<"aborted">((resolve) => {
          if (options.abortSignal?.aborted) {
            resolve("aborted");
            return;
          }
          abortHandler = () => resolve("aborted");
          options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
        })
      : undefined;

    const waits: Array<Promise<void | "timeout" | "aborted">> = [entry.done];
    if (timeoutPromise) waits.push(timeoutPromise);
    if (abortPromise) waits.push(abortPromise);
    const result = await Promise.race(waits);
    if (abortHandler) {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    }

    const outcome = result === "timeout"
      ? "timeout"
      : result === "aborted"
        ? "aborted"
        : "completed";
    return {
      task: entry.task,
      timedOut: outcome === "timeout" || outcome === "aborted",
      outcome,
      waitedMs: Date.now() - startedAt,
    };
  }  /**
   * Spawn the command in the background. Resolves once the child has been
   * forked (typically <10 ms). `task.status` flips to `running` on spawn
   * and `completed` / `failed` / `cancelled` later via the `exit` listener.
   */
  async start(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask> {
    // Capacity counts bash tasks only — managed agent tasks live in the same
    // registry but are bounded separately (see `startManaged`) so a pile of
    // terminal agent records can never exhaust the bash budget.
    let bashTaskCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.task.type === "local_bash") bashTaskCount++;
    }
    if (bashTaskCount >= this.options.maxTasks) {
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
      sessionId: spec.sessionId,
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
      const shell = resolveDefaultCommandShell({ env: spec.env });
      child = this.options.spawn(shell.shell, shell.args(spec.command), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
      child.unref();
    } catch (err) {
      task.status = "failed";
      task.completionStatusSentInAttachment = true;
      task.endedAt = this.options.now();
      const message = err instanceof Error ? err.message : String(err);
      output.append(Buffer.from(`spawn error: ${message}\n`));
      task.outputBytes = output.totalBytes();
      this.entries.set(taskId, { task, output, done: Promise.resolve() });
      this.notifyCompletion(task, output);
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
      task.completionStatusSentInAttachment = true;
      this.notifyCompletion(task, output);
      resolveDone();
    });

    this.entries.set(taskId, { task, child, output, done });
    return task;
  }

  /**
   * Run a managed (`local_agent`) task — an asynchronous callback (e.g. a
   * forked subagent) registered in the same registry as bash tasks so the
   * existing `task_list` / `task_output` / `task_wait` / `task_stop` surface
   * works unchanged. Resolves once the task has been registered and started
   * (never awaits completion).
   *
   * Capacity: bounded by `maxRunningAgentTasks` simultaneous running tasks
   * and `maxRetainedAgentTasks` retained terminal records (oldest pruned) —
   * deliberately independent of the lifetime bash `maxTasks` cap.
   */
  async startManaged(spec: StartManagedTaskSpec): Promise<PilotDeckBackgroundAgentTask> {
    let runningAgentTasks = 0;
    for (const entry of this.entries.values()) {
      if (entry.task.type === "local_agent" && !isTerminalTaskStatus(entry.task.status)) {
        runningAgentTasks++;
      }
    }
    if (runningAgentTasks >= this.options.maxRunningAgentTasks) {
      throw new Error(
        `BackgroundTaskRuntime: running agent task capacity (${this.options.maxRunningAgentTasks}) exceeded; ${runningAgentTasks} agent tasks are still running.`,
      );
    }
    if (this.entries.has(spec.subagentId)) {
      throw new Error(`BackgroundTaskRuntime: duplicate task id: ${spec.subagentId}`);
    }
    this.pruneRetainedAgentRecords(1);

    const taskId = spec.subagentId;
    const startedAt = this.options.now();
    const task: PilotDeckBackgroundAgentTask = {
      taskId,
      type: "local_agent",
      agentId: spec.agentId,
      sessionId: spec.sessionId,
      kind: "agent",
      command: spec.label,
      subagentId: spec.subagentId,
      ...(spec.subagentType ? { subagentType: spec.subagentType } : {}),
      ...(spec.originTurnId ? { originTurnId: spec.originTurnId } : {}),
      status: "running",
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
    const controller = new AbortController();

    // Settle-once guard: `stop` may force-cancel before the callback settles
    // (or the callback may settle after the grace window). Whichever path
    // arrives first wins; late completions are guarded no-ops so a cancelled
    // task can never resurrect as completed and no completion event fires twice.
    let settled = false;
    const finish = (ok: boolean, report?: string, errorMessage?: string): void => {
      if (settled) return;
      settled = true;
      if (report !== undefined && report.length > 0) {
        output.append(Buffer.from(report));
      }
      if (errorMessage !== undefined) {
        output.append(Buffer.from(`error: ${errorMessage}\n`));
      }
      task.endedAt = this.options.now();
      task.status = task.interrupted
        ? "cancelled"
        : ok
          ? "completed"
          : "failed";
      task.completionStatusSentInAttachment = true;
      task.outputBytes = output.totalBytes();
      this.notifyCompletion(task, output);
      resolveDone();
    };

    const entry: RuntimeEntry = {
      task,
      output,
      controller,
      requestCancel: () => finish(false),
      done,
    };
    this.entries.set(taskId, entry);

    void (async () => {
      try {
        const report = await spec.run(controller.signal);
        finish(true, report);
      } catch (err) {
        finish(false, undefined, err instanceof Error ? err.message : String(err));
      }
    })();

    return task;
  }

  /** Prune the oldest terminal managed records so `reserveSlots` fit under the retention cap. */
  private pruneRetainedAgentRecords(reserveSlots: number): void {
    const max = this.options.maxRetainedAgentTasks;
    if (max <= 0) return;
    const terminalAgentEntries = [...this.entries.values()]
      .filter((e) => e.task.type === "local_agent" && isTerminalTaskStatus(e.task.status))
      .sort((a, b) => {
        const aEnded = a.task.type === "local_agent" ? a.task.endedAt?.getTime() ?? 0 : 0;
        const bEnded = b.task.type === "local_agent" ? b.task.endedAt?.getTime() ?? 0 : 0;
        return aEnded - bEnded;
      });
    const excess = terminalAgentEntries.length + reserveSlots - max;
    for (let i = 0; i < excess; i++) {
      this.entries.delete(terminalAgentEntries[i]!.task.taskId);
    }
  }

  /**
   * Stop a task. Bash tasks: SIGTERM → grace → SIGKILL. Managed tasks:
   * cooperative abort → grace → forced cancel (a non-cooperative callback
   * cannot be killed; it is detached and its late settle is a guarded no-op).
   * Idempotent: stopping an already-finished task is a no-op.
   */
  async stop(taskId: string, options: StopTaskOptions = {}): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    const { task } = entry;
    if (task.status !== "running" && task.status !== "pending") return;
    if (task.type === "local_agent") {
      task.interrupted = true;
      entry.controller?.abort(new Error("Background agent task stopped."));
      await waitForDoneOrTimeout(entry.done, options.graceMs ?? DEFAULT_GRACE_MS);
      entry.requestCancel?.();
      await entry.done;
      return;
    }
    const { child, done } = entry;
    if (!child) return;
    task.interrupted = true;
    if (process.platform === "win32") {
      await killWindowsProcessTree(child);
      await waitForDoneOrTimeout(done, options.graceMs ?? DEFAULT_GRACE_MS);
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // child already exited
      }
    }
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // already exited between the timer firing and kill()
            }
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
  async waitFor(taskId: string): Promise<PilotDeckBackgroundTask> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`Unknown taskId: ${taskId}`);
    await entry.done;
    return entry.task;
  }

  private notifyCompletion(task: PilotDeckBackgroundTask, output: TaskOutputStore): void {
    if (!this.options.onCompletion || !task.endedAt) {
      return;
    }
    const previewBytes = Math.max(0, this.options.completionPreviewBytes ?? DEFAULT_COMPLETION_PREVIEW_BYTES);
    const totalBytes = output.totalBytes();
    const slice = output.readSlice(Math.max(0, totalBytes - previewBytes), previewBytes);
    try {
      this.options.onCompletion({
        taskId: task.taskId,
        sessionId: task.sessionId,
        kind: task.kind,
        status: task.status as BackgroundTaskCompletionEvent["status"],
        exitCode: task.type === "local_bash" ? task.exitCode : undefined,
        outputPreview: slice.content,
        totalBytes,
        startedAt: task.startedAt.toISOString(),
        endedAt: task.endedAt.toISOString(),
        ...(task.type === "local_agent"
          ? { subagentId: task.subagentId, originTurnId: task.originTurnId }
          : {}),
      });
    } catch {
      // Completion notifications are best-effort and must never break task cleanup.
    }
  }
}

async function waitForDoneOrTimeout(done: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function killWindowsProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    child.kill("SIGTERM");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", finish);
      killer.once("error", () => {
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
        finish();
      });
      killer.unref();
    } catch {
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      finish();
    }
  });
}
