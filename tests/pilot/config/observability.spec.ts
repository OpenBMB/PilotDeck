import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

test("observability is disabled by default and preserves the O1 diagnostic profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-config-observation-"));
  try {
    await writeFile(join(root, "pilotdeck.yaml"), configYaml());
    assert.equal(loadPilotConfig({ env: { PILOT_HOME: root } }).config.observability, undefined);

    await writeFile(join(root, "pilotdeck.yaml"), `${configYaml()}\nobservability:\n  enabled: true\n  profile: diagnostic\n  campaignId: e2-v24\n  variant: baseline\n  queueCapacity: 1024\n`);
    assert.deepEqual(loadPilotConfig({ env: { PILOT_HOME: root } }).config.observability, {
      enabled: true,
      profile: "diagnostic",
      campaignId: "e2-v24",
      variant: "baseline",
      queueCapacity: 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O1 rejects unsupported profiles and unsafe labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-config-observation-invalid-"));
  try {
    await writeFile(join(root, "pilotdeck.yaml"), `${configYaml()}\nobservability:\n  enabled: true\n  profile: forensic-local\n`);
    assert.throws(() => loadPilotConfig({ env: { PILOT_HOME: root } }), /observability\.profile/u);
    await writeFile(join(root, "pilotdeck.yaml"), `${configYaml()}\nobservability:\n  enabled: true\n  campaignId: ../escape\n`);
    assert.throws(() => loadPilotConfig({ env: { PILOT_HOME: root } }), /observability\.campaignId/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function configYaml(): string {
  return `schemaVersion: 1
agent:
  model: test/test-model
model:
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
