import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { McpClient } from '../../src/mcp/client/McpClient.js';
import { createModelRuntime, type CanonicalModelEvent } from '../../src/model/index.js';
import type { GatewayEvent } from '../../src/gateway/protocol/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, beforeTools?: () => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-extension-reload-'));
  const configPath = join(home, 'pilotdeck.yaml');
  const projects = [join(home, 'project-a'), join(home, 'project-b')];
  const clients: McpClient[] = [];
  const running = new Set<McpClient>();
  const closed: McpClient[] = [];
  const called: McpClient[] = [];
  const calledTools: string[] = [];
  let toolNames = ['probe'];
  t.mock.method(McpClient.prototype, 'start', async function (this: McpClient) {
    clients.push(this);
    running.add(this);
  });
  t.mock.method(McpClient.prototype, 'getStatus', function (this: McpClient) {
    return running.has(this) ? 'ready' : 'idle';
  });
  t.mock.method(McpClient.prototype, 'listTools', async function (this: McpClient) {
    return toolNames.map(name => ({ serverId: this.spec.id, toolName: name, wireName: `mcp__${this.spec.id}__${name}`,
      description: 'Synthetic resource ownership probe', inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true } }));
  });
  t.mock.method(McpClient.prototype, 'callTool', async function (this: McpClient, name: string) {
    assert.ok(running.has(this), 'A retained session must keep its MCP client connected');
    called.push(this);
    calledTools.push(name);
    return { content: [{ type: 'text', text: `connected:${this.spec.id}` }] };
  });
  t.mock.method(McpClient.prototype, 'close', async function (this: McpClient) {
    closed.push(this);
    running.delete(this);
  });
  await writeFile(configPath, `schemaVersion: 1
agent: { model: test/model }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture-key
      models: { model: {} }
runtime: { python: { enabled: false } }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
telemetry: { enabled: false }
`);
  for (const [index, project] of projects.entries()) {
    await mkdir(join(project, '.pilotdeck'), { recursive: true });
    const registration = join(home, 'projects', `project-${index}`);
    await mkdir(registration, { recursive: true });
    await writeFile(join(registration, '.cwd'), project);
    await writeFile(join(project, '.pilotdeck', 'mcp.json'), JSON.stringify({ mcpServers: {
      [`project${index}_shared`]: { command: 'synthetic-mcp' },
      [`project${index}_session`]: { command: 'synthetic-mcp', perSession: true },
    } }));
  }
  const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'),
    permissionMode: 'bypassPermissions',
    env: { PATH: process.env.PATH, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath },
    __testModelFactory(snapshot) {
      return { ...createModelRuntime(snapshot.config.model),
        async *stream(request): AsyncIterable<CanonicalModelEvent> {
          yield { type: 'message_start', role: 'assistant' };
          if (!request.messages.at(-1)?.content.some(block => block.type === 'tool_result')) {
            await beforeTools?.();
            for (const tool of request.tools?.filter(tool => tool.name.startsWith('mcp__project')) ?? []) {
              const call = { id: `call-${tool.name}`, name: tool.name, input: {} };
              yield { type: 'tool_call_start', id: call.id, name: call.name };
              yield { type: 'tool_call_end', toolCall: call };
            }
            yield { type: 'message_end', finishReason: 'tool_call' };
          } else {
            assert.ok(request.messages.at(-1)!.content.every(block => block.type !== 'tool_result' || !block.isError));
            yield { type: 'text_delta', text: 'Both MCP probes completed.' };
            yield { type: 'message_end', finishReason: 'stop' };
          }
        },
        async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Reload probe"}' }], finishReason: 'stop' as const }; },
      };
    },
  });
  t.after(async () => {
    for (const index of [0, 1]) await local.gateway.closeSession({ sessionKey: `web:project-${index}` });
    local.dispose();
    assert.deepEqual(new Set(closed), new Set(clients), 'Shutdown releases all started MCP clients');
    assert.equal(closed.length, clients.length, 'Each MCP client is closed exactly once');
    await rm(home, { recursive: true, force: true });
  });
  return { local, projects, clients, running, closed, called, calledTools,
    setTools(names: string[]) { toolNames = names; },
    async turn(index: number) {
      const events: GatewayEvent[] = [];
      for await (const event of local.gateway.submitTurn({ projectKey: projects[index], sessionKey: `web:project-${index}`,
        channelKey: 'web', message: 'Run the MCP probes.' })) events.push(event);
      assert.deepEqual(events.filter(event => event.type === 'error'), []);
      assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    },
  };
}

