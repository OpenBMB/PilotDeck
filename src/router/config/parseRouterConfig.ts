import type { ModelConfig } from "../../model/index.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_BLOCKED_TOOLS,
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_TIER_DESCRIPTIONS,
  DEFAULT_TIER_NAME,
  DEFAULT_TIER_RULES,
  DEFAULT_TRIGGER_TIERS,
  DEFAULT_ZERO_USAGE_MAX_ATTEMPTS,
  LITELLM_ROUTER_MAX_FALLBACKS,
  resolveProviderRef,
  ROUTER_PRICING_UNITS,
  type RouterAutoOrchestrateConfig,
  type RouterConfig,
  type RouterCustomRouterConfig,
  type RouterFallbackConfig,
  type RouterModelRef,
  type RouterScenariosConfig,
  type RouterStatsConfig,
  type RouterTokenSaverConfig,
  type RouterPricingUnit,
} from "./schema.js";
import type { RouterScenarioType } from "../protocol/decision.js";

export type RouterConfigDiagnostic = {
  code: string;
  severity: "warning" | "fatal";
  path: string;
  message: string;
  hint?: string;
};

const SCENARIO_KEYS: RouterScenarioType[] = [
  "default",
  "subagent",
  "explicit",
];

export type ParseRouterConfigResult = {
  config?: RouterConfig;
  diagnostics: RouterConfigDiagnostic[];
};

/**
 * Validate the `router` section of PilotConfig and return a structured
 * RouterConfig. Returns diagnostics rather than throwing so the caller
 * (loadPilotConfig) can integrate with its existing fatal-aware flow.
 */
export function parseRouterConfig(
  raw: unknown,
  modelConfig: ModelConfig,
): ParseRouterConfigResult {
  const diagnostics: RouterConfigDiagnostic[] = [];
  if (raw === undefined) {
    return { diagnostics };
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_CONFIG_INVALID",
      severity: "fatal",
      path: "router",
      message: "router config must be an object.",
    });
    return { diagnostics };
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      enabled = raw.enabled;
    } else {
      diagnostics.push({
        code: "ROUTER_ENABLED_INVALID",
        severity: "fatal",
        path: "router.enabled",
        message: "router.enabled must be a boolean.",
      });
    }
  }

  if (!enabled) {
    return {
      config: { enabled: false },
      diagnostics,
    };
  }

  const scenarios = parseScenarios(raw.scenarios, modelConfig, diagnostics);
  // Don't early-return on `scenarios === undefined`: that's the legitimate
  // "user only filled in tokenSaver / fallback" case. `ensureRouterConfig`
  // in createLocalGateway.ts derives `scenarios.default` from `agent.model`
  // for us. Only the malformed-but-present case (handled inside
  // parseScenarios via a `fatal` diagnostic) actually aborts the load.

  const fallback = parseFallback(raw.fallback, modelConfig, diagnostics);
  const zeroUsageRetry = parseZeroUsageRetry(raw.zeroUsageRetry, diagnostics);
  const tokenSaver = parseTokenSaver(raw.tokenSaver, modelConfig, diagnostics);
  const autoOrchestrate = parseAutoOrchestrate(raw.autoOrchestrate, modelConfig, tokenSaver, diagnostics);
  const stats = parseStats(raw.stats, modelConfig, diagnostics);
  const customRouter = parseCustomRouter(raw.customRouter, diagnostics);

  return {
    config: {
      enabled,
      ...(scenarios ? { scenarios } : {}),
      fallback,
      zeroUsageRetry,
      tokenSaver,
      autoOrchestrate,
      stats,
      customRouter,
    },
    diagnostics,
  };
}

