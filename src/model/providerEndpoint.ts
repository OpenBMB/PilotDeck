export type ProviderEndpointProtocol = "openai" | "openai-responses" | "anthropic" | "google";

const VERSION_SEGMENT_PATTERN = /^v\d+(?:beta\d*)?$/i;

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.filter(Boolean))];
}

function getPathSegments(baseUrl: string): string[] {
  try {
    return new URL(baseUrl).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function hasVersionSegment(baseUrl: string): boolean {
  return getPathSegments(baseUrl).some((segment) => VERSION_SEGMENT_PATTERN.test(segment));
}

function pathEndsWith(baseUrl: string, suffix: string[]): boolean {
  const segments = getPathSegments(baseUrl).map((segment) => segment.toLowerCase());
  const normalizedSuffix = suffix.map((segment) => segment.toLowerCase());
  if (segments.length < normalizedSuffix.length) return false;
  return normalizedSuffix.every((segment, index) => segments[segments.length - normalizedSuffix.length + index] === segment);
}

function baseUrlEndsWithEndpoint(baseUrl: string, endpointPath: string): boolean {
  const normalizedEndpointPath = trimSlashes(endpointPath);
  const endpointSegments = normalizedEndpointPath.split("/").filter(Boolean);
  if (pathEndsWith(baseUrl, endpointSegments)) return true;

  if (endpointSegments.length === 2 && endpointSegments[0].toLowerCase() === "models") {
    const segments = getPathSegments(baseUrl).map((segment) => segment.toLowerCase());
    const last = segments.at(-1) || "";
    const methodSeparator = endpointSegments[1].indexOf(":");
    const methodSuffix = methodSeparator >= 0 ? endpointSegments[1].slice(methodSeparator).toLowerCase() : "";
    return Boolean(methodSuffix) && segments.at(-2) === "models" && last.endsWith(methodSuffix);
  }

  return false;
}

function buildEndpointCandidates(baseUrl: string, defaultVersion: string, endpointPath: string): string[] {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const normalizedEndpointPath = trimSlashes(endpointPath);
  if (baseUrlEndsWithEndpoint(normalizedBase, normalizedEndpointPath)) return [normalizedBase];
  const unversionedEndpoint = joinUrl(normalizedBase, normalizedEndpointPath);
  if (hasVersionSegment(normalizedBase)) return [unversionedEndpoint];
  const versionedEndpoint = joinUrl(normalizedBase, [defaultVersion, normalizedEndpointPath].filter(Boolean).join("/"));
  return uniqueUrls([
    versionedEndpoint,
    unversionedEndpoint,
  ]);
}

function buildVersionedEndpoint(baseUrl: string, defaultVersion: string, endpointPath: string): string {
  return buildEndpointCandidates(baseUrl, defaultVersion, endpointPath)[0] || "";
}

export function normalizeGoogleProbeModel(model: string): string {
  const text = String(model || "").trim();
  const withoutProvider = text.startsWith("google/") ? text.slice("google/".length) : text;
  if (withoutProvider === "gemini-3-pro") return "gemini-3-pro-preview";
  if (withoutProvider === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (withoutProvider === "gemini-3-flash") return "gemini-3-flash-preview";
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
  return withoutProvider;
}

export function buildProviderChatEndpoint(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
  model?: string;
  googleMethod?: string;
}): string {
  return buildProviderChatEndpointCandidates(input)[0] || "";
}

export function buildProviderChatEndpointCandidates(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
  model?: string;
  googleMethod?: string;
}): string[] {
  const normalizedProtocol = input.protocol;
  if (normalizedProtocol === "anthropic") {
    return buildEndpointCandidates(input.baseUrl, "v1", "messages");
  }
  if (normalizedProtocol === "openai-responses") {
    return buildEndpointCandidates(input.baseUrl, "v1", "responses");
  }
  if (normalizedProtocol === "google") {
    const method = input.googleMethod || "generateContent";
    const model = encodeURIComponent(normalizeGoogleProbeModel(input.model || ""));
    const normalizedBase = input.baseUrl.trim().replace(/\/+$/, "") || "https://generativelanguage.googleapis.com";
    return buildEndpointCandidates(normalizedBase, "v1beta", `models/${model}:${method}`);
  }
  return buildEndpointCandidates(input.baseUrl, "v1", "chat/completions");
}

export function buildProviderModelsEndpoint(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
}): string {
  return buildProviderModelsEndpointCandidates(input)[0] || "";
}

export function buildProviderModelsEndpointCandidates(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
}): string[] {
  if (input.protocol === "google") {
    return buildEndpointCandidates(input.baseUrl, "v1beta", "models");
  }
  return buildEndpointCandidates(input.baseUrl, "v1", "models");
}

export function isExpectedProviderResponseShape(protocol: ProviderEndpointProtocol, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (protocol === "anthropic") {
    return Array.isArray(record.content) || record.type === "message";
  }
  if (protocol === "google") {
    return Array.isArray(record.candidates);
  }
  if (protocol === "openai-responses") {
    return record.object === "response" || Array.isArray(record.output) || typeof record.output_text === "string";
  }
  return Array.isArray(record.choices);
}

export function isExpectedProviderModelsResponseShape(protocol: ProviderEndpointProtocol, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (protocol === "google") return Array.isArray(record.models);
  return Array.isArray(record.data) || Array.isArray(record.models);
}
