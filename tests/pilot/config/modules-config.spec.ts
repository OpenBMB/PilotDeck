import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { classifyConfigChanges } from "../../../src/pilot/config/classifyChanges.js";

function configWithModules(modules: string): string {
  return `
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
${modules}
`;
}

test("loadPilotConfig resolves the StaffDeck SOP module profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: http://sop-runtime:8091
    definitionsPath: sops/definitions.yaml
    defaultSopId: onboarding
    timeoutMs: 5000
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.deepEqual(snapshot.config.modules?.agentLoop, { enabled: true, provider: "pilotdeck" });
    assert.deepEqual(snapshot.config.modules?.sop, {
      provider: "staffdeck",
      endpoint: "http://sop-runtime:8091",
      definitionsPath: join(root, "sops", "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: join(root, "sop"),
      timeoutMs: 5000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects unsupported module ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-invalid-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: false, provider: pilotdeck }
  sop:
    enabled: true
    provider: pilotdeck
    endpoint: http://sop-runtime:8091
    definitionsPath: definitions.yaml
    defaultSopId: onboarding
`));

    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
        (diagnostic) => diagnostic.code === "MODULE_PROVIDER_UNSUPPORTED" || diagnostic.code === "SOP_MODULE_PROVIDER_INVALID",
      ) === true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig disables StaffDeck SOP without loading a runtime profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-disabled-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop: { enabled: false, provider: staffdeck }
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.equal(snapshot.config.modules?.sop, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig keeps the native profile when modules is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-native-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(""));
    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.equal(snapshot.config.modules, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects incomplete StaffDeck SOP runtime settings before startup", () => {
  const cases = [
    { name: "endpoint", endpoint: "relative/path", definitionsPath: "definitions.yaml", defaultSopId: "onboarding", code: "SOP_MODULE_ENDPOINT_INVALID" },
    { name: "definitions", endpoint: "http://sop-runtime:8091", definitionsPath: "   ", defaultSopId: "onboarding", code: "SOP_MODULE_DEFINITIONS_PATH_INVALID" },
    { name: "default id", endpoint: "http://sop-runtime:8091", definitionsPath: "definitions.yaml", defaultSopId: "", code: "SOP_MODULE_DEFAULT_ID_INVALID" },
    { name: "timeout", endpoint: "http://sop-runtime:8091", definitionsPath: "definitions.yaml", defaultSopId: "onboarding", timeoutMs: 0, code: "SOP_MODULE_TIMEOUT_INVALID" },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-required-"));
    const configPath = join(root, "pilotdeck.yaml");
    try {
      writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: ${item.endpoint}
    definitionsPath: ${JSON.stringify(item.definitionsPath)}
    defaultSopId: ${JSON.stringify(item.defaultSopId)}
    ${item.timeoutMs === undefined ? "" : `timeoutMs: ${item.timeoutMs}`}
`));
      assert.throws(
        () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
        (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
          (diagnostic) => diagnostic.code === item.code,
        ) === true,
        item.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("module profile changes require a new runtime generation", () => {
  assert.deepEqual(classifyConfigChanges(["modules", "modules.sop.endpoint"]), ["restart-required"]);
});