function parseScenarios(
  raw: unknown,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterScenariosConfig | undefined {
  // Missing entirely → no diagnostic. The UI today can persist a partial
  // `router:` block (e.g. user enabled the master toggle, seeded tokenSaver
  // tiers, never opened the Scenarios editor). `ensureRouterConfig` will
  // fill `scenarios.default` from `agent.model` downstream.
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_SCENARIOS_INVALID",
      severity: "fatal",
      path: "router.scenarios",
      message: "router.scenarios must be an object.",
    });
    return undefined;
  }

  const defaultRef = consumeRef(raw.default, "router.scenarios.default", modelConfig, diagnostics);
  if (!defaultRef) {
    return undefined;
  }

  return {
    default: defaultRef,
  };
}

function parseFallback(
  raw: unknown,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterFallbackConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_FALLBACK_INVALID",
      severity: "fatal",
      path: "router.fallback",
      message: "router.fallback must be an object keyed by scenario type.",
    });
    return undefined;
  }

  const fallback: RouterFallbackConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "maxFallbacks") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        fallback.maxFallbacks = value;
      } else {
        diagnostics.push({
          code: "ROUTER_FALLBACK_MAX_FALLBACKS_INVALID",
          severity: "fatal",
          path: "router.fallback.maxFallbacks",
          message: "router.fallback.maxFallbacks must be a non-negative integer.",
        });
      }
      continue;
    }
    if (!SCENARIO_KEYS.includes(key as RouterScenarioType)) {
      diagnostics.push({
        code: "ROUTER_FALLBACK_UNKNOWN_SCENARIO",
        severity: "warning",
        path: `router.fallback.${key}`,
        message: `Unknown scenario type ${key} in router.fallback.`,
      });
      continue;
    }
    if (!Array.isArray(value)) {
      diagnostics.push({
        code: "ROUTER_FALLBACK_NOT_ARRAY",
        severity: "fatal",
        path: `router.fallback.${key}`,
        message: `router.fallback.${key} must be an array of provider/model strings.`,
      });
      continue;
    }
    const refs: RouterModelRef[] = [];
    value.forEach((item: unknown, index: number) => {
      const path = `router.fallback.${key}[${index}]`;
      const ref = consumeRef(item, path, modelConfig, diagnostics);
      if (ref) {
        refs.push(ref);
      }
    });
    if (refs.length > 0) {
      fallback[key as RouterScenarioType] = refs;
    }
  }
  if (fallback.maxFallbacks === undefined) {
    fallback.maxFallbacks = LITELLM_ROUTER_MAX_FALLBACKS;
  }
  return Object.keys(fallback).length > 0 ? fallback : undefined;
}

function parseZeroUsageRetry(
  raw: unknown,
  diagnostics: RouterConfigDiagnostic[],
): RouterConfig["zeroUsageRetry"] {
  if (raw === undefined) {
    return { enabled: true, maxAttempts: DEFAULT_ZERO_USAGE_MAX_ATTEMPTS };
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_ZERO_USAGE_RETRY_INVALID",
      severity: "fatal",
      path: "router.zeroUsageRetry",
      message: "router.zeroUsageRetry must be an object.",
    });
    return { enabled: true, maxAttempts: DEFAULT_ZERO_USAGE_MAX_ATTEMPTS };
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  let maxAttempts = DEFAULT_ZERO_USAGE_MAX_ATTEMPTS;
  if (raw.maxAttempts !== undefined) {
    if (
      typeof raw.maxAttempts === "number" &&
      Number.isInteger(raw.maxAttempts) &&
      raw.maxAttempts >= 0
    ) {
      maxAttempts = raw.maxAttempts;
    } else {
      diagnostics.push({
        code: "ROUTER_ZERO_USAGE_RETRY_MAX_ATTEMPTS_INVALID",
        severity: "fatal",
        path: "router.zeroUsageRetry.maxAttempts",
        message: "maxAttempts must be a non-negative integer.",
      });
    }
  }
  return { enabled, maxAttempts };
}

