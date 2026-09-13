import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { loadPilotConfig } from "../../../src/pilot/index.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";

const tempPilotHomes: string[] = [];

afterEach(() => {
  for (const dir of tempPilotHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE_MODEL_CONFIG = `
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
    zhipu:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        glm-5.3-flash: {}
`;

function loadInlinePilotConfig(raw: string) {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-profiles-config-"));
  tempPilotHomes.push(pilotHome);
  writeFileSync(join(pilotHome, "pilotdeck.yaml"), raw, "utf8");
  return loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
}

function configWithSubagents(subagentsYaml: string): string {
  return `
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
${subagentsYaml}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
    zhipu:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        glm-5.3-flash: {}
`;
}

test("agent.subagents.profiles parses alongside default and timeoutMs", () => {
  const snapshot = loadInlinePilotConfig(configWithSubagents(`
    default: zhipu/glm-5.3-flash
    timeoutMs: 120000
    maxDepth: 2
    profiles:
      vision:
        description: Read image files and report visual details.
        model: zhipu/glm-5.3-flash
        tools: [read_file]
        readOnly: true
        enabled: true
      consultant:
        description: Analyze difficult questions.
        model: inherit
`));

  const subagents = snapshot.config.agent.subagents;
  assert.equal(subagents?.default?.id, "zhipu/glm-5.3-flash");
  assert.equal(subagents?.timeoutMs, 120000);
  assert.equal(subagents?.maxDepth, 2);
  assert.deepEqual(subagents?.profiles?.vision, {
    description: "Read image files and report visual details.",
    model: "zhipu/glm-5.3-flash",
    tools: ["read_file"],
    readOnly: true,
    enabled: true,
  });
  assert.deepEqual(subagents?.profiles?.consultant, {
    description: "Analyze difficult questions.",
    model: "inherit",
  });
  assert.equal(
    snapshot.diagnostics.some((diagnostic) => diagnostic.path?.startsWith("agent.subagents")),
    false,
  );
});

test("agent.subagents without profiles keeps legacy defaults and no profiles key", () => {
  const snapshot = loadInlinePilotConfig(BASE_MODEL_CONFIG);
  assert.equal(snapshot.config.agent.subagents?.profiles, undefined);
  assert.equal(snapshot.config.agent.subagents?.maxDepth, undefined);
});

test("agent.subagents.maxDepth outside 0..5 is rejected", () => {
  assert.throws(
    () => loadInlinePilotConfig(configWithSubagents("    maxDepth: 6")),
    (error) =>
      error instanceof PilotConfigError &&
      error.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.maxDepth"),
  );
  assert.throws(
    () => loadInlinePilotConfig(configWithSubagents('    maxDepth: "2"')),
    (error) => error instanceof PilotConfigError,
  );
});

test("agent.subagents.profiles structural violations are rejected with readable paths", () => {
  const cases: Array<[string, RegExp]> = [
    ["    profiles:\n      Vision:\n        description: x", /Vision/],
    ["    profiles:\n      vision:\n        description: \"   \"", /description/],
    ["    profiles:\n      vision: {}", /description/],
    ["    profiles:\n      vision:\n        description: x\n        tools: nope", /tools/],
    ["    profiles:\n      explore:\n        description: x\n        readOnly: false", /read-only/],
    [
      "    profiles:\n      plan:\n        description: x\n        tools: [read_file, write_file]",
      /write_file/,
    ],
  ];
  for (const [snippet, pattern] of cases) {
    assert.throws(
      () => loadInlinePilotConfig(configWithSubagents(snippet)),
      (error) =>
        error instanceof PilotConfigError &&
        error.diagnostics.some((diagnostic) =>
          diagnostic.path?.startsWith("agent.subagents.profiles"),
        ) &&
        pattern.test(error.message),
      snippet,
    );
  }
});

test("agent.subagents.profiles allows narrowing explore tools plus nested agent", () => {
  const snapshot = loadInlinePilotConfig(configWithSubagents(`
    profiles:
      explore:
        description: Narrowed explore.
        tools: [read_file, agent]
  `));
  assert.deepEqual(snapshot.config.agent.subagents?.profiles?.explore?.tools, [
    "read_file",
    "agent",
  ]);
});

test("agent.subagents.profiles rejects unknown model references", () => {
  assert.throws(
    () =>
      loadInlinePilotConfig(configWithSubagents(`
        profiles:
          vision:
            description: x
            model: missing/glm
      `)),
    (error) => error instanceof PilotConfigError,
  );
  assert.throws(
    () =>
      loadInlinePilotConfig(configWithSubagents(`
        profiles:
          vision:
            description: x
            model: zhipu/nope
      `)),
    (error) => error instanceof PilotConfigError,
  );
  assert.throws(
    () =>
      loadInlinePilotConfig(configWithSubagents(`
        profiles:
          vision:
            description: x
            model: malformed
      `)),
    (error) => error instanceof PilotConfigError,
  );
});
