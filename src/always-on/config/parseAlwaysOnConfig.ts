import { resolve } from "node:path";
import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic } from "../../pilot/config/types.js";

export type AlwaysOnTriggerConfig = {
  tickIntervalMinutes: number;
  cooldownMinutes: number;
  dailyBudget: number;
  heartbeatStaleSeconds: number;
  recentUserMsgMinutes: number;
  preferChannel: string;
};

export type AlwaysOnProjectConfig = {
  enabled: boolean;
};

export type AlwaysOnPromptLanguage = "en" | "zh-CN";

export type AlwaysOnConfig = {
  language?: AlwaysOnPromptLanguage;
  trigger: AlwaysOnTriggerConfig;
  projects: Record<string, AlwaysOnProjectConfig>;
};

export const DEFAULT_IGNORE_GLOBS: string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.pilotdeck/**",
  "**/.pilotdeck-always-on/**",
  "**/dist/**",
  "**/.DS_Store",
];

export const DEFAULT_SNAPSHOT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const DEFAULT_MAX_PLANS_PER_CYCLE = 3;

export function defaultAlwaysOnConfig(): AlwaysOnConfig {
  return {
    trigger: {
      tickIntervalMinutes: 5,
      cooldownMinutes: 60,
      dailyBudget: 4,
      heartbeatStaleSeconds: 90,
      recentUserMsgMinutes: 5,
      preferChannel: "web",
    },
    projects: {},
  };
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "language",
  "trigger",
  "projects",
]);

const VALID_LANGUAGES = new Set<string>(["en", "zh-CN"]);

const REMOVED_TOP_LEVEL_KEYS: Record<string, string> = {
  discovery:
    "alwaysOn.discovery wrapper has been removed. Lift trigger / projects to alwaysOn.<key>.",
  plan: "alwaysOn.plan section has been removed. plan-per-fire is fixed at 1 by protocol.",
  cron: "Always-On cron is no longer part of this module.",
  dormancy:
    "alwaysOn.dormancy has been removed. Dormancy is always active with built-in defaults and can no longer be configured.",
  workspace:
    "alwaysOn.workspace has been removed. Workspace parameters are now hardcoded internally.",
  execution:
    "alwaysOn.execution has been removed. Execution limits are now managed by the runtime.",
};

const REMOVED_PROJECT_KEYS: Record<string, string> = {
  sessionKey:
    "alwaysOn.projects.<root>.sessionKey is no longer accepted. The runtime derives sessionKey from projectKey + runId.",
  workspace:
    "alwaysOn.projects.<root>.workspace per-project override is no longer accepted. WorkspaceProviderRegistry resolves provider automatically.",
};

export function parseAlwaysOnConfig(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): AlwaysOnConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_CONFIG_INVALID",
      severity: "fatal",
      message: "alwaysOn config must be an object.",
      path: "alwaysOn",
      recoverable: false,
    });
    return undefined;
  }

  const result = defaultAlwaysOnConfig();

  if (raw.enabled !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_FIELD_REMOVED",
      severity: "warning",
      message:
        "alwaysOn.enabled has been removed. Always-On is active when any project in alwaysOn.projects is enabled; this field is ignored.",
      path: "alwaysOn.enabled",
      recoverable: true,
    });
  }

  if (typeof raw.language === "string" && VALID_LANGUAGES.has(raw.language)) {
    result.language = raw.language as AlwaysOnPromptLanguage;
  } else if (raw.language !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_LANGUAGE_INVALID",
      severity: "warning",
      message: `alwaysOn.language must be "en" or "zh-CN"; ignoring "${String(raw.language)}".`,
      path: "alwaysOn.language",
      recoverable: true,
    });
  }

  for (const key of Object.keys(raw)) {
    if (key === "enabled") continue;
    const removalReason = REMOVED_TOP_LEVEL_KEYS[key];
    if (removalReason) {
      diagnostics.push({
        code: "ALWAYS_ON_FIELD_REMOVED",
        severity: "warning",
        message: removalReason,
        path: `alwaysOn.${key}`,
        recoverable: true,
      });
      continue;
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push({
        code: "ALWAYS_ON_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown alwaysOn field ${key}.`,
        path: `alwaysOn.${key}`,
        recoverable: true,
      });
    }
  }

  if (raw.trigger !== undefined) {
    parseTrigger(raw.trigger, result.trigger, diagnostics);
  }
  if (raw.projects !== undefined) {
    result.projects = parseProjects(raw.projects, diagnostics);
  }

  return result;
}

