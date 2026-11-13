import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronCreateInput, CronCreateResult } from "../protocol/types.js";
import type { GatewayChannelKey } from "../../gateway/index.js";
import { CRON_SCHEDULE_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";
import { resolvePilotHome } from "../../pilot/paths.js";

export function createCronCreateTool(runtime: CronToolRuntime): PilotDeckToolDefinition<CronCreateInput, CronCreateResult> {
  return {
    name: "cron_create",
    title: "Create Cron Task",
    description: "Create a durable scheduled task managed by the Scheduled Tasks page. Each task owns a dedicated task conversation; recurring runs continue that same conversation. Results stay in Scheduled Tasks and never enter the source chat. Project defaults to this conversation; projectKey may select another absolute project path or 'general'. For relative reminders use delay. Before resolving tonight/tomorrow/next Monday, call get_current_time and pass an explicit timezone. Give every task a short name and a durable instruction that works on future dates. Creation saves the task without running it immediately; report its timezone and nextRunAt. Unattended tasks cannot ask questions; default permissions remain restricted unless the user explicitly requests Full Access.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["message", "schedule"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        message: { type: "string", minLength: 1 },
        schedule: CRON_SCHEDULE_SCHEMA,
        projectKey: { type: "string", description: "Absolute project directory or 'general'; omitted means this project." },
        notificationPolicy: { type: "string", enum: ["all", "findings", "failures"] },
        workspaceMode: { type: "string", enum: ["local", "worktree"] },
        mode: { type: "string", enum: ["default", "plan", "bypassPermissions"] },
        timezone: { type: "string", description: "Explicit IANA timezone, such as Asia/Shanghai." },
        modelSelection: { type: "object", required: ["provider", "model"], additionalProperties: false,
          properties: { provider: { type: "string" }, model: { type: "string" } } },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
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
