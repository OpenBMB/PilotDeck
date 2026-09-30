/**
 * Configurable subagent profiles — shared, browser-safe module.
 *
 * Single source for:
 *   - the raw `agent.subagents.profiles` config shape (`SubagentProfileConfig`),
 *   - structural validation (`parseSubagentProfiles`),
 *   - merging profiles with the built-in presets (`resolveSubagentProfiles`),
 *   - the exact model-facing catalog section (`formatSubagentCatalog`) used by
 *     both the runtime agent tool description and the UI live preview.
 *
 * Imports ONLY browser-safe builtin definitions/data/types — no node-only
 * APIs, no model-runtime imports. The PilotDeck UI may import this module
 * directly.
 */

import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "./builtinSubagentTypes.js";

/** Global cap for `agent.subagents.maxDepth` (and the nesting depth in general). */
export const MAX_SUBAGENT_DEPTH = 5;

const DESCRIPTION_MAX_LENGTH = 2000;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Keys that must never be used as profile ids (prototype pollution vectors). */
const FORBIDDEN_IDS = new Set(["constructor", "prototype"]);
const LEGACY_PROFILE_ALIASES = new Map([
  ["general_purpose", "general-purpose"],
  ["explorer", "explore"],
]);
const PROFILE_FIELDS = ["description", "model", "tools", "readOnly", "enabled"] as const;
/** Default tool allowlist for custom profiles (read/search only). */
export const DEFAULT_CUSTOM_TOOLS: readonly string[] = ["read_file", "grep", "glob"];

/** Raw per-profile config shape under `agent.subagents.profiles.<id>`. */
export type SubagentProfileConfig = {
  /** Required for custom ids; overrides the preset description for builtins. */
  description?: string;
  /**
   * Exact `provider/model` reference, or the literal `"inherit"` to keep
   * automatic routing. Unset means inherit.
   */
  model?: string;
  /** Tool allowlist. Builtins may only narrow their preset list (plus `agent`). */
  tools?: string[];
  /** Read-only enforcement. Defaults to `true` for customs; builtins cannot widen. */
  readOnly?: boolean;
  /** Disabled profiles stay listed in config but are not dispatchable. Default `true`. */
  enabled?: boolean;
};

/** A builtin preset merged with its profile overrides, ready for runtime use. */
export type ResolvedSubagentProfile = SubagentDefinition & {
  /** Bound model reference (`provider/model`); `undefined` retains automatic routing. */
  model?: string;
  /** Disabled profiles are resolved but never dispatchable or catalog-visible. */
  enabled: boolean;
  /** `true` for the four presets, `false` for user-defined customs. */
  builtIn: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileError(path: string, message: string): Error {
  return new Error(`${path} ${message}`);
}

function validateId(id: string): void {
  const path = `agent.subagents.profiles.${id}`;
  const canonicalId = LEGACY_PROFILE_ALIASES.get(id);
  if (canonicalId) {
    throw profileError(
      path,
      `uses the legacy preset name "${id}". Use "${canonicalId}" instead.`,
    );
  }
  if (FORBIDDEN_IDS.has(id) || id === "__proto__") {
    throw profileError(path, "is a reserved identifier and cannot be used as a profile id.");
  }
  if (!ID_PATTERN.test(id)) {
    throw profileError(
      path,
      "must be a lowercase letter followed by lowercase letters, digits, or hyphens (length 1-64).",
    );
  }
}

function validateDescription(id: string, value: unknown, required: boolean): string | undefined {
  const path = `agent.subagents.profiles.${id}.description`;
  if (value === undefined) {
    if (required) {
      throw profileError(path, "is required for custom profiles.");
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw profileError(path, "must be a non-empty string (whitespace-only is rejected).");
  }
  if (value.length > DESCRIPTION_MAX_LENGTH) {
    throw profileError(
      path,
      `must be at most ${DESCRIPTION_MAX_LENGTH} characters (got ${value.length}); shorten it instead of relying on truncation.`,
    );
  }
  return value;
}

/**
 * Structural model-reference validation. Malformed references are rejected
 * here; whether the provider/model actually exists in the catalog is checked
 * by the node-side config loader (needs the model config).
 */
function validateModel(id: string, value: unknown): string {
  const path = `agent.subagents.profiles.${id}.model`;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw profileError(path, "must be a non-empty provider/model string or \"inherit\".");
  }
  const trimmed = value.trim();
  if (trimmed !== value || /\s/.test(trimmed)) {
    throw profileError(path, "must not contain whitespace.");
  }
  if (trimmed === "inherit") {
    return trimmed;
  }
  const separatorIndex = trimmed.indexOf("/");
  const providerId = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : "";
  const modelId = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : "";
  if (!providerId || !modelId) {
    throw profileError(
      path,
      'must use an exact "provider/model" reference (model ids may contain slashes).',
    );
  }
  return trimmed;
}

function validateTools(id: string, value: unknown): string[] {
  const path = `agent.subagents.profiles.${id}.tools`;
  if (!Array.isArray(value)) {
    throw profileError(path, "must be an array of tool names.");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0 || /\s/.test(entry.trim())) {
      throw profileError(path, "entries must be non-empty tool names without whitespace.");
    }
    const tool = entry.trim();
    if (seen.has(tool)) {
      throw profileError(path, `contains duplicate tool "${tool}".`);
    }
    seen.add(tool);
  }
  return value.map((entry) => (entry as string).trim());
}

/**
 * Structural validation of the raw `agent.subagents.profiles` value.
 *
 * Throws a readable `Error` whose message includes the config path
 * (`agent.subagents.profiles.<id>[.<field>]`). Returns `undefined` for an
 * omitted/null section so callers can distinguish "not configured".
 */
