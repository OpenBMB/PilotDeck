import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../../src/tool/builtin/webSearch.js";
import { filterAvailableTools } from "../../src/tool/registry/filterAvailableTools.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

async function availabilityForWebSearch(options: Parameters<typeof createWebSearchTool>[0], env: NodeJS.ProcessEnv = {}) {
  const registry = new ToolRegistry();
  registry.register(createWebSearchTool(options));
  return filterAvailableTools(registry, { cwd: process.cwd(), env });
}

test("web_search is unavailable when no API key is configured", async () => {
  const result = await availabilityForWebSearch({}, {});

  assert.equal(result.registry.has("web_search"), false);
  assert.deepEqual(result.unavailable, [
    { toolName: "web_search", code: "setup_required", reason: "web_search requires an API key." },
  ]);
});

test("web_search is available with GLM, ZAI, Tavily, or explicit API keys", async () => {
  const cases: Array<[string, Parameters<typeof createWebSearchTool>[0], NodeJS.ProcessEnv]> = [
    ["GLM env", {}, { GLM_WEB_SEARCH_API_KEY: "glm-key" }],
    ["ZAI env", {}, { ZAI_API_KEY: "zai-key" }],
    ["Tavily env", { provider: "tavily" }, { TAVILY_API_KEY: "tavily-key" }],
    ["explicit key", { apiKey: "explicit-key" }, {}],
  ];

  for (const [name, options, env] of cases) {
    const result = await availabilityForWebSearch(options, env);
    assert.equal(result.registry.has("web_search"), true, name);
    assert.deepEqual(result.unavailable, [], name);
  }
});

test("custom web_search auth none requires only an endpoint", async () => {
  const available = await availabilityForWebSearch({
    provider: "custom",
    endpoint: "https://search.example.test",
    customProvider: { auth: "none" },
  }, {});
  assert.equal(available.registry.has("web_search"), true);
  assert.deepEqual(available.unavailable, []);

  const unavailable = await availabilityForWebSearch({
    provider: "custom",
    customProvider: { auth: "none" },
  }, {});
  assert.equal(unavailable.registry.has("web_search"), false);
  assert.deepEqual(unavailable.unavailable, [
    {
      toolName: "web_search",
      code: "setup_required",
      reason: "web_search custom provider requires an endpoint URL.",
    },
  ]);
});