test('project extension reload preserves other projects and replaces only the next owning session', async t => {
  const f = await fixture(t);
  await f.turn(0);
  await f.turn(1);
  const oldA = f.clients.filter(client => client.spec.id.startsWith('project0_'));
  const oldB = f.clients.filter(client => client.spec.id.startsWith('project1_'));
  assert.equal(oldA.length, 2);
  assert.equal(oldB.length, 2);
  await f.local.gateway.reloadExtensions!({ projectKey: f.projects[0] });
  assert.deepEqual(f.closed, [], 'Reload must not disconnect cached sessions or unrelated projects');
  await f.turn(1);
  assert.equal(f.clients.length, 4, 'Project B must reuse its original runtime');
  assert.ok(oldB.every(client => f.called.filter(called => called === client).length === 2));
  await f.turn(0);
  assert.equal(f.clients.length, 6, 'Project A must initialize a fresh shared and per-session client');
  assert.deepEqual(new Set(f.closed), new Set(oldA));
  assert.equal(f.closed.length, 2, 'Each replaced client closes exactly once');
  assert.ok(oldB.every(client => f.running.has(client)));
});

test('live catalog replacement reaches the next request without recreating session clients', async t => {
  const f = await fixture(t);
  await f.turn(0);
  const original = [...f.clients];
  f.setTools(['replacement']);
  await f.turn(0);
  assert.deepEqual(f.clients, original);
  assert.deepEqual(f.closed, []);
  assert.equal(f.called.length, 4, 'Both replacement tools must execute successfully on existing clients');
  assert.deepEqual(f.calledTools, ['probe', 'probe', 'replacement', 'replacement']);
});

test('session disposal alone releases its per-session MCP resources', async t => {
  const f = await fixture(t);
  const session = await f.local.registry.createSession({ sessionKey: 'orphan', projectKey: f.projects[0], channelKey: 'web' });
  const owned = f.clients.find(client => client.spec.id.endsWith('_session'))!;
  assert.ok(f.running.has(owned));
  await session.dispose();
  assert.equal(f.running.has(owned), false);
  assert.equal(f.closed.filter(client => client === owned).length, 1);
});

test('disposing a late session factory releases its own MCP lease without removing its replacement', async t => {
  const f = await fixture(t);
  const entered = deferred(), finishDiscovery = deferred();
  const listTools = McpClient.prototype.listTools;
  let first: McpClient | undefined;
  t.mock.method(McpClient.prototype, 'listTools', async function (this: McpClient, ...args: Parameters<McpClient['listTools']>) {
    if (this.spec.id.endsWith('_session') && !first) {
      first = this;
      entered.resolve();
      await finishDiscovery.promise;
    }
    return listTools.apply(this, args);
  });
  const context = { sessionKey: 'web:project-0', projectKey: f.projects[0], channelKey: 'web' };
  const pending = f.local.registry.createSession(context);
  await entered.promise;
  const replacement = await f.local.registry.createSession(context);
  const current = f.clients.find(client => client !== first && client.spec.id.endsWith('_session'))!;
  assert.ok(current);
  finishDiscovery.resolve();
  const orphan = await pending;
  await orphan.dispose();
  assert.ok(f.running.has(current), 'Old lease cleanup must not stop the newer same-key runtime');
  f.local.registry.evictSessionMcp(context.sessionKey);
  assert.equal(f.running.has(current), false, 'Old lease cleanup must not remove the newer map entry');
  await replacement.dispose();
  assert.equal(f.closed.filter(client => client === first).length, 1);
  assert.equal(f.closed.filter(client => client === current).length, 1);
});

test('global extension reload lets the active turn finish before retiring its runtime', async t => {
  const entered = deferred(), continueTurn = deferred();
  let turn: Promise<void> | undefined;
  t.after(async () => { continueTurn.resolve(); await turn?.catch(() => {}); });
  const f = await fixture(t, async () => { entered.resolve(); await continueTurn.promise; });
  const runtime = f.local.registry.resolve(f.projects[0]);
  const shutdown = t.mock.method(runtime.router, 'shutdown');
  turn = f.turn(0);
  await Promise.race([entered.promise, turn]);
  const original = [...f.clients];
  assert.equal(original.length, 2);
  await f.local.gateway.reloadExtensions!();
  assert.equal(shutdown.mock.calls.length, 0);
  assert.deepEqual(f.closed, []);
  continueTurn.resolve();
  await turn;
  assert.ok(original.every(client => f.called.includes(client)));
  assert.equal(shutdown.mock.calls.length, 0, 'The cached session still owns the runtime after its turn');
  await f.turn(0);
  assert.equal(shutdown.mock.calls.length, 1);
  assert.deepEqual(new Set(f.closed), new Set(original));
  assert.equal(f.closed.length, 2);
});

test('Gateway shutdown releases shared and per-session MCP resources exactly once', async t => {
  const f = await fixture(t);
  await f.turn(0);
  await f.turn(1);
  assert.equal(f.running.size, 4);
  f.local.dispose();
  assert.equal(f.running.size, 0);
  assert.equal(f.closed.length, 4);
  f.local.dispose();
  assert.equal(f.closed.length, 4);
});