export function parseSubagentProfiles(
  value: unknown,
): Record<string, SubagentProfileConfig> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw profileError("agent.subagents.profiles", "must be an object keyed by profile id.");
  }

  const parsed: Record<string, SubagentProfileConfig> = {};
  for (const id of Object.keys(value)) {
    validateId(id);
    const path = `agent.subagents.profiles.${id}`;
    const raw = value[id];
    if (!isRecord(raw)) {
      throw profileError(path, "must be an object.");
    }
    for (const key of Object.keys(raw)) {
      if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
        throw profileError(`${path}.${key}`, "is not a supported profile field.");
      }
    }
    const preset = (SUBAGENT_DEFINITIONS as Record<string, SubagentDefinition>)[id];
    const isBuiltIn = preset !== undefined;

    const description = validateDescription(id, raw.description, !isBuiltIn);
    const model = raw.model !== undefined && raw.model !== null
      ? validateModel(id, raw.model)
      : undefined;
    const tools = raw.tools !== undefined && raw.tools !== null
      ? validateTools(id, raw.tools)
      : undefined;
    if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") {
      throw profileError(`${path}.readOnly`, "must be a boolean.");
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      throw profileError(`${path}.enabled`, "must be a boolean.");
    }
    const readOnly = raw.readOnly as boolean | undefined;

    if (isBuiltIn) {
      if (preset.isReadOnly && readOnly === false) {
        throw profileError(
          path,
          `overrides the read-only preset "${id}"; built-in read-only presets cannot be made writable.`,
        );
      }
      if (tools && preset.isReadOnly) {
        const allowed = new Set([...preset.allowedTools, "agent"]);
        for (const tool of tools) {
          if (!allowed.has(tool)) {
            throw profileError(
              path,
              `cannot add "${tool}" to read-only preset "${id}"; built-in read-only tool lists may only be narrowed (plus "agent" for nested dispatch).`,
            );
          }
        }
      }
    }

    parsed[id] = {
      ...(description !== undefined ? { description } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(readOnly !== undefined ? { readOnly } : {}),
      ...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
    };
  }
  return parsed;
}

/**
 * Merge parsed profiles with the built-in presets.
 *
 * Returns every builtin (in preset order) plus customs (in config order),
 * including disabled entries. `inherit` models normalize to `undefined`.
 * Input must come from {@link parseSubagentProfiles} (or be structurally
 * valid); customs without a description throw a readable error.
 */
export function resolveSubagentProfiles(
  profiles?: Record<string, SubagentProfileConfig>,
): ResolvedSubagentProfile[] {
  const resolved: ResolvedSubagentProfile[] = [];

  for (const [id, preset] of Object.entries(SUBAGENT_DEFINITIONS)) {
    const override = profiles?.[id];
    const model = normalizeModel(override?.model);
    resolved.push({
      ...preset,
      ...(override?.description !== undefined ? { description: override.description } : {}),
      ...(override?.tools !== undefined ? { allowedTools: [...override.tools] } : {}),
      ...(override?.readOnly !== undefined ? { isReadOnly: override.readOnly } : {}),
      ...(model !== undefined ? { model } : {}),
      enabled: override?.enabled ?? true,
      builtIn: true,
    });
  }

  if (profiles) {
    for (const [id, config] of Object.entries(profiles)) {
      if ((SUBAGENT_DEFINITIONS as Record<string, SubagentDefinition>)[id] !== undefined) {
        continue;
      }
      if (!config.description || config.description.trim().length === 0) {
        throw profileError(
          `agent.subagents.profiles.${id}.description`,
          "is required for custom profiles.",
        );
      }
      const model = normalizeModel(config.model);
      resolved.push({
        id,
        description: config.description,
        allowedTools: config.tools ? [...config.tools] : [...DEFAULT_CUSTOM_TOOLS],
        omitProjectInstructions: false,
        omitGitStatus: false,
        isReadOnly: config.readOnly ?? true,
        systemPromptSuffix:
          "Custom profile mode: follow the parent's directive exactly and stay strictly within your allowed tool set.",
        ...(model !== undefined ? { model } : {}),
        enabled: config.enabled ?? true,
        builtIn: false,
      });
    }
  }

  return resolved;
}

function normalizeModel(model: string | undefined): string | undefined {
  if (model === undefined || model === "inherit" || model.trim().length === 0) {
    return undefined;
  }
  return model;
}

/**
 * Profiles currently dispatchable for a parent in normal vs ask/plan mode.
 * Disabled profiles are never dispatchable; ask mode exposes read-only
 * profiles only (writable presets are remapped or rejected by the caller).
 */
export function selectDispatchableSubagentProfiles(
  profiles: readonly ResolvedSubagentProfile[],
  options: { askMode?: boolean } = {},
): ResolvedSubagentProfile[] {
  const askMode = options.askMode ?? false;
  return profiles.filter((profile) => profile.enabled && (!askMode || profile.isReadOnly));
}

/**
 * Exact model-facing catalog section: enabled profiles only, ids +
 * descriptions, never model ids. Empty string when nothing is enabled.
 */
export function formatSubagentCatalog(
  profiles: readonly ResolvedSubagentProfile[],
): string {
  const enabled = profiles.filter((profile) => profile.enabled);
  if (enabled.length === 0) {
    return "";
  }
  return [
    "Available subagent types (choose `subagent_type` by matching the task to a description):",
    ...enabled.map((profile) => `- ${profile.id}: ${profile.description}`),
  ].join("\n");
}
