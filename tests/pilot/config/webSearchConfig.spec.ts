import assert from "node:assert/strict";
import test from "node:test";
import { getWebSearchProviderConfig, migrateWebSearchProviderConfigs, resolveWebSearchConfig } from "../../../src/pilot/config/webSearchConfig.js";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";

test("legacy keys belong only to their original provider and migration is idempotent", () => {
  const old = { enabled: false, provider: "tavily" as const, apiKey: "legacy-key" };
  assert.deepEqual(getWebSearchProviderConfig(old, "glm"), {});
  assert.deepEqual(resolveWebSearchConfig(old), old);
  const migrated = migrateWebSearchProviderConfigs(old);
  assert.deepEqual(migrated, { enabled: false, provider: "tavily", providers: { tavily: { apiKey: "legacy-key" } } });
  assert.deepEqual(migrateWebSearchProviderConfigs(migrated), migrated);
  assert.deepEqual(resolveWebSearchConfig({ ...migrated, provider: "glm" }), { enabled: false, provider: "glm" });
});

test("saved provider entries take precedence over legacy flat fields", () => {
  const config = { provider: "glm" as const, apiKey: "stale", providers: { glm: { apiKey: "saved" } } };
  assert.equal(resolveWebSearchConfig(config).apiKey, "saved");
  assert.equal(migrateWebSearchProviderConfigs(config).providers?.glm?.apiKey, "saved");
  assert.equal(resolveWebSearchConfig({ ...config, providers: { glm: {} } }).apiKey, undefined);
  assert.deepEqual(resolveWebSearchConfig({}), {});
});

test("actual search requests use only the selected provider's saved key", async () => {
  const providers = { glm: { apiKey: "glm-saved" }, tavily: { apiKey: "tavily-saved" } };
  for (const provider of ["glm", "tavily", "glm"] as const) {
    let captured: RequestInit | undefined;
    const tool = createWebSearchTool({
      ...resolveWebSearchConfig({ provider, providers }),
      fetchImpl: async (_url, init) => {
        captured = init;
        return new Response(JSON.stringify(provider === "glm" ? { search_result: [] } : { results: [] }));
      },
    });
    await tool.execute({ query: "hello" }, { env: {}, cwd: "/", projectRoot: "/" } as any);
    if (provider === "glm") {
      assert.equal((captured?.headers as Record<string, string>).Authorization, "Bearer glm-saved");
    } else {
      assert.equal(JSON.parse(String(captured?.body)).api_key, "tavily-saved");
    }
  }
});
