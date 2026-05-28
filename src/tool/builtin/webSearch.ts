import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

/**
 * `web_search` is a local PilotDeck tool backed by exactly one configured
 * provider. The model still sees one stable tool surface; provider-specific
 * request/response shapes stay behind this adapter.
 */
export type WebSearchProvider = "glm" | "tavily" | "custom";
export type WebSearchCustomAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
export type WebSearchCustomMethod = "GET" | "POST";

export type WebSearchCustomProviderConfig = {
  name?: string;
  auth?: WebSearchCustomAuth;
  method?: WebSearchCustomMethod;
  queryParam?: string;
  apiKeyParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

export type CreateWebSearchToolOptions = {
  provider?: WebSearchProvider;
  apiKey?: string;
  /** Override provider endpoint. GLM defaults to Z.AI web_search; Tavily defaults to api.tavily.com. */
  endpoint?: string;
  customProvider?: WebSearchCustomProviderConfig;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Override timeout (default 30s). */
  timeoutMs?: number;
  /** Cap on organic results returned to the model (default 8). */
  organicLimit?: number;
  /** Cap on top-stories returned (default 5). */
  topStoriesLimit?: number;
};

export type WebSearchInput = {
  /** Search query string. */
  query: string;
  /** Country code for localized results (default "us"). Use "cn" for China-localized results. */
  gl?: string;
};

export type WebSearchOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
};

export type WebSearchOutput = {
  query: string;
  organic: WebSearchOrganicResult[];
  knowledgeGraph?: Record<string, unknown>;
  answerBox?: Record<string, unknown>;
  topStories?: Array<Record<string, unknown>>;
};

const DEFAULT_GLM_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";
const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ORGANIC_LIMIT = 8;

export function createWebSearchTool(
  options: CreateWebSearchToolOptions = {},
): PilotDeckToolDefinition<WebSearchInput, WebSearchOutput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const organicLimit = options.organicLimit ?? DEFAULT_ORGANIC_LIMIT;

  return {
    name: "web_search",
    aliases: ["WebSearch"],
    description: `- Searches the web for current information using the configured GLM/Z.AI, Tavily, or custom provider
- Takes a search query and optional country code (\`gl\`) as input
- Returns structured search data including organic results and, when available, answer box content
- Use this tool for current events, recent documentation, and information beyond the model's knowledge cutoff

Usage notes:
  - Configure \`tools.webSearch.provider\` as \`glm\`, \`tavily\`, or \`custom\` in \`pilotdeck.yaml\`
  - Requires \`tools.webSearch.apiKey\`, \`GLM_WEB_SEARCH_API_KEY\`/\`ZAI_API_KEY\`, \`TAVILY_API_KEY\`, or \`CUSTOM_WEB_SEARCH_API_KEY\` unless custom auth is \`none\`
  - The optional \`gl\` parameter is forwarded only by providers that support localization
  - This tool is read-only and does not modify files`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Search query string. Be specific, and include versions or the current year when looking for recent documentation, releases, or current events.",
        },
        gl: {
          type: "string",
          description: 'Optional country code for localized results. Defaults to "us"; use "cn" for China-localized results.',
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "web_search",
        message: "Network search requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "web_search",
        inputSummary: "web search",
        reason: {
          type: "tool",
          toolName: "web_search",
          message: "Network search requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const provider = resolveProvider(options.provider, options.apiKey, context);
      const apiKey = resolveApiKey(options.apiKey, provider, context);
      const custom = normalizeCustomProviderConfig(options.customProvider);
      if (!apiKey && !(provider === "custom" && custom.auth === "none")) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "web_search is not configured. Set tools.webSearch.provider to glm, tavily, or custom and provide tools.webSearch.apiKey, or set GLM_WEB_SEARCH_API_KEY/ZAI_API_KEY/TAVILY_API_KEY/CUSTOM_WEB_SEARCH_API_KEY.",
        );
      }
      if (provider === "custom") {
        if (!options.endpoint?.trim()) {
          throw new PilotDeckToolRuntimeError(
            "unsupported_tool",
            "web_search custom provider requires tools.webSearch.endpoint.",
          );
        }
        return performCustomSearch({
          input,
          context,
          apiKey: apiKey ?? "",
          endpoint: options.endpoint,
          fetchImpl,
          timeoutMs,
          organicLimit,
          custom,
        });
      }
      if (provider === "tavily") {
        return performTavilySearch({
          input,
          context,
          apiKey: apiKey ?? "",
          endpoint: options.endpoint ?? DEFAULT_TAVILY_ENDPOINT,
          fetchImpl,
          timeoutMs,
          organicLimit,
        });
      }
      return performGlmSearch({
        input,
        context,
        apiKey: apiKey ?? "",
        endpoint: options.endpoint ?? readEnv(context, "GLM_WEB_SEARCH_ENDPOINT") ?? DEFAULT_GLM_ENDPOINT,
        fetchImpl,
        timeoutMs,
        organicLimit,
      });
    },
  };
}

