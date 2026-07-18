/**
 * `task_*` builtin tools — public surface for the C5 background task
 * runtime (§6.5.5 step 4-5).
 *
 *   - task_create  → `BackgroundTaskRuntime.start`
 *   - task_list    → `BackgroundTaskRuntime.list`
 *   - task_output  → `BackgroundTaskRuntime.getOutput` (incremental polling)
 *   - task_wait    → `BackgroundTaskRuntime.wait` + final output slice
 *   - task_stop    → `BackgroundTaskRuntime.stop`
 *
 * The runtime is injected once at registry construction (no per-call
 * lookup); tools without a runtime hand back `unsupported_tool`.
 */

import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import type {
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTaskKind,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckBackgroundTaskStatus,
} from "../../task/protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TaskCreateInput = {
  command: string;
  agentId?: string;
  kind?: PilotDeckBackgroundTaskKind;
};

export type TaskCreateOutput = {
  taskId: string;
  status: PilotDeckBackgroundTaskStatus;
  pid?: number;
};

export type TaskListInput = {
  agentId?: string;
  status?: PilotDeckBackgroundTaskStatus | PilotDeckBackgroundTaskStatus[];
  kind?: PilotDeckBackgroundTaskKind;
};

export type TaskListOutput = {
  tasks: Array<
    Pick<
      PilotDeckBackgroundBashTask,
      | "taskId"
      | "agentId"
      | "kind"
      | "command"
      | "status"
      | "pid"
      | "exitCode"
      | "interrupted"
      | "outputBytes"
    > & { startedAt: string; endedAt?: string }
  >;
};

export type TaskOutputInput = {
  taskId: string;
  offset?: number;
  maxBytes?: number;
};

export type TaskOutputResult = {
  taskId: string;
  content: string;
  nextOffset: number;
  totalBytes: number;
  truncated: boolean;
  status: PilotDeckBackgroundTaskStatus;
  exitCode?: number | null;
};

export type TaskWaitInput = {
  taskId: string;
  timeoutMs?: number;
  offset?: number;
  maxBytes?: number;
};

export type TaskWaitResult = TaskOutputResult & {
  waitedMs: number;
  timedOut: boolean;
};

export type TaskStopInput = {
  taskId: string;
  graceMs?: number;
};

export type TaskStopResult = {
  taskId: string;
  status: PilotDeckBackgroundTaskStatus;
};

const TERMINAL_TASK_STATUSES = new Set<PilotDeckBackgroundTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const DEFAULT_TASK_WAIT_TIMEOUT_MS = 600_000;
const MAX_TASK_WAIT_TIMEOUT_MS = 600_000;

function ensureRuntime(runtime: BackgroundTaskRuntime | undefined): BackgroundTaskRuntime {
  if (!runtime) {
    throw new PilotDeckToolRuntimeError(
      "unsupported_tool",
      "task_* tools require a BackgroundTaskRuntime. Configure one via createBuiltinRegistry({ backgroundTasks: { runtime } }).",
    );
  }
  return runtime;
}

function isTerminalTaskStatus(status: PilotDeckBackgroundTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

function formatTaskOutputText(data: TaskOutputResult, requestedOffset: number): string {
  const exitCode = data.exitCode ?? "null";
  const header = `task_output taskId=${data.taskId} status=${data.status} offset=${requestedOffset} nextOffset=${data.nextOffset} totalBytes=${data.totalBytes} truncated=${data.truncated} exitCode=${exitCode}`;
  const hasNewOutput = data.content.length > 0;
  const isFinished = isTerminalTaskStatus(data.status) && data.nextOffset >= data.totalBytes;

  if (!hasNewOutput) {
    const message = isFinished
      ? `No new output. Task is ${data.status} and polling is finished.`
      : `No new output yet. Use nextOffset=${data.nextOffset} for the next poll.`;
    return `${header}\n${message}`;
  }

  if (isFinished) {
    return `${header}\n${data.content}\nTask is ${data.status} and all output has been read; polling is finished.`;
  }

  return `${header}\n${data.content}`;
}

function formatTaskWaitText(data: TaskWaitResult, requestedOffset: number): string {
  const exitCode = data.exitCode ?? "null";
  const header = `task_wait taskId=${data.taskId} status=${data.status} waitedMs=${data.waitedMs} offset=${requestedOffset} nextOffset=${data.nextOffset} totalBytes=${data.totalBytes} truncated=${data.truncated} exitCode=${exitCode}`;
  const hasNewOutput = data.content.length > 0;
  const isFinished = isTerminalTaskStatus(data.status) && data.nextOffset >= data.totalBytes;
  const body = hasNewOutput ? `\n${data.content}` : "";

  if (isFinished) {
    return `${header}${body}\nTask finished; no further polling is needed.`;
  }
  if (data.timedOut) {
    return `${header}${body}\nTask is still running after timeoutMs; use task_wait again to block or task_output for progress.`;
  }
  return `${header}${body}`;
}

export function createTaskCreateTool(
  runtime?: BackgroundTaskRuntime,
): PilotDeckToolDefinition<TaskCreateInput, TaskCreateOutput> {
  return {
    name: "task_create",
    aliases: ["TaskCreate"],
    description:
      "Spawn a shell command as a detached background task. Returns immediately with a taskId; it does not automatically push completion output back into the model context. For long-running tasks that should finish, call task_wait immediately after task_create so the final output returns to the current context. Use task_output only for progress checks, not manual sleep polling. Use task_stop for long-lived services/watchers.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Shell command to run as a detached background task.",
        },
        agentId: {
          type: "string",
          description: "Optional agent id to associate this task with.",
        },
        kind: {
          type: "string",
          enum: ["bash", "monitor"],
          description: "Task kind: 'bash' (default) or 'monitor'.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TaskCreateOutput>> => {
      const rt = ensureRuntime(runtime);
      const task = await rt.start({
        command: input.command,
        cwd: context.cwd,
        env: context.env,
        sessionId: context.sessionId,
        agentId: input.agentId,
        kind: input.kind,
      });
      return {
        content: [
          { type: "text", text: `task_create taskId=${task.taskId} status=${task.status}` },
        ],
        data: { taskId: task.taskId, status: task.status, pid: task.pid },
      };
    },
  };
}

