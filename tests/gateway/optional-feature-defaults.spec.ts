import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';

const BASE = `
schemaVersion: 1
agent:
  model: test/model
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        model: {}
extension:
  builtinPluginsEnabled:
    windows-skills: false
    browser-use: false
    funasr: false
telemetry:
  enabled: false
`;

for (const [name, extra, enabled] of [
  ['missing sections', '', false],
  ['new-user explicit defaults', `
memory: { enabled: false }
router: { enabled: false }
tools: { webSearch: { enabled: false } }
alwaysOn: { projects: {} }
adapters:
  feishu: { enabled: false }
  weixin: { enabled: false }
  wecom: { enabled: false }
`, false],
  ['explicitly enabled features', `
router: { enabled: true }
tools: { webSearch: { enabled: true, provider: tavily } }
`, true],
  ['legacy configured sections', `
router: { scenarios: { default: test/model } }
tools: { webSearch: { provider: tavily } }
`, true],
  ['legacy empty search block with environment credentials', `
router: { scenarios: { default: test/model } }
tools: { webSearch: {} }
`, true],
  ['legacy region-only search block with environment credentials', `
router: { scenarios: { default: test/model } }
tools: { webSearch: { region: cn } }
`, true],
] as const) {
  test(`${name}: catalog, router execution and search availability agree`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'pilotdeck-feature-defaults-'));
    await writeFile(join(home, 'pilotdeck.yaml'), BASE + extra);
    await mkdir(join(home, 'skills'));
    const requests: CanonicalModelRequest[] = [];
    const completions: CanonicalModelRequest[] = [];
    const local = createLocalGateway({
      pilotHome: home,
      projectRoot: home,
      builtinSkillsRoot: join(home, 'skills'),
      env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'), PILOT_AGENT_MODEL: undefined, TAVILY_API_KEY: 'present-but-not-opt-in' },
      __testModelFactory(snapshot) {
        assert.notEqual(snapshot.config.memory?.enabled, true);
        for (const channel of ['feishu', 'weixin', 'wecom'] as const) {
          assert.notEqual(snapshot.config.adapters?.[channel]?.enabled, true);
        }
        assert.equal(Object.values(snapshot.config.alwaysOn?.projects ?? {}).some(project => project.enabled), false);
        return {
          ...createModelRuntime(snapshot.config.model),
          async *stream(request): AsyncIterable<CanonicalModelEvent> {
            requests.push(request);
            yield { type: 'message_start', role: 'assistant' };
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'message_end', finishReason: 'stop' };
          },
          async complete(request) {
            completions.push(request);
            return { role: 'assistant', content: [{ type: 'text', text: '{"tier":"medium"}' }], finishReason: 'stop' };
          },
        };
      },
    });
    t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
    const catalog = await local.gateway.modelCatalogList!({ includeAuto: true });
    assert.equal(catalog.router.autoAvailable, enabled);
    const events = [];
    // No Composer snapshot: exercise the actual default path used by CLI/API.
    for await (const event of local.gateway.submitTurn({ projectKey: home, sessionKey: 'web:feature-defaults', channelKey: 'web', message: 'hello' })) events.push(event);
    assert.deepEqual(events.filter(event => event.type === 'error'), []);
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.tools?.some(tool => tool.name === 'web_search'), enabled);
    const judges = completions.filter(request => request.metadata?.purpose !== 'session_title_generation');
    assert.equal(judges.length > 0, enabled, 'disabled routing must not make hidden classification calls');
  });
}
