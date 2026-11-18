import { PilotDeckToolRuntimeError, type PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronCreateInput, CronCreateResult } from "../protocol/types.js";
import type { GatewayChannelKey } from "../../gateway/index.js";
import { CRON_CREATE_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";
import { resolvePilotHome } from "../../pilot/paths.js";

export function createCronCreateTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronCreateInput, CronCreateResult> {
  return {
    name: "cron_create",
    title: "Create Cron Task",
    description: [
      "Create a durable scheduled task. Give it a short name and instructions that still make sense on future runs.",
      "Use calendar for daily or weekly local clock times, including multiple times and weekdays. Use cron for fixed dates each month or year. Use interval for elapsed repeats in whole minutes. Use delay for a one-time relative reminder such as in ten minutes.",
      "Monthly ordinal weekdays are unavailable for new tasks. Ask for a different schedule if requested.",
      "Before resolving tonight, tomorrow or next Monday into an absolute date, call get_current_time and pass an explicit IANA timezone.",
      "The task defaults to this conversation's project. projectKey can select another registered absolute project path or 'general'.",
      "Creation saves the task without running it immediately. Report its timezone and nextRunAt. Runs and their results stay in a dedicated task conversation. Reminders follow notificationPolicy after the run ends.",
      "Use Default Permissions unless the user explicitly requests Full Access for this task. When a Default Permissions task needs approval, it waits in its dedicated task conversation and continues after approval.",
    ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["message", "schedule"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        message: { type: "string", minLength: 1 },
        schedule: CRON_CREATE_SCHEDULE_SCHEMA,
        projectKey: { type: "string", description: "Absolute project directory or 'general'; omitted means this project." },
        notificationPolicy: { type: "string", enum: ["all", "findings", "failures"] },
        workspaceMode: { type: "string", enum: ["local", "worktree"] },
        mode: { type: "string", enum: ["default", "bypassPermissions"],
          description: "Default Permissions or Full Access explicitly requested for this scheduled task." },
        timezone: { type: "string", description: "Explicit IANA timezone, such as Asia/Shanghai." },
        modelSelection: { type: "object", required: ["provider", "model"], additionalProperties: false,
          properties: { provider: { type: "string" }, model: { type: "string" } } },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const schedule = input.schedule;
      if (schedule?.type === "monthly") {
        throw new PilotDeckToolRuntimeError("invalid_tool_input",
          "New tasks do not support monthly weekday rules. Use cron for a fixed day of the month, or ask the user to choose another schedule.");
      }
      if (schedule?.type === "interval" &&
        (!Number.isSafeInteger(schedule.everySeconds) || schedule.everySeconds < 60 || schedule.everySeconds % 60 !== 0)) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input",
          "Repeating intervals must be in whole minutes. Set everySeconds to a positive multiple of 60.");
      }
      const channelKey = inferChannelKey(context.sessionId);
      const projectKey = input.projectKey === "general" ? resolvePilotHome(context.env) : input.projectKey ?? context.projectKey ?? context.cwd;
      const result = await runtime.createTask({
        ...input,
        sessionKey: context.sessionId,
        originProjectKey: context.projectKey ?? context.cwd,
        ...(channelKey ? { channelKey } : {}),
        projectKey,
        workspaceCwd: projectKey === (context.projectKey ?? context.cwd) ? context.cwd : undefined,
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