function resolveProvider(
  optionProvider: WebSearchProvider | undefined,
  optionApiKey: string | undefined,
  context: PilotDeckToolRuntimeContext,
): WebSearchProvider {
  if (optionProvider) return optionProvider;
  if (optionApiKey?.trim()) return "glm";
  if (readEnv(context, "TAVILY_API_KEY")) return "tavily";
  return "glm";
}

function resolveApiKey(
  optionApiKey: string | undefined,
  provider: WebSearchProvider,
  context: PilotDeckToolRuntimeContext,
): string | undefined {
  const fromOption = optionApiKey?.trim();
  if (fromOption) {
    return fromOption;
  }
  if (provider === "tavily") return readEnv(context, "TAVILY_API_KEY");
  if (provider === "custom") return readEnv(context, "CUSTOM_WEB_SEARCH_API_KEY");
  return readEnv(context, "GLM_WEB_SEARCH_API_KEY") ?? readEnv(context, "ZAI_API_KEY");
}

function normalizeCustomProviderConfig(
  config: WebSearchCustomProviderConfig | undefined,
): Required<WebSearchCustomProviderConfig> {
  return {
    auth: config?.auth ?? "bearer",
    name: config?.name?.trim() || "custom",
    method: config?.method ?? "POST",
    queryParam: config?.queryParam?.trim() || "query",
    apiKeyParam: config?.apiKeyParam?.trim() || "api_key",
    resultsPath: config?.resultsPath?.trim() || "",
    titleField: config?.titleField?.trim() || "title",
    urlField: config?.urlField?.trim() || "url",
    snippetField: config?.snippetField?.trim() || "snippet",
    sourceField: config?.sourceField?.trim() || "source",
    publishedAtField: config?.publishedAtField?.trim() || "publishedAt",
  };
}

