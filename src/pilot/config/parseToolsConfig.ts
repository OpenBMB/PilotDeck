import { isRecord } from "../../model/config/schema.js";
import type {
  PilotConfigDiagnostic,
  PilotTransSpeechConfig,
  PilotTransSpeechEnabledConfig,
  PilotToolsConfig,
  PilotWebSearchConfig,
  PilotWebSearchCustomAuth,
  PilotWebSearchCustomMethod,
  PilotWebSearchProvider,
} from "./types.js";

/**
 * Parse the optional `tools` section of `pilotdeck.yaml`.
 *
 *   tools:
 *     webSearch:
 *       enabled: true
 *       provider: glm                    # glm | tavily | custom
 *       apiKey: "..."
 *       endpoint: https://api.z.ai/api/paas/v4/web_search
 *
 * Unknown fields produce non-fatal warnings so future additions don't break
 * older deployments.  Returns `undefined` when the section is missing or
 * empty so callers can keep the field off the snapshot entirely.
 */
export function parseToolsConfig(
  rawTools: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotToolsConfig | undefined {
  if (rawTools === undefined) {
    return undefined;
  }
  if (!isRecord(rawTools)) {
    diagnostics.push({
      code: "TOOLS_CONFIG_INVALID",
      severity: "fatal",
      message: "tools config must be an object.",
      path: "tools",
      recoverable: false,
    });
    return undefined;
  }

  const webSearch = parseWebSearch(rawTools.webSearch, diagnostics);
  const transSpeech = parseTransSpeech(rawTools.transSpeech, diagnostics);

  for (const key of Object.keys(rawTools)) {
    if (key !== "webSearch" && key !== "transSpeech") {
      diagnostics.push({
        code: "TOOLS_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools config field ${key}.`,
        path: `tools.${key}`,
        recoverable: true,
      });
    }
  }

  if (!webSearch && !transSpeech) {
    return undefined;
  }
  return {
    ...(webSearch ? { webSearch } : {}),
    ...(transSpeech ? { transSpeech } : {}),
  };
}

function parseTransSpeech(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotTransSpeechConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_TRANS_SPEECH_INVALID",
      severity: "fatal",
      message: "tools.transSpeech must be an object.",
      path: "tools.transSpeech",
      recoverable: false,
    });
    return undefined;
  }

  const enabled = parseRequiredBoolean(raw.enabled, "tools.transSpeech.enabled", "TOOLS_TRANS_SPEECH_ENABLED_INVALID", diagnostics);
  if (enabled === false) {
    return { enabled: false };
  }

  const baseUrl = parseRequiredTransSpeechUrl(raw.baseUrl, "tools.transSpeech.baseUrl", "TOOLS_TRANS_SPEECH_BASE_URL_INVALID", diagnostics);
  const language = parseRequiredString(raw.language, "tools.transSpeech.language", "TOOLS_TRANS_SPEECH_LANGUAGE_INVALID", diagnostics);
  const asrProfile = parseRequiredString(raw.asrProfile, "tools.transSpeech.asrProfile", "TOOLS_TRANS_SPEECH_ASR_PROFILE_INVALID", diagnostics);
  const diarize = parseRequiredBoolean(raw.diarize, "tools.transSpeech.diarize", "TOOLS_TRANS_SPEECH_DIARIZE_INVALID", diagnostics);
  const timeoutMs = parseRequiredPositiveInteger(raw.timeoutMs, "tools.transSpeech.timeoutMs", "TOOLS_TRANS_SPEECH_TIMEOUT_INVALID", diagnostics);
  const maxConcurrentTasks = parseRequiredPositiveInteger(raw.maxConcurrentTasks, "tools.transSpeech.maxConcurrentTasks", "TOOLS_TRANS_SPEECH_CONCURRENCY_INVALID", diagnostics);
  const generate = parseTransSpeechGenerate(raw.generate, diagnostics);

  const known = new Set([
    "enabled",
    "baseUrl",
    "language",
    "asrProfile",
    "diarize",
    "timeoutMs",
    "maxConcurrentTasks",
    "generate",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      diagnostics.push({
        code: "TOOLS_TRANS_SPEECH_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.transSpeech field ${key}.`,
        path: `tools.transSpeech.${key}`,
        recoverable: true,
      });
    }
  }

  if (enabled === undefined || baseUrl === undefined || language === undefined || asrProfile === undefined
    || diarize === undefined || timeoutMs === undefined || maxConcurrentTasks === undefined || !generate) {
    return undefined;
  }
  return { enabled, baseUrl, language, asrProfile, diarize, timeoutMs, maxConcurrentTasks, generate };
}

