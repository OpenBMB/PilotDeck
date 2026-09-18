import { isAbsolute, join, resolve } from "node:path";

import { isRecord } from "../../model/config/schema.js";
import type { StaffDeckSopRuntimeConfig } from "../../sop/staffdeck/types.js";
import type { PilotConfigDiagnostic, PilotModulesConfig } from "./types.js";

const CORE_MODULE_NAMES = ["agentLoop", "modelProvider", "tools"] as const;

/** Parse the first supported composition profile without silently changing ownership. */
export function parseModulesConfig(
  raw: unknown,
  pilotHome: string,
  diagnostics: PilotConfigDiagnostic[],
): PilotModulesConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    fatal(diagnostics, "MODULES_INVALID", "modules must be an object.", "modules");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (![...CORE_MODULE_NAMES, "sop"].includes(key as (typeof CORE_MODULE_NAMES)[number] | "sop")) {
      warning(diagnostics, "MODULES_UNKNOWN_FIELD", `Unknown modules field '${key}'.`, `modules.${key}`);
    }
  }

  const core = Object.fromEntries(CORE_MODULE_NAMES.map((name) => [name, parseCoreModule(name, raw[name], diagnostics)]));
  const sop = parseSopModule(raw.sop, pilotHome, diagnostics);
  return {
    ...(core.agentLoop ? { agentLoop: core.agentLoop } : {}),
    ...(core.modelProvider ? { modelProvider: core.modelProvider } : {}),
    ...(core.tools ? { tools: core.tools } : {}),
    ...(sop ? { sop } : {}),
  };
}

function parseCoreModule(
  name: (typeof CORE_MODULE_NAMES)[number],
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): { enabled: true; provider: "pilotdeck" } | undefined {
  if (value === undefined || value === null) return undefined;
  const path = `modules.${name}`;
  if (!isRecord(value)) {
    fatal(diagnostics, "MODULE_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  warnUnknownKeys(value, ["enabled", "provider"], path, diagnostics);
  if (value.enabled !== true || value.provider !== "pilotdeck") {
    fatal(diagnostics, "MODULE_PROVIDER_UNSUPPORTED", `${path} currently requires enabled: true and provider: pilotdeck.`, path);
    return undefined;
  }
  return { enabled: true, provider: "pilotdeck" };
}

function parseSopModule(
  value: unknown,
  pilotHome: string,
  diagnostics: PilotConfigDiagnostic[],
): StaffDeckSopRuntimeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const path = "modules.sop";
  if (!isRecord(value)) {
    fatal(diagnostics, "SOP_MODULE_INVALID", `${path} must be an object.`, path);
    return undefined;
  }
  warnUnknownKeys(value, ["enabled", "provider", "endpoint", "definitionsPath", "defaultSopId", "timeoutMs"], path, diagnostics);
  if (value.enabled === false) return undefined;
  if (value.enabled !== true) {
    fatal(diagnostics, "SOP_MODULE_ENABLED_INVALID", "modules.sop.enabled must be a boolean.", `${path}.enabled`);
    return undefined;
  }
  if (value.provider !== "staffdeck") {
    fatal(diagnostics, "SOP_MODULE_PROVIDER_INVALID", "modules.sop.provider must be staffdeck.", `${path}.provider`);
    return undefined;
  }
  const endpoint = nonEmptyText(value.endpoint);
  if (!endpoint || !isHttpUrl(endpoint)) {
    fatal(diagnostics, "SOP_MODULE_ENDPOINT_INVALID", "modules.sop.endpoint must be an absolute http(s) URL.", `${path}.endpoint`);
  }
  const definitionsPath = nonEmptyText(value.definitionsPath);
  if (!definitionsPath) {
    fatal(diagnostics, "SOP_MODULE_DEFINITIONS_PATH_INVALID", "modules.sop.definitionsPath must be a non-empty path.", `${path}.definitionsPath`);
  }
  const defaultSopId = nonEmptyText(value.defaultSopId);
  if (!defaultSopId) {
    fatal(diagnostics, "SOP_MODULE_DEFAULT_ID_INVALID", "modules.sop.defaultSopId must be a non-empty string.", `${path}.defaultSopId`);
  }
  const timeoutMs = optionalPositiveInteger(value.timeoutMs);
  if (value.timeoutMs !== undefined && timeoutMs === undefined) {
    fatal(diagnostics, "SOP_MODULE_TIMEOUT_INVALID", "modules.sop.timeoutMs must be a positive integer.", `${path}.timeoutMs`);
  }
  if (!endpoint || !definitionsPath || !defaultSopId) return undefined;
  return {
    provider: "staffdeck",
    endpoint,
    definitionsPath: isAbsolute(definitionsPath) ? definitionsPath : resolve(pilotHome, definitionsPath),
    defaultSopId,
    stateRoot: join(pilotHome, "sop"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) warning(diagnostics, "MODULE_UNKNOWN_FIELD", `Unknown field '${path}.${key}'.`, `${path}.${key}`);
  }
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function fatal(diagnostics: PilotConfigDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, severity: "fatal", message, path, recoverable: false });
}

function warning(diagnostics: PilotConfigDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, severity: "warning", message, path, recoverable: true });
}