function parseTokenSaver(
  raw: unknown,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterTokenSaverConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_TOKEN_SAVER_INVALID",
      severity: "fatal",
      path: "router.tokenSaver",
      message: "router.tokenSaver must be an object.",
    });
    return undefined;
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      enabled = raw.enabled;
    } else {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_ENABLED_INVALID",
        severity: "fatal",
        path: "router.tokenSaver.enabled",
        message: "tokenSaver.enabled must be a boolean.",
      });
    }
  }
  if (!enabled) {
    // Disabled Token Saver does not require judge/tier settings. Runtime
    // paths guard on `enabled` before reading those fields.
    return { enabled } as RouterTokenSaverConfig;
  }
  const judgeRef = consumeRef(raw.judge, "router.tokenSaver.judge", modelConfig, diagnostics);
  if (!judgeRef) {
    return undefined;
  }

  const tiersRaw = raw.tiers;
  if (!isRecord(tiersRaw) || Object.keys(tiersRaw).length === 0) {
    diagnostics.push({
      code: "ROUTER_TOKEN_SAVER_TIERS_EMPTY",
      severity: "fatal",
      path: "router.tokenSaver.tiers",
      message: "router.tokenSaver.tiers must be a non-empty object.",
    });
    return undefined;
  }
  const tiers: Record<string, { model: RouterModelRef; description?: string }> = {};
  for (const [name, body] of Object.entries(tiersRaw)) {
    if (!isRecord(body)) {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_TIER_INVALID",
        severity: "fatal",
        path: `router.tokenSaver.tiers.${name}`,
        message: `tier ${name} must be an object with model.`,
      });
      continue;
    }
    const ref = consumeRef(body.model, `router.tokenSaver.tiers.${name}.model`, modelConfig, diagnostics);
    if (!ref) {
      continue;
    }
    tiers[name] = {
      model: ref,
      description: typeof body.description === "string"
        ? body.description
        : DEFAULT_TIER_DESCRIPTIONS[name],
    };
  }
  if (Object.keys(tiers).length === 0) {
    return undefined;
  }

  let defaultTier = typeof raw.defaultTier === "string"
    ? raw.defaultTier
    : (tiers[DEFAULT_TIER_NAME] ? DEFAULT_TIER_NAME : Object.keys(tiers)[0]!);
  if (!tiers[defaultTier]) {
    diagnostics.push({
      code: "ROUTER_TOKEN_SAVER_DEFAULT_TIER_UNKNOWN",
      severity: "fatal",
      path: "router.tokenSaver.defaultTier",
      message: `defaultTier ${defaultTier} is not present in tiers.`,
    });
    defaultTier = Object.keys(tiers)[0]!;
  }

  let rules: string[] | undefined;
  if (raw.rules !== undefined) {
    if (Array.isArray(raw.rules) && raw.rules.every((rule) => typeof rule === "string")) {
      rules = raw.rules as string[];
    } else {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_RULES_INVALID",
        severity: "fatal",
        path: "router.tokenSaver.rules",
        message: "router.tokenSaver.rules must be an array of strings.",
      });
    }
  } else {
    rules = [...DEFAULT_TIER_RULES];
  }

  let subagent: RouterTokenSaverConfig["subagent"];
  if (raw.subagent !== undefined) {
    if (!isRecord(raw.subagent)) {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_SUBAGENT_INVALID",
        severity: "fatal",
        path: "router.tokenSaver.subagent",
        message: "router.tokenSaver.subagent must be an object.",
      });
    } else {
      const policy = raw.subagent.policy;
      if (policy !== "skip" && policy !== "judge") {
        diagnostics.push({
          code: "ROUTER_TOKEN_SAVER_SUBAGENT_POLICY_INVALID",
          severity: "fatal",
          path: "router.tokenSaver.subagent.policy",
          message: "subagent.policy must be one of skip / judge.",
        });
      } else {
        subagent = { policy };
      }
    }
  }

  let judgeTimeoutMs = DEFAULT_JUDGE_TIMEOUT_MS;
  if (raw.judgeTimeoutMs !== undefined) {
    if (
      typeof raw.judgeTimeoutMs === "number" &&
      Number.isInteger(raw.judgeTimeoutMs) &&
      raw.judgeTimeoutMs > 0
    ) {
      judgeTimeoutMs = raw.judgeTimeoutMs;
    } else {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_JUDGE_TIMEOUT_INVALID",
        severity: "fatal",
        path: "router.tokenSaver.judgeTimeoutMs",
        message: "judgeTimeoutMs must be a positive integer.",
      });
    }
  }

  let cacheAwareSwitching: RouterTokenSaverConfig["cacheAwareSwitching"] = {
    enabled: true,
    minSavingsRatio: 0,
  };
  if (raw.cacheAwareSwitching !== undefined) {
    if (!isRecord(raw.cacheAwareSwitching)) {
      diagnostics.push({
        code: "ROUTER_TOKEN_SAVER_CACHE_AWARE_SWITCHING_INVALID",
        severity: "fatal",
        path: "router.tokenSaver.cacheAwareSwitching",
        message: "cacheAwareSwitching must be an object.",
      });
    } else {
      const enabled = typeof raw.cacheAwareSwitching.enabled === "boolean"
        ? raw.cacheAwareSwitching.enabled
        : true;
      const minSavingsRatioRaw = raw.cacheAwareSwitching.minSavingsRatio;
      let minSavingsRatio = 0;
      if (minSavingsRatioRaw !== undefined) {
        if (typeof minSavingsRatioRaw === "number" && Number.isFinite(minSavingsRatioRaw) && minSavingsRatioRaw >= 0) {
          minSavingsRatio = minSavingsRatioRaw;
        } else {
          diagnostics.push({
            code: "ROUTER_TOKEN_SAVER_CACHE_AWARE_SWITCHING_MIN_SAVINGS_INVALID",
            severity: "fatal",
            path: "router.tokenSaver.cacheAwareSwitching.minSavingsRatio",
            message: "cacheAwareSwitching.minSavingsRatio must be a non-negative number.",
          });
        }
      }
      cacheAwareSwitching = { enabled, minSavingsRatio };
    }
  }

  return {
    enabled,
    judge: judgeRef,
    defaultTier,
    tiers,
    rules,
    subagent,
    judgeTimeoutMs,
    cacheAwareSwitching,
  };
}

