import assert from "node:assert/strict";
import test from "node:test";
import { listSubagentModels } from "../../../src/agent/sub/subagentModels.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";
import type { ModelConfig, ModelDefinition } from "../../../src/model/index.js";
import type { RouterConfig } from "../../../src/router/config/schema.js";

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return { id: "text", displayName: "Text model",
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true },
    multimodal: { input: ["text"] }, ...overrides };
}

function config(): ModelConfig {
  return { providers: {
    gateway: { id: "gateway", protocol: "openai", url: "https://example.test", apiKey: "test-secret", headers: {},
      models: {
        "vendor/vision": model({ id: "vendor/vision", displayName: "Vision model", multimodal: { input: ["text", "image"] } }),
        text: model(),
        chat: model({ capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: false } }),
        nostream: model({ capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true, supportsStreaming: false } }),
      } },
    unconfigured: { id: "unconfigured", protocol: "openai", url: "https://example.test", apiKey: " ", headers: {}, models: { text: model() } },
  } };
}

test("catalog includes only configured models that can run streaming tool loops", () => {
  const candidates = listSubagentModels(config());
  assert.deepEqual(candidates.map(candidate => candidate.id), ["gateway/text", "gateway/vendor/vision"]);
  assert.match(candidates[1]!.description, /Vision model; input: text, image/);
  assert.deepEqual(candidates[1]!.modelMultimodal.input, ["text", "image"]);
  assert.equal(candidates[1]!.maxContextTokens, DEFAULT_MODEL_CAPABILITIES.maxContextTokens);
  assert.equal(candidates[1]!.maxOutputTokens, DEFAULT_MODEL_CAPABILITIES.maxOutputTokens);
  assert.ok(!JSON.stringify(candidates).includes("test-secret"));
});

test("catalog reuses configured tier descriptions and bounds each description", () => {
  const ref = { id: "gateway/vendor/vision", provider: "gateway", model: "vendor/vision" };
  const router: RouterConfig = { tokenSaver: {
    enabled: true, judge: ref, defaultTier: "visual", judgeTimeoutMs: 1000,
    tiers: {
      visual: { model: ref, description: "Detailed\nvisual review" },
      duplicate: { model: ref, description: "Detailed\nvisual review" },
      text: { model: { id: "gateway/text", provider: "gateway", model: "text" }, description: "x".repeat(500) },
    },
  } };
  const candidates = listSubagentModels(config(), router);
  assert.equal(candidates[1]!.description, "Detailed visual review; input: text, image");
  assert.equal(candidates[0]!.description, `${"x".repeat(160)}; input: text`);
});
