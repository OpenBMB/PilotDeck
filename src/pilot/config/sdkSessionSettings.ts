import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

import { isRecord } from "../../model/config/schema.js";
import {
  getPilotConfigFilePath,
  getPilotProjectConfigFilePath,
  resolvePilotHome,
  type PilotPathEnv,
} from "../paths.js";

/**
 * The only settings an SDK session may overlay onto an existing Gateway
 * runtime. They deliberately exclude model/provider credentials, plugins,
 * paths, tools, and permission grants.
 */
export type PilotSdkSessionSettings = {
  agent?: {
    /** A session-local primary model or null to retain the Gateway default. */
    model?: string | null;
    /** A session-local fallback model or null to disable a source fallback. */
    fallbackModel?: string | null;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    thinking?: { enabled: boolean; budgetTokens?: number };
    /** A session-local fork model or null to inherit the parent model. */
    subagents?: { default?: string | null; timeoutMs?: number; maxDepth?: number };
  };
};

/** Claude-like source labels resolved exclusively by the Gateway host. */
export type PilotSdkSettingSource = "managed" | "user" | "project" | "local";

const SDK_SETTING_SOURCE_PRECEDENCE = ["managed", "user", "project", "local"] as const;

export type ResolvePilotSdkSessionSettingsOptions = {
  projectRoot: string;
  env?: PilotPathEnv;
  /**
   * Gateway-host-owned defaults applied below selected files and explicit SDK
   * settings. This remains the same non-secret overlay namespace as every
   * other value in this module.
   */
  hostDefaults?: PilotSdkSessionSettings;
  /**
   * Host-owned, non-secret managed source. It participates only when the
   * managed source is selected; remote SDK callers can never provide or
   * inspect this value.
   */
  hostManagedSettings?: PilotSdkSessionSettings;
  /**
   * Gateway-host-owned source layers applied for SDK sessions before optional
   * caller-selected layers. Both use the fixed Gateway source precedence.
   */
  hostSettingSources?: PilotSdkSettingSource[];
  settings?: PilotSdkSessionSettings;
  settingSources?: PilotSdkSettingSource[];
  /**
   * Gateway-host-owned values that win over selected sources and all remote
   * SDK session settings. This stays in the same deliberately non-secret
   * overlay namespace as `hostDefaults`; it does not load or mutate files.
   */
  hostEnforcedSettings?: PilotSdkSessionSettings;
};

export class PilotSdkSessionSettingsError extends Error {
  readonly name = "PilotSdkSessionSettingsError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Resolve a small, non-secret session overlay from Gateway-local config
 * layers. This does not replace `loadPilotConfig()` or alter the host's
 * global configuration. The result is only consumed while one SDK session's
 * native AgentSession config is constructed.
 */
export function resolvePilotSdkSessionSettings(
  options: ResolvePilotSdkSessionSettingsOptions,
): PilotSdkSessionSettings | undefined {
  const sources = mergeSources(options.hostSettingSources, options.settingSources);
  let resolved = mergeSettings(
    undefined,
    normalizeSettings(options.hostDefaults, "hostDefaults"),
  );

  const managedSettings = normalizeSettings(options.hostManagedSettings, "hostManagedSettings");
  for (const source of sources) {
    const sourceSettings = source === "managed"
      ? managedSettings
      : readSourceSettings(source, options.projectRoot, options.env);
    resolved = mergeSettings(resolved, sourceSettings);
  }
  resolved = mergeSettings(resolved, normalizeSettings(options.settings, "settings"));
  resolved = mergeSettings(
    resolved,
    normalizeSettings(options.hostEnforcedSettings, "hostEnforcedSettings"),
  );
  return hasSettings(resolved) ? resolved : undefined;
}

/** Validates SDK-provided settings without reading any Gateway-local files. */
export function validatePilotSdkSessionSettings(value: unknown): void {
  normalizeSettings(value, "settings");
}

/** Validates a source selector without resolving host paths or content. */
export function validatePilotSdkSettingSources(value: unknown): void {
  normalizeSources(value as PilotSdkSettingSource[] | undefined);
}

function normalizeSources(value: PilotSdkSettingSource[] | undefined): PilotSdkSettingSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new PilotSdkSessionSettingsError(
      "INVALID_SDK_SETTING_SOURCES",
      "settingSources must be a non-empty array containing managed, user, project, and/or local.",
    );
  }
  if (value.some((source) => source !== "managed" && source !== "user" && source !== "project" && source !== "local")) {
    throw new PilotSdkSessionSettingsError(
      "UNSUPPORTED_SDK_SETTING_SOURCE",
      "PilotDeck settingSources supports only Gateway-owned managed, user, project, and local sources.",
    );
  }
  if (new Set(value).size !== value.length) {
    throw new PilotSdkSessionSettingsError(
      "INVALID_SDK_SETTING_SOURCES",
      "settingSources cannot contain duplicate entries.",
    );
  }

  // Source order is Gateway policy, not an SDK-client-controlled precedence
  // mechanism. This mirrors the normal configuration hierarchy regardless of
  // the caller's array ordering.
  return SDK_SETTING_SOURCE_PRECEDENCE.filter((source) => value.includes(source));
}

