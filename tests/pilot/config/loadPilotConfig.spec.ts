import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

for (const [name, yaml, enabled, timezone] of [
  ["missing section", "", true, "UTC"],
  ["bare section", "cron:\n", true, "UTC"],
  ["null section", "cron: null\n", true, "UTC"],
  ["empty section", "cron: {}\n", true, "UTC"],
  ["missing enabled", "cron:\n  timezone: Asia/Shanghai\n", true, "Asia/Shanghai"],
  ["explicit true", "cron:\n  enabled: true\n", true, "UTC"],
  ["explicit false", "cron:\n  enabled: false\n", false, "UTC"],
] as const) {
  test(`loadPilotConfig resolves Cron defaults for ${name}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "pilotdeck-cron-config-"));
    const configPath = join(directory, "pilotdeck.yaml");
    const raw = configYaml("model-a") + yaml;
    try {
      writeFileSync(configPath, raw);
      const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: directory } });
      assert.deepEqual(snapshot.config.cron, {
        enabled, timezone, maxConcurrentRuns: 1, runTimeoutMinutes: 60,
      });
      assert.equal(snapshot.diagnostics.some(d => d.code.startsWith("CRON_")), false);
      assert.equal(readFileSync(configPath, "utf8"), raw);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const yaml of ["cron: false\n", "cron: invalid\n", "cron: []\n"]) {
  test(`loadPilotConfig still rejects invalid Cron structures: ${yaml.trim()}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "pilotdeck-cron-invalid-"));
    const configPath = join(directory, "pilotdeck.yaml");
    try {
      writeFileSync(configPath, configYaml("model-a") + yaml);
      assert.throws(
        () => loadPilotConfig({ configPath, env: { PILOT_HOME: directory } }),
        (error: unknown) => (error as { code?: string }).code === "CRON_CONFIG_INVALID",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("PilotConfigStore reports Cron switch changes when enabling, disabling, or removing the section", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-cron-reload-"));
  const configPath = join(directory, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configYaml("model-a"));
    const store = createPilotConfigStoreSync({ configPath, env: { PILOT_HOME: directory } });
    let changedPaths: string[] = [];
    store.subscribe(event => { changedPaths = event.changedPaths; });
    for (const yaml of ["cron: { enabled: false }\n", "cron: { enabled: true }\n", "cron: { enabled: false }\n", ""]) {
      writeFileSync(configPath, configYaml("model-a") + yaml);
      const snapshot = await store.reload();
      assert.equal(snapshot.config.cron?.enabled, !yaml.includes("false"));
      assert.deepEqual(changedPaths, ["cron.enabled"]);
    }
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


test("invalid unused providers are isolated from the Gateway without deleting their settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-provider-isolation-"));
  const path = join(dir, "pilotdeck.yaml");
  const raw = configYaml("model-a") + `
    broken:
      protocol: openai
      url: aaa
      apiKey: bad
      models:
        bad: {}
`;
  try {
    writeFileSync(path, raw);
    const snapshot = loadPilotConfig({ configPath: path, env: {} });
    assert.equal(snapshot.config.agent.model.id, "custom/model-a");
    assert.equal(snapshot.config.model.providers.broken, undefined);
    assert.ok(snapshot.diagnostics.some(d => d.path === "model.providers.broken" && d.severity === "warning"));
    assert.equal(readFileSync(path, "utf8"), raw);
    writeFileSync(path, raw.replace("custom/model-a", "broken/bad"));
    assert.throws(() => loadPilotConfig({ configPath: path, env: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
