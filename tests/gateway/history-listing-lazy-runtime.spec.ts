import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime } from '../../src/model/index.js';
import { getPilotProjectChatDir } from '../../src/pilot/paths.js';

test('Gateway browsing history does not initialize models/plugins for each project', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-lazy-history-'));
  const configPath = join(home, 'pilotdeck.yaml');
  await writeFile(configPath, `schemaVersion: 1
agent: { model: test/model }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture-key
      models: { model: {} }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
telemetry: { enabled: false }
`);
  let modelInitializations = 0;
  const local = createLocalGateway({
    pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'),
    env: { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath },
    __testModelFactory(snapshot) {
      modelInitializations += 1;
      return createModelRuntime(snapshot.config.model);
    },
  });
  t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
  const initializationsBeforeBrowsing = modelInitializations;
  for (let i = 0; i < 3; i++) {
    const project = join(home, `workspace-${i}`);
    await mkdir(project);
    const chats = getPilotProjectChatDir(project, home);
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, '..', '.cwd'), project);
    await writeFile(join(chats, 'web_saved.jsonl'), JSON.stringify({ type: 'session_metadata', metadata: { title: 'Saved' } }) + '\n');
    const result = await local.gateway.listSessions({ projectKey: project, limit: 5 });
    assert.equal(result.sessions[0]?.summary, 'Saved');
    assert.equal(modelInitializations, initializationsBeforeBrowsing);
  }
});
