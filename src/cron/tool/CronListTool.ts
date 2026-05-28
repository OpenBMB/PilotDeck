import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronListInput, CronListResult } from "../protocol/types.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronListTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronListInput, CronListResult> {
  return {
    name: "cron_list",
    title: "List Cron Tasks",
    description: "List scheduled Cron tasks and optionally recent Cron run history.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeHistory: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => {
      const result = await runtime.listTasks(input ?? {});
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
