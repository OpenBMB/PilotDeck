import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { createModelRuntime } from "../../../src/model/ModelRuntime.js";
import { PROVIDER_CATALOG } from "../../../src/model/catalog/providers.js";
import type { CanonicalModelRequest, ModelProtocol } from "../../../src/model/protocol/canonical.js";
import { CATALOG_PROVIDERS, filterMiniMaxModelChoices, preserveMiniMaxSelection } from "../../../ui/src/shared/catalogProviders.js";
import { lookupModelPricing } from "../../../src/router/utils/modelPricing.js";

const flash = "MiniMax-M3.1-Flash";
const models = [flash, "MiniMax-M3"];
const modes = ["low", "medium", "high", "xhigh", "max"] as const;

function setup(model = flash, protocol: ModelProtocol = "openai", url?: string) {
  return parseModelConfig({ providers: { minimax: {
    protocol, url, apiKey: "offline-test-placeholder", models: { [model]: {} },
    retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
  } } }, { env: {} });
}

async function capture(model = flash, protocol: ModelProtocol = "openai", thinking?: CanonicalModelRequest["thinking"], url?: string, stream = false) {
  let body: Record<string, any> | undefined;
  let endpoint = "";
  const runtime = createModelRuntime(setup(model, protocol, url), { fetch: async (input, init) => {
    endpoint = String(input);
    body = JSON.parse(String(init?.body));
    if (stream) return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    const response = protocol === "anthropic"
      ? { id: "test", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : protocol === "openai-responses"
        ? { id: "test", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: "test", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return Response.json(response);
  } });
  const request: CanonicalModelRequest = {
    provider: "minimax", model, thinking,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  };
  if (stream) {
    for await (const event of runtime.stream(request)) assert.notEqual(event.type, "error");
  } else {
    await runtime.complete(request);
  }
  assert.ok(body, "must reach the real serialized HTTP boundary");
  assert.equal(body.model, model);
  assert.equal(body.service_tier, undefined);
  assert.equal(body.reasoning_split, undefined);
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.thinking_budget, undefined);
  return { body, endpoint };
}

test("MiniMax catalogs list Flash first and M3 second", () => {
  assert.deepEqual(Object.keys(PROVIDER_CATALOG.minimax.models), models);
  assert.deepEqual(CATALOG_PROVIDERS.find((provider) => provider.id === "minimax")?.models.map((model) => model.id), models);
  const capabilities = setup().providers.minimax.models[flash].capabilities;
  assert.equal(capabilities.maxContextTokens, 1_000_000);
  assert.equal(capabilities.maxOutputTokens, 524_288);
});

test("MiniMax Flash UI thinking availability", async () => {
  const { getThinkingModeAvailability } = await import("../../../ui/src/components/chat/constants/thinkingModeAvailability.js");
  const availability = getThinkingModeAvailability({ modelId: flash, protocol: "anthropic" });
  assert.ok(availability.off);
  assert.ok(availability.minimal);
  for (const mode of ["default", ...modes] as const) assert.equal(availability[mode], null);
});

for (const url of [undefined, "https://api.minimaxi.com/v1"]) {
  test(`MiniMax default and saved regional chat transport: ${url ?? "global"}`, async () => {
    for (const mode of modes) {
      const { body } = await capture(flash, "openai", { mode, enabled: true }, url);
      assert.equal(body.reasoning_effort, mode);
      assert.deepEqual(body.thinking, { type: "adaptive" });
    }
    for (const model of models) {
      for (const stream of [false, true]) {
        const { body, endpoint } = await capture(model, "openai", undefined, url, stream);
        assert.equal(endpoint, `${url ?? "https://api.minimax.io/v1"}/chat/completions`);
        assert.equal(body.stream, stream);
        assert.equal(body.thinking, undefined);
        assert.equal(body.reasoning_effort, undefined);
      }
    }
  });
}

for (const protocol of ["openai", "anthropic", "openai-responses"] as const) {
  test(`MiniMax Flash effort at ${protocol} HTTP boundary`, async () => {
    const url = protocol === "anthropic" ? "https://api.minimax.io/anthropic" : undefined;
    const { body: defaultBody } = await capture(flash, protocol, undefined, url);
    assert.equal(defaultBody.thinking, undefined);
    assert.equal(defaultBody.output_config, undefined);
    assert.equal(defaultBody.reasoning, undefined);
    for (const mode of modes) {
      const { body } = await capture(flash, protocol, { mode, enabled: true }, url);
      if (protocol === "openai") {
        assert.deepEqual(body.thinking, { type: "adaptive" });
        assert.equal(body.reasoning_effort, mode);
      } else if (protocol === "anthropic") {
        assert.deepEqual(body.thinking, { type: "adaptive" });
        assert.deepEqual(body.output_config, { effort: mode });
      } else {
        assert.deepEqual(body.reasoning, { effort: mode });
      }
    }
    for (const mode of ["off", "minimal"] as const) {
      await assert.rejects(capture(flash, protocol, { mode, enabled: true }, url), /MiniMax M3.1 Flash supports/);
    }
    const { body: legacyEnabled } = await capture(flash, protocol, { enabled: true, budgetTokens: 8192 }, url);
    assert.equal(legacyEnabled.thinking?.budget_tokens, undefined);
  });

  test(`MiniMax M3 on/off at ${protocol} HTTP boundary`, async () => {
    for (const mode of ["off", "high"] as const) {
      const { body } = await capture("MiniMax-M3", protocol, { mode, enabled: true });
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.output_config, undefined);
      if (protocol === "openai") assert.deepEqual(body.thinking, { type: mode === "off" ? "disabled" : "adaptive" });
      if (protocol === "anthropic") assert.deepEqual(body.thinking, mode === "off" ? undefined : { type: "adaptive" });
      if (protocol === "openai-responses") assert.deepEqual(body.reasoning, { effort: mode === "off" ? "none" : "high" });
    }
  });
}

