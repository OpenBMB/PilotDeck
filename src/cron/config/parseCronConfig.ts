import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic } from "../../pilot/config/types.js";

export type CronConfig = {
  enabled: boolean;
  timezone: string;
  maxConcurrentRuns: number;
};

export function defaultCronConfig(): CronConfig {
  return {
    enabled: true,
    timezone: "UTC",
    maxConcurrentRuns: 1,
  };
}

const ALLOWED_KEYS = new Set(["enabled", "timezone", "maxConcurrentRuns"]);

export function parseCronConfig(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): CronConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "CRON_CONFIG_INVALID",
      severity: "fatal",
      message: "cron config must be an object.",
      path: "cron",
      recoverable: false,
    });
    return undefined;
  }

  const result = defaultCronConfig();
  result.enabled = booleanField(raw, "enabled", result.enabled);
  result.timezone = nonEmptyString(raw.timezone, result.timezone, "cron.timezone", diagnostics);
  result.maxConcurrentRuns = positiveInteger(
    raw.maxConcurrentRuns,
    result.maxConcurrentRuns,
    "cron.maxConcurrentRuns",
    diagnostics,
  );

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      diagnostics.push({
        code: "CRON_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown cron config field ${key}.`,
        path: `cron.${key}`,
        recoverable: true,
      });
    }
  }

  return result;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function nonEmptyString(
  value: unknown,
  fallback: string,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  diagnostics.push({
    code: "CRON_STRING_INVALID",
    severity: "warning",
    message: `${path} must be a non-empty string; falling back to ${fallback}.`,
    path,
    recoverable: true,
  });
  return fallback;
}

function positiveInteger(
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
    value <= 0
  ) {
    diagnostics.push({
      code: "CRON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a positive integer; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}