function parseTransSpeechGenerate(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotTransSpeechEnabledConfig["generate"] | undefined {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_TRANS_SPEECH_GENERATE_INVALID",
      severity: "fatal",
      message: "tools.transSpeech.generate must be an object.",
      path: "tools.transSpeech.generate",
      recoverable: false,
    });
    return undefined;
  }
  const polish = parseRequiredBoolean(raw.polish, "tools.transSpeech.generate.polish", "TOOLS_TRANS_SPEECH_GENERATE_POLISH_INVALID", diagnostics);
  const minutes = parseRequiredBoolean(raw.minutes, "tools.transSpeech.generate.minutes", "TOOLS_TRANS_SPEECH_GENERATE_MINUTES_INVALID", diagnostics);
  const actions = parseRequiredBoolean(raw.actions, "tools.transSpeech.generate.actions", "TOOLS_TRANS_SPEECH_GENERATE_ACTIONS_INVALID", diagnostics);
  for (const key of Object.keys(raw)) {
    if (key !== "polish" && key !== "minutes" && key !== "actions") {
      diagnostics.push({
        code: "TOOLS_TRANS_SPEECH_GENERATE_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.transSpeech.generate field ${key}.`,
        path: `tools.transSpeech.generate.${key}`,
        recoverable: true,
      });
    }
  }
  if (polish === undefined || minutes === undefined || actions === undefined) return undefined;
  return { polish, minutes, actions };
}

function parseRequiredBoolean(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  diagnostics.push({ code, severity: "fatal", message: `${path} must be a boolean.`, path, recoverable: false });
  return undefined;
}

function parseRequiredPositiveInteger(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): number | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  diagnostics.push({ code, severity: "fatal", message: `${path} must be a positive integer.`, path, recoverable: false });
  return undefined;
}

function parseRequiredString(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  diagnostics.push({ code, severity: "fatal", message: `${path} must be a non-empty string.`, path, recoverable: false });
  return undefined;
}

function parseRequiredTransSpeechUrl(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): string | undefined {
  const value = parseRequiredString(raw, path, code, diagnostics);
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.port !== "8090" || !isAllowedTransSpeechHost(parsed.hostname)
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("unsupported Trans-Speech address");
    }
    return `http://${parsed.host}`;
  } catch {
    diagnostics.push({ code, severity: "fatal", message: `${path} must be an approved private HTTP service address on port 8090.`, path, recoverable: false });
    return undefined;
  }
}

function isAllowedTransSpeechHost(hostname: string): boolean {
  if (hostname === "trans-speech") return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168;
}