export function createTaskListTool(
  runtime?: BackgroundTaskRuntime,
): PilotDeckToolDefinition<TaskListInput, TaskListOutput> {
  return {
    name: "task_list",
    aliases: ["TaskList"],
    description: "List background tasks (optionally filter by agentId / status / kind).",
    kind: "shell",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Filter tasks by agent id.",
        },
        status: {
          type: ["string", "array"],
          description: "Filter by status (e.g. 'running', 'completed'). String or array of strings.",
        },
        kind: {
          type: "string",
          enum: ["bash", "monitor"],
          description: "Filter by task kind.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input): Promise<PilotDeckToolExecutionOutput<TaskListOutput>> => {
      const rt = ensureRuntime(runtime);
      const filter: PilotDeckBackgroundTaskListFilter = {
        agentId: input.agentId,
        status: input.status,
        kind: input.kind,
      };
      const tasks = rt.list(filter).map((t) => ({
        taskId: t.taskId,
        agentId: t.agentId,
        kind: t.kind,
        command: t.command,
        status: t.status,
        pid: t.pid,
        exitCode: t.exitCode ?? undefined,
        interrupted: t.interrupted,
        outputBytes: t.outputBytes,
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString(),
      }));
      return {
        content: [{ type: "text", text: formatTaskListText(tasks) }],
        data: { tasks },
      };
    },
  };
}

function formatTaskListText(tasks: TaskListOutput["tasks"]): string {
  const lines = [`task_list count=${tasks.length}`];
  if (tasks.length === 0) {
    lines.push("No background tasks matched the filter.");
    return lines.join("\n");
  }

  for (const task of tasks) {
    const exitCode = task.exitCode ?? "null";
    const pid = task.pid ?? "null";
    const command = task.command.length > 160 ? `${task.command.slice(0, 157)}...` : task.command;
    lines.push(
      `- taskId=${task.taskId} status=${task.status} kind=${task.kind} pid=${pid} exitCode=${exitCode} outputBytes=${task.outputBytes} interrupted=${task.interrupted} command=${JSON.stringify(command)}`,
    );
    if (!isTerminalTaskStatus(task.status) || task.outputBytes > 0) {
      lines.push(`  next: use task_output({ taskId: "${task.taskId}", offset: 0 }) to inspect output, or task_wait for a finite running task.`);
    }
  }
  return lines.join("\n");
}

export function createTaskOutputTool(
  runtime?: BackgroundTaskRuntime,
): PilotDeckToolDefinition<TaskOutputInput, TaskOutputResult> {
  return {
    name: "task_output",
    aliases: ["TaskOutput"],
    description:
      "Read newly-produced output for a background task (incremental progress polling). Use task_wait when you need to block until a finite task completes. Use nextOffset for the next read. Stop polling when status is completed, failed, or cancelled and nextOffset >= totalBytes.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "The task id returned by task_create.",
        },
        offset: {
          type: "integer",
          description: "Byte offset to start reading from (for incremental polling). Defaults to 0.",
        },
        maxBytes: {
          type: "integer",
          description: "Maximum bytes to return in this read. Defaults to tool limit.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input): Promise<PilotDeckToolExecutionOutput<TaskOutputResult>> => {
      const rt = ensureRuntime(runtime);
      const task = rt.get(input.taskId);
      if (!task) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      const requestedOffset = input.offset ?? 0;
      const slice = rt.getOutput(input.taskId, requestedOffset, input.maxBytes);
      const data: TaskOutputResult = {
        taskId: input.taskId,
        content: slice.content,
        nextOffset: slice.nextOffset,
        totalBytes: slice.totalBytes,
        truncated: slice.truncated,
        status: task.status,
        exitCode: task.exitCode,
      };
      return {
        content: [{ type: "text", text: formatTaskOutputText(data, requestedOffset) }],
        data,
      };
    },
  };
}

