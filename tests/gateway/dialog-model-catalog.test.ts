import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listModelCatalog,
  validateExplicitModelSelection,
} from "../../src/gateway/dialog/modelCatalog.js";

test("model catalog exposes explicitly configured reasoning and opt-in speed capabilities", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-model-catalog-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  await writeFile(join(pilotHome, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: custom/default-model
model:
  providers:
    custom:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      speedMapping: openai_service_tier
      models:
        default-model: {}
        enabled-default:
          thinking: { state: enabled }
        configured:
          thinking: { state: enabled, efforts: [low, medium, xhigh] }
        disabled:
          thinking: { state: disabled, efforts: [high] }
        no-thinking:
          capabilities:
            supportsThinking: false
        speed-model:
          capabilities:
            supportsSpeed: true
    google:
      protocol: google
      models:
        speed-model:
          capabilities:
            supportsSpeed: true
`);

  const env = { ...process.env, PILOT_HOME: pilotHome, GEMINI_API_KEY: "test-key" };
  const result = listModelCatalog({ projectKey: "/project" }, env);
  const defaultModel = result.items.find((item) => item.model === "default-model");
  const noThinking = result.items.find((item) => item.model === "no-thinking");
  const speedModel = result.items.find((item) => item.model === "speed-model");
  const googleSpeedModel = result.items.find((item) => item.provider === "google");

  assert.equal(defaultModel?.capabilities.reasoning, undefined);
  assert.ok(result.items.every(item => !("temperature" in item.capabilities)));
  assert.deepEqual(result.items.find(item => item.model === 'enabled-default')?.capabilities.reasoning?.values, []);
  assert.deepEqual(result.items.find(item => item.model === 'configured')?.capabilities.reasoning?.values, [.4, .6, .9]);
  assert.equal(result.items.find(item => item.model === 'disabled')?.capabilities.reasoning, undefined);
  for (const reasoning of [0, .2, .8, 1]) assert.throws(() => validateExplicitModelSelection('/project', {
    mode: 'model', provider: 'custom', model: 'configured', reasoning,
  }, env));
  assert.equal(defaultModel?.capabilities.speed, undefined);
  assert.equal(noThinking?.capabilities.reasoning, undefined);
  assert.deepEqual(speedModel?.capabilities.speed, { type: "enum", values: [0, 1] });
  assert.equal(googleSpeedModel?.capabilities.speed, undefined);

  validateExplicitModelSelection("/project", {
    mode: "model", provider: "custom", model: "speed-model", speed: 0,
  }, env);
  validateExplicitModelSelection("/project", {
    mode: "model", provider: "custom", model: "speed-model", speed: 1,
  }, env);
  await assert.rejects(
    Promise.resolve().then(() => validateExplicitModelSelection("/project", {
      mode: "model", provider: "custom", model: "speed-model", speed: 1.1,
    }, env)),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_MODEL_PARAMETER",
  );
  for (const speed of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      Promise.resolve().then(() => validateExplicitModelSelection("/project", {
        mode: "model", provider: "custom", model: "speed-model", speed,
      }, env)),
      (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_MODEL_PARAMETER",
    );
  }
  await assert.rejects(
    Promise.resolve().then(() => validateExplicitModelSelection("/project", {
      mode: "model", provider: "custom", model: "default-model", speed: 0.5,
    }, env)),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_MODEL_PARAMETER",
  );
  await assert.rejects(
    Promise.resolve().then(() => validateExplicitModelSelection("/project", {
      mode: "model", provider: "google", model: "speed-model", speed: 0.5,
    }, env)),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_MODEL_PARAMETER",
  );
});

test("official openai catalog models expose two-tier speed options", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-openai-speed-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  await writeFile(join(pilotHome, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: openai/gpt-4o-mini
model:
  providers:
    openai:
      models:
        gpt-4o-mini: {}
`);
  const env = { ...process.env, PILOT_HOME: pilotHome, OPENAI_API_KEY: "test-key" };
  const result = listModelCatalog({ projectKey: "/project" }, env);
  const mini = result.items.find((item) => item.id === "openai/gpt-4o-mini");
  assert.deepEqual(mini?.capabilities.speed, { type: "enum", values: [0, 1] });
});
