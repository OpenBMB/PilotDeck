import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronDeleteInput, CronDeleteResult } from "../protocol/types.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronDeleteTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronDeleteInput, CronDeleteResult> {
  return {
    name: "cron_delete",
    title: "Delete Cron Task",
    description: "Delete a scheduled Cron task and cancel its future triggers.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        stopRunning: { type: "boolean" },
        projectKey: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    execute: async (input, context) => {
      const result = await runtime.deleteTask({
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