test("saved legacy and custom models keep their IDs and endpoints", async () => {
  for (const model of ["MiniMax-M2.7", "MiniMax-M2.5", "my-custom-model"]) {
    const { body, endpoint } = await capture(model, "openai", undefined, "https://custom.example/v1");
    assert.equal(body.model, model);
    assert.equal(endpoint, "https://custom.example/v1/chat/completions");
  }
});

test("MiniMax chat preserves image, tool, and reasoning history at HTTP boundary", async () => {
  let captured: Record<string, any> | undefined;
  const runtime = createModelRuntime(setup(), { fetch: async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  } });
  await runtime.complete({ provider: "minimax", model: flash, messages: [
    { role: "user", content: [{ type: "image", source: "url", data: "https://example.com/image.png", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "thinking", text: "stored reasoning" }, { type: "tool_call", id: "call_1", name: "lookup", input: { id: 1 } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", content: [{ type: "text", text: "saved result" }] }] },
  ] });
  assert.ok(captured);
  assert.equal(captured.messages[0].content[0].image_url.url, "https://example.com/image.png");
  assert.equal(captured.messages[1].reasoning_content, "stored reasoning");
  assert.equal(captured.messages[1].tool_calls[0].id, "call_1");
  assert.equal(captured.messages[2].tool_call_id, "call_1");
  assert.equal(captured.messages[2].content, "saved result");
});

test("remote MiniMax suggestions filter legacy text while preserving media and custom selections", () => {
  const entries = ["other", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-Text-01", "MiniMax-VL-01", flash, "speech-02-hd"].map((id) => ({ id }));
  assert.deepEqual(filterMiniMaxModelChoices(entries, "minimax").map((model) => model.id), ["other", flash, "MiniMax-M3", "speech-02-hd"]);
  assert.equal(filterMiniMaxModelChoices(entries, "custom"), entries);
  const gateway = ["unrelated", "minimax/minimax-m3", "minimax/minimax-01", "minimax/minimax-m2.7", "minimax/minimax-m3.1-flash", "minimax/minimax-m3.1-flash:free"].map((id) => ({ id }));
  assert.deepEqual(filterMiniMaxModelChoices(gateway, "openrouter").map((model) => model.id), ["unrelated", "minimax/minimax-m3.1-flash:free", "minimax/minimax-m3"]);
  assert.equal(preserveMiniMaxSelection("MiniMax-M2.7", "minimax"), true);
  assert.equal(preserveMiniMaxSelection("my-saved-model", "minimax"), true);
  assert.equal(preserveMiniMaxSelection("minimax/minimax-m2.7", "openrouter"), true);
  assert.equal(preserveMiniMaxSelection("unrelated", "openrouter"), false);
});

test("MiniMax Flash pricing is exact and user overrides retain precedence", () => {
  assert.deepEqual(lookupModelPricing("minimax", flash), { input: 0.15, output: 0.60, cacheRead: 0.015 });
  assert.deepEqual(lookupModelPricing("minimax", flash, { [`minimax/${flash}`]: { input: 7 } }), { input: 7 });
  assert.notDeepEqual(lookupModelPricing("gateway", `minimax/${flash}:free`), lookupModelPricing("minimax", flash));
});
