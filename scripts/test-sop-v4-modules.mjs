import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, createConnection } from 'node:net';
import YAML from 'yaml';
import { createLocalGateway } from '../dist/src/cli/createLocalGateway.js';
import { startGatewayServer } from '../dist/src/gateway/server/GatewayServer.js';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';
import { SopExecutionClient } from '../dist/src/sop/execution/SopExecutionClient.js';
import { createKnowledgeModulePort } from '../dist/src/composition/domainPorts.js';

const repo = resolve('.');
const root = await mkdtemp(join(tmpdir(), 'sop-v4-modules-'));
const report = { root, scenarios: [], startedAt: new Date().toISOString() };
const children = [];
const env = { ...process.env }; delete env.NODE_OPTIONS;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function freePort() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const p = s.address().port; await new Promise(done => s.close(done)); return p; }
async function tcpReady(port) { await until(() => new Promise(done => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); done(true); }); socket.once('error', () => done(false)); }), 'TCP sidecar readiness'); }
function child(name, command, args, extra = {}) {
  const fd = openSync(join(root, `${name}.log`), 'a', 0o600);
  const p = spawn(command, args, { env: { ...env, ...extra }, cwd: repo, stdio: ['ignore', fd, fd] }); closeSync(fd);
  p.finished = new Promise((done, reject) => { p.once('exit', done); p.once('error', reject); }); children.push(p); return p;
}
async function until(fn, message, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(100); } throw Error(`Timeout ${message}`); }
async function jsonFile(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return false; } }
const fixture = child('fixture', process.execPath, ['scripts/sop-v4-module-fixture.mjs'], { SOP_FIXTURE_READY: join(root, 'fixture-ready.json'), SOP_FIXTURE_LOG: join(root, 'module-calls.jsonl') });
const fixtureInfo = await until(() => jsonFile(join(root, 'fixture-ready.json')), 'fixture');
const fixtureEndpoint = `http://127.0.0.1:${fixtureInfo.port}`;
const runtimePort = await freePort(), tcpPort = await freePort();
const runtimeEndpoint = `http://127.0.0.1:${runtimePort}`;
const token = 'isolated-source-module-acceptance';
child('runtime', process.env.SOP_RUNTIME_PYTHON, ['-m', 'uvicorn', 'staffdeck_sop_runtime.execution_api_v4:app_factory', '--factory', '--host', '127.0.0.1', '--port', String(runtimePort)],
  { PYTHONPATH: join(repo, 'packages/sop-runtime/src'), SOP_V4_DB: join(root, 'runtime.sqlite'), SOP_V4_HOST_TOKEN: token });
const client = new SopExecutionClient(runtimeEndpoint, token);
await until(async () => { try { await client.preflight(); return true; } catch { return false; } }, 'runtime');
let tcp = child('tcp', process.execPath, ['dist/src/cli/pilotdeck-agent-loop-sidecar.js'], { PILOTDECK_AGENT_LOOP_TCP_PORT: String(tcpPort) });
const methods = { modelProvider: ['prepare', 'stream'], tools: ['execute'], context: ['prepare_for_model', 'apply_tool_results', 'recover_from_model_error', 'capture_turn', 'try_auto_compact'], skills: ['list', 'read'], knowledge: ['query', 'resolve_citation'] };
const contract = { modelProvider: 'pilotdeck.model/v1', tools: 'pilotdeck.tools/v1', context: 'pilotdeck.context/v1', skills: 'pilotdeck.skills/v1', knowledge: 'staffdeck.knowledge/v1' };
function external(slot) { return { enabled: true, implementationId: `source.${slot}`, contract: contract[slot], transport: 'module-http-v2', endpoint: fixtureEndpoint,
  manifestPath: `/manifest/${slot}`, callPath: `/call/${slot}`, methods: methods[slot], timeoutMs: 1500,
  ...(slot === 'tools' ? { catalog: [{ name: 'remote_lookup', description: 'External fixture tool', inputSchema: { type: 'object' }, readOnly: true, concurrencySafe: true }] } : {}) }; }
