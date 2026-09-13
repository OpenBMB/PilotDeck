import { randomUUID } from "node:crypto";

import type { PilotDeckBackgroundTaskStatus } from "../../task/protocol/types.js";

/**
 * Gateway-owned lifecycle registry for AgentDefinition.background forks.
 * This deliberately does not reuse BackgroundTaskRuntime: that runtime owns
 * detached shell processes, whereas a background subagent is an in-process
 * AgentLoop with a cooperative AbortSignal.
 */
export type BackgroundSubagentTask = {
  taskId: string;
  /** Explicit user-launched background child or an internal observer child. */
  kind: "background" | "observer";
  sessionId: string;
  parentTurnId: string;
  subagentId: string;
  subagentType: string;
  observedSubagentId?: string;
  status: PilotDeckBackgroundTaskStatus;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
};

export type StartBackgroundSubagentInput = {
  kind?: "background" | "observer";
  sessionId: string;
  parentTurnId: string;
  subagentId: string;
  subagentType: string;
  observedSubagentId?: string;
  run(signal: AbortSignal): Promise<unknown>;
};

type RuntimeEntry = {
  task: BackgroundSubagentTask;
  controller: AbortController;
  done: Promise<void>;
};

export class BackgroundSubagentRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();

  start(input: StartBackgroundSubagentInput): BackgroundSubagentTask {
    const task: BackgroundSubagentTask = {
      taskId: randomUUID(),
      kind: input.kind ?? "background",
      sessionId: input.sessionId,
      parentTurnId: input.parentTurnId,
      subagentId: input.subagentId,
      subagentType: input.subagentType,
      ...(input.observedSubagentId ? { observedSubagentId: input.observedSubagentId } : {}),
      status: "pending",
      startedAt: new Date(),
    };
    const controller = new AbortController();
    const entry: RuntimeEntry = {
      task,
      controller,
      done: Promise.resolve(),
    };
    entry.done = Promise.resolve()
      .then(async () => {
        if (task.status === "cancelled") return;
        task.status = "running";
        await input.run(controller.signal);
        if (!controller.signal.aborted) task.status = "completed";
      })
      .catch((error) => {
        if (task.status !== "cancelled") {
          task.status = controller.signal.aborted ? "cancelled" : "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        task.endedAt ??= new Date();
      });
    this.entries.set(task.taskId, entry);
    return task;
  }

  get(taskId: string): BackgroundSubagentTask | undefined {
    return this.entries.get(taskId)?.task;
  }

  list(filter: {
    sessionId?: string;
    kind?: BackgroundSubagentTask["kind"];
    status?: PilotDeckBackgroundTaskStatus | PilotDeckBackgroundTaskStatus[];
  } = {}): BackgroundSubagentTask[] {
    const requestedStatuses = filter.status === undefined
      ? undefined
      : Array.isArray(filter.status) ? filter.status : [filter.status];
    return [...this.entries.values()]
      .map((entry) => entry.task)
      .filter((task) => (filter.sessionId === undefined || task.sessionId === filter.sessionId)
        && (filter.kind === undefined || task.kind === filter.kind)
        && (requestedStatuses === undefined || requestedStatuses.includes(task.status)));
  }

  stop(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry || (entry.task.status !== "pending" && entry.task.status !== "running")) return false;
    entry.task.status = "cancelled";
    entry.task.endedAt = new Date();
    entry.controller.abort();
    return true;
  }

  shutdown(): void {
    for (const taskId of this.entries.keys()) this.stop(taskId);
  }
}
