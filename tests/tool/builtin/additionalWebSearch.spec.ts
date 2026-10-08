import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";
import { SERPAPI_ENGINES } from "../../../src/pilot/config/webSearchProviders.js";

const context = { env: {}, cwd: "/", projectRoot: "/" } as any;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
for (const [provider, response, requestBody, header] of [
  ["baidu", { references: [{ type: "image", title: "ignore" }, { type: "web", title: "百度", url: "https://example.test", content: "摘要", date: "2026-09-30" }] },
    { messages: [{ role: "user", content: "你好" }], search_source: "baidu_search_v2", resource_type_filter: [{ type: "web", top_k: 8 }] }, "Authorization"],
  ["bocha", { code: 200, data: { webPages: { value: [{ name: "博查", url: "https://example.test", snippet: "short", summary: "摘要", siteName: "Example", datePublished: "2026-09-30" }] } } },
    { query: "你好", count: 8, freshness: "noLimit", summary: true }, "Authorization"],
  ["exa", { results: [{ title: "Exa", url: "https://example.test", highlights: ["摘要", "second"], publishedDate: "2026-09-30" }] },
    { query: "你好", numResults: 8, type: "auto", contents: { highlights: true, text: false } }, "x-api-key"],
] as const) {
  test(`${provider} uses its documented auth/body and returns normalized citations`, async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get(header), provider === "exa" ? "key" : "Bearer key");
      assert.deepEqual(JSON.parse(String(init?.body)), requestBody);
      return json(response);
    };
    const result = await createWebSearchTool({ provider, apiKey: "key", fetchImpl }).execute({ query: " 你好 " }, context);
    assert.equal(result.data?.organic.length, 1);
    assert.equal(result.data?.organic[0]?.link, "https://example.test");
    assert.ok(result.data?.organic[0]?.snippet?.startsWith("摘要"));
    assert.equal(result.data?.organic[0]?.publishedAt, "2026-09-30");
  });
}
for (const engine of SERPAPI_ENGINES) {
  test(`SerpAPI ${engine} uses the correct query parameter and caps organic results`, async () => {
    const fetchImpl: typeof fetch = async (value, init) => {
      const url = new URL(String(value));
      assert.equal(url.origin, "https://serpapi.com");
      assert.equal(url.searchParams.get("engine"), engine);
      assert.equal(url.searchParams.get(engine === "yahoo" ? "p" : engine === "yandex" ? "text" : "q"), "中文 & search");
      assert.equal(url.searchParams.get("api_key"), "key+/?");
      assert.equal(url.searchParams.get("gl"), engine === "google" ? "cn" : null);
      assert.equal(init?.method, "GET");
      return json({ organic_results: [{ title: "first", link: "https://first.test", snippet: "text" }, { title: "second" }] });
    };
    const result = await createWebSearchTool({ provider: "serpapi", searchEngine: engine, apiKey: "key+/?", organicLimit: 1, fetchImpl }).execute({ query: "中文 & search", gl: "cn" }, context);
    assert.deepEqual(result.data?.organic, [{ title: "first", link: "https://first.test", snippet: "text", source: undefined, publishedAt: undefined }]);
    assert.equal(result.metadata?.engine, engine);
    assert.ok(!JSON.stringify(result).includes("key+/?"));
  });
}
test("new provider errors and query-authenticated network errors never expose API keys", async () => {
  for (const [provider, response] of [
    ["baidu", { code: "InvalidAuth", message: "bad key+/ with key%2B%2F" }],
    ["bocha", { code: 401, msg: "key+/ unauthorized" }],
    ["exa", { error: "key+/ invalid" }],
    ["serpapi", { error: "key+/ exhausted" }],
  ] as const) {
    await assert.rejects(createWebSearchTool({ provider, apiKey: "key+/", fetchImpl: async () => json(response) }).execute({ query: "test" }, context), error => {
      assert.equal((error as any).code, "tool_execution_failed");
      assert.ok(!String(error).includes("key+/")); assert.ok(!String(error).includes("key%2B%2F")); return true;
    });
  }
  await assert.rejects(createWebSearchTool({ provider: "serpapi", apiKey: "key+/", fetchImpl: async url => { throw new Error(`failed ${url}`); } }).execute({ query: "test" }, context), error => {
    assert.ok(!String(error).includes("key%2B%2F")); return true;
  });
});
test("new providers reject malformed success payloads and accept real empty results", async () => {
  for (const provider of ["baidu", "bocha", "exa", "serpapi"] as const) {
    await assert.rejects(createWebSearchTool({ provider, apiKey: "key", fetchImpl: async () => json({}) }).execute({ query: "test" }, context), /missing its result list/);
  }
  const result = await createWebSearchTool({ provider: "serpapi", apiKey: "key", fetchImpl: async () => json({ search_metadata: { status: "Success" } }) }).execute({ query: "test" }, context);
  assert.deepEqual(result.data?.organic, []);
});
test("new providers keep retry, timeout and caller cancellation behavior", async () => {
  let calls = 0;
  const tool = createWebSearchTool({ provider: "bocha", apiKey: "key", fetchImpl: async () => ++calls === 1 ? json({}, 503) : json({ code: 200, data: { webPages: { value: [] } } }) });
  await tool.execute({ query: "test" }, context); assert.equal(calls, 2);
  const hanging: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(createWebSearchTool({ provider: "exa", apiKey: "key", timeoutMs: 1, fetchImpl: hanging }).execute({ query: "test" }, context), { code: "tool_timeout" });
  const abort = new AbortController(); abort.abort(new Error("caller cancelled"));
  await assert.rejects(createWebSearchTool({ provider: "serpapi", apiKey: "key", fetchImpl: hanging }).execute({ query: "test" }, { ...context, abortSignal: abort.signal }), { code: "tool_execution_failed" });
});
test("new provider environment keys are isolated and preserve existing provider precedence", async () => {
  for (const [provider, name] of [["baidu", "BAIDU_WEB_SEARCH_API_KEY"], ["bocha", "BOCHA_API_KEY"], ["exa", "EXA_API_KEY"], ["serpapi", "SERPAPI_API_KEY"]] as const) {
    assert.equal((await createWebSearchTool({ provider }).checkAvailability?.({ ...context, env: { [name]: "key" } }))?.ok, true);
    assert.equal((await createWebSearchTool({ provider }).checkAvailability?.({ ...context, env: { TAVILY_API_KEY: "other" } }))?.ok, false);
  }
  const result = await createWebSearchTool({ fetchImpl: async (url) => { assert.equal(String(url), "https://api.tavily.com/search"); return json({ results: [] }); } }).execute({ query: "test" }, { ...context, env: { TAVILY_API_KEY: "old", SERPAPI_API_KEY: "new" } });
  assert.equal(result.metadata?.provider, "tavily");
});
