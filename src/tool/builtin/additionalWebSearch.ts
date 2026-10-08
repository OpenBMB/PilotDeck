import { isSerpApiEngine, type SerpApiEngine } from "../../pilot/config/webSearchProviders.js";
import type { WebSearchOrganicResult } from "./webSearch.js";

export type AdditionalSearchProvider = "baidu" | "bocha" | "exa" | "serpapi";
export function isAdditionalSearchProvider(value: unknown): value is AdditionalSearchProvider {
  return value === "baidu" || value === "bocha" || value === "exa" || value === "serpapi";
}

/** Used by both real searches and the settings connection probe. */
export function additionalSearchRequest(provider: AdditionalSearchProvider, options: {
  endpoint: string; apiKey: string; query: string; limit: number; searchEngine?: SerpApiEngine; gl?: string;
}): { url: string; init: RequestInit } {
  const { endpoint, apiKey, query } = options;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Search endpoint must use HTTP(S).");
  const headers: Record<string, string> = { Accept: "application/json" };
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));
  if (provider === "serpapi") {
    const engine = options.searchEngine ?? "google";
    if (!isSerpApiEngine(engine)) throw new Error("Unsupported SerpAPI search engine.");
    url.searchParams.set("engine", engine);
    url.searchParams.set(engine === "yahoo" ? "p" : engine === "yandex" ? "text" : "q", query);
    url.searchParams.set("api_key", apiKey);
    if (engine === "google" && options.gl?.trim()) url.searchParams.set("gl", options.gl.trim());
    return { url: url.toString(), init: { method: "GET", headers } };
  }
  headers["Content-Type"] = "application/json";
  let body: Record<string, unknown>;
  if (provider === "baidu") {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { messages: [{ role: "user", content: query }], search_source: "baidu_search_v2", resource_type_filter: [{ type: "web", top_k: limit }] };
  } else if (provider === "bocha") {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { query, count: limit, freshness: "noLimit", summary: true };
  } else {
    headers["x-api-key"] = apiKey;
    body = { query, numResults: limit, type: "auto", contents: { highlights: true, text: false } };
  }
  return { url: url.toString(), init: { method: "POST", headers, body: JSON.stringify(body) } };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

export function additionalSearchResults(provider: AdditionalSearchProvider, raw: unknown, limit: number): WebSearchOrganicResult[] {
  if (!record(raw)) throw new Error("Search API returned an invalid JSON response.");
  if (raw.error) throw new Error(typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error));
  const code = raw.code;
  if (code !== undefined && code !== 0 && code !== "0" && !(provider === "bocha" && (code === 200 || code === "200"))) {
    throw new Error(`code=${String(code)}: ${text(raw.message) ?? text(raw.msg) ?? "Search provider error"}`);
  }
  if (provider === "serpapi" && record(raw.search_metadata) && raw.search_metadata.status === "Error") throw new Error("SerpAPI search failed.");
  const data = provider === "bocha" && record(raw.data) ? raw.data : raw;
  const pages = record(data.webPages) ? data.webPages.value : undefined;
  const items = provider === "baidu" ? raw.references : provider === "bocha" ? pages : provider === "exa" ? raw.results : raw.organic_results;
  // SerpAPI legitimately omits organic_results for a query with no organic hits.
  if (!Array.isArray(items)) {
    if (provider === "serpapi" && record(raw.search_metadata) && raw.search_metadata.status === "Success") return [];
    throw new Error("Search API response is missing its result list.");
  }
  return items.filter(record).filter(item => provider !== "baidu" || !item.type || item.type === "web").slice(0, Math.max(0, limit)).map(item => ({
    title: text(item.title) ?? text(item.name),
    link: text(item.url) ?? text(item.link),
    snippet: text(item.summary) ?? text(item.snippet) ?? text(item.content)
      ?? (Array.isArray(item.highlights) ? item.highlights.filter(value => typeof value === "string").join("\n") || undefined : undefined)
      ?? text(item.text),
    source: text(item.siteName) ?? text(item.source),
    publishedAt: text(item.publishedDate) ?? text(item.datePublished) ?? text(item.date),
  }));
}

/** Query-authenticated APIs can include the full request URL in network errors. */
export function redactSearchError(value: unknown, apiKey: string): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ key: apiKey }).toString().slice(4)]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 500);
}
