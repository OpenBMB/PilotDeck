import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';
import { SopExecutionClient } from '../dist/src/sop/execution/SopExecutionClient.js';
import { createKnowledgeModulePort } from '../dist/src/composition/domainPorts.js';

const execute = promisify(execFile);
const source = resolve(process.argv[2]), root = resolve(process.argv[3]), kmPackage = resolve(process.argv[4]);
await mkdir(root, { mode: 0o700 });
const original = YAML.parse(await readFile(join(source, 'home/pilotdeck.yaml'), 'utf8'));
const sourceSecrets = JSON.parse(await readFile(join(source, 'private.json'), 'utf8'));
const env = { ...process.env, NODE_OPTIONS: '', SOP_V4_MODEL_CONFIG: join(source, 'home/pilotdeck.yaml'),
  SOP_SOURCE_PYTHON: process.env.SOP_SOURCE_PYTHON ?? '/opt/homebrew/bin/python3.12' };
async function control(action, directory, args = [], overrides = {}) {
  return execute(process.execPath, ['scripts/sop-v4-source.mjs', action, directory, ...args], {
    env: { ...env, ...overrides }, maxBuffer: 4 * 1024 * 1024,
  });
}
const report = { checks: {}, startedAt: new Date().toISOString() };
const directories = [];
try {
  await control('start', source, ['--services-only']);
  const externalPids = JSON.parse(await readFile(join(source, 'pids.json'), 'utf8'));
  for (const mode of ['sop-only', 'km-only', 'external']) {
    const directory = join(root, mode), profilePath = join(root, mode + '.yaml');
    const config = structuredClone(original);
    if (mode === 'sop-only') config.modules.knowledge = { enabled: false };
    if (mode === 'km-only') config.modules.sop = { enabled: false };
    if (config.modules.sop.enabled) config.modules.sop.approval = { provider: 'disabled' };
    if (mode === 'external') {
      delete config.modules.sop.localRuntime;
      delete config.modules.knowledge.localRuntime;
    }
    await writeFile(profilePath, YAML.stringify(config), { mode: 0o600 });
    await control('prepare', directory, ['--profile', profilePath, '--without-web', '--knowledge-package', kmPackage]);
    directories.push(directory);
    const overrides = mode === 'external' ? { SOP_V4_HOST_TOKEN: sourceSecrets.host,
      [config.modules.knowledge.credentialEnv]: sourceSecrets.knowledge } : {};
    await control('start', directory, [], overrides);
    const meta = JSON.parse(await readFile(join(directory, 'deployment.json'), 'utf8'));
    const secrets = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8'));
    const prepared = YAML.parse(await readFile(join(directory, 'home/pilotdeck.yaml'), 'utf8'));
    const pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8'));
    assert.equal(Boolean(pids.runtime), mode === 'sop-only');
    assert.equal(Boolean(pids.knowledge), mode === 'km-only');
    assert.equal(await readFile(join(directory, 'home/auth.db')).then(() => true, () => false), false);
    const sdk = createPilotDeckClient({ gatewayUrl: `ws://127.0.0.1:${meta.ports.gateway}/ws`, authToken: secrets.gateway,
      projectKey: join(directory, 'workspace') });
    try {
      await sdk.connect();
      if (prepared.modules.sop.enabled) {
        const runtime = new SopExecutionClient(prepared.modules.sop.endpoint, mode === 'external' ? sourceSecrets.host : secrets.host);
        await runtime.request('/v4/ready');
        await runtime.request('/v4/definitions', undefined, { schema: 'sop.definition/v4', skill_id: mode, version: '1',
          start_node_id: 'work', nodes: [{ node_id: 'work', instruction: 'Return structured_output completed with output {ok:true}.' }], edges: [] });
        const run = await sdk.sop.call('run_sop', { requestId: mode, sopId: mode, version: '1', input: { originalQuery: 'Verify pure SOP' } });
        let state;
        for (let attempt = 0; attempt < 5; attempt++) { state = await sdk.sop.call('sop_wait', { runId: run.runId, timeoutMs: 60000 }); if (state.status !== 'running') break; }
        assert.equal(state.status, 'completed', JSON.stringify(state));
      }
      if (prepared.modules.knowledge.enabled) {
        process.env[prepared.modules.knowledge.credentialEnv] = mode === 'external' ? sourceSecrets.knowledge : secrets.knowledge;
        const km = createKnowledgeModulePort(prepared.modules.knowledge);
        const base = await km.call('create_base', { name: mode });
        assert.ok(base.id);
        if (mode === 'km-only') assert.equal((await fetch(prepared.modules.knowledge.endpoint + '/api/km/v1/spaces')).status, 401);
      }
    } finally { await sdk.close(); }
    await control('stop', directory, [], overrides);
    if (mode === 'external') for (const name of ['runtime', 'knowledge']) {
      process.kill(externalPids[name], 0);
      assert.equal(JSON.parse(await readFile(join(source, 'pids.json'), 'utf8'))[name], externalPids[name]);
    }
    report.checks[mode] = { status: 'PASS', noUserDatabase: true, managed: meta.managed,
      ...(mode === 'external' ? { externalProcessesPreserved: true } : {}) };
  }
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stderr ?? error.stack ?? error); throw error; }
finally {
  for (const directory of directories.reverse()) await control('stop', directory).catch(() => {});
  await control('stop', source).catch(() => {});
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, report: join(root, 'report.json') }));