function parseAutoOrchestrate(
  raw: unknown,
  modelConfig: ModelConfig,
  tokenSaver: RouterTokenSaverConfig | undefined,
  diagnostics: RouterConfigDiagnostic[],
): RouterAutoOrchestrateConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_AUTO_ORCHESTRATE_INVALID",
      severity: "fatal",
      path: "router.autoOrchestrate",
      message: "router.autoOrchestrate must be an object.",
    });
    return undefined;
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  for (const deprecated of ["mainAgentModel", "subagentModel"] as const) {
    if (raw[deprecated] !== undefined) {
      diagnostics.push({
        code: "ROUTER_AUTO_ORCHESTRATE_DEPRECATED_FIELD",
        severity: "warning",
        path: `router.autoOrchestrate.${deprecated}`,
        message: `router.autoOrchestrate.${deprecated} is deprecated and ignored.`,
      });
    }
  }
  let triggerTiers: string[] = [...DEFAULT_TRIGGER_TIERS];
  if (raw.triggerTiers !== undefined) {
    if (Array.isArray(raw.triggerTiers) && raw.triggerTiers.every((entry) => typeof entry === "string")) {
      triggerTiers = raw.triggerTiers as string[];
      if (tokenSaver?.enabled) {
        for (const tier of triggerTiers) {
          if (!tokenSaver.tiers[tier]) {
            diagnostics.push({
              code: "ROUTER_AUTO_ORCHESTRATE_TRIGGER_TIER_UNKNOWN",
              severity: "warning",
              path: "router.autoOrchestrate.triggerTiers",
              message: `Trigger tier ${tier} not present in tokenSaver.tiers.`,
            });
          }
        }
      }
    } else {
      diagnostics.push({
        code: "ROUTER_AUTO_ORCHESTRATE_TRIGGER_TIERS_INVALID",
        severity: "fatal",
        path: "router.autoOrchestrate.triggerTiers",
        message: "triggerTiers must be an array of strings.",
      });
    }
  }
  let allowedTools: string[] | undefined;
  let blockedTools: string[] | undefined;

  if (raw.allowedTools !== undefined) {
    if (Array.isArray(raw.allowedTools) && raw.allowedTools.every((entry) => typeof entry === "string")) {
      allowedTools = raw.allowedTools as string[];
    } else {
      diagnostics.push({
        code: "ROUTER_AUTO_ORCHESTRATE_ALLOWED_TOOLS_INVALID",
        severity: "fatal",
        path: "router.autoOrchestrate.allowedTools",
        message: "allowedTools must be an array of strings.",
      });
    }
  }

  if (raw.blockedTools !== undefined) {
    if (Array.isArray(raw.blockedTools) && raw.blockedTools.every((entry) => typeof entry === "string")) {
      blockedTools = raw.blockedTools as string[];
    } else {
      diagnostics.push({
        code: "ROUTER_AUTO_ORCHESTRATE_BLOCKED_TOOLS_INVALID",
        severity: "fatal",
        path: "router.autoOrchestrate.blockedTools",
        message: "blockedTools must be an array of strings.",
      });
    }
  }

  if (allowedTools && blockedTools) {
    diagnostics.push({
      code: "ROUTER_AUTO_ORCHESTRATE_TOOLS_CONFLICT",
      severity: "warning",
      path: "router.autoOrchestrate",
      message: "Both allowedTools and blockedTools are set; allowedTools takes precedence.",
    });
  }

  if (!allowedTools && !blockedTools) {
    allowedTools = [...DEFAULT_ALLOWED_TOOLS];
  }

  const slimSystemPrompt = typeof raw.slimSystemPrompt === "boolean" ? raw.slimSystemPrompt : true;
  const skillExtensionId = typeof raw.skillExtensionId === "string" ? raw.skillExtensionId : undefined;
  const orchestrationPrompt = typeof raw.orchestrationPrompt === "string" ? raw.orchestrationPrompt : undefined;

  let subagentMaxTokens: number | undefined;
  if (raw.subagentMaxTokens !== undefined) {
    if (
      typeof raw.subagentMaxTokens === "number" &&
      Number.isInteger(raw.subagentMaxTokens) &&
      raw.subagentMaxTokens > 0
    ) {
      subagentMaxTokens = raw.subagentMaxTokens;
    } else {
      diagnostics.push({
        code: "ROUTER_AUTO_ORCHESTRATE_SUBAGENT_MAX_TOKENS_INVALID",
        severity: "fatal",
        path: "router.autoOrchestrate.subagentMaxTokens",
        message: "subagentMaxTokens must be a positive integer.",
      });
    }
  }

  return {
    enabled,
    triggerTiers,
    allowedTools,
    blockedTools,
    slimSystemPrompt,
    skillExtensionId,
    orchestrationPrompt,
    subagentMaxTokens,
  };
}