/** Host-selected sources cannot be removed or reordered by a remote SDK. */
function mergeSources(
  hostSources: PilotSdkSettingSource[] | undefined,
  sdkSources: PilotSdkSettingSource[] | undefined,
): PilotSdkSettingSource[] {
  const selected = new Set([
    ...normalizeSources(hostSources),
    ...normalizeSources(sdkSources),
  ]);
  return SDK_SETTING_SOURCE_PRECEDENCE.filter((source) => selected.has(source));
}

function readSourceSettings(
  source: Exclude<PilotSdkSettingSource, "managed">,
  projectRoot: string,
  env: PilotPathEnv | undefined,
): PilotSdkSessionSettings | undefined {
  const path = sourcePath(source, projectRoot, env);
  if (!existsSync(path)) return undefined;

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(readFileSync(path, "utf8"), { prettyErrors: false });
  } catch (error) {
    throw new PilotSdkSessionSettingsError(
      "SDK_SETTING_SOURCE_READ_FAILED",
      `Unable to read ${source} settings source: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document.errors.length > 0) {
    throw new PilotSdkSessionSettingsError(
      "SDK_SETTING_SOURCE_YAML_INVALID",
      `Unable to parse ${source} settings source: ${document.errors.map((item) => item.message).join("; ")}`,
    );
  }
  const parsed = document.toJSON();
  if (parsed === null || parsed === undefined) return undefined;
  if (!isRecord(parsed)) {
    throw new PilotSdkSessionSettingsError(
      "SDK_SETTING_SOURCE_INVALID",
      `${source} settings source must have an object root.`,
    );
  }
  // These source paths are normal Gateway configuration files, not a second
  // SDK-only YAML format. Read only the narrow session-overlay namespace so
  // selecting a source never imports models, credentials, plugins, tools, or
  // arbitrary runtime settings into the SDK session.
  return normalizeSettings(extractSourceOverlay(parsed), `${source} settings source`);
}

function extractSourceOverlay(value: Record<string, unknown>): Record<string, unknown> {
  const agent = value.agent;
  if (agent === undefined) return {};
  if (!isRecord(agent)) return { agent };

  const overlay: Record<string, unknown> = {};
  if (agent.model !== undefined) overlay.model = agent.model;
  if (agent.fallbackModel !== undefined) overlay.fallbackModel = agent.fallbackModel;
  if (agent.maxContextTokens !== undefined) overlay.maxContextTokens = agent.maxContextTokens;
  if (agent.maxOutputTokens !== undefined) overlay.maxOutputTokens = agent.maxOutputTokens;

  if (agent.thinking !== undefined) {
    if (!isRecord(agent.thinking)) {
      overlay.thinking = agent.thinking;
    } else {
      overlay.thinking = {
        ...(agent.thinking.enabled !== undefined ? { enabled: agent.thinking.enabled } : {}),
        ...(agent.thinking.budgetTokens !== undefined
          ? { budgetTokens: agent.thinking.budgetTokens }
          : {}),
      };
    }
  }
  if (agent.subagents !== undefined) {
    if (!isRecord(agent.subagents)) {
      overlay.subagents = agent.subagents;
    } else {
      const subagents: Record<string, unknown> = {};
      if (agent.subagents.default !== undefined) subagents.default = agent.subagents.default;
      if (agent.subagents.timeoutMs !== undefined) subagents.timeoutMs = agent.subagents.timeoutMs;
      if (agent.subagents.maxDepth !== undefined) subagents.maxDepth = agent.subagents.maxDepth;
      if (Object.keys(subagents).length > 0) overlay.subagents = subagents;
    }
  }
  return { agent: overlay };
}

function sourcePath(source: Exclude<PilotSdkSettingSource, "managed">, projectRoot: string, env: PilotPathEnv | undefined): string {
  if (source === "user") return getPilotConfigFilePath(resolvePilotHome(env));
  if (source === "project") return getPilotProjectConfigFilePath(projectRoot);
  return resolve(projectRoot, ".pilotdeck", "pilotdeck.local.yaml");
}

function normalizeSettings(
  value: unknown,
  label: string,
): PilotSdkSessionSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new PilotSdkSessionSettingsError("INVALID_SDK_SETTINGS", `${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "agent") {
      throw new PilotSdkSessionSettingsError(
        "UNSUPPORTED_SDK_SETTING",
        `${label}.${key} is not supported; only non-secret agent model, limits, thinking, and subagent settings may be overlaid.`,
      );
    }
  }
  if (value.agent === undefined) return {};
  if (!isRecord(value.agent)) {
    throw new PilotSdkSessionSettingsError("INVALID_SDK_SETTINGS", `${label}.agent must be an object.`);
  }
  const agent = value.agent;
  for (const key of Object.keys(agent)) {
    if (key !== "model" && key !== "fallbackModel" && key !== "maxContextTokens" && key !== "maxOutputTokens" && key !== "thinking" && key !== "subagents") {
      throw new PilotSdkSessionSettingsError(
        "UNSUPPORTED_SDK_SETTING",
        `${label}.agent.${key} is not supported by the SDK session overlay.`,
      );
    }
  }
  const output: NonNullable<PilotSdkSessionSettings["agent"]> = {};
  if (agent.model !== undefined) {
    if (agent.model !== null && (typeof agent.model !== "string" || !agent.model.trim())) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.model must be a non-empty model id or null.`,
      );
    }
    output.model = agent.model === null ? null : agent.model.trim();
  }
  if (agent.fallbackModel !== undefined) {
    if (agent.fallbackModel !== null && (typeof agent.fallbackModel !== "string" || !agent.fallbackModel.trim())) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.fallbackModel must be a non-empty model id or null.`,
      );
    }
    output.fallbackModel = agent.fallbackModel === null ? null : agent.fallbackModel.trim();
  }
  for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
    const setting = agent[key];
    if (setting === undefined) continue;
    if (typeof setting !== "number" || !Number.isInteger(setting) || setting <= 0) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.${key} must be a positive integer.`,
      );
    }
    output[key] = setting;
  }
  if (agent.thinking !== undefined) {
    if (!isRecord(agent.thinking) || typeof agent.thinking.enabled !== "boolean") {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.thinking must include a boolean enabled field.`,
      );
    }
    for (const key of Object.keys(agent.thinking)) {
      if (key !== "enabled" && key !== "budgetTokens") {
        throw new PilotSdkSessionSettingsError(
          "UNSUPPORTED_SDK_SETTING",
          `${label}.agent.thinking.${key} is not supported by the SDK session overlay.`,
        );
      }
    }
    const budgetTokens = agent.thinking.budgetTokens;
    if (budgetTokens !== undefined && (
      typeof budgetTokens !== "number" || !Number.isInteger(budgetTokens) || budgetTokens < 0
    )) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.thinking.budgetTokens must be a non-negative integer.`,
      );
    }
    output.thinking = {
      enabled: agent.thinking.enabled,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
  }
  if (agent.subagents !== undefined) {
    if (!isRecord(agent.subagents)) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.subagents must be an object.`,
      );
    }
    if (Object.keys(agent.subagents).some((key) => key !== "default" && key !== "timeoutMs" && key !== "maxDepth")) {
      throw new PilotSdkSessionSettingsError(
        "UNSUPPORTED_SDK_SETTING",
        `${label}.agent.subagents supports only default, timeoutMs, and maxDepth for the SDK session overlay.`,
      );
    }
    const defaultModel = agent.subagents.default;
    if (defaultModel !== undefined && defaultModel !== null
      && (typeof defaultModel !== "string" || !defaultModel.trim())) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.subagents.default must be a non-empty model id, "inherit", or null.`,
      );
    }
    const timeoutMs = agent.subagents.timeoutMs;
    if (timeoutMs !== undefined && (
      typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    )) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.subagents.timeoutMs must be a positive integer.`,
      );
    }
    const maxDepth = agent.subagents.maxDepth;
    if (maxDepth !== undefined && (
      typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) || maxDepth < 0
    )) {
      throw new PilotSdkSessionSettingsError(
        "INVALID_SDK_SETTINGS",
        `${label}.agent.subagents.maxDepth must be a non-negative safe integer.`,
      );
    }
    if (defaultModel !== undefined || timeoutMs !== undefined || maxDepth !== undefined) {
      output.subagents = {
        ...(defaultModel !== undefined
          ? { default: defaultModel === null || defaultModel.trim() === "inherit" ? null : defaultModel.trim() }
          : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
    }
  }
  return Object.keys(output).length > 0 ? { agent: output } : {};
}

function mergeSettings(
  base: PilotSdkSessionSettings | undefined,
  override: PilotSdkSessionSettings | undefined,
): PilotSdkSessionSettings | undefined {
  if (!base) return override ? structuredClone(override) : undefined;
  if (!override) return base;
  return {
    agent: {
      ...(base.agent ?? {}),
      ...(override.agent ?? {}),
      ...((base.agent?.subagents || override.agent?.subagents) ? {
        subagents: {
          ...(base.agent?.subagents ?? {}),
          ...(override.agent?.subagents ?? {}),
        },
      } : {}),
    },
  };
}

function hasSettings(value: PilotSdkSessionSettings | undefined): boolean {
  return Boolean(value?.agent && Object.keys(value.agent).length > 0);
}
