import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { isMap, parseDocument } from "yaml";
import { getPilotConfigFilePath, resolvePilotHome, type PilotPathEnv } from "../paths.js";
import { loadPilotConfig } from "./loadPilotConfig.js";

/**
 * Deliberately small, non-secret subset of `pilotdeck.yaml` that the public
 * SDK may persist through `Query.updateSettings("localSettings", ...)`.
 *
 * The Gateway owns this mutation because the SDK client must never assume the
 * remote host's PILOT_HOME or write into its own local configuration instead.
 */
export type PilotLocalSettingsUpdate = {
  agent?: {
    maxContextTokens?: number | null;
    maxOutputTokens?: number | null;
    thinking?: { enabled: boolean; budgetTokens?: number } | null;
    /**
     * These values use the native `agent.subagents` configuration schema.
     * `null` clears the whole section; null child values clear just that key.
     */
    subagents?: {
      default?: string | null;
      timeoutMs?: number | null;
      maxDepth?: number | null;
    } | null;
  };
  extension?: {
    includeHookEvents?: boolean | null;
    /** Explicit per-plugin enablement map; it never loads arbitrary plugin paths. */
    builtinPluginsEnabled?: Record<string, boolean> | null;
  };
  tools?: {
    /** SDK may switch an already configured web-search integration on or off, but cannot write its credentials. */
    webSearch?: {
      enabled?: boolean | null;
    };
  };
};

export type PilotLocalSettingsUpdateResult = {
  applied: string[];
  cleared: string[];
  changedPaths: string[];
};

export type UpdatePilotLocalSettingsOptions = {
  settings: Record<string, unknown>;
  env?: PilotPathEnv;
  projectRoot?: string;
};

/**
 * Validate, atomically persist, and return an allowlisted local settings
 * update.  Validation happens against a temporary PILOT_HOME before the
 * actual config file is replaced, so a rejected SDK call cannot leave an
 * invalid `pilotdeck.yaml` behind.
 */
export async function updatePilotLocalSettings(
  options: UpdatePilotLocalSettingsOptions,
): Promise<PilotLocalSettingsUpdateResult> {
  const settings = normalizeSettings(options.settings);
  const env = options.env ?? process.env;
  const configPath = getPilotConfigFilePath(resolvePilotHome(env));
  const original = await readFile(configPath, "utf8").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new PilotLocalSettingsError("LOCAL_SETTINGS_READ_FAILED", `Unable to read local settings: ${message}`);
  });
  const document = parseDocument(original, { prettyErrors: false });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    const detail = document.errors[0]?.message ?? "Config root must be a YAML mapping.";
    throw new PilotLocalSettingsError("LOCAL_SETTINGS_YAML_INVALID", `Unable to update local settings: ${detail}`);
  }

  const { applied, cleared } = applySettings(document, settings);
  if (applied.length === 0 && cleared.length === 0) {
    return { applied, cleared, changedPaths: [] };
  }
  const updated = document.toString();
  await validateCandidateConfig(updated, env, options.projectRoot);
  await atomicWrite(configPath, updated);
  return { applied, cleared, changedPaths: [...applied, ...cleared] };
}

export class PilotLocalSettingsError extends Error {
  readonly name = "PilotLocalSettingsError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function normalizeSettings(value: Record<string, unknown>): PilotLocalSettingsUpdate {
  if (!isRecord(value)) {
    throw new PilotLocalSettingsError("INVALID_LOCAL_SETTINGS", "localSettings must be an object.");
  }
  const allowedRoots = new Set(["agent", "extension", "tools"]);
  for (const key of Object.keys(value)) {
    if (!allowedRoots.has(key)) {
      throw unsupported(`localSettings.${key}`);
    }
  }

