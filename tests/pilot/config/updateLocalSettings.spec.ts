import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PilotLocalSettingsError,
  updatePilotLocalSettings,
} from "../../../src/pilot/config/updateLocalSettings.js";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

const CONFIG = `# Keep this user comment when the SDK changes settings.
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
extension:
  includeHookEvents: false
`;

test("SDK localSettings validates before an atomic config replacement and preserves YAML content", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-local-settings-"));
  const configPath = join(pilotHome, "pilotdeck.yaml");
  await writeFile(configPath, CONFIG, "utf8");
  const env = { PILOT_HOME: pilotHome };
  try {
    const result = await updatePilotLocalSettings({
      env,
      settings: {
        agent: {
          maxContextTokens: 4096,
          thinking: { enabled: true, budgetTokens: 1024 },
        },
        extension: { includeHookEvents: true },
      },
    });
    assert.deepEqual(result, {
      applied: ["agent.maxContextTokens", "agent.thinking", "extension.includeHookEvents"],
      cleared: [],
      changedPaths: ["agent.maxContextTokens", "agent.thinking", "extension.includeHookEvents"],
    });
    const updated = await readFile(configPath, "utf8");
    assert.match(updated, /# Keep this user comment/);
    const snapshot = loadPilotConfig({ env });
    assert.equal(snapshot.config.agent.maxContextTokens, 4096);
    assert.deepEqual(snapshot.config.agent.thinking, { enabled: true, budgetTokens: 1024 });
    assert.equal(snapshot.config.extension.includeHookEvents, true);

    await updatePilotLocalSettings({ env, settings: { agent: { thinking: null } } });
    assert.equal(loadPilotConfig({ env }).config.agent.thinking, undefined);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("SDK localSettings manages safe subagent, builtin-plugin, and web-search controls without accepting credentials", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-local-settings-expanded-"));
  const configPath = join(pilotHome, "pilotdeck.yaml");
  const expandedConfig = CONFIG.replace(
    "extension:\n  includeHookEvents: false\n",
    "extension:\n  includeHookEvents: false\n  builtinPluginsEnabled:\n    legacy_plugin: false\n",
  ) + "tools:\n  webSearch:\n    enabled: true\n    provider: custom\n    apiKey: keep-this-secret\n    endpoint: https://search.example.test\n";
  await writeFile(configPath, expandedConfig, "utf8");
  const env = { PILOT_HOME: pilotHome };
  try {
    const result = await updatePilotLocalSettings({
      env,
      settings: {
        agent: { subagents: { default: "test/test", timeoutMs: 3000, maxDepth: 2 } },
        extension: { builtinPluginsEnabled: { builtin_one: true, legacy_plugin: false } },
        tools: { webSearch: { enabled: false } },
      },
    });
    assert.deepEqual(result, {
      applied: [
        "agent.subagents.default",
        "agent.subagents.timeoutMs",
        "agent.subagents.maxDepth",
        "extension.builtinPluginsEnabled",
        "tools.webSearch.enabled",
      ],
      cleared: [],
      changedPaths: [
        "agent.subagents.default",
        "agent.subagents.timeoutMs",
        "agent.subagents.maxDepth",
        "extension.builtinPluginsEnabled",
        "tools.webSearch.enabled",
      ],
    });
    const snapshot = loadPilotConfig({ env });
    assert.equal(snapshot.config.agent.subagents?.default?.id, "test/test");
    assert.equal(snapshot.config.agent.subagents?.timeoutMs, 3000);
    assert.equal(snapshot.config.agent.subagents?.maxDepth, 2);
    assert.deepEqual(snapshot.config.extension.builtinPluginsEnabled, { builtin_one: true, legacy_plugin: false });
    assert.equal(snapshot.config.tools?.webSearch?.enabled, false);
    const updated = await readFile(configPath, "utf8");
    assert.match(updated, /apiKey: keep-this-secret/);

    const cleared = await updatePilotLocalSettings({
      env,
      settings: {
        agent: { subagents: { default: null, timeoutMs: null, maxDepth: null } },
        extension: { builtinPluginsEnabled: null },
        tools: { webSearch: { enabled: null } },
      },
    });
    assert.deepEqual(cleared, {
      applied: [],
      cleared: [
        "agent.subagents.default",
        "agent.subagents.timeoutMs",
        "agent.subagents.maxDepth",
        "extension.builtinPluginsEnabled",
        "tools.webSearch.enabled",
      ],
      changedPaths: [
        "agent.subagents.default",
        "agent.subagents.timeoutMs",
        "agent.subagents.maxDepth",
        "extension.builtinPluginsEnabled",
        "tools.webSearch.enabled",
      ],
    });
    const restored = loadPilotConfig({ env });
    assert.equal(restored.config.agent.subagents?.default, undefined);
    assert.equal(restored.config.agent.subagents?.timeoutMs, undefined);
    assert.equal(restored.config.agent.subagents?.maxDepth, undefined);
    assert.deepEqual(restored.config.extension.builtinPluginsEnabled, {});
    assert.equal(restored.config.tools?.webSearch?.enabled, undefined);
    assert.match(await readFile(configPath, "utf8"), /apiKey: keep-this-secret/);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("SDK localSettings rejects unsupported or invalid keys without changing the file", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-local-settings-invalid-"));
  const configPath = join(pilotHome, "pilotdeck.yaml");
  await writeFile(configPath, CONFIG, "utf8");
  const env = { PILOT_HOME: pilotHome };
  try {
    await assert.rejects(
      () => updatePilotLocalSettings({ env, settings: { agent: { maxOutputTokens: 0 } } }),
      (error: unknown) => error instanceof PilotLocalSettingsError && error.code === "INVALID_LOCAL_SETTINGS",
    );
    assert.equal(await readFile(configPath, "utf8"), CONFIG);
    await assert.rejects(
      () => updatePilotLocalSettings({ env, settings: { model: { providers: {} } } }),
      (error: unknown) => error instanceof PilotLocalSettingsError && error.code === "UNSUPPORTED_LOCAL_SETTING",
    );
    assert.equal(await readFile(configPath, "utf8"), CONFIG);
    await assert.rejects(
      () => updatePilotLocalSettings({ env, settings: { tools: { webSearch: { apiKey: "new-secret" } } } }),
      (error: unknown) => error instanceof PilotLocalSettingsError && error.code === "UNSUPPORTED_LOCAL_SETTING",
    );
    assert.equal(await readFile(configPath, "utf8"), CONFIG);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("Pilot config merges Gateway-owned project settings between global and environment sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-settings-source-"));
  const pilotHome = join(root, "home");
  const projectRoot = join(root, "project");
  const globalConfig = CONFIG.replace("maxContextTokens: 65536", "maxContextTokens: 2048");
  const projectConfig = `agent:\n  maxContextTokens: 4096\nextension:\n  includeHookEvents: true\n`;
  try {
    await mkdir(pilotHome, { recursive: true });
    await mkdir(join(projectRoot, ".pilotdeck"), { recursive: true });
    await writeFile(join(pilotHome, "pilotdeck.yaml"), globalConfig, "utf8");
    await writeFile(join(projectRoot, ".pilotdeck", "pilotdeck.yaml"), projectConfig, "utf8");

    const snapshot = loadPilotConfig({
      projectRoot,
      env: { PILOT_HOME: pilotHome, PILOT_AGENT_MODEL: "test/test" },
    });

    assert.equal(snapshot.config.agent.maxContextTokens, 4096);
    assert.equal(snapshot.config.extension.includeHookEvents, true);
    assert.deepEqual(snapshot.sources.map((source) => source.kind), ["env", "default", "project", "env"]);
    const projectSource = snapshot.sources.find((source) => source.kind === "project");
    assert.equal(projectSource?.path, join(projectRoot, ".pilotdeck", "pilotdeck.yaml"));
    assert.equal(projectSource?.priority, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
