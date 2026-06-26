import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";
import {
  readProjectModelSettings,
  saveProjectModelSettings,
} from "../../src/pilot/config/projectModelSettings.js";

test("project model settings override only the selected project's runtime config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-models-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "workspace");
  await mkdir(pilotHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), baseConfig("openai/gpt-main"), "utf8");

  const env = { PILOT_HOME: pilotHome };
  const globalSnapshot = loadPilotConfig({ env });
  assert.equal(globalSnapshot.config.agent.model.id, "openai/gpt-main");

  const saved = await saveProjectModelSettings({
    projectKey: projectRoot,
    settings: {
      mainModel: "openai/gpt-project",
      tokenSaver: {
        enabled: true,
        judge: "openai/gpt-main",
        tiers: {
          simple: { model: "openai/gpt-small" },
          medium: { model: "openai/gpt-project" },
        },
        defaultTier: "medium",
      },
    },
  }, { env });

  assert.equal(saved.saved, true);
  assert.equal(saved.effective.mainModel, "openai/gpt-project");

  const projectYaml = await readFile(join(projectRoot, ".pilotdeck", "pilotdeck.yaml"), "utf8");
  assert.match(projectYaml, /agent:\n  model: openai\/gpt-project/);
  assert.doesNotMatch(projectYaml, /apiKey/);

  const projectSnapshot = loadPilotConfig({ env, projectRoot });
  assert.equal(projectSnapshot.config.agent.model.id, "openai/gpt-project");
  assert.equal(projectSnapshot.config.router?.scenarios?.default.id, "openai/gpt-project");
  assert.equal(projectSnapshot.config.router?.tokenSaver?.tiers.medium.model.id, "openai/gpt-project");

  const stillGlobal = loadPilotConfig({ env });
  assert.equal(stillGlobal.config.agent.model.id, "openai/gpt-main");

  const readBack = await readProjectModelSettings({ projectKey: projectRoot }, { env });
  assert.equal(readBack.settings.mainModel, "openai/gpt-project");
  assert.equal(readBack.inherited.mainModel, "openai/gpt-main");

  const cleared = await saveProjectModelSettings({
    projectKey: projectRoot,
    settings: {},
  }, { env });
  assert.equal(cleared.saved, true);
  assert.equal(cleared.settings.mainModel, undefined);
  assert.equal(cleared.effective.mainModel, "openai/gpt-main");

  const clearedYaml = await readFile(join(projectRoot, ".pilotdeck", "pilotdeck.yaml"), "utf8");
  assert.doesNotMatch(clearedYaml, /gpt-project/);
  assert.doesNotMatch(clearedYaml, /tokenSaver/);

  const inheritedProjectSnapshot = loadPilotConfig({ env, projectRoot });
  assert.equal(inheritedProjectSnapshot.config.agent.model.id, "openai/gpt-main");
  assert.equal(inheritedProjectSnapshot.config.router?.scenarios?.default.id, "openai/gpt-main");

  await rm(root, { recursive: true, force: true });
});

test("project model settings normalize friendly model refs and preserve inherited router models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-models-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "workspace");
  await mkdir(pilotHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), baseConfig("llmcenter/gpt-main", "llmcenter"), "utf8");

  const env = { PILOT_HOME: pilotHome };
  const inherited = await readProjectModelSettings({ projectKey: projectRoot }, { env });
  assert.equal(inherited.inherited.tokenSaver?.judge, "llmcenter/gpt-main");
  assert.equal(inherited.inherited.tokenSaver?.tiers?.medium.model, "llmcenter/gpt-main");

  const saved = await saveProjectModelSettings({
    projectKey: projectRoot,
    settings: {
      mainModel: "qwen3.6-35B-A3B",
    },
  }, { env });

  assert.equal(saved.saved, true);
  assert.deepEqual(saved.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  assert.equal(saved.settings.mainModel, "llmcenter/qwen3.6-35b-a3b");
  assert.equal(saved.effective.mainModel, "llmcenter/qwen3.6-35b-a3b");

  const projectYaml = await readFile(join(projectRoot, ".pilotdeck", "pilotdeck.yaml"), "utf8");
  assert.match(projectYaml, /model: llmcenter\/qwen3\.6-35b-a3b/);

  await rm(root, { recursive: true, force: true });
});

function baseConfig(agentModel: string, provider = "openai"): string {
  return `schemaVersion: 1
agent:
  model: ${agentModel}
model:
  providers:
    ${provider}:
      protocol: openai
      url: https://api.openai.example/v1
      apiKey: test-key
      models:
        gpt-main: {}
        gpt-project: {}
        gpt-small: {}
        qwen3.6-35b-a3b: {}
extension:
  builtinPluginsEnabled: {}
router:
  scenarios:
    default: ${agentModel}
  tokenSaver:
    enabled: true
    judge: ${agentModel}
    defaultTier: medium
    tiers:
      medium:
        model: ${agentModel}
`;
}
