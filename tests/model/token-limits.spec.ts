import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";
import { normalizeProviderTokenLimits, parseModelListResponse, resolveTokenLimits, tokenLimitSettingsPatch } from "../../src/model/metadata/tokenLimits.js";
import { metadataEndpointScope, readProviderModelLimits, writeProviderModelLimits } from "../../src/model/metadata/store.js";
import { discoverProviderModels, discoverOllamaModel } from "../../src/model/metadata/discovery.js";

test("provider field map resolves each positive limit independently", () => {
  for (const [raw, expected] of [
    [{ context_window: 1048576, max_output_tokens: 393216 }, { maxContextTokens: 1048576, maxOutputTokens: 393216 }],
    [{ max_input_tokens: 200000, max_tokens: 64000 }, { maxContextTokens: 200000, maxOutputTokens: 64000 }],
    [{ inputTokenLimit: 1000000, outputTokenLimit: 65536 }, { maxContextTokens: 1000000, maxOutputTokens: 65536 }],
    [{ context_length: 1000000, top_provider: { max_completion_tokens: 32768 } }, { maxContextTokens: 1000000, maxOutputTokens: 32768 }],
    [{ context_length: 262144 }, { maxContextTokens: 262144 }],
    [{ model_info: { context_window: 1000000, max_output_tokens: 65536 } }, { maxContextTokens: 1000000, maxOutputTokens: 65536 }],
    [{ context_window: null, max_output_tokens: 0, context_length: 123 }, { maxContextTokens: 123 }],
    [{ max_input_tokens: -1, max_tokens: "123", outputTokenLimit: Infinity }, {}],
    [{ id: "model", created: 1 }, {}],
  ]) assert.deepEqual(normalizeProviderTokenLimits(raw), expected);
  assert.deepEqual(parseModelListResponse({ models: [{ name: "models/gemini", inputTokenLimit: 123 }, { id: "gemini", outputTokenLimit: 45 }, null] }), [{ id: "gemini", displayName: "gemini", maxContextTokens: 123, maxOutputTokens: 45 }]);
});

test("user > provider > catalog > protocol, independently, with legacy-pair recovery", () => {
  const catalog = { maxContextTokens: 1048576, maxOutputTokens: 393216 };
  const resolved = resolveTokenLimits({ protocol: "openai", catalog, provider: { maxContextTokens: 2000000 }, user: { maxOutputTokens: 1024 } });
  assert.deepEqual(resolved, { maxContextTokens: { value: 2000000, source: "provider" }, maxOutputTokens: { value: 1024, source: "user" } });
  const legacy = { maxContextTokens: 128000, maxOutputTokens: 32768 };
  assert.equal(resolveTokenLimits({ protocol: "openai", catalog, user: legacy }).maxContextTokens.source, "catalog");
  assert.equal(resolveTokenLimits({ protocol: "openai", catalog, user: legacy, explicit: { maxOutputTokens: true } }).maxOutputTokens.source, "user");
  assert.equal(resolveTokenLimits({ protocol: "openai", user: legacy }).maxContextTokens.value, 128000);
  assert.equal(resolveTokenLimits({ protocol: "openai", user: { maxContextTokens: 128000 }, catalog }).maxContextTokens.source, "user");
  assert.equal(resolveTokenLimits({ protocol: "openai" }).maxOutputTokens.source, "protocol");
});

test("settings save omits automatic limits and keeps explicit default pins and other capabilities", () => {
  const automatic = resolveTokenLimits({ protocol: "openai", provider: { maxContextTokens: 1048576, maxOutputTokens: 393216 } });
  assert.deepEqual(tokenLimitSettingsPatch({ capabilities: { supportsToolUse: false, maxContextTokens: 128000, maxOutputTokens: 32768 }, values: { maxContextTokens: 1048576, maxOutputTokens: 393216 }, automatic }), { capabilities: { supportsToolUse: false }, tokenLimitOverrides: {} });
  assert.deepEqual(tokenLimitSettingsPatch({ capabilities: {}, values: { maxContextTokens: 128000, maxOutputTokens: 32768 }, automatic }), { capabilities: { maxContextTokens: 128000, maxOutputTokens: 32768 }, tokenLimitOverrides: { maxContextTokens: true, maxOutputTokens: true } });
});

