/**
 * Lightweight ~/.pilotdeck/pilotdeck.yaml validator owned by the desktop shell.
 *
 * Supports two schema variants:
 *
 * NEW (schemaVersion: 1):
 *   model:
 *     providers:
 *       <providerName>:
 *         url: https://...
 *         apiKey: sk-xxx
 *   agent:
 *     model: <providerName>/<modelName>
 *
 * LEGACY (onboarding-generated):
 *   models:
 *     providers:
 *       <name>:
 *         baseUrl: https://...
 *         apiKey: sk-xxx
 *     entries:
 *       default:
 *         provider: <name>
 *         name: <modelName>
 *   agents:
 *     main:
 *       model: default
 */

import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

export type ConfigValidationResult =
  | { ok: true }
  | { ok: false; reason: string; missing: string[] };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNewSchema(parsed: Record<string, unknown>): ConfigValidationResult {
  const missing: string[] = [];

  const model = isRecord(parsed.model) ? parsed.model : {};
  const providers = isRecord(model.providers) ? model.providers : {};

  if (Object.keys(providers).length === 0) {
    missing.push("model.providers");
  }

  const agent = isRecord(parsed.agent) ? parsed.agent : {};
  const agentModel = nonEmptyString(agent.model) ? agent.model : "";

  if (!agentModel) {
    missing.push("agent.model");
  }

  if (agentModel && Object.keys(providers).length > 0) {
    const slashIdx = agentModel.indexOf("/");
    const providerName =
      slashIdx > 0 ? agentModel.slice(0, slashIdx) : agentModel;
    const provider = isRecord(providers[providerName])
      ? providers[providerName]
      : null;

    if (!provider) {
      missing.push(`model.providers.${providerName}`);
    } else {
      if (!nonEmptyString(provider.url)) {
        missing.push(`model.providers.${providerName}.url`);
      }
      if (!nonEmptyString(provider.apiKey)) {
        missing.push(`model.providers.${providerName}.apiKey`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `配置文件缺少以下字段：${missing.join(", ")}`,
      missing,
    };
  }
  return { ok: true };
}

function validateLegacySchema(
  parsed: Record<string, unknown>,
): ConfigValidationResult {
  const missing: string[] = [];

  const models = isRecord(parsed.models) ? parsed.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};

  if (Object.keys(providers).length === 0) {
    missing.push("models.providers");
  }

  const entries = isRecord(models.entries) ? models.entries : {};
  const defaultEntry = isRecord(entries.default) ? entries.default : null;

  if (!defaultEntry) {
    missing.push("models.entries.default");
  } else {
    const provName = nonEmptyString(defaultEntry.provider)
      ? defaultEntry.provider
      : "";
    if (!provName) {
      missing.push("models.entries.default.provider");
    } else {
      const prov = isRecord(providers[provName]) ? providers[provName] : null;
      if (!prov) {
        missing.push(`models.providers.${provName}`);
      } else {
        const url = nonEmptyString(prov.baseUrl)
          ? prov.baseUrl
          : nonEmptyString(prov.url)
            ? prov.url
            : "";
        if (!url) missing.push(`models.providers.${provName}.baseUrl`);
        if (!nonEmptyString(prov.apiKey))
          missing.push(`models.providers.${provName}.apiKey`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `配置文件缺少以下字段：${missing.join(", ")}`,
      missing,
    };
  }
  return { ok: true };
}

export function validatePilotDeckConfigFile(
  configPath: string,
): ConfigValidationResult {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      reason: `配置文件不存在：${configPath}`,
      missing: ["pilotdeck.yaml"],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    return {
      ok: false,
      reason: `无法读取配置文件：${e instanceof Error ? e.message : String(e)}`,
      missing: ["pilotdeck.yaml"],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `配置文件 YAML 解析失败：${
        e instanceof Error ? e.message : String(e)
      }`,
      missing: ["pilotdeck.yaml"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "配置文件内容不是合法的 YAML 对象",
      missing: ["model", "agent"],
    };
  }

  // Detect schema variant: new uses `model` (singular), legacy uses `models` (plural)
  if (isRecord(parsed.model) || isRecord(parsed.agent)) {
    return validateNewSchema(parsed);
  }
  if (isRecord(parsed.models) || isRecord(parsed.agents)) {
    return validateLegacySchema(parsed);
  }

  return {
    ok: false,
    reason: "配置文件缺少 model/agent 或 models/agents 段",
    missing: ["model", "agent"],
  };
}
