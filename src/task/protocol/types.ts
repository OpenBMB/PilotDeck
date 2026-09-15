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

export type PilotDeckBackgroundTaskKind = "bash" | "monitor" | "agent";

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
  /** Owning gateway/agent session for best-effort completion notifications. */
  sessionId?: string;
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

/**
 * State envelope for a managed `local_agent` background task (asynchronous
 * subagent execution). `taskId` IS the subagent id — a single stable id is
 * used by the `agent` tool result, the `task_*` tools, and the
 * `background_subagent_result` delivery message.
 *
 * Lifecycle: `running` → `completed` (report appended to the output store)
 * | `failed` (error appended) | `cancelled` (cooperative stop won). Stop is
 * cooperative: a non-cooperative callback is force-cancelled after the stop
 * grace window and a late settle is a guarded no-op.
 */
export type PilotDeckBackgroundAgentTask = {
  taskId: string;
  type: "local_agent";
  agentId?: string;
  /** Owning session — other sessions cannot inspect/stop this task via task_*. */
  sessionId?: string;
  kind: "agent";
  /** Human-readable label (the `agent` tool `description`). */
  command: string;
  /** Stable subagent id; equals `taskId`. */
  subagentId: string;
  subagentType?: string;
  /** Turn that spawned this task; owns result delivery for the active request. */
  originTurnId?: string;
  status: PilotDeckBackgroundTaskStatus;
  completionStatusSentInAttachment: boolean;
  lastReportedTotalLines: number;
  isBackgrounded: true;
  interrupted: boolean;
  startedAt: Date;
  endedAt?: Date;
  outputBytes: number;
};

export type PilotDeckBackgroundTask =
  | PilotDeckBackgroundBashTask
  | PilotDeckBackgroundAgentTask;

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
