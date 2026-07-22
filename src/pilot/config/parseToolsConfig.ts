import { isRecord } from "../../model/config/schema.js";
import type {
  PilotConfigDiagnostic,
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

  for (const key of Object.keys(rawTools)) {
    if (key !== "webSearch") {
      diagnostics.push({
        code: "TOOLS_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools config field ${key}.`,
        path: `tools.${key}`,
        recoverable: true,
      });
    }
  }

  if (!webSearch) {
    return undefined;
  }
  return { webSearch };
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
