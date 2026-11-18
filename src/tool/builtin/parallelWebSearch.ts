import { McpClient, McpClientError } from "../../mcp/client/McpClient.js";
import { networkFetch } from "../../network/fetch.js";
import { requestAppVersion } from "../../network/requestContext.js";
import { customSearchResults } from "../../pilot/config/customSearch.js";
import { WEB_SEARCH_ENDPOINTS } from "../../pilot/config/webSearchProviders.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { WebSearchOrganicResult } from "./webSearch.js";

export async function parallelSearchResults(query: string, options: {
  signal?: AbortSignal;
  timeoutMs: number;
  organicLimit: number;
  fetchImpl?: typeof fetch;
}): Promise<WebSearchOrganicResult[]> {
  if (!query) throw new PilotDeckToolRuntimeError("invalid_tool_input", "web_search requires a non-empty `query`.");
  const { signal, timeoutMs, organicLimit, fetchImpl } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const searchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const client = new McpClient({
    id: "parallel-search",
    transport: "streamable_http",
    url: WEB_SEARCH_ENDPOINTS.parallel,
    headers: { "User-Agent": `PilotDeck/${requestAppVersion()}` },
  }, {
    callTimeoutMs: timeoutMs,
    fetch: (input, init) => {
      const isSessionClose = init?.method === "DELETE";
      const requestSignal = isSessionClose ? AbortSignal.timeout(1_000) : searchSignal;
      return networkFetch(input, { ...init, redirect: "error" }, {
        signal: init?.signal ? AbortSignal.any([init.signal, requestSignal]) : requestSignal,
        fetchImpl,
      });
    },
  });

  try {
    const result = await client.callTool("web_search", {
      objective: query,
      search_queries: [[...query].slice(0, 200).join("")],
    }, { signal: searchSignal });
    if (result.isError) throw new Error("Parallel returned a search error.");

    // Parallel can return the JSON result as an MCP text content item.
    const item = Array.isArray(result.content) ? result.content.find(part => part?.type === "text") : undefined;
    const payload: unknown = result.structuredContent ?? (typeof item?.text === "string" ? JSON.parse(item.text) : undefined);
    return customSearchResults(payload, {
      resultsPath: "results",
      snippetField: "excerpts",
      publishedAtField: "publish_date",
    }, organicLimit);
  } catch (error) {
    if (signal?.aborted) {
      throw new PilotDeckToolRuntimeError("tool_aborted", "Web search was cancelled.");
    }
    if (timeout.aborted || (error instanceof McpClientError && error.code === "mcp_call_timeout")) {
      throw new PilotDeckToolRuntimeError("tool_timeout", `Parallel search timed out after ${timeoutMs}ms.`);
    }
    throw new PilotDeckToolRuntimeError("tool_execution_failed", "Parallel search failed. Try again or check Settings → Search.");
  } finally {
    await client.close({ terminateSession: true });
  }
}
