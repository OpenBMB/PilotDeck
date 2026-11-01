import { isWebSearchProvider, SERPAPI_ENGINES, type SerpApiEngine } from "./webSearchProviders.js";
import { isRecord } from "../../model/config/schema.js";
import { validateCustomSearch } from "./customSearch.js";
import type {
  PilotConfigDiagnostic,
  PilotToolsConfig,
  PilotWebSearchConfig,
  PilotWebSearchCustomAuth,
  PilotWebSearchCustomMethod,
  PilotWebSearchProvider,
  PilotWebSearchProviderConfig,
} from "./types.js";

/**
 * Parse the optional `tools` section of `pilotdeck.yaml`.
 *
 *   tools:
 *     webSearch:
 *       enabled: true
 *       provider: glm                    # See webSearchProviders.ts for supported providers
 *       providers:
 *         glm:
 *           apiKey: "..."
 *           endpoint: https://api.z.ai/api/paas/v4/web_search
 *
 * Legacy apiKey/endpoint fields at the webSearch level remain supported.
 *
 * Unknown fields produce non-fatal warnings so future additions don't break
 * older deployments. Returns `undefined` when no webSearch block exists.
 * Preserve a present but empty block: legacy configs use it to opt into
 * search with credentials supplied by the environment.
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

  if (result.enabled === false) {
    return { enabled: false };
  }

  if (raw.provider !== undefined) {
    if (!isWebSearchProvider(raw.provider)) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_PROVIDER_INVALID",
        severity: "fatal",
        message: "tools.webSearch.provider must be a supported search provider.",
        path: "tools.webSearch.provider",
        recoverable: false,
      });
    } else {
      result.provider = raw.provider as PilotWebSearchProvider;
    }
  }

  Object.assign(result, parseProviderConfig(raw, diagnostics, "tools.webSearch"));

  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_PROVIDERS_INVALID",
        severity: "fatal",
        message: "tools.webSearch.providers must be an object.",
        path: "tools.webSearch.providers",
        recoverable: false,
      });
    } else {
      result.providers = {};
      for (const [provider, settings] of Object.entries(raw.providers)) {
        const path = `tools.webSearch.providers.${provider}`;
        if (!isWebSearchProvider(provider)) {
          diagnostics.push({
            code: "TOOLS_WEB_SEARCH_PROVIDER_UNKNOWN",
            severity: "warning",
            message: `Unknown Web Search provider ${provider}.`,
            path,
            recoverable: true,
          });
          continue;
        }
        if (!isRecord(settings)) {
          diagnostics.push({
            code: "TOOLS_WEB_SEARCH_PROVIDER_CONFIG_INVALID",
            severity: "fatal",
            message: `${path} must be an object.`,
            path,
            recoverable: false,
          });
          continue;
        }
        result.providers[provider] = parseProviderConfig(settings, diagnostics, path);
        for (const key of Object.keys(settings)) {
          if (!["apiKey", "endpoint", "searchEngine", "customProvider"].includes(key)) {
            diagnostics.push({
              code: "TOOLS_WEB_SEARCH_UNKNOWN_FIELD",
              severity: "warning",
              message: `Unknown ${path} field ${key}.`,
              path: `${path}.${key}`,
              recoverable: true,
            });
          }
        }
      }
    }
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
    if (key !== "enabled" && key !== "provider" && key !== "apiKey" && key !== "endpoint" && key !== "customProvider" && key !== "searchEngine" && key !== "region" && key !== "tavilyApiKey" && key !== "providers") {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.webSearch field ${key}.`,
        path: `tools.webSearch.${key}`,
        recoverable: true,
      });
    }
  }

  // Presence is meaningful even if every legacy/unknown field was discarded.
  return result;
}

function parseProviderConfig(
  raw: Record<string, unknown>,
  diagnostics: PilotConfigDiagnostic[],
  path: string,
): PilotWebSearchProviderConfig {
  const result: PilotWebSearchProviderConfig = {};
  const searchEngine = parseEnumField<SerpApiEngine>(
    raw.searchEngine, [...SERPAPI_ENGINES], `${path}.searchEngine`,
    "TOOLS_WEB_SEARCH_ENGINE_INVALID", diagnostics,
  );
  if (searchEngine) result.searchEngine = searchEngine;

  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string" || raw.apiKey.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_API_KEY_INVALID",
        severity: "fatal",
        message: `${path}.apiKey must be a non-empty string.`,
        path: `${path}.apiKey`,
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
        message: `${path}.endpoint must be a non-empty URL string.`,
        path: `${path}.endpoint`,
        recoverable: false,
      });
    } else {
      const endpoint = raw.endpoint.trim();
      try {
        const parsed = new URL(endpoint);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
        result.endpoint = endpoint;
      } catch {
        diagnostics.push({
          code: "TOOLS_WEB_SEARCH_ENDPOINT_INVALID",
          severity: "fatal",
          message: `${path}.endpoint must be an HTTP(S) URL.`,
          path: `${path}.endpoint`,
          recoverable: false,
        });
      }
    }
  }

  const customProvider = parseCustomProvider(raw.customProvider, diagnostics, `${path}.customProvider`);
  if (customProvider) {
    result.customProvider = customProvider;
  }

  return result;
}

function parseCustomProvider(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
  path: string,
): NonNullable<PilotWebSearchConfig["customProvider"]> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_INVALID",
      severity: "fatal",
      message: `${path} must be an object.`,
      path,
      recoverable: false,
    });
    return undefined;
  }

  const result: NonNullable<PilotWebSearchConfig["customProvider"]> = {};
  const auth = parseEnumField<PilotWebSearchCustomAuth>(
    raw.auth,
    ["bearer", "bodyApiKey", "queryApiKey", "headerApiKey", "none"],
    `${path}.auth`,
    "TOOLS_WEB_SEARCH_CUSTOM_AUTH_INVALID",
    diagnostics,
  );
  if (auth) result.auth = auth;

  const method = parseEnumField<PilotWebSearchCustomMethod>(
    raw.method,
    ["GET", "POST"],
    `${path}.method`,
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
    const parsed = parseOptionalStringField(raw[field], `${path}.${field}`, diagnostics);
    if (parsed !== undefined) {
      result[field] = parsed;
    }
  }

  for (const field of ['headers', 'queryParams', 'requestBody', 'bodyEncoding'] as const) {
    if (raw[field] !== undefined) Object.assign(result, { [field]: raw[field] });
  }
  try { validateCustomSearch(result); }
  catch (error) {
    diagnostics.push({ code: 'TOOLS_WEB_SEARCH_CUSTOM_TEMPLATE_INVALID', severity: 'fatal',
      message: `${path}: ${error instanceof Error ? error.message : String(error)}`, path, recoverable: false });
  }
  for (const key of Object.keys(raw)) {
    if (
      !['headers', 'queryParams', 'requestBody', 'bodyEncoding'].includes(key) &&
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
        message: `Unknown ${path} field ${key}.`,
        path: `${path}.${key}`,
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
