import {
  ANTHROPIC_DEFAULT_CAPABILITIES,
  ANTHROPIC_DEFAULT_MULTIMODAL,
} from "../providers/anthropic/defaults.js";
import {
  OPENAI_DEFAULT_CAPABILITIES,
  OPENAI_DEFAULT_MULTIMODAL,
} from "../providers/openai/defaults.js";
import {
  GOOGLE_DEFAULT_CAPABILITIES,
  GOOGLE_DEFAULT_MULTIMODAL,
} from "../providers/google/defaults.js";
import type {
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
  ProviderRetryConfig,
} from "../protocol/canonical.js";
import { mergeCapabilities, type ModelCapabilities } from "../protocol/capabilities.js";
import { ModelConfigError } from "../protocol/errors.js";
import {
  DEFAULT_MULTIMODAL_CONSTRAINTS,
  isInputModality,
  type MultimodalConstraints,
} from "../protocol/multimodal.js";
import { lookupCatalogModel, lookupCatalogProvider } from "../catalog/index.js";
import { resolveApiKey, type CredentialEnv } from "./resolveCredentials.js";
import {
  isModelProtocol,
  isRecord,
  type RawCapabilities,
  type RawModelConfig,
  type RawModelDefinition,
  type RawMultimodal,
  type RawProviderConfig,
} from "./schema.js";

export type ParseModelConfigOptions = {
  env?: CredentialEnv;
};

export function parseModelConfig(
  rawConfig: RawModelConfig | unknown,
  options: ParseModelConfigOptions = {},
): ModelConfig {
  if (!isRecord(rawConfig)) {
    throw new ModelConfigError("invalid_model_config", "Model config must be an object.");
  }

  if (!isRecord(rawConfig.providers) || Object.keys(rawConfig.providers).length === 0) {
    throw new ModelConfigError("missing_provider", "Model config must contain at least one provider.");
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [providerId, rawProvider] of Object.entries(rawConfig.providers)) {
    providers[providerId] = parseProvider(providerId, rawProvider, options.env);
  }

  return {
    providers,
  };
}

function parseProvider(providerId: string, rawProvider: unknown, env?: CredentialEnv): ProviderConfig {
  if (!isRecord(rawProvider)) {
    throw new ModelConfigError("invalid_provider", `Provider ${providerId} must be an object.`);
  }

  const provider = rawProvider as RawProviderConfig;
  const catalogProvider = lookupCatalogProvider(providerId);

  const protocol = isModelProtocol(provider.protocol)
    ? provider.protocol
    : catalogProvider?.protocol;
  if (!protocol) {
    throw new ModelConfigError("unsupported_protocol", `Provider ${providerId} has unsupported protocol.`, {
      providerId,
      protocol: provider.protocol,
    });
  }

  const trimmedUrl = typeof provider.url === "string" ? provider.url.trim() : "";
  const rawUrl = trimmedUrl.length > 0
    ? trimmedUrl
    : resolveDefaultProviderUrl(providerId, protocol, catalogProvider?.defaultUrl);
  if (!rawUrl) {
    throw new ModelConfigError("invalid_config_value", `Provider ${providerId} requires a url.`, { providerId });
  }
  assertValidUrl(rawUrl, providerId);

  if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
    throw new ModelConfigError("empty_models", `Provider ${providerId} must contain at least one model.`, {
      providerId,
    });
  }

  const models: Record<string, ModelDefinition> = {};
  for (const [modelId, rawModel] of Object.entries(provider.models)) {
    models[modelId] = parseModelDefinition(modelId, protocol, rawModel, providerId);
  }

  return {
    id: providerId,
    protocol,
    url: rawUrl,
    apiKey: resolveProviderApiKey(providerId, provider.apiKey, env),
    timeoutMs: readOptionalPositiveNumber(provider.timeoutMs, "timeoutMs"),
    headers: readStringRecord(provider.headers, "headers"),
    extraBody: isRecord(provider.extraBody) ? (provider.extraBody as Record<string, unknown>) : undefined,
    retry: parseRetryConfig(provider.retry),
    models,
  };
}

function resolveProviderApiKey(providerId: string, value: unknown, env?: CredentialEnv): string {
  if (providerId === "ollama" && value === undefined) {
    return "ollama";
  }
  return resolveApiKey(value, env);
}

function resolveDefaultProviderUrl(
  providerId: string,
  protocol: ModelProtocol,
  catalogDefaultUrl: string | undefined,
): string | undefined {
  if (providerId === "google" && protocol === "openai") {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  return catalogDefaultUrl;
}

function parseRetryConfig(raw: unknown): ProviderRetryConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return undefined;
  const result: ProviderRetryConfig = {};
  const numFields = [
    "requestMaxRetries", "streamMaxRetries", "streamIdleTimeoutMs",
    "maxStreamingDurationMs", "repeatedChunkLimit",
    "baseDelayMs", "maxDelayMs", "jitter",
  ] as const;
  for (const key of numFields) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ModelConfigError("invalid_config_value", `retry.${key} must be a non-negative number.`);
      }
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseModelDefinition(
  modelId: string,
  protocol: ModelProtocol,
  rawModel: unknown,
  providerId: string,
): ModelDefinition {
  const effectiveRaw = rawModel ?? {};
  if (!isRecord(effectiveRaw)) {
    throw new ModelConfigError("invalid_model", `Model ${modelId} must be an object.`);
  }

  const model = effectiveRaw as RawModelDefinition;
  const catalogHit = lookupCatalogModel(providerId, modelId);
  const catalogModel = catalogHit.model;

  const capabilities = parseCapabilities(protocol, model.capabilities, catalogModel?.capabilities);
  const multimodal = parseMultimodal(protocol, model.multimodal, catalogModel?.multimodal);

  return {
    id: modelId,
    displayName: typeof model.displayName === "string"
      ? model.displayName
      : catalogModel?.displayName,
    capabilities,
    multimodal,
    aliases: readStringArray(model.aliases, "aliases"),
  };
}

