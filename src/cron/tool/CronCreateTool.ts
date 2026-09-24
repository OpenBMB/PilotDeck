import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronCreateInput, CronCreateResult } from "../protocol/types.js";
import type { GatewayChannelKey } from "../../gateway/index.js";
import { CRON_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronCreateTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronCreateInput, CronCreateResult> {
  return {
    name: "cron_create",
    title: "Create Cron Task",
    description: "Create a one-time or recurring background Cron task that submits future work back into a session. For relative reminders like 'in 10 minutes', use schedule.type='delay'. For absolute natural-language times like tonight, tomorrow morning, or next Monday, call get_current_time first to resolve the current local time/timezone, then pass a future schedule.type='once' runAt. Recurring expressions use Unix cron day matching: if neither day field starts with '*', day-of-month and day-of-week match with OR, not AND; see the expression schema for examples.",
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
        mode: { type: "string" },
        timezone: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const channelKey = input.channelKey ?? inferChannelKey(context.sessionId);
      const result = await runtime.createTask({
        ...input,
        sessionKey: input.sessionKey ?? context.sessionId,
        ...(channelKey ? { channelKey } : {}),
        projectKey: context.cwd,
      });
      return {
        content: [{ type: "json", value: result.task }],
        data: result,
      };
    },
  };
}

function inferChannelKey(sessionKey: string): GatewayChannelKey | undefined {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return undefined;
  return sessionKey.slice(0, idx) as GatewayChannelKey;
}
