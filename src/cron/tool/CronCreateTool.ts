import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronCreateInput, CronCreateResult } from "../protocol/types.js";
import { CRON_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronCreateTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronCreateInput, CronCreateResult> {
  return {
    name: "cron_create",
    title: "Create Cron Task",
    description: "Create a one-time or recurring background Cron task that submits future work back into a session.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["message", "schedule"],
      additionalProperties: false,
      properties: {
        message: { type: "string" },
        schedule: CRON_SCHEDULE_SCHEMA,
        sessionKey: { type: "string" },
        channelKey: { type: "string" },
        projectKey: { type: "string" },
        mode: { type: "string" },
        timezone: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const result = await runtime.createTask({
        ...input,
        projectKey: input.projectKey ?? context.cwd,
      });
      return {
        content: [{ type: "json", value: result.task }],
        data: result,
      };
    },
  };
}
