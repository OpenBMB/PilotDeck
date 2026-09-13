import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";
import {
  DELIVERY_FIELD_LIMITS,
  DELIVERY_PROMPT_MAX_BYTES,
  parseDeliveryConfig,
} from "../../../src/pilot/config/parseDeliveryConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

type ModelConfigStub = {
  providers: Record<string, { models: Record<string, unknown> }>;
};

const MODEL_CONFIG: ModelConfigStub = {
  providers: {
    custom: { models: { "model-a": {}, "model-b": {} } },
  },
};

function resolveReviewerModel(value: unknown, path: string) {
  if (typeof value !== "string" || !value.includes("/")) {
    throw new PilotConfigError("CONFIG_AGENT_MODEL_INVALID", `${path} must use provider/model format.`);
  }
  const [provider, model] = value.split("/", 2);
  if (!MODEL_CONFIG.providers[provider] || !MODEL_CONFIG.providers[provider].models[model]) {
    throw new PilotConfigError(
      "CONFIG_AGENT_MODEL_NOT_FOUND",
      `${path} references unknown model ${model} for provider ${provider}.`,
    );
  }
  return { id: value, provider, model };
}

function parse(raw: unknown): {
  result: ReturnType<typeof parseDeliveryConfig>;
  diagnostics: PilotConfigDiagnostic[];
} {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseDeliveryConfig(raw, resolveReviewerModel, diagnostics);
  return { result, diagnostics };
}

test("parseDeliveryConfig returns undefined when the section is omitted or null", () => {
  assert.equal(parse(undefined).result, undefined);
  assert.equal(parse(null).result, undefined);
  assert.deepEqual(parse({}).diagnostics, []);
});

test("parseDeliveryConfig keeps only supplied fields and defaults stay omitted", () => {
  const { result } = parse({ mode: "off" });
  assert.deepEqual(result, { mode: "off" });

  const { result: full } = parse({
    mode: "auto",
    prompt: "custom guidance",
    maxRepairs: 3,
    maxTurns: 40,
    reviewerModel: "custom/model-a",
    reviewTimeoutMs: 30000,
    maxReviewInputTokens: 8192,
    maxReviewOutputTokens: 1024,
  });
  assert.deepEqual(full, {
    mode: "auto",
    prompt: "custom guidance",
    maxRepairs: 3,
    maxTurns: 40,
    reviewerModel: { id: "custom/model-a", provider: "custom", model: "model-a" },
    reviewTimeoutMs: 30000,
    maxReviewInputTokens: 8192,
    maxReviewOutputTokens: 1024,
  });
});

test("parseDeliveryConfig accepts boundary values for every bounded field", () => {
  const raw: Record<string, number> = {};
  for (const [field, limit] of Object.entries(DELIVERY_FIELD_LIMITS)) {
    raw[field] = limit.min;
  }
  const { result: minima, diagnostics: minDiags } = parse(raw);
  assert.equal(minDiags.length, 0);
  for (const [field, limit] of Object.entries(DELIVERY_FIELD_LIMITS)) {
    assert.equal((minima as Record<string, number>)[field], limit.min);
    const { result: maxima, diagnostics } = parse({ [field]: limit.max });
    assert.equal((maxima as Record<string, number>)[field], limit.max);
    assert.equal(diagnostics.length, 0);
    const { diagnostics: lowDiags } = parse({ [field]: limit.min - 1 });
    assert.ok(lowDiags.some((d) => d.severity === "fatal" && d.path === `agent.delivery.${field}`));
    const { diagnostics: highDiags } = parse({ [field]: limit.max + 1 });
    assert.ok(highDiags.some((d) => d.severity === "fatal" && d.path === `agent.delivery.${field}`));
    const { diagnostics: fractionDiags } = parse({ [field]: limit.min + 0.5 });
    assert.ok(fractionDiags.some((d) => d.severity === "fatal" && d.path === `agent.delivery.${field}`));
  }
});

test("parseDeliveryConfig rejects invalid mode values", () => {
  const { diagnostics } = parse({ mode: "strict" });
  assert.ok(diagnostics.some((d) => d.severity === "fatal" && d.code === "CONFIG_AGENT_DELIVERY_MODE_INVALID"));
});

