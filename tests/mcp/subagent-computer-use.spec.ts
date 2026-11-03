import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import type { GatewayEvent } from '../../src/gateway/protocol/types.js';
import { collectRequiredInputModalities } from '../../src/router/utils/mediaRequirements.js';
import { createProjectId } from '../../src/pilot/index.js';

const OBSERVE = 'mcp__pilotdeck-computer-use__observe';
const REPORT = 'Scope: desktop fixture\nResult: inspected\nKey files: none\nFiles changed: none\nIssues: none';

test('profile model binding survives managed Computer Use observations and revocation', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-profile-cua-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, 'skills'));
  const registration = join(home, 'projects', createProjectId(workspace));
  await mkdir(registration, { recursive: true });
  await writeFile(join(registration, '.cwd'), workspace);
  await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent:
  model: test/parent
  maxContextTokens: 32768
  maxOutputTokens: 4096
  subagents:
    profiles:
      observer:
        description: Inspect desktop observations.
        model: test/vision
        tools: [${OBSERVE}]
        readOnly: true
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        parent: {}
        vision:
          multimodal: { input: [text, image] }
`);
  const managed = join(root, 'managed-mcp.json');
  await writeFile(managed, JSON.stringify({ mcpServers: { 'pilotdeck-computer-use': {
    command: process.execPath,
    args: [resolve('tests/mcp/fixtures/roundtrip-server.mjs')],
    concurrencySafe: false,
  } } }));
  const previous = process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
  process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = managed;
  const requests: CanonicalModelRequest[] = [];
  const turns = new Map<string, number>();
  const local = createLocalGateway({
    pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, 'skills'),
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: snapshot => ({
      ...createModelRuntime(snapshot.config.model),
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        const childId = request.metadata?.subagentId;
        const key = typeof childId === 'string' ? childId : 'parent';
        const turn = turns.get(key) ?? 0;
        turns.set(key, turn + 1);
        yield { type: 'message_start', role: 'assistant' };
        if (!childId && turn === 0) {
          yield { type: 'tool_call_end', toolCall: { id: 'delegate', name: 'agent', input: {
            description: 'Inspect desktop', prompt: 'Observe the fixture and report.', subagent_type: 'observer',
          } } };
        } else if (childId && turn === 0 && request.tools?.some(tool => tool.name === OBSERVE)) {
          yield { type: 'tool_call_end', toolCall: { id: 'observe', name: OBSERVE, input: {} } };
        } else {
          yield { type: 'text_delta', text: REPORT };
        }
        yield { type: 'message_end', finishReason: 'stop' };
      },
      async complete() {
        return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Desktop review"}' }], finishReason: 'stop' as const };
      },
    }),
  });
  t.after(async () => {
    local.dispose();
    if (previous === undefined) delete process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
    else process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  });
  async function submit(sessionKey: string) {
    turns.clear(); requests.length = 0;
    const events: GatewayEvent[] = [];
    for await (const event of local.gateway.submitTurn({
      projectKey: workspace, sessionKey, channelKey: 'web', message: 'Inspect the desktop.',
    })) events.push(event);
    assert.deepEqual(events.filter(event => event.type === 'error'), []);
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.match(requests[0].tools?.find(tool => tool.name === 'agent')?.description ?? '', /observer: Inspect desktop observations/);
    const children = requests.filter(request => request.metadata?.subagentId);
    assert.ok(children.length > 0);
    assert.ok(children.every(request => request.provider === 'test' && request.model === 'vision'));
    return children;
  }

  const enabled = await submit('web:cua-enabled');
  assert.equal(enabled.length, 2);
  assert.deepEqual(enabled[0].tools?.map(tool => tool.name), [OBSERVE]);
  assert.match(enabled[0].systemPrompt ?? '', /Observe the window before acting/);
  assert.match(enabled[0].systemPrompt ?? '', /Custom profile mode/);
  assert.match(enabled[0].systemPrompt ?? '', /run_mode: ask/);
  assert.deepEqual(collectRequiredInputModalities(enabled[1].messages), ['image']);
  assert.match(JSON.stringify(enabled[1].messages), /fixture:4:0/);

  await writeFile(managed, JSON.stringify({ mcpServers: {} }));
  const disabled = await submit('web:cua-disabled');
  assert.equal(disabled.length, 1);
  assert.deepEqual(disabled[0].tools ?? [], []);
  assert.doesNotMatch(disabled[0].systemPrompt ?? '', /Observe the window before acting/);
});