function parseCapabilities(
  protocol: ModelProtocol,
  rawCapabilities: unknown,
  catalogCapabilities?: ModelCapabilities,
): ModelCapabilities {
  const protocolDefaults =
    protocol === "anthropic"
      ? ANTHROPIC_DEFAULT_CAPABILITIES
      : protocol === "google"
        ? GOOGLE_DEFAULT_CAPABILITIES
        : OPENAI_DEFAULT_CAPABILITIES;
  const defaults = catalogCapabilities ?? protocolDefaults;

  if (rawCapabilities === undefined) {
    return defaults;
  }

  if (!isRecord(rawCapabilities)) {
    throw new ModelConfigError("invalid_capabilities", "Model capabilities must be an object.");
  }

  const capabilities = rawCapabilities as RawCapabilities;
  const overrides: Partial<ModelCapabilities> = {};

  for (const key of [
    "supportsToolUse",
    "supportsStreaming",
    "supportsParallelToolCalls",
    "supportsThinking",
    "supportsJsonSchema",
    "supportsSystemPrompt",
    "supportsPromptCache",
  ] as const) {
    if (capabilities[key] !== undefined) {
      if (typeof capabilities[key] !== "boolean") {
        throw new ModelConfigError("invalid_capabilities", `Capability ${key} must be boolean.`);
      }
      overrides[key] = capabilities[key];
    }
  }

  // Accept `contextWindow` as an alias for `maxContextTokens` so that
  // YAML configs using the friendlier name are not silently ignored.
  const raw = rawCapabilities as Record<string, unknown>;
  if (raw.contextWindow !== undefined && capabilities.maxContextTokens === undefined) {
    overrides.maxContextTokens = readPositiveNumber(raw.contextWindow, "contextWindow");
  }

  for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
    if (capabilities[key] !== undefined) {
      overrides[key] = readPositiveNumber(capabilities[key], key);
    }
  }

  return {
    ...mergeCapabilities(defaults, overrides),
    ...(capabilities.supportsThinking !== undefined
      ? { supportsThinkingExplicit: capabilities.supportsThinking }
      : {}),
  } as ModelCapabilities;
}

function parseMultimodal(
  protocol: ModelProtocol,
  rawMultimodal: unknown,
  catalogMultimodal?: MultimodalConstraints,
): MultimodalConstraints {
  const protocolDefaults =
    protocol === "anthropic"
      ? ANTHROPIC_DEFAULT_MULTIMODAL
      : protocol === "google"
        ? GOOGLE_DEFAULT_MULTIMODAL
        : OPENAI_DEFAULT_MULTIMODAL;
  const defaults = catalogMultimodal ?? { ...DEFAULT_MULTIMODAL_CONSTRAINTS, ...protocolDefaults };

  if (rawMultimodal === undefined) {
    return defaults;
  }

  if (!isRecord(rawMultimodal)) {
    throw new ModelConfigError("invalid_multimodal", "Model multimodal config must be an object.");
  }

  const multimodal = rawMultimodal as RawMultimodal;
  if (!Array.isArray(multimodal.input)) {
    throw new ModelConfigError("invalid_multimodal_input", "multimodal.input must be a string list.");
  }

  const input = multimodal.input.map((value) => {
    if (!isInputModality(value)) {
      throw new ModelConfigError("invalid_multimodal_input", "multimodal.input contains unsupported modality.", {
        modality: value,
      });
    }
    return value;
  });

  return {
    ...defaults,
    input,
    maxImagesPerRequest: readOptionalPositiveNumber(
      multimodal.maxImagesPerRequest,
      "maxImagesPerRequest",
    ),
    maxImageBytes: readOptionalPositiveNumber(multimodal.maxImageBytes, "maxImageBytes"),
    supportedImageMimeTypes: readStringArray(
      multimodal.supportedImageMimeTypes,
      "supportedImageMimeTypes",
    ),
    maxPdfPages: readOptionalPositiveNumber(multimodal.maxPdfPages, "maxPdfPages"),
    maxPdfBytes: readOptionalPositiveNumber(multimodal.maxPdfBytes, "maxPdfBytes"),
    maxAudioSeconds: readOptionalPositiveNumber(multimodal.maxAudioSeconds, "maxAudioSeconds"),
    imageDetail: parseImageDetail(multimodal.imageDetail),
  };
}

function readRequiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a non-empty string.`);
  }
  return value;
}

function readPositiveNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a positive number.`);
  }
  return value;
}

function readOptionalPositiveNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readPositiveNumber(value, key);
}

function readStringRecord(value: unknown, key: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ModelConfigError("invalid_config_value", `${key} must be an object.`);
  }

  const output: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== "string") {
      throw new ModelConfigError("invalid_config_value", `${key}.${recordKey} must be a string.`);
    }
    output[recordKey] = recordValue;
  }
  return output;
}

function readStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ModelConfigError("invalid_config_value", `${key} must be a string list.`);
  }

  return value;
}

function parseImageDetail(value: unknown): MultimodalConstraints["imageDetail"] {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "low" || value === "high") {
    return value;
  }

  throw new ModelConfigError("invalid_multimodal", "multimodal.imageDetail must be auto, low or high.");
}

function assertValidUrl(value: string, providerId: string): void {
  try {
    new URL(value);
  } catch {
    throw new ModelConfigError("invalid_url", `Provider ${providerId} url is invalid.`, {
      providerId,
      url: value,
    });
  }
}
