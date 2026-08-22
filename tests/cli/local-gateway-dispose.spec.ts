import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

test("local gateway disposal is awaitable and leaves disabled telemetry untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-local-gateway-dispose-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "pilotdeck.yaml"), [
      "schemaVersion: 1",
      "agent:",
      "  model: test/mock",
      "model:",
      "  providers:",
      "    test:",
      "      protocol: openai",
      "      url: https://example.invalid",
      "      apiKey: test",
      "      models:",
      "        mock: {}",
      "telemetry:",
      "  enabled: false",
      "",
    ].join("\n"));
    const runtime = createLocalGateway({
      pilotHome,
      projectRoot,
      env: { PILOT_HOME: pilotHome, ANALYTICS_ENABLED: "0" },
    });

    const firstDispose = runtime.dispose();
    assert.equal(typeof firstDispose.then, "function");
    assert.equal(runtime.dispose(), firstDispose);
    await firstDispose;

    await assert.rejects(stat(join(pilotHome, "telemetry", "queue.jsonl")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
