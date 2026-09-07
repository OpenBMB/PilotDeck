import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { createPilotConfigStoreSync } from "../../../src/pilot/config/PilotConfigStore.js";

function configYaml(model: "model-a" | "model-b"): string {
  return `
schemaVersion: 1
agent:
  model: custom/${model}
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

test("PilotConfigStore watches the configured custom path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-config-watch-"));
  const configPath = join(directory, "custom.yaml");
  const pilotHome = join(directory, "home");
  let stopWatching: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let reloadTimeout: NodeJS.Timeout | undefined;
  try {
    writeFileSync(configPath, configYaml("model-a"), "utf8");
    const store = createPilotConfigStoreSync({
      env: {
        PILOT_HOME: pilotHome,
        PILOTDECK_CONFIG_PATH: configPath,
      },
    });
    const reloaded = new Promise<void>((resolve, reject) => {
      reloadTimeout = setTimeout(() => reject(new Error("custom config was not reloaded")), 2_000);
      unsubscribe = store.subscribe((event) => {
        if (event.nextSnapshot.config.agent.model.id !== "custom/model-b") return;
        clearTimeout(reloadTimeout);
        resolve();
      });
    });
    stopWatching = store.startWatching({ debounceMs: 10 });

    await new Promise((resolve) => setTimeout(resolve, 25));
    writeFileSync(configPath, configYaml("model-b"), "utf8");
    await reloaded;
    assert.equal(store.getSnapshot().config.agent.model.id, "custom/model-b");
  } finally {
    clearTimeout(reloadTimeout);
    unsubscribe?.();
    stopWatching?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
