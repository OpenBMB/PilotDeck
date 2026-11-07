import { networkFetch } from "../../network/fetch.js";
import { buildProviderModelsEndpointCandidates, isExpectedProviderModelsResponseShape } from "../providerEndpoint.js";
import type { ModelProtocol } from "../protocol/canonical.js";
import { normalizeModelListItem, parseModelListResponse, positiveTokenLimit, type ProviderModelMetadata } from "./tokenLimits.js";

type Options = { protocol: ModelProtocol; baseUrl: string; apiKey?: string; providerId?: string; signal?: AbortSignal; fetchImpl?: typeof fetch };

export class ModelDiscoveryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function headers(options: Options): Record<string, string> {
  const key = options.apiKey;
  if (options.protocol === "anthropic") return { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) };
  return key ? options.protocol === "google" ? { "x-goog-api-key": key } : { Authorization: `Bearer ${key}` } : {};
}

async function request(url: string, options: Options, body?: unknown): Promise<Record<string, unknown>> {
  const response = await networkFetch(url, {
    method: body === undefined ? "GET" : "POST", headers: { ...headers(options), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal,
  }, { signal: options.signal, fetchImpl: options.fetchImpl, retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000, retryOnPost: body !== undefined } });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* Non-JSON error responses still keep the upstream HTTP status. */ }
  if (!response.ok) throw new ModelDiscoveryError(parsed?.error?.message || parsed?.message || text || `HTTP ${response.status}`, response.status);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ModelDiscoveryError(`Expected JSON from ${url}, but received non-JSON content.`, 502);
  return parsed;
}

/** Follow only provider-issued cursors on the same URL; never forward keys to a next-link host. */
async function listPages(options: Options): Promise<ProviderModelMetadata[]> {
  const urls = buildProviderModelsEndpointCandidates(options);
  let body: Record<string, unknown> | undefined, endpoint = urls[0];
  for (const url of urls) {
    try {
      const candidate = await request(url, options);
      if (isExpectedProviderModelsResponseShape(options.protocol, candidate)) { body = candidate; endpoint = url; break; }
    } catch (error) {
      if (!(error instanceof ModelDiscoveryError) || ![400, 404, 405].includes(error.status) || url === urls.at(-1)) throw error;
    }
  }
  if (!body) throw new ModelDiscoveryError("Expected a provider model list.", 502);
  const models = new Map<string, ProviderModelMetadata>(), cursors = new Set<string>();
  for (let page = 0; ; page++) {
    for (const model of parseModelListResponse(body)) models.set(model.id, { ...models.get(model.id), ...model });
    const cursor = options.protocol === "google" ? body.nextPageToken : options.protocol === "anthropic" && body.has_more === true ? body.last_id : undefined;
    if (!cursor) {
      if (options.protocol === "anthropic" && body.has_more === true) throw new ModelDiscoveryError("Provider omitted its pagination cursor.", 502);
      return [...models.values()];
    }
    if (typeof cursor !== "string" || cursors.has(cursor) || page >= 99) throw new ModelDiscoveryError("Provider model pagination did not finish.", 502);
    cursors.add(cursor);
    const url = new URL(endpoint);
    url.searchParams.set(options.protocol === "google" ? "pageToken" : "after_id", cursor);
    body = await request(url.toString(), options);
    if (!isExpectedProviderModelsResponseShape(options.protocol, body)) throw new ModelDiscoveryError("Expected a provider model list.", 502);
  }
}

export async function discoverProviderModels(options: Options): Promise<ProviderModelMetadata[]> {
  const models = await listPages(options);
  const url = new URL(options.baseUrl);
  // This API is separate from the compatible-mode discovery endpoint. A proxy
  // must never cause an additional request to the official host with its key.
  if (["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(url.hostname)) {
    try {
      const details = parseModelListResponse(await request(`${url.origin}/api/v1/models`, options));
      const byId = new Map(details.map(model => [model.id, model]));
      return models.map(model => ({ ...model, ...byId.get(model.id) }));
    } catch { /* Discovery still works when the optional metadata endpoint is unavailable. */ }
  }
  return models;
}

/** Ollama's loaded window is available only in /api/show, requested for one opened model. */
export async function discoverOllamaModel(options: Options, modelId: string): Promise<ProviderModelMetadata> {
  const url = new URL(options.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "").replace(/\/v1$/, "").replace(/\/api$/, "") + "/api/show";
  url.search = ""; url.hash = "";
  const body = await request(url.toString(), options, { model: modelId });
  const info = body.model_info && typeof body.model_info === "object" ? body.model_info as Record<string, unknown> : {};
  const parameters = typeof body.parameters === "string" ? body.parameters : "";
  const configured = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  const configuredValue = configured ? positiveTokenLimit(Number(configured[1])) : undefined;
  const architecture = typeof info["general.architecture"] === "string" ? info["general.architecture"] : undefined;
  const context = configuredValue ?? positiveTokenLimit(architecture ? info[`${architecture}.context_length`] : undefined)
    ?? Object.entries(info).filter(([key]) => key.endsWith(".context_length")).map(([, value]) => positiveTokenLimit(value)).find(v => v !== undefined);
  return { ...normalizeModelListItem({ id: modelId })!, ...(context !== undefined ? { maxContextTokens: context } : {}) };
}
