import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronStopInput, CronStopResult } from "../protocol/types.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronStopTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronStopInput, CronStopResult> {
  return {
    name: "cron_stop",
    title: "Stop Cron Run",
    description: "Stop only the current execution of a scheduled task. Retains the task and history; future recurring runs remain enabled. To pause future occurrences, use cron_update with enabled=false.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["taskId"] }, { required: ["runId"] }],
      properties: {
        taskId: { type: "string" },
        runId: { type: "string" },
        projectKey: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const result = await runtime.stopTask({
        ...input,
        projectKey: input.projectKey,
      });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
