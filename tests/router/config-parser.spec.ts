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

test("enables bounded context-aware judging by default", () => {
  const result = parseRouterConfig({
    tokenSaver: {
      judge: "openai/gpt-test",
      defaultTier: "medium",
      tiers: { medium: { model: "openai/gpt-test" } },
    },
  }, modelConfig);

  assert.deepEqual(result.config?.tokenSaver?.contextAware, {
    enabled: true,
    continuationGate: true,
    confidenceThreshold: 0.7,
    maxCurrentMessageChars: 2_000,
    maxPreviousTaskChars: 800,
    maxAssistantTailChars: 400,
  });
});

test("parses context-aware judge controls and rejects unsafe limits", () => {
  const valid = parseRouterConfig({
    tokenSaver: {
      judge: "openai/gpt-test",
      defaultTier: "medium",
      tiers: { medium: { model: "openai/gpt-test" } },
      contextAware: {
        enabled: true,
        continuationGate: false,
        confidenceThreshold: 0.82,
        maxCurrentMessageChars: 1500,
        maxPreviousTaskChars: 600,
        maxAssistantTailChars: 240,
      },
    },
  }, modelConfig);
  assert.equal(valid.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.equal(valid.config?.tokenSaver?.contextAware?.confidenceThreshold, 0.82);
  assert.equal(valid.config?.tokenSaver?.contextAware?.continuationGate, false);

  const invalid = parseRouterConfig({
    tokenSaver: {
      judge: "openai/gpt-test",
      defaultTier: "medium",
      tiers: { medium: { model: "openai/gpt-test" } },
      contextAware: {
        confidenceThreshold: 1.2,
        maxPreviousTaskChars: 0,
      },
    },
  }, modelConfig);
  assert.deepEqual(
    invalid.diagnostics.filter((item) => item.severity === "fatal").map((item) => item.code),
    [
      "ROUTER_TOKEN_SAVER_CONTEXT_CONFIDENCE_INVALID",
      "ROUTER_TOKEN_SAVER_CONTEXT_LIMIT_INVALID",
    ],
  );
});

test("parses opt-in HALO recovery budgets and bounded health options", () => {
  const result = parseRouterConfig({
    recovery: {
      enabled: true,
      maxAttempts: 4,
      deadlineMs: 12_000,
      health: { capacity: 32, recordTtlMs: 60_000, openThreshold: 2 },
    },
  }, modelConfig);

  assert.equal(result.diagnostics.filter((item) => item.severity === "fatal").length, 0);
  assert.deepEqual(result.config?.recovery, {
    enabled: true,
    maxAttempts: 4,
    deadlineMs: 12_000,
    health: { capacity: 32, recordTtlMs: 60_000, openThreshold: 2 },
  });
});

test("keeps HALO disabled by default and rejects non-positive budgets", () => {
  assert.equal(parseRouterConfig({}, modelConfig).config?.recovery?.enabled, false);
  const invalid = parseRouterConfig({ recovery: { enabled: true, maxAttempts: 0, deadlineMs: -1 } }, modelConfig);
  assert.deepEqual(
    invalid.diagnostics.filter((item) => item.severity === "fatal").map((item) => item.code),
    ["ROUTER_RECOVERY_MAXATTEMPTS_INVALID", "ROUTER_RECOVERY_DEADLINEMS_INVALID"],
  );
});
