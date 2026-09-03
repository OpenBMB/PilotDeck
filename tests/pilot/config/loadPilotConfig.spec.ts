import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

test("loadPilotConfig reads PILOTDECK_CONFIG_PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-config-path-"));
  const configPath = join(directory, "custom.yaml");
  try {
    writeFileSync(configPath, `
schemaVersion: 1
agent:
  model: custom/model-a
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
`, "utf8");

    const snapshot = loadPilotConfig({
      env: { PILOTDECK_CONFIG_PATH: configPath },
    });

    assert.equal(snapshot.config.agent.model.id, "custom/model-a");
    assert.equal(snapshot.sources[0]?.path, configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects a missing config without creating one", () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-missing-config-"));
  const configPath = join(directory, "pilotdeck.yaml");
  try {
    assert.throws(
      () => loadPilotConfig({ env: { PILOTDECK_CONFIG_PATH: configPath } }),
      (error: unknown) => (error as { code?: string }).code === "CONFIG_AGENT_MISSING",
    );
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