async function faults(slots) { await fetch(`${fixtureEndpoint}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ faults: slots }) }); }
let count = 0;
async function scenario(name, options = {}) {
  if (process.env.SOP_MODULE_SCENARIOS && !process.env.SOP_MODULE_SCENARIOS.split(',').includes(name)) return;
  const folder = join(root, `${++count}-${name}`); await mkdir(folder);
  const modules = { agentLoop: { enabled: true, provider: 'pilotdeck' }, tools: { enabled: true, provider: 'pilotdeck' }, context: { enabled: true, provider: 'pilotdeck' },
    skills: { enabled: false }, knowledge: { enabled: false }, modelProvider: external('modelProvider') };
  for (const slot of options.external ?? []) modules[slot] = external(slot);
  if (options.skillsNative) modules.skills = { enabled: true, provider: 'pilotdeck' };
  if (options.loop && options.loop !== 'native') modules.agentLoop = { enabled: true, implementationId: 'pilotdeck-agent-loop', contract: 'pilotdeck.agent-loop/v1', methods: ['execute', 'cancel', 'status', 'resume', 'ack'],
    ...(options.loop === 'stdio' ? { transport: 'module-stdio-v2', command: process.execPath, args: [join(repo, 'dist/src/cli/pilotdeck-agent-loop-sidecar.js')] }
      : { transport: 'module-tcp-v2', host: '127.0.0.1', port: tcpPort, connectTimeoutMs: 1000 }) };
  if (options.disable) modules[options.disable] = { enabled: false };
  const config = { schemaVersion: 1, agent: { model: 'fixture/fixture', interactionProfile: 'headless' },
    model: { providers: { fixture: { protocol: 'openai', url: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: { fixture: { capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 } } } } } }, modules };
  await writeFile(join(folder, 'pilotdeck.yaml'), YAML.stringify(config));
  if (options.skillsNative) { const skill = join(folder, '.pilotdeck/skills/source-guide'); await mkdir(skill, { recursive: true }); await writeFile(join(skill, 'SKILL.md'), '---\nname: source-guide\ndescription: Source acceptance guide\n---\n# Source guide\nSKILL_BODY_OK\n'); }
  const id = `probe-${count}`;
  const tools = options.tools ?? [];
  await client.request('/v4/definitions', undefined, { schema: 'sop.definition/v4', skill_id: id, version: '1', start_node_id: 'node', terminal_node_ids: ['node'],
    nodes: [{ node_id: 'node', instruction: `PROBE:${options.probe ?? 'none'} Complete fixture task.`, tools }], edges: [] });
  let local, server, sdk;
  const entry = { name, options, status: 'FAIL' }; report.scenarios.push(entry);
  try {
    await faults(options.faults ?? []);
    if (options.queued) {
      const queued = await client.call('run_sop', folder, { requestId: name, sopId: id, version: '1', input: { originalQuery: 'Source module acceptance' } });
      await pause(500);
      const state = await client.call('sop_status', folder, { runId: queued.runId });
      assert.equal(state.status, 'running');
      assert.ok(state.calls.every(call => call.status === 'queued'));
      entry.queuedBeforeHost = state;
    }
    local = createLocalGateway({ projectRoot: folder, fallbackProjectRoot: folder, pilotHome: folder, permissionMode: 'bypassPermissions',
      env: { ...env, PILOT_HOME: folder, PILOTDECK_CONFIG_PATH: join(folder, 'pilotdeck.yaml'), ...(options.sopOff ? {} : { PILOTDECK_SOP_V4_ENDPOINT: options.sopUnavailable ? 'http://127.0.0.1:1' : runtimeEndpoint, SOP_V4_HOST_TOKEN: token }) },
      extraTools: [{ name: 'native_probe', kind: 'custom', description: 'Native acceptance tool', inputSchema: { type: 'object' }, isReadOnly: () => true, isConcurrencySafe: () => true,
        async execute() { return { content: [{ type: 'text', text: 'NATIVE_TOOL_OK' }] }; } }] });
    server = await startGatewayServer({ gateway: local.gateway, port: 0, token: 'module-sdk' });
    sdk = createPilotDeckClient({ gatewayUrl: server.wsUrl, authToken: server.token, projectKey: folder });
    if (options.sopOff) {
      await assert.rejects(sdk.sop.call('run_sop', { requestId: name, sopId: id, version: '1', input: {} }), /unavailable/i);
      assert.equal(local.registry.resolve(folder).tools.has('run_sop'), false);
    } else {
      const run = await sdk.sop.call('run_sop', { requestId: name, sopId: id, version: '1', input: { originalQuery: 'Source module acceptance' } });
      entry.runId = run.runId;
      const state = await until(async () => { const v = await sdk.sop.call('sop_status', { runId: run.runId }); return v.status !== 'running' && v; }, name, 45000);
      entry.state = state;
      if (options.expectFailure) assert.notEqual(state.status, 'completed', JSON.stringify(state));
      else {
        assert.equal(state.status, 'completed', JSON.stringify(state));
        const result = await sdk.sop.call('sop_result', { runId: run.runId }); entry.result = result;
        const output = result.items[0].output;
        if (options.probe === 'native' || options.probe === 'external') assert.equal(output.toolMarker, true);
        if (options.probe === 'skill') assert.equal(output.skillMarker, true);
        if (options.probe === 'knowledge' || options.probe === 'citation') assert.equal(output.knowledgeMarker, true);
        if (options.external?.includes('knowledge') && !options.faults?.includes('knowledge')) {
          entry.citation = await createKnowledgeModulePort(modules.knowledge).call('resolve_citation', { chunk_id: 'chunk-source' });
          assert.equal(entry.citation.text, 'KNOWLEDGE_HIT_OK');
        }
        if (options.external?.includes('context')) assert.equal(output.contextMarker, true);
        if (!options.skillsNative && !options.external?.includes('skills')) assert.equal(output.tools.includes('read_skill'), false);
        if (!tools.includes('remote_lookup')) assert.equal(output.tools.includes('remote_lookup'), false);
      }
    }
    if (options.expectPreflightError) throw Error('Expected preflight rejection');
    entry.status = 'PASS';
  } catch (error) {
    entry.error = String(error.stack ?? error);
    if (options.expectPreflightError && new RegExp(options.expectPreflightError).test(String(error))) entry.status = 'PASS';
    else throw error;
  } finally { await sdk?.close(); await server?.close(); await local?.dispose(); await faults([]); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(`${entry.status} ${name}`);
}
try {
  await tcpReady(tcpPort);
  await scenario('native-tools-skills-off', { probe: 'native', tools: ['native_probe'] });
  await scenario('sop-unplugged', { sopOff: true });
  await scenario('sop-unavailable', { sopUnavailable: true, expectPreflightError: 'fetch failed' });
  await scenario('sop-reconnected');
  await scenario('sop-durable-queued-reconnect', { queued: true });
  await scenario('stdio-loop', { loop: 'stdio', probe: 'native', tools: ['native_probe'] });
  await scenario('tcp-loop', { loop: 'tcp', probe: 'native', tools: ['native_probe'] });
  tcp.kill('SIGTERM'); await tcp.finished;
  await scenario('tcp-loop-disconnected', { loop: 'tcp', expectFailure: true });
  tcp = child('tcp-reconnected', process.execPath, ['dist/src/cli/pilotdeck-agent-loop-sidecar.js'], { PILOTDECK_AGENT_LOOP_TCP_PORT: String(tcpPort) });
  await tcpReady(tcpPort);
  await scenario('tcp-loop-reconnected', { loop: 'tcp' });
  await scenario('external-tools', { external: ['tools'], probe: 'external', tools: ['remote_lookup'] });
  await scenario('external-tool-whitelist', { external: ['tools'] });
  await scenario('missing-tool', { tools: ['remote_lookup'], expectPreflightError: 'SOP tool unavailable' });
  await scenario('tool-disconnected', { external: ['tools'], probe: 'external', tools: ['remote_lookup'], faults: ['tools'], expectFailure: true });
  await scenario('tool-reconnected', { external: ['tools'], probe: 'external', tools: ['remote_lookup'] });
  await scenario('external-context', { external: ['context'] });
  await scenario('context-disconnected', { external: ['context'], faults: ['context'], expectFailure: true });
  await scenario('context-reconnected', { external: ['context'] });
  await scenario('native-skills', { skillsNative: true, probe: 'skill', tools: ['read_skill'] });
  await scenario('external-skills', { external: ['skills'], probe: 'skill', tools: ['read_skill'] });
  await scenario('skills-disconnected', { external: ['skills'], probe: 'skill', tools: ['read_skill'], faults: ['skills'], expectFailure: true });
  await scenario('skills-off-dependent', { tools: ['read_skill'], expectPreflightError: 'unavailable' });
  await scenario('skills-reconnected', { external: ['skills'], probe: 'skill', tools: ['read_skill'] });
  await scenario('knowledge-enabled', { external: ['knowledge'], probe: 'knowledge', tools: ['knowledge_query'] });
  await scenario('knowledge-off-dependent', { tools: ['knowledge_query'], expectPreflightError: 'unavailable' });
  await scenario('knowledge-disconnected', { external: ['knowledge'], probe: 'knowledge', tools: ['knowledge_query'], faults: ['knowledge'], expectFailure: true });
  await scenario('knowledge-reconnected', { external: ['knowledge'], probe: 'knowledge', tools: ['knowledge_query'] });
  await scenario('model-disconnected', { faults: ['modelProvider'], expectFailure: true });
  await scenario('model-reconnected');
  for (const slot of ['agentLoop', 'tools', 'context', 'modelProvider']) await scenario(`required-${slot}-off`, { disable: slot, expectPreflightError: 'MODULE_ENABLED_INVALID|required binding|enabled must be true' });
  await scenario('combined-external-tcp', { loop: 'tcp', external: ['tools', 'context', 'skills', 'knowledge'], probe: 'external', tools: ['remote_lookup'] });
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const p of children.reverse()) if (p.exitCode === null && p.signalCode === null) { p.kill('SIGTERM'); await p.finished; }
  report.finishedAt = new Date().toISOString(); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.length, root, error: report.error }));
}
