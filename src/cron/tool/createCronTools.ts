import type { PilotDeckToolDefinition } from "../../tool/index.js";
import { createCronCreateTool } from "./CronCreateTool.js";
import { createCronListTool } from "./CronListTool.js";
import { createCronDeleteTool } from "./CronDeleteTool.js";
import { createCronStopTool } from "./CronStopTool.js";
import { CRON_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";
import type { CronUpdateInput, CronListInput, CronRunNowInput } from "../protocol/types.js";
import { previewCronSchedule } from "../runtime/CronSchedule.js";

export function createCronTools(runtime: CronToolRuntime): PilotDeckToolDefinition[] {
  const identity = { taskId: { type: "string", minLength: 1 }, projectKey: { type: "string" } };
  const output = (data: unknown) => ({ content: [{ type: "json" as const, value: data }], data });
  return [createCronCreateTool(runtime), createCronListTool(runtime), createCronDeleteTool(runtime), createCronStopTool(runtime), {
    name: "cron_get", title: "View Scheduled Task", kind: "session",
    description: "Read a scheduled task, its next occurrences, and saved execution results without starting work. Use the revision when editing. Supply beforeRunId to read older history.",
    inputSchema: { type: "object", required: ["taskId"], additionalProperties: false,
      properties: { ...identity, beforeRunId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async (raw, context) => {
      const input = raw as CronListInput;
      const result = await runtime.listTasks({ ...input, includeHistory: true });
      const task = result.tasks[0];
      return output({ task: task ?? null, runs: result.recentRuns ?? [], nextBeforeRunId: result.nextBeforeRunId,
        nextRuns: task?.enabled && task.status !== "completed" ? previewCronSchedule(task.schedule, context.now?.() ?? new Date(), task.timezone) : [] });
    },
  }, {
    name: "cron_update", title: "Update Scheduled Task", kind: "session",
    description: "Edit a task using the revision from cron_get. Omitted fields remain unchanged. enabled=false pauses future occurrences; enabled=true resumes. Stopping a running execution is separate (cron_stop). Finished one-time tasks need a new future schedule to resume; use cron_run_now to retry immediately.",
    inputSchema: { type: "object", required: ["taskId", "expectedRevision"], additionalProperties: false, properties: {
      ...identity, expectedRevision: { type: "integer", minimum: 0 }, name: { type: "string", minLength: 1, maxLength: 120 },
      message: { type: "string", minLength: 1 }, schedule: CRON_SCHEDULE_SCHEMA, timezone: { type: "string" }, enabled: { type: "boolean" },
      notificationPolicy: { type: "string", enum: ["all", "findings", "failures"] },
      mode: { type: "string", enum: ["default", "plan", "bypassPermissions"] }, workspaceMode: { type: "string", enum: ["local", "worktree"] },
      modelSelection: { anyOf: [{ type: "null" }, { type: "object", required: ["provider", "model"], additionalProperties: false,
        properties: { provider: { type: "string" }, model: { type: "string" } } }] },
    } },
    isReadOnly: () => false, isConcurrencySafe: () => false,
    execute: async (raw) => {
      const input = raw as Partial<CronUpdateInput> & { taskId: string; expectedRevision: number };
      const task = (await runtime.listTasks({ taskId: input.taskId, projectKey: input.projectKey })).tasks[0];
      if (!task) return output({ updated: false, reason: "not_found" });
      const schedule = input.schedule ?? (input.timezone && "timezone" in task.schedule
        ? { ...task.schedule, timezone: input.timezone } : task.schedule);
      const update = { ...input, name: input.name ?? task.name, projectKey: task.projectKey!, message: input.message ?? task.message,
        schedule, timezone: input.timezone ?? task.timezone };
      // Relative edit inputs are normalized by the same creation rule before applying the revision guard.
      return output(await runtime.updateTask(update as CronUpdateInput));
    },
  }, {
    name: "cron_run_now", title: "Run Scheduled Task", kind: "session",
    description: "Start one execution under the existing task ID. Keeps its normal schedule and history together, and also works for paused or finished tasks. Refuses overlapping executions. Results remain in the dedicated task conversation.",
    inputSchema: { type: "object", required: ["taskId"], additionalProperties: false,
      properties: { ...identity } },
    isReadOnly: () => false, isConcurrencySafe: () => false,
    execute: async (input) => output(await runtime.runTaskNow(input as CronRunNowInput)),
  }];
}
