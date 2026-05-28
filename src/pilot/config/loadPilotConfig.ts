import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseAlwaysOnConfig } from "../../always-on/config/parseAlwaysOnConfig.js";
import { parseCronConfig } from "../../cron/config/parseCronConfig.js";
import { parseModelConfig } from "../../model/config/parseModelConfig.js";
import { isRecord } from "../../model/config/schema.js";
import { ModelConfigError } from "../../model/protocol/errors.js";
import { getPilotConfigFilePath, getPilotMemoryRootDir, resolvePilotHome } from "../paths.js";
import { sha256, stableStringify } from "./hash.js";
import { mergeConfigSources } from "./merge.js";
import { parseMemoryConfig } from "./parseMemoryConfig.js";
import { parseAdaptersConfig, parseGatewayConfig } from "./parseGatewayConfig.js";
import { parseToolsConfig } from "./parseToolsConfig.js";
import { parseRouterConfig } from "../../router/config/parseRouterConfig.js";
import { redactConfig } from "./redact.js";
import {
  PilotConfigError,
  type PilotAgentConfig,
  type PilotAgentModelSelection,
  type PilotConfigDiagnostic,
  type PilotExtensionConfig,
  type PilotConfigLoadOptions,
  type PilotConfigSnapshot,
  type PilotConfigSource,
  type PilotRawConfig,
} from "./types.js";

const SUPPORTED_SCHEMA_VERSION = 1;
const ENV_CONFIG_OVERRIDES = [
  ["PILOT_AGENT_MODEL", ["agent", "model"]],
] as const;

export function loadPilotConfig(options: PilotConfigLoadOptions = {}): PilotConfigSnapshot {
  const env = options.env ?? process.env;
  const loadedAt = new Date();
  const diagnostics: PilotConfigDiagnostic[] = [];
  const sources: PilotConfigSource[] = [];

  const pilotHome = resolvePilotHome(env);
  if (env.PILOT_HOME) {
    sources.push({
      kind: "env",
      phase: "bootstrap",
      priority: 30,
      loadedAt,
      contentHash: sha256("PILOT_HOME=<redacted-path>"),
    });
  }

  const defaultConfigPath = getPilotConfigFilePath(pilotHome);
  const defaultConfig = readYamlSource(defaultConfigPath, "default", 10, loadedAt, diagnostics, sources);

  const envConfig = readEnvOverrides(env);
  if (envConfig) {
    sources.push({
      kind: "env",
      phase: "merge",
      priority: 30,
      loadedAt,
      contentHash: sha256(stableStringify(redactConfig(envConfig))),
    });
  }

  const rawConfig = mergeConfigSources(defaultConfig, envConfig) as PilotRawConfig;
  validateTopLevel(rawConfig, diagnostics);
  const schemaVersion = parseSchemaVersion(rawConfig.schemaVersion, diagnostics);

  if (rawConfig.agent === undefined) {
    diagnostics.push({
      code: "CONFIG_AGENT_MISSING",
      severity: "fatal",
      message: "Config must contain an agent section.",
      path: "agent",
      recoverable: false,
    });
  }

  if (rawConfig.model === undefined) {
    diagnostics.push({
      code: "CONFIG_MODEL_MISSING",
      severity: "fatal",
      message: "Config must contain a model section.",
      path: "model",
      recoverable: false,
    });
  }
  throwConfigErrorIfFatal(diagnostics);

  const model = parseModel(rawConfig.model, env, diagnostics);
  const agent = parseAgent(rawConfig.agent, model, diagnostics);
  const extension = parseExtension(rawConfig.extension, diagnostics);
  const memory = parseMemoryConfig(rawConfig.memory, diagnostics, getPilotMemoryRootDir(pilotHome), model);
  const gateway = parseGatewayConfig(rawConfig.gateway, diagnostics);
  const adapters = parseAdaptersConfig(rawConfig.adapters, diagnostics);
  const router = parseRouterSection(rawConfig.router, model, diagnostics);

  if (router?.scenarios?.default && agent.model.id !== router.scenarios.default.id) {
    // Soft-recover instead of crashing: many users update agent.model through
    // onboarding/UI without touching the router block, leaving the two out of
    // sync. Treating that as fatal locks them out of the gateway entirely
    // (see issue: customer reinstall doesn't help because pilotdeck.yaml
    // survives the wipe). Auto-align router.scenarios.default to agent.model
    // and warn — agent.model is the canonical source of truth.
    const previousId = router.scenarios.default.id;
    router.scenarios.default = {
      id: agent.model.id,
      provider: agent.model.provider,
      model: agent.model.model,
    };
    diagnostics.push({
      code: "CONFIG_MODEL_CONFLICT",
      severity: "warning",
      message:
        `agent.model (${agent.model.id}) and router.scenarios.default (${previousId}) ` +
        `disagree. Using agent.model and overriding router.scenarios.default ` +
        `at runtime. Update the yaml to silence this warning.`,
      path: "agent.model",
      recoverable: true,
    });
  }

  const alwaysOn = parseAlwaysOnConfig(rawConfig.alwaysOn, diagnostics);
  const cron = parseCronConfig(rawConfig.cron, diagnostics);
  const tools = parseToolsConfig(rawConfig.tools, diagnostics);
  throwConfigErrorIfFatal(diagnostics);

  const redactedSnapshotConfig = redactConfig({
    agent,
    model,
    extension,
    memory,
    gateway,
    adapters,
    router,
    alwaysOn,
    cron,
    tools,
  });
  return deepFreeze({
    version: options.version ?? 1,
    schemaVersion,
    loadedAt,
    contentHash: sha256(stableStringify(redactedSnapshotConfig)),
    sources,
    diagnostics,
    config: {
      agent,
      model,
      extension,
      ...(memory ? { memory } : {}),
      ...(gateway ? { gateway } : {}),
      ...(adapters ? { adapters } : {}),
      ...(router ? { router } : {}),
      ...(alwaysOn ? { alwaysOn } : {}),
      ...(cron ? { cron } : {}),
      ...(tools ? { tools } : {}),
    },
  });
}

