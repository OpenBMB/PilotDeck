import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { ModelConfig } from "../../model/index.js";
import { isRecord } from "../../model/config/schema.js";
import { loadPilotConfig } from "./loadPilotConfig.js";
import { mergeConfigSources } from "./merge.js";
import { getPilotProjectConfigFilePath } from "../paths.js";

export type ProjectModelSettingsInput = {
  projectKey: string;
};

export type ProjectModelRefOption = {
  id: string;
  provider: string;
  model: string;
  label: string;
};

export type ProjectModelSettings = {
  mainModel?: string;
  thinking?: {
    enabled?: boolean;
    budgetTokens?: number;
  };
  tokenSaver?: {
    enabled?: boolean;
    judge?: string;
    defaultTier?: string;
    tiers?: Record<string, { model?: string; description?: string }>;
    subagentPolicy?: "skip" | "judge";
  };
  autoOrchestrate?: {
    enabled?: boolean;
    mainAgentModel?: string;
    subagentModel?: string;
    triggerTiers?: string[];
  };
  fallback?: {
    default?: string[];
    subagent?: string[];
    explicit?: string[];
  };
};

export type ProjectModelSettingsResult = {
  projectKey: string;
  configPath: string;
  exists: boolean;
  inherited: ProjectModelSettings;
  settings: ProjectModelSettings;
  effective: ProjectModelSettings;
  modelOptions: ProjectModelRefOption[];
  diagnostics: Array<{ severity: "warning" | "error"; message: string; path?: string }>;
};

export type SaveProjectModelSettingsInput = ProjectModelSettingsInput & {
  settings: ProjectModelSettings;
};

export type SaveProjectModelSettingsResult = ProjectModelSettingsResult & {
  saved: boolean;
};

export async function readProjectModelSettings(
  input: ProjectModelSettingsInput,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<ProjectModelSettingsResult> {
  const projectKey = input.projectKey;
  const globalSnapshot = loadPilotConfig({ env: options.env });
  const modelOptions = listModelOptions(globalSnapshot.config.model);
  const inherited = extractModelSettings(globalSnapshot.config);
  const { raw, exists, configPath, diagnostics } = await readProjectConfig(projectKey);
  const settings = extractProjectModelSettings(raw);
  const effective = normalizeProjectModelSettings(
    mergeConfigSources(settingsToPilotConfig(inherited), settingsToPilotConfig(settings)),
    globalSnapshot.config.model,
  );

  return {
    projectKey,
    configPath,
    exists,
    inherited,
    settings,
    effective,
    modelOptions,
    diagnostics,
  };
}

export async function saveProjectModelSettings(
  input: SaveProjectModelSettingsInput,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<SaveProjectModelSettingsResult> {
  const projectKey = input.projectKey;
  const globalSnapshot = loadPilotConfig({ env: options.env });
  const inherited = extractModelSettings(globalSnapshot.config);
  const settings = normalizeModelRefs(input.settings, globalSnapshot.config.model);
  const diagnostics = validateSettings(settings, inherited, globalSnapshot.config.model);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      ...(await readProjectModelSettings(input, options)),
      settings,
      saved: false,
      diagnostics,
    };
  }

  const current = await readProjectConfig(projectKey);
  const nextRaw = clearManagedModelSettings({ ...current.raw });
  Object.assign(nextRaw, mergeConfigSources(nextRaw, settingsToPilotConfig(settings)));
  pruneEmpty(nextRaw);
  const yaml = stringify(nextRaw, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
  });
  await mkdir(dirname(current.configPath), { recursive: true });
  await writeFile(current.configPath, yaml, "utf8");

  const saved = await readProjectModelSettings(input, options);
  return {
    ...saved,
    saved: true,
    diagnostics: [...saved.diagnostics, ...diagnostics],
  };
}

async function readProjectConfig(projectKey: string): Promise<{
  configPath: string;
  exists: boolean;
  raw: Record<string, unknown>;
  diagnostics: ProjectModelSettingsResult["diagnostics"];
}> {
  const configPath = getPilotProjectConfigFilePath(projectKey);
  let content = "";
  try {
    content = await readFile(configPath, "utf8");
  } catch {
    return { configPath, exists: false, raw: {}, diagnostics: [] };
  }

  const document = parseDocument(content, { prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      configPath,
      exists: true,
      raw: {},
      diagnostics: document.errors.map((error) => ({
        severity: "error",
        message: error.message,
        path: configPath,
      })),
    };
  }
  const parsed = document.toJSON();
  return {
    configPath,
    exists: true,
    raw: isRecord(parsed) ? parsed : {},
    diagnostics: isRecord(parsed)
      ? []
      : [{ severity: "error", message: "Project config root must be an object.", path: configPath }],
  };
}

