import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

test("agent profile exposes the durable user-message runtime-context surface", () => {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-context-surface-"));
  try {
    writeFileSync(join(home, "pilotdeck.yaml"), [
      "schemaVersion: 1",
      "agent:",
      "  model: test/test-model",
      "  runtimeContextSurface: user_message",
      "model:",
      "  providers:",
      "    test:",
      "      protocol: openai",
      "      url: https://example.invalid/v1",
      "      apiKey: test",
      "      models:",
      "        test-model: {}",
      "",
    ].join("\n"), "utf8");

    const snapshot = loadPilotConfig({ env: { PILOT_HOME: home } });

    assert.equal(snapshot.config.agent.runtimeContextSurface, "user_message");
    assert.equal(
      snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.runtimeContextSurface"),
      false,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent profile defaults to the native system-prompt runtime-context surface", () => {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-context-surface-"));
  try {
    writeFileSync(join(home, "pilotdeck.yaml"), [
      "schemaVersion: 1",
      "agent:",
      "  model: test/test-model",
      "model:",
      "  providers:",
      "    test:",
      "      protocol: openai",
      "      url: https://example.invalid/v1",
      "      apiKey: test",
      "      models:",
      "        test-model: {}",
      "",
    ].join("\n"), "utf8");

    const snapshot = loadPilotConfig({ env: { PILOT_HOME: home } });

    assert.equal(snapshot.config.agent.runtimeContextSurface, "system_prompt");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid runtime-context surface fails soft to the system-prompt profile", () => {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-context-surface-"));
  try {
    writeFileSync(join(home, "pilotdeck.yaml"), [
      "schemaVersion: 1",
      "agent:",
      "  model: test/test-model",
      "  runtimeContextSurface: unsupported",
      "model:",
      "  providers:",
      "    test:",
      "      protocol: openai",
      "      url: https://example.invalid/v1",
      "      apiKey: test",
      "      models:",
      "        test-model: {}",
      "",
    ].join("\n"), "utf8");

    const snapshot = loadPilotConfig({ env: { PILOT_HOME: home } });

    assert.equal(snapshot.config.agent.runtimeContextSurface, "system_prompt");
    assert.equal(
      snapshot.diagnostics.some(
        (diagnostic) => diagnostic.code === "CONFIG_AGENT_RUNTIME_CONTEXT_SURFACE_INVALID",
      ),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