function readEnv(context: PilotDeckToolRuntimeContext, name: string): string | undefined {
  const value = (context.env ?? process.env)[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

type PerformTavilySearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

async function performTavilySearch(
  args: PerformTavilySearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit } = args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: organicLimit,
    include_answer: true,
    search_depth: "basic",
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && context.abortSignal?.aborted !== true) {
      throw new PilotDeckToolRuntimeError(
        "tool_timeout",
        `web_search (tavily) timed out after ${timeoutMs}ms.`,
      );
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `web_search (tavily) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Tavily API error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;

  const organic: WebSearchOrganicResult[] = [];
  if (Array.isArray(raw.results)) {
    for (const r of (raw.results as Array<Record<string, unknown>>).slice(0, organicLimit)) {
      organic.push({
        title: readString(r.title),
        link: readString(r.url),
        snippet: readString(r.content),
        source: readString(r.url),
      });
    }
  }

  const output: WebSearchOutput = { query, organic };
  if (typeof raw.answer === "string" && raw.answer.length > 0) {
    output.answerBox = { answer: raw.answer };
  }

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "tavily",
      endpoint,
      engine: "tavily",
      organicCount: organic.length,
    },
  };
}

type PerformGlmSearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
};

async function performGlmSearch(
  args: PerformGlmSearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const {
    input,
    context,
    apiKey,
    endpoint,
    fetchImpl,
    timeoutMs,
    organicLimit,
  } = args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
  }

  const body: Record<string, unknown> = {
    search_engine: "search-prime",
    search_query: query,
    count: Math.max(1, Math.min(organicLimit, 50)),
    search_recency_filter: "noLimit",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && context.abortSignal?.aborted !== true) {
      throw new PilotDeckToolRuntimeError(
        "tool_timeout",
        `web_search timed out after ${timeoutMs}ms.`,
      );
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `web_search (glm) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `GLM web search error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `GLM web search error: ${raw.error}`,
    );
  }
  const proxyCode = raw.code;
  if (typeof proxyCode === "number" && proxyCode !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "search proxy error";
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `GLM web search error code=${proxyCode}: ${message}`,
    );
  }
  const organic = parseGlmResults(extractResultItems(raw), organicLimit);
  const output: WebSearchOutput = { query, organic };

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "glm",
      endpoint,
      organicCount: organic.length,
    },
  };
}

type PerformCustomSearchInput = {
  input: WebSearchInput;
  context: PilotDeckToolRuntimeContext;
  apiKey: string | undefined;
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  organicLimit: number;
  custom: Required<WebSearchCustomProviderConfig>;
};

async function performCustomSearch(
  args: PerformCustomSearchInput,
): Promise<PilotDeckToolExecutionOutput<WebSearchOutput>> {
  const { input, context, apiKey, endpoint, fetchImpl, timeoutMs, organicLimit, custom } = args;
  const query = input.query.trim();
  if (!query) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "web_search requires a non-empty `query`.",
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `web_search custom provider endpoint is not a valid URL: ${endpoint}`,
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const body: Record<string, unknown> = {};
  const method = custom.method;

  if (method === "GET") {
    url.searchParams.set(custom.queryParam, query);
    if (input.gl?.trim()) url.searchParams.set("gl", input.gl.trim());
  } else {
    headers["Content-Type"] = "application/json";
    body[custom.queryParam] = query;
    if (input.gl?.trim()) body.gl = input.gl.trim();
  }

  if (custom.auth === "bearer" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (custom.auth === "queryApiKey" && apiKey) {
    url.searchParams.set(custom.apiKeyParam, apiKey);
  } else if (custom.auth === "bodyApiKey" && apiKey) {
    if (method === "GET") {
      url.searchParams.set(custom.apiKeyParam, apiKey);
    } else {
      body[custom.apiKeyParam] = apiKey;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = forwardAbort(context.abortSignal, controller);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && context.abortSignal?.aborted !== true) {
      throw new PilotDeckToolRuntimeError(
        "tool_timeout",
        `web_search (custom) timed out after ${timeoutMs}ms.`,
      );
    }
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `web_search (custom) request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    detachAbort?.();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Custom web search error (${response.status}): ${truncate(detail, 500)}`,
    );
  }

  const raw = (await response.json()) as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Custom web search error: ${raw.error}`,
    );
  }
  const proxyCode = raw.code;
  if (typeof proxyCode === "number" && proxyCode !== 0) {
    const message = typeof raw.msg === "string" ? raw.msg : "search provider error";
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Custom web search error code=${proxyCode}: ${message}`,
    );
  }

  const resultValue = custom.resultsPath ? readPath(raw, custom.resultsPath) : extractResultItems(raw);
  const organic = parseMappedResults(resultValue, organicLimit, custom);
  const output: WebSearchOutput = { query, organic };

  return {
    content: [
      { type: "text", text: formatTextSummary(output) },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      provider: "custom",
      providerName: custom.name,
      endpoint,
      organicCount: organic.length,
    },
  };
}

function extractResultItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["search_result", "results", "items", "webPages", "data"]) {
    const child = value[key];
    if (Array.isArray(child)) return child;
    if (isRecord(child)) {
      const nested = extractResultItems(child);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function parseGlmResults(value: unknown, limit: number): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map((entry) => ({
    title: readString(entry.title) ?? readString(entry.name),
    link: readString(entry.url) ?? readString(entry.link) ?? readString(entry.href),
    snippet: readString(entry.snippet) ?? readString(entry.summary) ?? readString(entry.content) ?? readString(entry.text),
    source: readString(entry.source) ?? readString(entry.site) ?? readString(entry.media),
    publishedAt: readString(entry.publishedAt) ?? readString(entry.published_at) ?? readString(entry.publish_date) ?? readString(entry.date),
  }));
}

function parseMappedResults(
  value: unknown,
  limit: number,
  mapping: Required<WebSearchCustomProviderConfig>,
): WebSearchOrganicResult[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).slice(0, limit).map((entry) => ({
    title: readString(readPath(entry, mapping.titleField)),
    link: readString(readPath(entry, mapping.urlField)),
    snippet: readString(readPath(entry, mapping.snippetField)),
    source: readString(readPath(entry, mapping.sourceField)),
    publishedAt: readString(readPath(entry, mapping.publishedAtField)),
  }));
}

function readPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  return trimmed.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTextSummary(output: WebSearchOutput): string {
  const lines: string[] = [`Web search results for: ${output.query}`];
  if (output.answerBox) {
    lines.push("", "Answer box:", JSON.stringify(output.answerBox));
  }
  if (output.knowledgeGraph) {
    lines.push("", "Knowledge graph:", JSON.stringify(output.knowledgeGraph));
  }
  if (output.organic.length > 0) {
    lines.push("", "Organic results:");
    for (const entry of output.organic) {
      lines.push(`- ${entry.title ?? "(no title)"} — ${entry.link ?? ""}`);
      if (entry.snippet) lines.push(`  ${entry.snippet}`);
    }
  } else {
    lines.push("", "No organic results.");
  }
  if (output.topStories && output.topStories.length > 0) {
    lines.push("", `Top stories (${output.topStories.length}):`);
    for (const story of output.topStories) {
      const title = readString(story.title);
      const link = readString(story.link);
      lines.push(`- ${title ?? "(no title)"} — ${link ?? ""}`);
    }
  }
  return lines.join("\n");
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
