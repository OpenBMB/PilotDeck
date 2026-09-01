import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "../../src/router/config/parseRouterConfig.js";

const modelConfig = {
  providers: {
    openai: {
      protocol: "openai",
      url: "https://api.example.test/v1",
      apiKey: "test-key",
      models: { "gpt-test": {} },
    },
  },
} as any;

test("parses pricing unit without changing numeric pricing fields", () => {
  const result = parseRouterConfig({
    stats: {
      modelPricing: {
        "openai/gpt-test": {
          input: 1,
          output: 2,
          cacheRead: 0.5,
          unit: "¥/百万 Token",
        },
      },
    },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.stats?.modelPricing?.["openai/gpt-test"], {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    unit: "¥/百万 Token",
  });
});

test("parses baselineModel object references", () => {
  const result = parseRouterConfig({
    stats: { baselineModel: { provider: "openai", model: "gpt-test" } },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.stats?.baselineModel, {
    id: "openai/gpt-test",
    provider: "openai",
    model: "gpt-test",
  });
});

test("rejects invalid pricing unit and values", () => {
  const result = parseRouterConfig({
    stats: {
      modelPricing: {
        "openai/gpt-test": { input: -1, unit: "EUR/token" },
      },
    },
  }, modelConfig);

  assert.deepEqual(
    result.diagnostics.filter((item) => item.severity === "fatal").map((item) => item.code),
    ["ROUTER_STATS_PRICING_VALUE_INVALID", "ROUTER_STATS_PRICING_UNIT_INVALID"],
  );
});

test("allows a disabled token saver without child model settings", () => {
  const result = parseRouterConfig({
    tokenSaver: { enabled: false, judge: "missing/model", tiers: "invalid" },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.tokenSaver, { enabled: false });
});

test("skips auto-orchestrate tier validation when token saver is disabled", () => {
  const result = parseRouterConfig({
    tokenSaver: { enabled: false },
    autoOrchestrate: { triggerTiers: ["simple"] },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.autoOrchestrate?.triggerTiers, ["simple"]);
});