function readYamlSource(
  path: string,
  kind: "default" | "project",
  priority: number,
  loadedAt: Date,
  diagnostics: PilotConfigDiagnostic[],
  sources: PilotConfigSource[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    diagnostics.push({
      code: "CONFIG_READ_FAILED",
      severity: "fatal",
      message: `Failed to read ${kind} config.`,
      path,
      source: { kind, path },
      hint: error instanceof Error ? error.message : undefined,
      recoverable: false,
    });
    return undefined;
  }

  sources.push({
    kind,
    priority,
    loadedAt,
    path,
    contentHash: sha256(content),
  });

  try {
    const document = parseDocument(content, { prettyErrors: false });
    if (document.errors.length > 0) {
      diagnostics.push({
        code: "CONFIG_YAML_INVALID",
        severity: "fatal",
        message: `Failed to parse ${kind} config YAML.`,
        path,
        source: { kind, path },
        hint: document.errors.map((yamlError) => yamlError.message).join("; "),
        recoverable: false,
      });
      return undefined;
    }

    const parsed = document.toJSON();
    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (!isRecord(parsed)) {
      diagnostics.push({
        code: "CONFIG_ROOT_INVALID",
        severity: "fatal",
        message: `${kind} config root must be an object.`,
        path,
        source: { kind, path },
        recoverable: false,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      code: "CONFIG_YAML_INVALID",
      severity: "fatal",
      message: `Failed to parse ${kind} config YAML.`,
      path,
      source: { kind, path },
      hint: error instanceof Error ? error.message : undefined,
      recoverable: false,
    });
    return undefined;
  }
}

function readEnvOverrides(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};

  for (const [envName, path] of ENV_CONFIG_OVERRIDES) {
    const value = env[envName];
    if (!value) {
      continue;
    }
    setPath(output, path, value);
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = cursor[key];
    if (!isRecord(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function validateTopLevel(rawConfig: PilotRawConfig, diagnostics: PilotConfigDiagnostic[]): void {
  if (!isRecord(rawConfig)) {
    diagnostics.push({
      code: "CONFIG_ROOT_INVALID",
      severity: "fatal",
      message: "Config root must be an object.",
      recoverable: false,
    });
    return;
  }

  if ("pilot" in rawConfig) {
    diagnostics.push({
      code: "CONFIG_PILOT_SECTION_FORBIDDEN",
      severity: "fatal",
      message: "YAML config must not contain a pilot section. Use PILOT_HOME for PilotHome.",
      path: "pilot",
      recoverable: false,
    });
  }

  const allowedKeys = new Set([
    "schemaVersion",
    "agent",
    "model",
    "extension",
    "memory",
    "gateway",
    "adapters",
    "router",
    "alwaysOn",
    "cron",
    "tools",
    // Reserved namespace for ui/server (Web UI Express bridge). The PilotDeck
    // gateway does not parse `webui.*` itself but tolerates it so a single
    // ~/.pilotdeck/pilotdeck.yaml can carry both gateway-side and ui-side
    // config without producing diagnostic noise.
    "webui",
  ]);
  for (const key of Object.keys(rawConfig)) {
    if (!allowedKeys.has(key)) {
      diagnostics.push({
        code: "CONFIG_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown top-level config field ${key}.`,
        path: key,
        recoverable: true,
      });
    }
  }
}

function parseAgent(
  rawAgent: unknown,
  modelConfig: ReturnType<typeof parseModel>,
  diagnostics: PilotConfigDiagnostic[],
): PilotAgentConfig {
  if (!isRecord(rawAgent)) {
    diagnostics.push({
      code: "CONFIG_AGENT_INVALID",
      severity: "fatal",
      message: "Agent config must be an object.",
      path: "agent",
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent config diagnostic.");
  }

  const model = parseAgentModelSelection(rawAgent.model, "agent.model", modelConfig, diagnostics);
  const subagents = parseAgentSubagents(rawAgent.subagents, diagnostics);
  const maxContextTokens = readOptionalPositiveInteger(rawAgent.maxContextTokens, "agent.maxContextTokens");
  if (rawAgent.fallbackModel !== undefined) {
    diagnostics.push({
      code: "CONFIG_AGENT_FALLBACK_MODEL_DEPRECATED",
      severity: "warning",
      message:
        "agent.fallbackModel has been removed. Move the value to router.fallback.default to keep fallback behaviour.",
      path: "agent.fallbackModel",
      recoverable: true,
    });
  }
  throwConfigErrorIfFatal(diagnostics);

  return {
    model,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(subagents ? { subagents } : {}),
  };
}

function parseAgentSubagents(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotAgentConfig["subagents"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PilotConfigError("CONFIG_AGENT_SUBAGENTS_INVALID", "agent.subagents must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "timeoutMs") {
      diagnostics.push({
        code: "CONFIG_AGENT_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown agent.subagents field ${key}.`,
        path: `agent.subagents.${key}`,
        recoverable: true,
      });
    }
  }
  return {
    timeoutMs: readOptionalPositiveInteger(value.timeoutMs, "agent.subagents.timeoutMs"),
  };
}

function parseAgentModelSelection(
  value: unknown,
  path: string,
  modelConfig: ReturnType<typeof parseModel>,
  diagnostics: PilotConfigDiagnostic[],
): PilotAgentModelSelection {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_INVALID",
      severity: "fatal",
      message: `${path} must be a non-empty provider/model string.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model diagnostic.");
  }

  const separatorIndex = value.indexOf("/");
  const providerId = separatorIndex >= 0 ? value.slice(0, separatorIndex) : "";
  const modelId = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : "";
  if (!providerId || !modelId) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_INVALID",
      severity: "fatal",
      message: `${path} must use provider/model format.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model format diagnostic.");
  }

  const provider = modelConfig.providers[providerId];
  if (!provider) {
    diagnostics.push({
      code: "CONFIG_AGENT_PROVIDER_NOT_FOUND",
      severity: "fatal",
      message: `${path} references unknown provider ${providerId}.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent provider diagnostic.");
  }

  if (!provider.models[modelId]) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_NOT_FOUND",
      severity: "fatal",
      message: `${path} references unknown model ${modelId} for provider ${providerId}.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model lookup diagnostic.");
  }

  return {
    id: value,
    provider: providerId,
    model: modelId,
  };
}

function parseSchemaVersion(
  value: unknown,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) {
    diagnostics.push({
      code: "CONFIG_SCHEMA_VERSION_MISSING",
      severity: "warning",
      message: "schemaVersion is missing; assuming schemaVersion 1.",
      path: "schemaVersion",
      recoverable: true,
    });
    return SUPPORTED_SCHEMA_VERSION;
  }

  if (value !== SUPPORTED_SCHEMA_VERSION) {
    diagnostics.push({
      code: "CONFIG_SCHEMA_VERSION_UNSUPPORTED",
      severity: "fatal",
      message: `Unsupported schemaVersion ${String(value)}.`,
      path: "schemaVersion",
      recoverable: false,
    });
    return SUPPORTED_SCHEMA_VERSION;
  }

  return SUPPORTED_SCHEMA_VERSION;
}

function parseModel(
  rawModel: unknown,
  env: Record<string, string | undefined>,
  diagnostics: PilotConfigDiagnostic[],
) {
  try {
    return parseModelConfig(rawModel, { env });
  } catch (error) {
    if (error instanceof ModelConfigError) {
      diagnostics.push({
        code: `MODEL_${error.code.toUpperCase()}`,
        severity: "fatal",
        message: error.message,
        path: "model",
        hint: stringifyDetails(error.details),
        recoverable: false,
      });
      throwConfigErrorIfFatal(diagnostics);
    }
    throw error;
  }
}

function parseExtension(rawExtension: unknown, diagnostics: PilotConfigDiagnostic[]): PilotExtensionConfig {
  const defaults: PilotExtensionConfig = {
    builtinPluginsEnabled: {},
    includeHookEvents: false,
  };
  if (rawExtension === undefined) {
    return defaults;
  }
  if (!isRecord(rawExtension)) {
    diagnostics.push({
      code: "CONFIG_EXTENSION_INVALID",
      severity: "fatal",
      message: "extension config must be an object.",
      path: "extension",
      recoverable: false,
    });
    return defaults;
  }

  const extension = { ...defaults };
  if (rawExtension.builtinPluginsEnabled !== undefined) {
    if (isRecord(rawExtension.builtinPluginsEnabled)) {
      extension.builtinPluginsEnabled = Object.fromEntries(
        Object.entries(rawExtension.builtinPluginsEnabled).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      );
    } else {
      diagnostics.push({
        code: "CONFIG_EXTENSION_BUILTIN_PLUGINS_INVALID",
        severity: "fatal",
        message: "extension.builtinPluginsEnabled must be an object of booleans.",
        path: "extension.builtinPluginsEnabled",
        recoverable: false,
      });
    }
  }
  if (rawExtension.includeHookEvents !== undefined) {
    if (typeof rawExtension.includeHookEvents === "boolean") {
      extension.includeHookEvents = rawExtension.includeHookEvents;
    } else {
      diagnostics.push({
        code: "CONFIG_EXTENSION_INCLUDE_HOOK_EVENTS_INVALID",
        severity: "fatal",
        message: "extension.includeHookEvents must be a boolean.",
        path: "extension.includeHookEvents",
        recoverable: false,
      });
    }
  }

  for (const key of Object.keys(rawExtension)) {
    if (key !== "builtinPluginsEnabled" && key !== "includeHookEvents") {
      diagnostics.push({
        code: "CONFIG_EXTENSION_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown extension config field ${key}.`,
        path: `extension.${key}`,
        recoverable: true,
      });
    }
  }

  return extension;
}

function stringifyDetails(details: unknown): string | undefined {
  if (details === undefined) {
    return undefined;
  }
  return stableStringify(redactConfig(details));
}

function readOptionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PilotConfigError("CONFIG_INVALID_VALUE", `${path} must be a positive integer.`);
  }
  return Math.floor(value);
}

function throwConfigErrorIfFatal(diagnostics: PilotConfigDiagnostic[]): void {
  const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatalDiagnostics.length > 0) {
    throw new PilotConfigError(
      fatalDiagnostics[0].code,
      fatalDiagnostics[0].message,
      diagnostics,
    );
  }
}

function parseRouterSection(
  rawRouter: unknown,
  modelConfig: ReturnType<typeof parseModelConfig>,
  diagnostics: PilotConfigDiagnostic[],
) {
  const result = parseRouterConfig(rawRouter, modelConfig);
  for (const issue of result.diagnostics) {
    diagnostics.push({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      path: issue.path,
      hint: issue.hint,
      recoverable: issue.severity !== "fatal",
    });
  }
  return result.config;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entryValue);
    }
  }
  return value;
}