test("metadata persists across config reloads without polluting configuration, and is endpoint scoped", () => {
  const directory = mkdtempSync(join(tmpdir(), "pilot-limits-")), env = { PILOT_HOME: directory };
  try {
    const scope = { providerId: "deepseek", protocol: "openai" as const, baseUrl: "https://api.deepseek.com/models" };
    const raw = { providers: { deepseek: { apiKey: "dummy", models: { "deepseek-flash": {}, "deepseek-chat": { capabilities: { maxContextTokens: 128000, maxOutputTokens: 32768 } } } } } };
    const before = JSON.stringify(raw);
    writeProviderModelLimits(scope, [{ id: "deepseek-flash", displayName: "Flash", maxContextTokens: 1048576, maxOutputTokens: 393216 }], env);
    const parsed = parseModelConfig(raw, { env });
    for (const id of ["deepseek-flash", "deepseek-chat"]) {
      assert.equal(parsed.providers.deepseek.models[id].capabilities.maxContextTokens, 1048576);
      assert.equal(parsed.providers.deepseek.models[id].capabilities.maxOutputTokens, 393216);
    }
    assert.equal(JSON.stringify(raw), before);
    assert.deepEqual(readProviderModelLimits({ ...scope, baseUrl: "https://proxy.example/v1" }, env), {});
    assert.equal(metadataEndpointScope(scope.baseUrl), metadataEndpointScope("https://api.deepseek.com/v1"));
    assert.equal(parseModelConfig(raw, { env }).providers.deepseek.models["deepseek-flash"].capabilities.maxOutputTokens, 393216);
    const file = join(directory, "cache", "provider-model-limits.json");
    assert.ok(!readFileSync(file, "utf8").includes("dummy"));
    writeFileSync(file, "broken");
    assert.deepEqual(readProviderModelLimits(scope, env), {});
    assert.equal(parseModelConfig(raw, { env }).providers.deepseek.models["deepseek-chat"].capabilities.maxContextTokens, 1048576);
    const pinned = { providers: { deepseek: { apiKey: "dummy", models: { "deepseek-chat": { capabilities: { maxContextTokens: 128000, maxOutputTokens: 32768 }, tokenLimitOverrides: { maxContextTokens: true, maxOutputTokens: true } } } } } };
    assert.equal(parseModelConfig(pinned, { env }).providers.deepseek.models["deepseek-chat"].capabilities.maxContextTokens, 128000);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

test("Anthropic and Gemini pagination collects later metadata, without adding input and output", async () => {
  for (const protocol of ["anthropic", "google"] as const) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return reply(protocol === "google"
        ? calls.length === 1 ? { models: [{ name: "models/one" }], nextPageToken: "next" } : { models: [{ name: "models/two", inputTokenLimit: 200000, outputTokenLimit: 64000 }] }
        : calls.length === 1 ? { data: [{ id: "one" }], has_more: true, last_id: "one" } : { data: [{ id: "two", max_input_tokens: 200000, max_tokens: 64000 }], has_more: false });
    }) as typeof fetch;
    const models = await discoverProviderModels({ protocol, baseUrl: "https://example.test", fetchImpl });
    assert.equal(models.length, 2);
    assert.equal(models[1].maxContextTokens, 200000);
    assert.equal(models[1].maxOutputTokens, 64000);
    assert.ok(calls[1].includes(protocol === "google" ? "pageToken=next" : "after_id=one"));
  }
});

test("repeated pagination cursors fail instead of caching a partial list", async () => {
  await assert.rejects(discoverProviderModels({ protocol: "google", baseUrl: "https://example.test", fetchImpl: (async () => reply({ models: [{ name: "models/one" }], nextPageToken: "same" })) as typeof fetch }), /pagination did not finish/);
});

test("DashScope enriches only its official endpoint; a proxy receives no extra official lookup", async () => {
  for (const host of ["dashscope.aliyuncs.com", "proxy.example"]) {
    const calls: string[] = [];
    const models = await discoverProviderModels({ protocol: "openai", baseUrl: `https://${host}/compatible-mode/v1`, fetchImpl: (async url => {
      calls.push(String(url));
      return reply({ data: [{ id: "qwen", ...(String(url).includes("/api/v1/models") ? { model_info: { context_window: 1000000, max_output_tokens: 65536 } } : {}) }] });
    }) as typeof fetch });
    assert.equal(calls.length, host === "proxy.example" ? 1 : 2);
    assert.equal(models[0].maxContextTokens, host === "proxy.example" ? undefined : 1000000);
  }
});

test("Ollama show is on demand and num_ctx wins over architecture context, without inventing output", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url, init) => {
    calls.push(String(url));
    if (init?.method === "GET") return reply({ data: [{ id: "local" }] });
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "local" });
    return reply({ parameters: "temperature 0.7\nnum_ctx 8192\n", model_info: { "general.architecture": "llama", "llama.context_length": 131072 } });
  }) as typeof fetch;
  await discoverProviderModels({ protocol: "openai", providerId: "ollama", baseUrl: "http://localhost:11434/v1", fetchImpl });
  assert.equal(calls.length, 1);
  assert.deepEqual(await discoverOllamaModel({ protocol: "openai", baseUrl: "http://localhost:11434/v1", fetchImpl }, "local"), { id: "local", displayName: "local", maxContextTokens: 8192 });
  assert.equal(calls[1], "http://localhost:11434/api/show");
});
