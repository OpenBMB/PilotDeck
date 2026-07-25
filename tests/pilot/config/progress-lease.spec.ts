import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

test("progress lease is disabled by default and opt-in evaluation config is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-config-progress-lease-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "pilotdeck.yaml"), configYaml());

    const disabled = loadPilotConfig({ env: { PILOT_HOME: root } });
    assert.equal(disabled.config.agent.progressLease, undefined);

    await writeFile(join(root, "pilotdeck.yaml"), configYaml(true));
    const enabled = loadPilotConfig({ env: { PILOT_HOME: root } });
    assert.deepEqual(enabled.config.agent.progressLease, {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress lease rejects non-evaluation modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-config-progress-lease-invalid-"));
  try {
    await writeFile(join(root, "pilotdeck.yaml"), configYaml(true).replace("mode: evaluation", "mode: production"));
    assert.throws(() => loadPilotConfig({ env: { PILOT_HOME: root } }), (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "CONFIG_AGENT_PROGRESS_LEASE_MODE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function configYaml(enabled = false): string {
  return `schemaVersion: 1
agent:
  model: test/test-model
${enabled ? "  progressLease:\n    enabled: true\n    mode: evaluation\n" : ""}model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 32768
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
`;
}
