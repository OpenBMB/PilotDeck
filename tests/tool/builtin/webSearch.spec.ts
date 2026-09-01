import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("web_search retries transient provider failures", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: "temporary" }, 500)
      : jsonResponse({ results: [{ title: "ok", url: "https://example.test", content: "snippet" }] });
  };
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1000 });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(calls, 2);
  assert.equal(result.data?.organic[0]?.title, "ok");
});

test("web_search turns request timeout into tool_timeout", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(
    tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any),
    { code: "tool_timeout" },
  );
});

test("web_search turns network timeout errors into tool_timeout", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    setTimeout(() => reject(init?.signal?.reason), 0);
  });
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-test", fetchImpl, timeoutMs: 1 });

  await assert.rejects(
    tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any),
    { code: "tool_timeout" },
  );
});

test("web_search supports Serper with its API key header and organic results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ organic: [{ title: "result", link: "https://example.test", snippet: "snippet" }] });
  };
  const tool = createWebSearchTool({ provider: "serper", apiKey: "serper-key", fetchImpl });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(request?.url, "https://google.serper.dev/search");
  assert.equal((request?.init?.headers as Record<string, string>)["X-API-KEY"], "serper-key");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { q: "hello", num: 8 });
  assert.equal(result.data?.organic[0]?.title, "result");
});

test("web_search supports Brave with its subscription token header and web results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ web: { results: [{ title: "result", url: "https://example.test", description: "snippet" }] } });
  };
  const tool = createWebSearchTool({ provider: "brave", apiKey: "brave-key", fetchImpl });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(request?.url, "https://api.search.brave.com/res/v1/web/search?q=hello&count=8");
  assert.equal((request?.init?.headers as Record<string, string>)["X-Subscription-Token"], "brave-key");
  assert.equal(request?.init?.method, "GET");
  assert.equal(result.data?.organic[0]?.title, "result");
});

test("web_search supports GLM with its bearer header and search_result payload", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ search_result: [{ title: "result", link: "https://example.test", content: "snippet" }] });
  };
  const tool = createWebSearchTool({ provider: "glm", apiKey: "glm-key", fetchImpl });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(request?.url, "https://api.z.ai/api/paas/v4/web_search");
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer glm-key");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    search_engine: "search-prime",
    search_query: "hello",
    count: 8,
    search_recency_filter: "noLimit",
  });
  assert.equal(result.data?.organic[0]?.title, "result");
});

test("web_search supports custom POST mappings", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ payload: [{ headline: "result", href: "https://example.test", text: "snippet" }] });
  };
  const tool = createWebSearchTool({
    provider: "custom",
    apiKey: "custom-key",
    endpoint: "https://example.test/search",
    customProvider: {
      method: "POST",
      auth: "bodyApiKey",
      queryParam: "q",
      apiKeyParam: "key",
      resultsPath: "payload",
      titleField: "headline",
      urlField: "href",
      snippetField: "text",
    },
    fetchImpl,
  });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(request?.url, "https://example.test/search");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { q: "hello", key: "custom-key" });
  assert.deepEqual(result.data?.organic[0], {
    title: "result",
    link: "https://example.test",
    snippet: "snippet",
    source: undefined,
    publishedAt: undefined,
  });
});

test("web_search supports custom GET query mappings", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ results: [{ title: "result", url: "https://example.test", content: "snippet" }] });
  };
  const tool = createWebSearchTool({
    provider: "custom",
    apiKey: "custom-key",
    endpoint: "https://example.test/search",
    customProvider: { method: "GET", auth: "queryApiKey", queryParam: "q", apiKeyParam: "token" },
    fetchImpl,
  });

  const result = await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);

  assert.equal(request?.url, "https://example.test/search?q=hello&token=custom-key");
  assert.equal(request?.init?.method, "GET");
  assert.equal(request?.init?.body, undefined);
  assert.equal(result.data?.organic[0]?.title, "result");
});

test("web_search selects the provider-specific environment key when provider is omitted", async () => {
  const cases: Array<{ provider: "serper" | "brave" | "custom"; env: Record<string, string>; url: string }> = [
    { provider: "serper", env: { SERPER_API_KEY: "serper-env" }, url: "https://google.serper.dev/search" },
    { provider: "brave", env: { BRAVE_API_KEY: "brave-env" }, url: "https://api.search.brave.com/res/v1/web/search?q=hello&count=8" },
    { provider: "custom", env: { CUSTOM_WEB_SEARCH_API_KEY: "custom-env" }, url: "https://example.test/search" },
  ];
  for (const item of cases) {
    let requestUrl = "";
    const tool = createWebSearchTool({
      endpoint: item.provider === "custom" ? "https://example.test/search" : undefined,
      fetchImpl: async (url) => {
        requestUrl = String(url);
        return item.provider === "brave"
          ? jsonResponse({ web: { results: [] } })
          : item.provider === "serper"
            ? jsonResponse({ organic: [] })
            : jsonResponse({ results: [] });
      },
    });
    await tool.execute({ query: "hello" }, { env: item.env, cwd: "/", projectRoot: "/", abortSignal: undefined } as any);
    assert.equal(requestUrl, item.url);
  }
});

test("web_search preserves Tavily precedence when multiple provider keys are set", async () => {
  let requestUrl = "";
  let requestBody = "";
  const tool = createWebSearchTool({
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body ?? "");
      return jsonResponse({ results: [] });
    },
  });

  await tool.execute(
    { query: "hello" },
    {
      env: {
        TAVILY_API_KEY: "tavily-env",
        GLM_WEB_SEARCH_API_KEY: "glm-env",
      },
      cwd: "/",
      projectRoot: "/",
      abortSignal: undefined,
    } as any,
  );

  assert.equal(requestUrl, "https://api.tavily.com/search");
  assert.equal(JSON.parse(requestBody).api_key, "tavily-env");
});

test("web_search rejects non-HTTP(S) endpoints", async () => {
  const tool = createWebSearchTool({ provider: "tavily", apiKey: "tvly-key", endpoint: "ftp://example.test/search", fetchImpl: async () => jsonResponse({ results: [] }) });

  await assert.rejects(
    tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as any),
    { code: "setup_required" },
  );
});