function parseStats(
  raw: unknown,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterStatsConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ROUTER_STATS_INVALID",
      severity: "fatal",
      path: "router.stats",
      message: "router.stats must be an object.",
    });
    return undefined;
  }
  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      enabled = raw.enabled;
    } else {
      diagnostics.push({
        code: "ROUTER_STATS_ENABLED_INVALID",
        severity: "fatal",
        path: "router.stats.enabled",
        message: "router.stats.enabled must be a boolean.",
      });
    }
  }
  let modelPricing: RouterStatsConfig["modelPricing"];
  if (raw.modelPricing !== undefined) {
    if (!isRecord(raw.modelPricing)) {
      diagnostics.push({
        code: "ROUTER_STATS_PRICING_INVALID",
        severity: "fatal",
        path: "router.stats.modelPricing",
        message: "modelPricing must be an object keyed by provider/model.",
      });
    } else {
      modelPricing = {};
      for (const [key, body] of Object.entries(raw.modelPricing)) {
        if (!isRecord(body)) {
          diagnostics.push({
            code: "ROUTER_STATS_PRICING_ENTRY_INVALID",
            severity: "fatal",
            path: `router.stats.modelPricing.${key}`,
            message: "modelPricing entries must be objects.",
          });
          continue;
        }
        const ref = consumeRef(key, `router.stats.modelPricing.${key}`, modelConfig, diagnostics);
        if (!ref) continue;
        const input = pricingNumber(body.input, `router.stats.modelPricing.${key}.input`, diagnostics);
        const output = pricingNumber(body.output, `router.stats.modelPricing.${key}.output`, diagnostics);
        const cacheRead = pricingNumber(body.cacheRead, `router.stats.modelPricing.${key}.cacheRead`, diagnostics);
        let unit: RouterPricingUnit | undefined;
        if (body.unit !== undefined) {
          if (typeof body.unit === "string" && (ROUTER_PRICING_UNITS as readonly string[]).includes(body.unit)) {
            unit = body.unit as RouterPricingUnit;
          } else {
            diagnostics.push({
              code: "ROUTER_STATS_PRICING_UNIT_INVALID",
              severity: "fatal",
              path: `router.stats.modelPricing.${key}.unit`,
              message: "unit must be one of $/百万 Token or ¥/百万 Token.",
            });
          }
        }
        modelPricing[key] = {
          ...(input === undefined ? {} : { input }),
          ...(output === undefined ? {} : { output }),
          ...(cacheRead === undefined ? {} : { cacheRead }),
          ...(unit === undefined ? {} : { unit }),
        };
      }
    }
  }
  const baselineModel = optionalBaselineModel(raw.baselineModel, modelConfig, diagnostics);
  return { enabled, modelPricing, baselineModel };
}

