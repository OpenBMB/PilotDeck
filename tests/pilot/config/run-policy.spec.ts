import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyConfigChanges, isRunPolicyOnlyChange } from "../../../src/pilot/config/classifyChanges.js";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

const BASE = `
schemaVersion: 1
agent:
  model: custom/model
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model: {}
`;

test("runPolicy failureGuard defaults off and validates configured limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-run-policy-"));
  const path = join(directory, "pilotdeck.yaml");
  try {
    writeFileSync(path, `${BASE}\nrunPolicy:\n  failureGuard: {}\n`);
    assert.deepEqual(loadPilotConfig({ configPath: path, env: {} }).config.runPolicy?.failureGuard, {
      enabled: false,
      modelFailureLimit: 0,
      toolFailureLimits: {},
      toolLabels: {},
    });

    writeFileSync(path, `${BASE}
runPolicy:
  failureGuard:
    enabled: true
    modelFailureLimit: 2
    toolFailureLimits: { mcp__research__: 3, web_fetch: 1 }
    toolLabels: { mcp__research__: Research }
`);
    const guard = loadPilotConfig({ configPath: path, env: {} }).config.runPolicy?.failureGuard;
    assert.equal(guard?.enabled, true);
    assert.equal(guard?.modelFailureLimit, 2);
    assert.equal(guard?.toolFailureLimits.mcp__research__, 3);

    writeFileSync(path, `${BASE}\nrunPolicy:\n  failureGuard:\n    modelFailureLimit: -1\n`);
    assert.throws(() => loadPilotConfig({ configPath: path, env: {} }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runPolicy changes apply on the next request without runtime replacement", () => {
  assert.deepEqual(classifyConfigChanges(["runPolicy.failureGuard.enabled"]), ["next-request"]);
  assert.equal(isRunPolicyOnlyChange(["runPolicy.failureGuard.enabled", "runPolicy.failureGuard.modelFailureLimit"]), true);
  assert.equal(isRunPolicyOnlyChange(["runPolicy.failureGuard.enabled", "model.providers.custom"]), false);
});
