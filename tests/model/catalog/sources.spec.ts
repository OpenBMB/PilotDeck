import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";
import { PROVIDER_CATALOG } from "../../../src/model/catalog/providers.js";
import {
  CATALOG_SOURCES,
  mergeCatalog,
  normalizeCatalogSource,
  type CatalogOverlay,
} from "../../../src/model/catalog/sources.js";
import type { CatalogModelEntry, ProviderCatalog } from "../../../src/model/catalog/types.js";
import { modelsDevFixture, openRouterFixture } from "./fixtures.js";

function fixtureModel(displayName: string, maxOutputTokens = 16_384): CatalogModelEntry {
  return {
    displayName,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, maxOutputTokens },
    multimodal: { input: ["text"] },
    status: "active",
  };
}

test("models.dev normalization keeps complete tool-capable metadata", () => {
  const overlay = normalizeCatalogSource("modelsDev", modelsDevFixture(), PROVIDER_CATALOG);

  for (const providerId of ["anthropic", "openai", "openai-responses", "google", "dashscope", "deepseek", "minimax", "moonshot", "volc_ark", "zhipu"]) {
    assert.ok(overlay[providerId], providerId);
  }
  const model = overlay.openai?.["fixture-openai"];
  assert.ok(model);
  assert.equal(model.displayName, "Fixture openai");
  assert.equal(model.source, CATALOG_SOURCES.modelsDev);
  assert.equal(model.status, "active");
  assert.equal(model.capabilities.maxContextTokens, 200_000);
  assert.equal(model.capabilities.maxOutputTokens, 16_384);
  assert.deepEqual(model.multimodal.input, ["text", "image"]);
  assert.deepEqual(model.thinking?.efforts, ["low", "high"]);
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: undefined });
});

test("OpenRouter normalization retains batch chat models and filters non-tool entries", () => {
  const overlay = normalizeCatalogSource("openrouter", openRouterFixture(), PROVIDER_CATALOG);
  const models = overlay.openrouter ?? {};

  assert.deepEqual(Object.keys(models), ["vendor/fixture:batch"]);
  assert.equal(models["vendor/fixture:batch"]?.protocol, "openai");
  assert.equal(models["vendor/fixture:batch"]?.capabilities.supportsJsonSchema, true);
  assert.deepEqual(models["vendor/fixture:batch"]?.multimodal.input, ["text", "image"]);
  assert.deepEqual(models["vendor/fixture:batch"]?.cost, { input: 1, output: 2 });
});

test("catalog overlays preserve saved models while refreshing current entries", () => {
  const baseline: ProviderCatalog = {
    test: {
      displayName: "Test",
      protocol: "openai",
      defaultUrl: "https://example.test/v1",
      models: {
        removed: fixtureModel("Removed"),
        refreshed: fixtureModel("Old name", 1_024),
      },
    },
  };
  const overlay: CatalogOverlay = {
    test: {
      refreshed: fixtureModel("New name", 8_192),
      added: fixtureModel("Added"),
    },
  };

  const merged = mergeCatalog(baseline, overlay);

  assert.equal(merged.test.displayName, "Test");
  assert.equal(merged.test.models.removed?.status, "legacy");
  assert.equal(merged.test.models.refreshed?.displayName, "New name");
  assert.equal(merged.test.models.refreshed?.capabilities.maxOutputTokens, 8_192);
  assert.equal(merged.test.models.added?.status, "active");
});
