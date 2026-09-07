import { lookupCatalogProvider } from "../catalog/index.js";
import type { ModelProtocol } from "../protocol/canonical.js";

const GOOGLE_OPENAI_COMPATIBLE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

function canonicalProviderUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function protocolCanUseCatalogCredential(
  providerId: string,
  protocol: unknown,
  catalogProtocol: ModelProtocol,
): boolean {
  if (protocol === catalogProtocol) return true;
  return providerId === "google" && protocol === "openai";
}

export function resolveCatalogProviderDefaultUrl(
  providerId: string,
  protocol: unknown,
): string | undefined {
  if (providerId === "google" && protocol === "openai") {
    return GOOGLE_OPENAI_COMPATIBLE_URL;
  }
  return lookupCatalogProvider(providerId)?.defaultUrl;
}

/**
 * Return the catalog environment variable only while the provider still uses
 * the catalog credential's protocol and endpoint. An explicit apiKey value
 * (including `${VAR}`) is handled separately and therefore remains valid for
 * custom endpoints as an intentional user choice.
 */
export function resolveCatalogProviderApiKeyEnvVar(
  providerId: string,
  protocol: unknown,
  url: unknown,
): string | undefined {
  const catalog = lookupCatalogProvider(providerId);
  if (
    !catalog?.apiKeyEnvVar
    || !protocolCanUseCatalogCredential(providerId, protocol, catalog.protocol)
  ) {
    return undefined;
  }

  const catalogUrl = resolveCatalogProviderDefaultUrl(providerId, protocol);
  const expected = canonicalProviderUrl(catalogUrl);
  const actual = canonicalProviderUrl(url);
  if (!expected || actual !== expected) return undefined;
  return catalog.apiKeyEnvVar;
}