function listModelOptions(modelConfig: ModelConfig): ProjectModelRefOption[] {
  return Object.values(modelConfig.providers)
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        model: model.id,
        label: model.displayName ? `${model.displayName} (${provider.id}/${model.id})` : `${provider.id}/${model.id}`,
      })),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

function extractModelSettings(config: Record<string, unknown>): ProjectModelSettings {
  const agent = isRecord(config.agent) ? config.agent : {};
  const router = isRecord(config.router) ? config.router : {};
  const tokenSaver = isRecord(router.tokenSaver) ? router.tokenSaver : undefined;
  const autoOrchestrate = isRecord(router.autoOrchestrate) ? router.autoOrchestrate : undefined;
  const fallback = isRecord(router.fallback) ? router.fallback : undefined;
  const thinking = isRecord(agent.thinking) ? agent.thinking : undefined;

  return {
    mainModel: readModelRef(agent.model),
    ...(thinking
      ? {
          thinking: {
            ...(typeof thinking.enabled === "boolean" ? { enabled: thinking.enabled } : {}),
            ...(typeof thinking.budgetTokens === "number" ? { budgetTokens: thinking.budgetTokens } : {}),
          },
        }
      : {}),
    ...(tokenSaver
      ? {
          tokenSaver: {
            ...(typeof tokenSaver.enabled === "boolean" ? { enabled: tokenSaver.enabled } : {}),
            ...(readModelRef(tokenSaver.judge) ? { judge: readModelRef(tokenSaver.judge) } : {}),
            ...(typeof tokenSaver.defaultTier === "string" ? { defaultTier: tokenSaver.defaultTier } : {}),
            ...(isRecord(tokenSaver.tiers) ? { tiers: extractTierSettings(tokenSaver.tiers) } : {}),
            ...(isRecord(tokenSaver.subagent) && typeof tokenSaver.subagent.policy === "string"
              ? { subagentPolicy: tokenSaver.subagent.policy === "skip" ? "skip" : "judge" }
              : {}),
          },
        }
      : {}),
    ...(autoOrchestrate
      ? {
          autoOrchestrate: {
            ...(typeof autoOrchestrate.enabled === "boolean" ? { enabled: autoOrchestrate.enabled } : {}),
            ...(readModelRef(autoOrchestrate.mainAgentModel)
              ? { mainAgentModel: readModelRef(autoOrchestrate.mainAgentModel) }
              : {}),
            ...(readModelRef(autoOrchestrate.subagentModel)
              ? { subagentModel: readModelRef(autoOrchestrate.subagentModel) }
              : {}),
            ...(Array.isArray(autoOrchestrate.triggerTiers)
              ? { triggerTiers: autoOrchestrate.triggerTiers.filter((tier): tier is string => typeof tier === "string") }
              : {}),
          },
        }
      : {}),
    ...(fallback ? { fallback: extractFallbackSettings(fallback) } : {}),
  };
}

function extractProjectModelSettings(raw: Record<string, unknown>): ProjectModelSettings {
  return extractModelSettings(raw);
}

function normalizeProjectModelSettings(
  raw: Record<string, unknown>,
  modelConfig: ModelConfig,
): ProjectModelSettings {
  return normalizeModelRefs(extractModelSettings(raw), modelConfig, { dropInvalid: true });
}