  const settings: PilotLocalSettingsUpdate = {};
  if (value.agent !== undefined) {
    if (!isRecord(value.agent)) throw invalid("localSettings.agent", "must be an object.");
    const allowed = new Set(["maxContextTokens", "maxOutputTokens", "thinking", "subagents"]);
    for (const key of Object.keys(value.agent)) {
      if (!allowed.has(key)) throw unsupported(`localSettings.agent.${key}`);
    }
    const agent: NonNullable<PilotLocalSettingsUpdate["agent"]> = {};
    for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
      if (value.agent[key] === undefined) continue;
      if (value.agent[key] !== null && (!Number.isInteger(value.agent[key]) || (value.agent[key] as number) <= 0)) {
        throw invalid(`localSettings.agent.${key}`, "must be a positive integer or null.");
      }
      agent[key] = value.agent[key] as number | null;
    }
    if (value.agent.thinking !== undefined) {
      if (value.agent.thinking !== null && !isRecord(value.agent.thinking)) {
        throw invalid("localSettings.agent.thinking", "must be an object or null.");
      }
      if (value.agent.thinking !== null) {
        const thinking = value.agent.thinking;
        const allowedThinking = new Set(["enabled", "budgetTokens"]);
        for (const key of Object.keys(thinking)) {
          if (!allowedThinking.has(key)) throw unsupported(`localSettings.agent.thinking.${key}`);
        }
        if (typeof thinking.enabled !== "boolean") {
          throw invalid("localSettings.agent.thinking.enabled", "must be a boolean.");
        }
        if (thinking.budgetTokens !== undefined
          && (!Number.isInteger(thinking.budgetTokens) || (thinking.budgetTokens as number) < 0)) {
          throw invalid("localSettings.agent.thinking.budgetTokens", "must be a non-negative integer.");
        }
        agent.thinking = {
          enabled: thinking.enabled,
          ...(thinking.budgetTokens !== undefined ? { budgetTokens: thinking.budgetTokens as number } : {}),
        };
      } else {
        agent.thinking = null;
      }
    }
    if (value.agent.subagents !== undefined) {
      if (value.agent.subagents === null) {
        agent.subagents = null;
      } else {
        if (!isRecord(value.agent.subagents)) {
          throw invalid("localSettings.agent.subagents", "must be an object or null.");
        }
        const allowedSubagents = new Set(["default", "timeoutMs", "maxDepth"]);
        for (const key of Object.keys(value.agent.subagents)) {
          if (!allowedSubagents.has(key)) throw unsupported(`localSettings.agent.subagents.${key}`);
        }
        const subagents: NonNullable<NonNullable<PilotLocalSettingsUpdate["agent"]>["subagents"]> = {};
        if (value.agent.subagents.default !== undefined) {
          const model = value.agent.subagents.default;
          if (model !== null && (typeof model !== "string" || model.trim().length === 0)) {
            throw invalid("localSettings.agent.subagents.default", 'must be a non-empty "provider/model" string, "inherit", or null.');
          }
          subagents.default = model === null ? null : model.trim();
        }
        if (value.agent.subagents.timeoutMs !== undefined) {
          const timeoutMs = value.agent.subagents.timeoutMs;
          if (timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
            throw invalid("localSettings.agent.subagents.timeoutMs", "must be a positive integer or null.");
          }
          subagents.timeoutMs = timeoutMs;
        }
        if (value.agent.subagents.maxDepth !== undefined) {
          const maxDepth = value.agent.subagents.maxDepth;
          if (maxDepth !== null && (
            typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) || maxDepth < 0
          )) {
            throw invalid("localSettings.agent.subagents.maxDepth", "must be a non-negative safe integer or null.");
          }
          subagents.maxDepth = maxDepth;
        }
        agent.subagents = subagents;
      }
    }
    settings.agent = agent;
  }

  if (value.extension !== undefined) {
    if (!isRecord(value.extension)) throw invalid("localSettings.extension", "must be an object.");
    const allowed = new Set(["includeHookEvents", "builtinPluginsEnabled"]);
    for (const key of Object.keys(value.extension)) {
      if (!allowed.has(key)) throw unsupported(`localSettings.extension.${key}`);
    }
    const extension: NonNullable<PilotLocalSettingsUpdate["extension"]> = {};
    if (value.extension.includeHookEvents !== undefined) {
      if (value.extension.includeHookEvents !== null && typeof value.extension.includeHookEvents !== "boolean") {
        throw invalid("localSettings.extension.includeHookEvents", "must be a boolean or null.");
      }
      extension.includeHookEvents = value.extension.includeHookEvents as boolean | null;
    }
    if (value.extension.builtinPluginsEnabled !== undefined) {
      const enabled = value.extension.builtinPluginsEnabled;
      if (enabled !== null && !isRecord(enabled)) {
        throw invalid("localSettings.extension.builtinPluginsEnabled", "must be an object of booleans or null.");
      }
      if (enabled !== null) {
        const normalized: Record<string, boolean> = {};
        for (const [name, value] of Object.entries(enabled)) {
          if (!name.trim() || typeof value !== "boolean") {
            throw invalid("localSettings.extension.builtinPluginsEnabled", "must be an object with non-empty keys and boolean values.");
          }
          normalized[name] = value;
        }
        extension.builtinPluginsEnabled = normalized;
      } else {
        extension.builtinPluginsEnabled = null;
      }
    }
    settings.extension = extension;
  }

  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) throw invalid("localSettings.tools", "must be an object.");
    for (const key of Object.keys(value.tools)) {
      if (key !== "webSearch") throw unsupported(`localSettings.tools.${key}`);
    }
    const tools: NonNullable<PilotLocalSettingsUpdate["tools"]> = {};
    if (value.tools.webSearch !== undefined) {
      if (!isRecord(value.tools.webSearch)) {
        throw invalid("localSettings.tools.webSearch", "must be an object.");
      }
      for (const key of Object.keys(value.tools.webSearch)) {
        if (key !== "enabled") throw unsupported(`localSettings.tools.webSearch.${key}`);
      }
      const webSearch: NonNullable<NonNullable<PilotLocalSettingsUpdate["tools"]>["webSearch"]> = {};
      if (value.tools.webSearch.enabled !== undefined) {
        const enabled = value.tools.webSearch.enabled;
        if (enabled !== null && typeof enabled !== "boolean") {
          throw invalid("localSettings.tools.webSearch.enabled", "must be a boolean or null.");
        }
        webSearch.enabled = enabled as boolean | null;
      }
      tools.webSearch = webSearch;
    }
    settings.tools = tools;
  }
  return settings;
}

