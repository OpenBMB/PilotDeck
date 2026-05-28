/**
 * Background task runtime protocol (C5 §6.5 of the deferred-feature guide).
 * Mirrors the legacy upstream LocalShellTask behaviour (T1-T11).
 */

export type PilotDeckBackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type PilotDeckBackgroundTaskKind = "bash" | "monitor";

/**
 * State envelope for a single background bash task. The shape is a strict
 * superset of legacy `LocalShellTaskState` for the fields PilotDeck actually
 * uses; legacy-only "task" classes (`local_agent`, `remote`) are not part of
 * this PR (D-tier).
 */
export type PilotDeckBackgroundBashTask = {
  taskId: string;
  type: "local_bash";
  /** T4 — owning agent; agent exit triggers `killForAgent(agentId)`. */
  agentId?: string;
  /** T5 — UI badge variant (`bash` plain task vs. long-running `monitor`). */
  kind: PilotDeckBackgroundTaskKind;
  command: string;
  cwd: string;
  /** Set once the child process has been spawned. */
  pid?: number;
  status: PilotDeckBackgroundTaskStatus;
  exitCode?: number | null;
  /** T6 — flipped to `true` once the runtime has dispatched a completion attachment. */
  completionStatusSentInAttachment: boolean;
  /** T7 — bookkeeping for incremental output reporters. */
  lastReportedTotalLines: number;
  /** T8 — flips foreground → background when bash mode flips at runtime. */
  isBackgrounded: boolean;
  /** Set when the task was killed via `task_stop` / SIGTERM. */
  interrupted: boolean;
  startedAt: Date;
  endedAt?: Date;
  /** Total bytes captured across stdout + stderr. */
  outputBytes: number;
};

export type PilotDeckTaskOutputSlice = {
  content: string;
  /** Offset into the combined byte stream from which the next read may resume. */
  nextOffset: number;
  /** Total bytes captured so far. */
  totalBytes: number;
  /** True when older bytes have been dropped beyond the buffer limit. */
  truncated: boolean;
};

export type PilotDeckBackgroundTaskListFilter = {
  agentId?: string;
  status?: PilotDeckBackgroundTaskStatus | PilotDeckBackgroundTaskStatus[];
  kind?: PilotDeckBackgroundTaskKind;
};