function normalizeModelRefs(
  settings: ProjectModelSettings,
  modelConfig: ModelConfig,
  options: { dropInvalid?: boolean } = {},
): ProjectModelSettings {
  const normalize = (value: string | undefined): string | undefined => {
    const normalized = resolveConfiguredModelRef(value, modelConfig);
    return normalized ?? (options.dropInvalid ? undefined : value);
  };

  return {
    ...settings,
    mainModel: normalize(settings.mainModel),
    ...(settings.tokenSaver
      ? {
          tokenSaver: {
            ...settings.tokenSaver,
            judge: normalize(settings.tokenSaver.judge),
            ...(settings.tokenSaver.tiers
              ? {
                  tiers: Object.fromEntries(
                    Object.entries(settings.tokenSaver.tiers).map(([tier, body]) => [
                      tier,
                      { ...body, model: normalize(body.model) },
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(settings.autoOrchestrate
      ? {
          autoOrchestrate: {
            ...settings.autoOrchestrate,
            mainAgentModel: normalize(settings.autoOrchestrate.mainAgentModel),
            subagentModel: normalize(settings.autoOrchestrate.subagentModel),
          },
        }
      : {}),
    ...(settings.fallback
      ? {
          fallback: {
            default: normalizeModelRefList(settings.fallback.default, normalize),
            subagent: normalizeModelRefList(settings.fallback.subagent, normalize),
            explicit: normalizeModelRefList(settings.fallback.explicit, normalize),
          },
        }
      : {}),
  };
}

function normalizeModelRefList(
  refs: string[] | undefined,
  normalize: (value: string | undefined) => string | undefined,
): string[] | undefined {
  if (!refs) return undefined;
  return refs.map((ref) => normalize(ref)).filter((ref): ref is string => typeof ref === "string");
}

function resolveConfiguredModelRef(value: string | undefined, modelConfig: ModelConfig): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const options = listModelOptions(modelConfig);
  const direct = options.find((option) => option.id === trimmed);
  if (direct) return direct.id;

  const lower = trimmed.toLowerCase();
  const caseInsensitive = options.filter((option) => option.id.toLowerCase() === lower);
  if (caseInsensitive.length === 1) return caseInsensitive[0]!.id;

  if (!trimmed.includes("/")) {
    const byModel = options.filter((option) => option.model.toLowerCase() === lower);
    if (byModel.length === 1) return byModel[0]!.id;
  }

  return undefined;
}

function settingsToPilotConfig(settings: ProjectModelSettings): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (settings.mainModel || settings.thinking) {
    output.agent = {
      ...(settings.mainModel ? { model: settings.mainModel } : {}),
      ...(settings.thinking
        ? {
            thinking: {
              ...(typeof settings.thinking.enabled === "boolean" ? { enabled: settings.thinking.enabled } : {}),
              ...(typeof settings.thinking.budgetTokens === "number"
                ? { budgetTokens: settings.thinking.budgetTokens }
                : {}),
            },
          }
        : {}),
    };
  }

  const router: Record<string, unknown> = {};
  if (settings.mainModel) {
    router.scenarios = { default: settings.mainModel };
  }
  if (settings.tokenSaver) {
    router.tokenSaver = {
      ...(typeof settings.tokenSaver.enabled === "boolean" ? { enabled: settings.tokenSaver.enabled } : {}),
      ...(settings.tokenSaver.judge ? { judge: settings.tokenSaver.judge } : {}),
      ...(settings.tokenSaver.defaultTier ? { defaultTier: settings.tokenSaver.defaultTier } : {}),
      ...(settings.tokenSaver.tiers ? { tiers: normalizeTierOutput(settings.tokenSaver.tiers) } : {}),
      ...(settings.tokenSaver.subagentPolicy
        ? { subagent: { policy: settings.tokenSaver.subagentPolicy } }
        : {}),
    };
  }
  if (settings.autoOrchestrate) {
    router.autoOrchestrate = {
      ...(typeof settings.autoOrchestrate.enabled === "boolean" ? { enabled: settings.autoOrchestrate.enabled } : {}),
      ...(settings.autoOrchestrate.mainAgentModel
        ? { mainAgentModel: settings.autoOrchestrate.mainAgentModel }
        : {}),
      ...(settings.autoOrchestrate.subagentModel
        ? { subagentModel: settings.autoOrchestrate.subagentModel }
        : {}),
      ...(settings.autoOrchestrate.triggerTiers ? { triggerTiers: settings.autoOrchestrate.triggerTiers } : {}),
    };
  }
  if (settings.fallback) {
    router.fallback = {
      ...(settings.fallback.default?.length ? { default: settings.fallback.default } : {}),
      ...(settings.fallback.subagent?.length ? { subagent: settings.fallback.subagent } : {}),
      ...(settings.fallback.explicit?.length ? { explicit: settings.fallback.explicit } : {}),
    };
  }
  if (Object.keys(router).length > 0) {
    output.router = router;
  }

  return output;
}

function clearManagedModelSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const agent = isRecord(raw.agent) ? raw.agent : undefined;
  if (agent) {
    delete agent.model;
    delete agent.thinking;
  }

  const router = isRecord(raw.router) ? raw.router : undefined;
  if (router) {
    const scenarios = isRecord(router.scenarios) ? router.scenarios : undefined;
    if (scenarios) {
      delete scenarios.default;
    }
    delete router.tokenSaver;
    delete router.autoOrchestrate;
    delete router.fallback;
  }
  pruneEmpty(raw);
  return raw;
}

function validateSettings(
  settings: ProjectModelSettings,
  inherited: ProjectModelSettings,
  modelConfig: ModelConfig,
): ProjectModelSettingsResult["diagnostics"] {
  const options = new Set(listModelOptions(modelConfig).map((option) => option.id));
  const diagnostics: ProjectModelSettingsResult["diagnostics"] = [];
  const check = (value: string | undefined, path: string) => {
    if (value && !options.has(value)) {
      diagnostics.push({ severity: "error", path, message: `${value} is not configured in global model providers.` });
    }
  };

  check(settings.mainModel, "mainModel");
  check(settings.tokenSaver?.judge, "tokenSaver.judge");
  if (settings.tokenSaver?.tiers) {
    for (const [tier, body] of Object.entries(settings.tokenSaver.tiers)) {
      check(body.model, `tokenSaver.tiers.${tier}.model`);
    }
  }
  check(settings.autoOrchestrate?.mainAgentModel, "autoOrchestrate.mainAgentModel");
  check(settings.autoOrchestrate?.subagentModel, "autoOrchestrate.subagentModel");
  for (const [name, refs] of Object.entries(settings.fallback ?? {})) {
    refs?.forEach((ref, index) => check(ref, `fallback.${name}.${index}`));
  }

  const tokenSaver = mergeTokenSaver(inherited.tokenSaver, settings.tokenSaver);
  if (tokenSaver?.enabled === true) {
    if (!tokenSaver.judge) {
      diagnostics.push({
        severity: "error",
        path: "tokenSaver.judge",
        message: "Tier router needs a judge model. Choose one here or configure one globally first.",
      });
    }
    const tiers = Object.values(tokenSaver.tiers ?? {}).filter((tier) => !!tier.model);
    if (tiers.length === 0) {
      diagnostics.push({
        severity: "error",
        path: "tokenSaver.tiers",
        message: "Tier router needs at least one tier model. Choose tier models here or configure them globally first.",
      });
    }
  }
  return diagnostics;
}

function mergeTokenSaver(
  inherited: ProjectModelSettings["tokenSaver"],
  override: ProjectModelSettings["tokenSaver"],
): ProjectModelSettings["tokenSaver"] {
  if (!inherited && !override) return undefined;
  return {
    ...(inherited ?? {}),
    ...(override ?? {}),
    tiers: {
      ...(inherited?.tiers ?? {}),
      ...(override?.tiers ?? {}),
    },
  };
}

function extractTierSettings(raw: Record<string, unknown>): NonNullable<ProjectModelSettings["tokenSaver"]>["tiers"] {
  const tiers: Record<string, { model?: string; description?: string }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    tiers[name] = {
      ...(readModelRef(value.model) ? { model: readModelRef(value.model) } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    };
  }
  return tiers;
}

function extractFallbackSettings(raw: Record<string, unknown>): NonNullable<ProjectModelSettings["fallback"]> {
  return {
    default: readModelRefArray(raw.default),
    subagent: readModelRefArray(raw.subagent),
    explicit: readModelRefArray(raw.explicit),
  };
}

function normalizeTierOutput(
  tiers: Record<string, { model?: string; description?: string }>,
): Record<string, Record<string, string>> {
  const output: Record<string, Record<string, string>> = {};
  for (const [name, tier] of Object.entries(tiers)) {
    output[name] = {
      ...(tier.model ? { model: tier.model } : {}),
      ...(tier.description ? { description: tier.description } : {}),
    };
  }
  return output;
}

function readModelRef(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim()
  ) {
    return value.id.trim();
  }
  return undefined;
}

function readModelRefArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => readModelRef(entry)).filter((entry): entry is string => typeof entry === "string");
}

function pruneEmpty(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (isRecord(child) && pruneEmpty(child)) {
      delete value[key];
    } else if (Array.isArray(child) && child.length === 0) {
      delete value[key];
    } else if (child === undefined) {
      delete value[key];
    }
  }
  return Object.keys(value).length === 0;
}
