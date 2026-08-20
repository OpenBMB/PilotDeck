import assert from "node:assert/strict";

import { createModelRuntime, type CanonicalModelResponse, type ModelRuntime } from "../../src/model/index.js";
import { loadPilotConfig } from "../../src/pilot/index.js";

export function externalModel(): { provider: string; model: string; runtime: ModelRuntime } {
  assert.equal(process.env.PILOTDECK_RUN_EXTERNAL, "1", "External tests must run through pnpm test:external.");
  const expectedProvider = process.env.PILOTDECK_EXTERNAL_PROVIDER?.trim();
  assert.ok(expectedProvider, "PILOTDECK_EXTERNAL_PROVIDER is required for the provider matrix.");
  const snapshot = loadPilotConfig();
  const { provider, model } = snapshot.config.agent.model;
  assert.equal(provider, expectedProvider, `Configured agent provider must match matrix provider ${expectedProvider}.`);
  assert.ok(model.trim(), `Configured agent model is required for ${expectedProvider}.`);
  assert.ok(snapshot.config.model.providers[provider], `Provider ${provider} is not configured.`);
  assert.ok(snapshot.config.model.providers[provider]?.models[model], `Model ${model} is not configured under ${provider}.`);
  return { provider, model, runtime: createModelRuntime(snapshot.config.model) };
}

export function responseText(response: CanonicalModelResponse): string {
  return response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
}