function parseCustomRouter(
  raw: unknown,
  diagnostics: RouterConfigDiagnostic[],
): RouterCustomRouterConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.extensionId !== "string" || raw.extensionId.length === 0) {
    diagnostics.push({
      code: "ROUTER_CUSTOM_ROUTER_INVALID",
      severity: "fatal",
      path: "router.customRouter",
      message: "router.customRouter must declare an extensionId string.",
    });
    return undefined;
  }
  return { extensionId: raw.extensionId };
}

function consumeRef(
  raw: unknown,
  path: string,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterModelRef | undefined {
  const result = resolveProviderRef(raw, path, modelConfig);
  for (const issue of result.issues) {
    diagnostics.push({
      code: issue.code,
      severity: "fatal",
      path: issue.path,
      message: issue.message,
    });
  }
  return result.ref;
}

function optionalRef(
  raw: unknown,
  path: string,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterModelRef | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return consumeRef(raw, path, modelConfig, diagnostics);
}

function optionalBaselineModel(
  raw: unknown,
  modelConfig: ModelConfig,
  diagnostics: RouterConfigDiagnostic[],
): RouterModelRef | undefined {
  const path = "router.stats.baselineModel";
  if (raw === undefined) return undefined;
  if (isRecord(raw) && typeof raw.provider === "string" && typeof raw.model === "string") {
    const provider = raw.provider.trim();
    const model = raw.model.trim();
    if (provider && model) return consumeRef(`${provider}/${model}`, path, modelConfig, diagnostics);
  }
  if (typeof raw === "string") return optionalRef(raw, path, modelConfig, diagnostics);
  diagnostics.push({
    code: "ROUTER_REF_INVALID",
    severity: "fatal",
    path,
    message: `${path} must be an object with provider and model.`,
  });
  return undefined;
}

function pricingNumber(value: unknown, path: string, diagnostics: RouterConfigDiagnostic[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  diagnostics.push({
    code: "ROUTER_STATS_PRICING_VALUE_INVALID",
    severity: "fatal",
    path,
    message: "pricing values must be finite non-negative numbers.",
  });
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