function parseTrigger(
  raw: unknown,
  target: AlwaysOnTriggerConfig,
  diagnostics: PilotConfigDiagnostic[],
): void {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_TRIGGER_INVALID",
      severity: "fatal",
      message: "alwaysOn.trigger must be an object.",
      path: "alwaysOn.trigger",
      recoverable: false,
    });
    return;
  }
  if (raw.enabled !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_FIELD_REMOVED",
      severity: "warning",
      message: "alwaysOn.trigger.enabled has been removed and is ignored.",
      path: "alwaysOn.trigger.enabled",
      recoverable: true,
    });
  }
  target.tickIntervalMinutes = positiveNumber(
    raw.tickIntervalMinutes,
    target.tickIntervalMinutes,
    "alwaysOn.trigger.tickIntervalMinutes",
    diagnostics,
  );
  target.cooldownMinutes = nonNegativeNumber(
    raw.cooldownMinutes,
    target.cooldownMinutes,
    "alwaysOn.trigger.cooldownMinutes",
    diagnostics,
  );
  target.dailyBudget = nonNegativeInteger(
    raw.dailyBudget,
    target.dailyBudget,
    "alwaysOn.trigger.dailyBudget",
    diagnostics,
  );
  target.heartbeatStaleSeconds = positiveNumber(
    raw.heartbeatStaleSeconds,
    target.heartbeatStaleSeconds,
    "alwaysOn.trigger.heartbeatStaleSeconds",
    diagnostics,
  );
  target.recentUserMsgMinutes = nonNegativeNumber(
    raw.recentUserMsgMinutes,
    target.recentUserMsgMinutes,
    "alwaysOn.trigger.recentUserMsgMinutes",
    diagnostics,
  );
  if (typeof raw.preferChannel === "string" && raw.preferChannel.length > 0) {
    target.preferChannel = raw.preferChannel;
  } else if (raw.preferChannel !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_TRIGGER_PREFER_CHANNEL_INVALID",
      severity: "warning",
      message: "alwaysOn.trigger.preferChannel must be a non-empty string; falling back to default.",
      path: "alwaysOn.trigger.preferChannel",
      recoverable: true,
    });
  }
}

function parseProjects(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): Record<string, AlwaysOnProjectConfig> {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_PROJECTS_INVALID",
      severity: "fatal",
      message: "alwaysOn.projects must be an object keyed by absolute project root.",
      path: "alwaysOn.projects",
      recoverable: false,
    });
    return {};
  }

  const projects: Record<string, AlwaysOnProjectConfig> = {};
  for (const [rootKey, value] of Object.entries(raw)) {
    if (typeof rootKey !== "string" || rootKey.trim().length === 0) {
      continue;
    }
    if (!isRecord(value)) {
      diagnostics.push({
        code: "ALWAYS_ON_PROJECT_INVALID",
        severity: "fatal",
        message: `alwaysOn.projects.${rootKey} must be an object.`,
        path: `alwaysOn.projects.${rootKey}`,
        recoverable: false,
      });
      continue;
    }
    for (const innerKey of Object.keys(value)) {
      const removed = REMOVED_PROJECT_KEYS[innerKey];
      if (removed) {
        diagnostics.push({
          code: "ALWAYS_ON_FIELD_REMOVED",
          severity: "warning",
          message: removed,
          path: `alwaysOn.projects.${rootKey}.${innerKey}`,
          recoverable: true,
        });
      } else if (innerKey !== "enabled") {
        diagnostics.push({
          code: "ALWAYS_ON_PROJECT_UNKNOWN_FIELD",
          severity: "warning",
          message: `Unknown alwaysOn.projects.${rootKey}.${innerKey}; only 'enabled' is accepted.`,
          path: `alwaysOn.projects.${rootKey}.${innerKey}`,
          recoverable: true,
        });
      }
    }
    const enabled = typeof value.enabled === "boolean" ? value.enabled : false;
    const normalizedKey = resolve(rootKey);
    projects[normalizedKey] = { enabled };
  }
  return projects;
}

function positiveNumber(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a positive number; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}

function nonNegativeNumber(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a non-negative number; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a non-negative integer; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}
