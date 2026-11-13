import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronListInput, CronListResult } from "../protocol/types.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronListTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronListInput, CronListResult> {
  return {
    name: "cron_list",
    title: "List Cron Tasks",
    description: "List durable scheduled tasks, including paused and finished tasks. Defaults to this project. Set scope=all when the user asks about tasks across projects, or specify projectKey. Use cron_get for one task's details and history.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeHistory: { type: "boolean" },
        limit: { type: "number" },
        projectKey: { type: "string" },
        scope: { type: "string", enum: ["project", "all"] },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const result = await runtime.listTasks({
        ...(input ?? {}),
        projectKey: (input as CronListInput & { scope?: string }).scope === "all" ? undefined : input.projectKey ?? context.projectKey ?? context.cwd,
      });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