function parseWebSearch(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotWebSearchConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_INVALID",
      severity: "fatal",
      message: "tools.webSearch must be an object.",
      path: "tools.webSearch",
      recoverable: false,
    });
    return undefined;
  }

  const result: PilotWebSearchConfig = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_ENABLED_INVALID",
        severity: "fatal",
        message: "tools.webSearch.enabled must be a boolean.",
        path: "tools.webSearch.enabled",
        recoverable: false,
      });
    } else {
      result.enabled = raw.enabled;
    }
  }

  if (raw.provider !== undefined) {
    if (raw.provider !== "glm" && raw.provider !== "tavily" && raw.provider !== "custom") {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_PROVIDER_INVALID",
        severity: "fatal",
        message: "tools.webSearch.provider must be \"glm\", \"tavily\", or \"custom\".",
        path: "tools.webSearch.provider",
        recoverable: false,
      });
    } else {
      result.provider = raw.provider as PilotWebSearchProvider;
    }
  }

  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string" || raw.apiKey.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_API_KEY_INVALID",
        severity: "fatal",
        message: "tools.webSearch.apiKey must be a non-empty string.",
        path: "tools.webSearch.apiKey",
        recoverable: false,
      });
    } else {
      result.apiKey = raw.apiKey.trim();
    }
  }

  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== "string" || raw.endpoint.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_ENDPOINT_INVALID",
        severity: "fatal",
        message: "tools.webSearch.endpoint must be a non-empty URL string.",
        path: "tools.webSearch.endpoint",
        recoverable: false,
      });
    } else {
      result.endpoint = raw.endpoint.trim();
    }
  }

  const customProvider = parseCustomProvider(raw.customProvider, diagnostics);
  if (customProvider) {
    result.customProvider = customProvider;
  }

  // Soft-deprecate removed legacy fields. Emit warnings + ignore so existing
  // yamls don't break during migration to provider/apiKey/endpoint.
  if (raw.region !== undefined) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_REGION_DEPRECATED",
      severity: "warning",
      message:
        "tools.webSearch.region has been removed. Select tools.webSearch.provider instead.",
      path: "tools.webSearch.region",
      recoverable: true,
    });
  }
  if (raw.tavilyApiKey !== undefined) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_TAVILY_KEY_DEPRECATED",
      severity: "warning",
      message:
        "tools.webSearch.tavilyApiKey has been removed. Set tools.webSearch.provider: tavily and use tools.webSearch.apiKey.",
      path: "tools.webSearch.tavilyApiKey",
      recoverable: true,
    });
  }

  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "provider" && key !== "apiKey" && key !== "endpoint" && key !== "customProvider" && key !== "region" && key !== "tavilyApiKey") {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.webSearch field ${key}.`,
        path: `tools.webSearch.${key}`,
        recoverable: true,
      });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCustomProvider(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): NonNullable<PilotWebSearchConfig["customProvider"]> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_INVALID",
      severity: "fatal",
      message: "tools.webSearch.customProvider must be an object.",
      path: "tools.webSearch.customProvider",
      recoverable: false,
    });
    return undefined;
  }

  const result: NonNullable<PilotWebSearchConfig["customProvider"]> = {};
  const auth = parseEnumField<PilotWebSearchCustomAuth>(
    raw.auth,
    ["bearer", "bodyApiKey", "queryApiKey", "none"],
    "tools.webSearch.customProvider.auth",
    "TOOLS_WEB_SEARCH_CUSTOM_AUTH_INVALID",
    diagnostics,
  );
  if (auth) result.auth = auth;

  const method = parseEnumField<PilotWebSearchCustomMethod>(
    raw.method,
    ["GET", "POST"],
    "tools.webSearch.customProvider.method",
    "TOOLS_WEB_SEARCH_CUSTOM_METHOD_INVALID",
    diagnostics,
  );
  if (method) result.method = method;

  for (const field of [
    "name",
    "queryParam",
    "apiKeyParam",
    "resultsPath",
    "titleField",
    "urlField",
    "snippetField",
    "sourceField",
    "publishedAtField",
  ] as const) {
    const parsed = parseOptionalStringField(raw[field], `tools.webSearch.customProvider.${field}`, diagnostics);
    if (parsed !== undefined) {
      result[field] = parsed;
    }
  }

  for (const key of Object.keys(raw)) {
    if (
      key !== "auth" &&
      key !== "name" &&
      key !== "method" &&
      key !== "queryParam" &&
      key !== "apiKeyParam" &&
      key !== "resultsPath" &&
      key !== "titleField" &&
      key !== "urlField" &&
      key !== "snippetField" &&
      key !== "sourceField" &&
      key !== "publishedAtField"
    ) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.webSearch.customProvider field ${key}.`,
        path: `tools.webSearch.customProvider.${key}`,
        recoverable: true,
      });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseEnumField<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${path} must be one of: ${allowed.join(", ")}.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return raw as T;
}

function parseOptionalStringField(
  raw: unknown,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_CUSTOM_STRING_INVALID",
      severity: "fatal",
      message: `${path} must be a non-empty string.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return raw.trim();
}
