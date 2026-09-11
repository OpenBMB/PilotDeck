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

test("preserves human-readable task tier labels", () => {
  const result = parseRouterConfig({
    tokenSaver: {
      judge: "openai/gpt-test",
      defaultTier: "custom",
      tiers: {
        custom: {
          model: "openai/gpt-test",
          label: "资料整理",
          description: "Organize source material into a concise summary",
        },
      },
    },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.equal(result.config?.tokenSaver?.tiers.custom?.label, "资料整理");
});

test("skips auto-orchestrate tier validation when token saver is disabled", () => {
  const result = parseRouterConfig({
    tokenSaver: { enabled: false },
    autoOrchestrate: { triggerTiers: ["simple"] },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.autoOrchestrate?.triggerTiers, ["simple"]);
});

const tokenSaverBase = {
  judge: "openai/gpt-test",
  defaultTier: "simple",
  tiers: {
    simple: { model: "openai/gpt-test" },
  },
};

test("cacheAwareSwitching defaults to upgradePolicy guard when not configured", () => {
  const result = parseRouterConfig({ tokenSaver: tokenSaverBase }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.tokenSaver?.cacheAwareSwitching, {
    enabled: true,
    minSavingsRatio: 0,
    upgradePolicy: "guard",
  });
});

test("cacheAwareSwitching legacy-only config defaults upgradePolicy to guard", () => {
  const result = parseRouterConfig({
    tokenSaver: {
      ...tokenSaverBase,
      cacheAwareSwitching: { enabled: false, minSavingsRatio: 0.5 },
    },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.tokenSaver?.cacheAwareSwitching, {
    enabled: false,
    minSavingsRatio: 0.5,
    upgradePolicy: "guard",
  });
});

for (const upgradePolicy of ["guard", "amortized", "exempt"] as const) {
  test(`cacheAwareSwitching accepts upgradePolicy ${upgradePolicy}`, () => {
    const result = parseRouterConfig({
      tokenSaver: {
        ...tokenSaverBase,
        cacheAwareSwitching: { upgradePolicy },
      },
    }, modelConfig);

    assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
    assert.equal(result.config?.tokenSaver?.cacheAwareSwitching?.upgradePolicy, upgradePolicy);
  });
}

for (const upgradePolicy of [123, "unknown-policy"] as const) {
  test(`cacheAwareSwitching rejects invalid upgradePolicy ${String(upgradePolicy)}`, () => {
    const result = parseRouterConfig({
      tokenSaver: {
        ...tokenSaverBase,
        cacheAwareSwitching: { upgradePolicy },
      },
    }, modelConfig);

    assert.deepEqual(
      result.diagnostics.filter((item) => item.severity === "fatal").map((item) => ({
        code: item.code,
        path: item.path,
      })),
      [{
        code: "ROUTER_TOKEN_SAVER_CACHE_AWARE_SWITCHING_UPGRADE_POLICY_INVALID",
        path: "router.tokenSaver.cacheAwareSwitching.upgradePolicy",
      }],
    );
    assert.equal(result.config?.tokenSaver?.cacheAwareSwitching?.upgradePolicy, "guard");
  });
}

test("ignores cacheAwareSwitching child fields when token saver is disabled", () => {
  const result = parseRouterConfig({
    tokenSaver: {
      enabled: false,
      cacheAwareSwitching: { upgradePolicy: "not-a-policy" },
    },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.tokenSaver, { enabled: false });
});