export function createTaskWaitTool(
  runtime?: BackgroundTaskRuntime,
): PilotDeckToolDefinition<TaskWaitInput, TaskWaitResult> {
  return {
    name: "task_wait",
    aliases: ["TaskWait"],
    description:
      "Block until a background task finishes or timeoutMs elapses, then return the task status and output. Use this immediately after task_create for finite long-running commands such as builds, tests, conversions, downloads, or batch scripts. It does not stop the task when timeoutMs elapses; call task_wait again or task_output for progress.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "The task id returned by task_create.",
        },
        timeoutMs: {
          type: "integer",
          description: "Maximum time to block in milliseconds. Defaults to 600000. Max 600000.",
        },
        offset: {
          type: "integer",
          description: "Byte offset to start reading output from after waiting. Defaults to 0.",
        },
        maxBytes: {
          type: "integer",
          description: "Maximum bytes to return in this read. Defaults to tool limit.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: async (input) => {
      if (input.timeoutMs !== undefined && input.timeoutMs > MAX_TASK_WAIT_TIMEOUT_MS) {
        return {
          ok: false,
          issues: [{ path: "timeoutMs", code: "invalid_schema", message: `timeoutMs must be <= ${MAX_TASK_WAIT_TIMEOUT_MS}.` }],
        };
      }
      if (input.timeoutMs !== undefined && input.timeoutMs < 0) {
        return {
          ok: false,
          issues: [{ path: "timeoutMs", code: "invalid_schema", message: "timeoutMs must be non-negative." }],
        };
      }
      if (input.offset !== undefined && input.offset < 0) {
        return {
          ok: false,
          issues: [{ path: "offset", code: "invalid_schema", message: "offset must be non-negative." }],
        };
      }
      return { ok: true, input };
    },
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TaskWaitResult>> => {
      const rt = ensureRuntime(runtime);
      const task = rt.get(input.taskId);
      if (!task) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      const requestedOffset = input.offset ?? 0;
      const waited = await rt.wait(input.taskId, {
        timeoutMs: input.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS,
        abortSignal: context.abortSignal,
      });
      if (!waited) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      if (waited.outcome === "aborted") {
        throw new PilotDeckToolRuntimeError(
          "tool_aborted",
          `task_wait aborted before task ${input.taskId} finished.`,
        );
      }
      const slice = rt.getOutput(input.taskId, requestedOffset, input.maxBytes);
      const data: TaskWaitResult = {
        taskId: input.taskId,
        content: slice.content,
        nextOffset: slice.nextOffset,
        totalBytes: slice.totalBytes,
        truncated: slice.truncated,
        status: waited.task.status,
        exitCode: waited.task.exitCode,
        waitedMs: waited.waitedMs,
        timedOut: waited.timedOut,
      };
      return {
        content: [{ type: "text", text: formatTaskWaitText(data, requestedOffset) }],
        data,
      };
    },
  };
}

export function createTaskStopTool(
  runtime?: BackgroundTaskRuntime,
): PilotDeckToolDefinition<TaskStopInput, TaskStopResult> {
  return {
    name: "task_stop",
    aliases: ["TaskStop"],
    description: "Stop a background task (SIGTERM → grace → SIGKILL).",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "The task id to stop.",
        },
        graceMs: {
          type: "integer",
          description: "Grace period in ms between SIGTERM and SIGKILL. Defaults to 5000.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input): Promise<PilotDeckToolExecutionOutput<TaskStopResult>> => {
      const rt = ensureRuntime(runtime);
      const task = rt.get(input.taskId);
      if (!task) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown taskId: ${input.taskId}`,
        );
      }
      await rt.stop(input.taskId, { graceMs: input.graceMs });
      const after = rt.get(input.taskId)!;
      return {
        content: [{ type: "text", text: `task_stop taskId=${input.taskId} status=${after.status}` }],
        data: { taskId: input.taskId, status: after.status },
      };
    },
  };
}

export type CreateTaskToolsOptions = {
  runtime: BackgroundTaskRuntime;
};

export function createTaskTools(options: CreateTaskToolsOptions): {
  create: ReturnType<typeof createTaskCreateTool>;
  list: ReturnType<typeof createTaskListTool>;
  output: ReturnType<typeof createTaskOutputTool>;
  wait: ReturnType<typeof createTaskWaitTool>;
  stop: ReturnType<typeof createTaskStopTool>;
} {
  return {
    create: createTaskCreateTool(options.runtime),
    list: createTaskListTool(options.runtime),
    output: createTaskOutputTool(options.runtime),
    wait: createTaskWaitTool(options.runtime),
    stop: createTaskStopTool(options.runtime),
  };
}