test("parseDeliveryConfig preserves a blank prompt and rejects oversized ones", () => {
  const { result } = parse({ prompt: "" });
  assert.deepEqual(result, { prompt: "" });

  const whitespace = parse({ prompt: "   \n  " });
  assert.deepEqual(whitespace.result, { prompt: "   \n  " });

  const exact = "a".repeat(DELIVERY_PROMPT_MAX_BYTES);
  assert.equal(new TextEncoder().encode(exact).length, DELIVERY_PROMPT_MAX_BYTES);
  assert.equal(parse({ prompt: exact }).diagnostics.length, 0);

  // 10923 CJK characters encode to 32769 UTF-8 bytes (3 bytes each).
  const oversized = "佩".repeat(10923);
  assert.equal(new TextEncoder().encode(oversized).length, DELIVERY_PROMPT_MAX_BYTES + 1);
  const { diagnostics } = parse({ prompt: oversized });
  assert.ok(diagnostics.some((d) => d.severity === "fatal" && d.code === "CONFIG_AGENT_DELIVERY_PROMPT_TOO_LONG"));
});

test("parseDeliveryConfig rejects non-string prompt and non-string mode", () => {
  assert.ok(parse({ prompt: 42 }).diagnostics.some((d) => d.severity === "fatal"));
  assert.ok(parse({ mode: true }).diagnostics.some((d) => d.severity === "fatal"));
  assert.ok(parse({ maxRepairs: "2" }).diagnostics.some((d) => d.severity === "fatal"));
});

test("parseDeliveryConfig resolves reviewerModel with id and rejects unknown references", () => {
  const { result } = parse({ reviewerModel: "custom/model-b" });
  assert.deepEqual(result, { reviewerModel: { id: "custom/model-b", provider: "custom", model: "model-b" } });

  assert.throws(() => parse({ reviewerModel: "custom/missing" }), (error: unknown) => {
    return error instanceof PilotConfigError
      && error.code === "CONFIG_AGENT_MODEL_NOT_FOUND";
  });
  assert.throws(() => parse({ reviewerModel: "no-slash" }), PilotConfigError);
});

test("parseDeliveryConfig treats null fields as absent", () => {
  const { result, diagnostics } = parse({
    mode: null,
    prompt: null,
    maxRepairs: null,
    reviewerModel: null,
  });
  assert.equal(result, undefined);
  assert.deepEqual(diagnostics, []);
});

test("parseDeliveryConfig warns on unknown fields and rejects non-object sections", () => {
  const { diagnostics } = parse({ temperature: 1 });
  assert.ok(diagnostics.some((d) => d.severity === "warning" && d.code === "CONFIG_AGENT_DELIVERY_UNKNOWN_FIELD"));

  const invalid = parse("off");
  assert.ok(invalid.diagnostics.some((d) => d.severity === "fatal" && d.code === "CONFIG_AGENT_DELIVERY_INVALID"));
  assert.equal(invalid.result, undefined);
});

function deliveryYaml(deliveryBlock: string): string {
  return `
schemaVersion: 1
agent:
  model: custom/model-a
${deliveryBlock}
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
        model-b: {}
`;
}

function loadWithDelivery(deliveryBlock: string) {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-delivery-config-"));
  const configPath = join(directory, "pilotdeck.yaml");
  writeFileSync(configPath, deliveryYaml(deliveryBlock), "utf8");
  try {
    return loadPilotConfig({ configPath, env: {} });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("loadPilotConfig preserves omitted agent.delivery", () => {
  const snapshot = loadWithDelivery("");
  assert.equal(snapshot.config.agent.delivery, undefined);
});

test("loadPilotConfig parses a valid agent.delivery section end to end", () => {
  const snapshot = loadWithDelivery(`
  delivery:
    mode: auto
    prompt: "Follow the workspace conventions."
    reviewerModel: custom/model-b
    maxRepairs: 1
`);
  assert.deepEqual(snapshot.config.agent.delivery, {
    mode: "auto",
    prompt: "Follow the workspace conventions.",
    reviewerModel: { id: "custom/model-b", provider: "custom", model: "model-b" },
    maxRepairs: 1,
  });
});

test("loadPilotConfig rejects an invalid agent.delivery section", () => {
  assert.throws(
    () => loadWithDelivery(`
  delivery:
    mode: off
    maxRepairs: 9
`),
    (error: unknown) => error instanceof PilotConfigError
      && error.code === "CONFIG_AGENT_DELIVERY_FIELD_INVALID",
  );
  assert.throws(
    () => loadWithDelivery(`
  delivery:
    reviewerModel: custom/unknown-model
`),
    (error: unknown) => error instanceof PilotConfigError
      && error.code === "CONFIG_AGENT_MODEL_NOT_FOUND",
  );
});
