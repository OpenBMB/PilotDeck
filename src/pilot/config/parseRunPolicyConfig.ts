import { isRecord } from "../../model/config/schema.js";
import type {
  PilotConfigDiagnostic,
  PilotFailureGuardConfig,
  PilotRunPolicyConfig,
} from "./types.js";

const SAFE_TOOL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function parseRunPolicyConfig(
  rawRunPolicy: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotRunPolicyConfig | undefined {
  if (rawRunPolicy === undefined) return undefined;
  if (!isRecord(rawRunPolicy)) {
    fatal(diagnostics, "RUN_POLICY_INVALID", "runPolicy config must be an object.", "runPolicy");
    return undefined;
  }

  const failureGuard = parseFailureGuard(rawRunPolicy.failureGuard, diagnostics);
  for (const key of Object.keys(rawRunPolicy)) {
    if (key !== "failureGuard") {
      diagnostics.push({
        code: "RUN_POLICY_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown runPolicy config field ${key}.`,
        path: `runPolicy.${key}`,
        recoverable: true,
      });
    }
  }
  return failureGuard ? { failureGuard } : undefined;
}

function parseFailureGuard(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotFailureGuardConfig | undefined {
  const result: PilotFailureGuardConfig = {
    enabled: false,
    modelFailureLimit: 0,
    toolFailureLimits: {},
    toolLabels: {},
  };
  if (raw === undefined) return result;
  if (!isRecord(raw)) {
    fatal(
      diagnostics,
      "RUN_POLICY_FAILURE_GUARD_INVALID",
      "runPolicy.failureGuard must be an object.",
      "runPolicy.failureGuard",
    );
    return undefined;
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
    else fatal(
      diagnostics,
      "RUN_POLICY_FAILURE_GUARD_ENABLED_INVALID",
      "runPolicy.failureGuard.enabled must be a boolean.",
      "runPolicy.failureGuard.enabled",
    );
  }
  if (raw.modelFailureLimit !== undefined) {
    result.modelFailureLimit = parseLimit(
      raw.modelFailureLimit,
      "runPolicy.failureGuard.modelFailureLimit",
      "RUN_POLICY_FAILURE_GUARD_MODEL_LIMIT_INVALID",
      diagnostics,
    );
  }
  if (raw.toolFailureLimits !== undefined) {
    const limits = parseLimitRecord(raw.toolFailureLimits, diagnostics);
    if (limits) result.toolFailureLimits = limits;
  }
  if (raw.toolLabels !== undefined) {
    const labels = parseLabelRecord(raw.toolLabels, diagnostics);
    if (labels) result.toolLabels = labels;
  }
  for (const key of Object.keys(raw)) {
    if (!["enabled", "modelFailureLimit", "toolFailureLimits", "toolLabels"].includes(key)) {
      diagnostics.push({
        code: "RUN_POLICY_FAILURE_GUARD_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown runPolicy.failureGuard field ${key}.`,
        path: `runPolicy.failureGuard.${key}`,
        recoverable: true,
      });
    }
  }
  return result;
}

function parseLimit(
  value: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fatal(diagnostics, code, `${path} must be a non-negative integer.`, path);
    return 0;
  }
  return value as number;
}

function parseLimitRecord(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): Record<string, number> | undefined {
  const path = "runPolicy.failureGuard.toolFailureLimits";
  if (!isRecord(value)) {
    fatal(diagnostics, "RUN_POLICY_FAILURE_GUARD_TOOL_LIMITS_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!SAFE_TOOL_KEY.test(key)) {
      fatal(diagnostics, "RUN_POLICY_FAILURE_GUARD_TOOL_LIMIT_KEY_INVALID", `${path} has an invalid key.`, `${path}.${key}`);
      continue;
    }
    result[key] = parseLimit(limit, `${path}.${key}`, "RUN_POLICY_FAILURE_GUARD_TOOL_LIMIT_INVALID", diagnostics);
  }
  return result;
}

function parseLabelRecord(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): Record<string, string> | undefined {
  const path = "runPolicy.failureGuard.toolLabels";
  if (!isRecord(value)) {
    fatal(diagnostics, "RUN_POLICY_FAILURE_GUARD_TOOL_LABELS_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (!SAFE_TOOL_KEY.test(key)) {
      fatal(diagnostics, "RUN_POLICY_FAILURE_GUARD_TOOL_LABEL_KEY_INVALID", `${path} has an invalid key.`, `${path}.${key}`);
      continue;
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      fatal(diagnostics, "RUN_POLICY_FAILURE_GUARD_TOOL_LABEL_INVALID", `${path}.${key} must be a non-empty string.`, `${path}.${key}`);
      continue;
    }
    result[key] = label.trim();
  }
  return result;
}

function fatal(
  diagnostics: PilotConfigDiagnostic[],
  code: string,
  message: string,
  path: string,
): void {
  diagnostics.push({ code, severity: "fatal", message, path, recoverable: false });
}