function applySettings(document: ReturnType<typeof parseDocument>, settings: PilotLocalSettingsUpdate): {
  applied: string[];
  cleared: string[];
} {
  const applied: string[] = [];
  const cleared: string[] = [];
  const set = (path: string[], value: unknown) => {
    const label = path.join(".");
    if (value === null) {
      document.deleteIn(path);
      cleared.push(label);
    } else {
      document.setIn(path, value);
      applied.push(label);
    }
  };
  if (settings.agent) {
    if (settings.agent.maxContextTokens !== undefined) set(["agent", "maxContextTokens"], settings.agent.maxContextTokens);
    if (settings.agent.maxOutputTokens !== undefined) set(["agent", "maxOutputTokens"], settings.agent.maxOutputTokens);
    if (settings.agent.thinking !== undefined) set(["agent", "thinking"], settings.agent.thinking);
    if (settings.agent.subagents === null) {
      set(["agent", "subagents"], null);
    } else if (settings.agent.subagents) {
      if (settings.agent.subagents.default !== undefined) {
        set(["agent", "subagents", "default"], settings.agent.subagents.default);
      }
      if (settings.agent.subagents.timeoutMs !== undefined) {
        set(["agent", "subagents", "timeoutMs"], settings.agent.subagents.timeoutMs);
      }
      if (settings.agent.subagents.maxDepth !== undefined) {
        set(["agent", "subagents", "maxDepth"], settings.agent.subagents.maxDepth);
      }
    }
  }
  if (settings.extension?.includeHookEvents !== undefined) {
    set(["extension", "includeHookEvents"], settings.extension.includeHookEvents);
  }
  if (settings.extension?.builtinPluginsEnabled !== undefined) {
    set(["extension", "builtinPluginsEnabled"], settings.extension.builtinPluginsEnabled);
  }
  if (settings.tools?.webSearch?.enabled !== undefined) {
    set(["tools", "webSearch", "enabled"], settings.tools.webSearch.enabled);
  }
  return { applied, cleared };
}

async function validateCandidateConfig(
  candidate: string,
  env: PilotPathEnv,
  projectRoot: string | undefined,
): Promise<void> {
  const validationHome = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-settings-"));
  try {
    await writeFile(getPilotConfigFilePath(validationHome), candidate, "utf8");
    loadPilotConfig({
      projectRoot,
      env: { ...env, PILOT_HOME: validationHome },
    });
  } catch (error) {
    if (error instanceof PilotLocalSettingsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PilotLocalSettingsError("LOCAL_SETTINGS_INVALID", `localSettings failed PilotDeck validation: ${message}`);
  } finally {
    await rm(validationHome, { recursive: true, force: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.sdk-${randomUUID()}.tmp`);
  let originalMode: number | undefined;
  try {
    originalMode = (await stat(path)).mode;
  } catch {
    // readFile above already gave the caller the useful error; retain the
    // platform default only if the file vanished between read and write.
  }
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: originalMode });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new PilotLocalSettingsError("LOCAL_SETTINGS_WRITE_FAILED", `Unable to write local settings: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, suffix: string): PilotLocalSettingsError {
  return new PilotLocalSettingsError("INVALID_LOCAL_SETTINGS", `${path} ${suffix}`);
}

function unsupported(path: string): PilotLocalSettingsError {
  return new PilotLocalSettingsError("UNSUPPORTED_LOCAL_SETTING", `${path} is not supported by PilotDeck localSettings.`);
}
