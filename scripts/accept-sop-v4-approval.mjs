import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import YAML from 'yaml';
import { createLocalGateway } from '../dist/src/cli/createLocalGateway.js';
import { startGatewayServer } from '../dist/src/gateway/server/GatewayServer.js';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';
import { SopExecutionClient } from '../dist/src/sop/execution/SopExecutionClient.js';

if (process.argv[2] === '--host') {
  const root = resolve(process.argv[3]);
  const meta = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'));
  const local = createLocalGateway({ projectRoot: root, fallbackProjectRoot: root, pilotHome: root,
    env: { ...process.env, PILOT_HOME: root, PILOTDECK_CONFIG_PATH: join(root, 'pilotdeck.yaml'), TEST_SOP_TOKEN: 'approval-host-token' },
    ...(process.env.TEST_APPROVAL_DISABLED === '1' ? {} : { sopApprovalAuthority: { async authenticate({ bearer, projectKey, signal }) {
      signal?.throwIfAborted();
      if (bearer !== 'custom-verified-credential' || projectKey !== root) throw Error('Custom authority rejected');
      return { subjectId: 'custom:reviewer' };
    } } }) });
  try { await local.ready; } catch (error) { await local.dispose(); throw error; }
  const server = await startGatewayServer({ gateway: local.gateway, port: meta.gatewayPort, token: 'approval-sdk-token' });
  await writeFile(join(root, 'host-ready.json'), JSON.stringify({ pid: process.pid }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); await local.dispose(); process.exit(0); });
} else {
  const source = resolve(process.argv[2]), root = join(source, `custom-approval-${Date.now()}`);
  await mkdir(root);
  const sourceConfig = YAML.parse(await readFile(join(source, 'home/pilotdeck.yaml'), 'utf8'));
  const python = join(source, 'venv/bin/python');
  const freePort = async () => { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; };
  const runtimePort = await freePort(), gatewayPort = await freePort();
  const endpoint = `http://127.0.0.1:${runtimePort}`;
  sourceConfig.modules.sop = { enabled: true, implementationId: 'portable-sop', contract: 'sop.lifecycle/v4', transport: 'sop-http-v4', endpoint,
    credentialEnv: 'TEST_SOP_TOKEN', approval: { provider: 'disabled' } };
  sourceConfig.modules.knowledge = { enabled: false };
  await writeFile(join(root, 'pilotdeck.yaml'), YAML.stringify(sourceConfig), { mode: 0o600 });
  await writeFile(join(root, 'meta.json'), JSON.stringify({ gatewayPort }));
  const children = [];
  function start(name, command, args, extra = {}) {
    const fd = openSync(join(root, `${name}.log`), 'a', 0o600);
    const child = spawn(command, args, { env: { ...process.env, NODE_OPTIONS: '', ...extra }, stdio: ['ignore', fd, fd] }); closeSync(fd);
    child.done = new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }); children.push(child); return child;
  }
  async function stop(child) { if (child.exitCode === null) child.kill('SIGTERM'); await child.done; }
  async function until(fn) { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await new Promise(done => setTimeout(done, 100)); } throw Error('Readiness timeout'); }
  const runtime = start('runtime', python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.execution_api_v4:app_factory', '--factory', '--host', '127.0.0.1', '--port', String(runtimePort)],
    { SOP_V4_DB: join(root, 'runtime.sqlite'), SOP_V4_HOST_TOKEN: 'approval-host-token' });
  const client = new SopExecutionClient(endpoint, 'approval-host-token');
  const newSdk = () => createPilotDeckClient({ gatewayUrl: `ws://127.0.0.1:${gatewayPort}/ws`, authToken: 'approval-sdk-token', projectKey: root });
  let sdk = newSdk();
  const report = { root, checks: {} };
  let host;
  const hostReady = child => until(async () => { try { return JSON.parse(await readFile(join(root, 'host-ready.json'), 'utf8')).pid === child.pid; } catch { return false; } });
  const call = (operation, input, credential) => sdk.sop.call(operation, input, credential ? { approverAuthorization: `Bearer ${credential}` } : undefined);
  try {
    await until(async () => { try { await client.preflight(); return true; } catch { return false; } });
    await client.request('/v4/definitions', undefined, { schema: 'sop.definition/v4', skill_id: 'custom-approval', version: '1', start_node_id: 'approve', terminal_node_ids: ['approve'],
      nodes: [{ node_id: 'approve', type: 'approval', assigneeUserId: 'custom:reviewer', instruction: 'Return completed with structured_output and output {approved:true} after approval.' }], edges: [] });
    host = start('host-disabled', process.execPath, [resolve('scripts/accept-sop-v4-approval.mjs'), '--host', root], { TEST_APPROVAL_DISABLED: '1' });
    await hostReady(host); await sdk.connect();
    await assert.rejects(call('run_sop', { requestId: 'disabled', sopId: 'custom-approval', version: '1', input: {} }), /SOP_APPROVAL_UNAVAILABLE/);
    report.checks.noAuthorityRejected = true;
    await sdk.close(); sdk = newSdk(); await stop(host);
    host = start('host-first', process.execPath, [resolve('scripts/accept-sop-v4-approval.mjs'), '--host', root]); await hostReady(host); await sdk.connect();
    const run = await call('run_sop', { requestId: 'custom', sopId: 'custom-approval', version: '1', input: {} });
    const before = await call('sop_status', { runId: run.runId }); assert.equal(before.calls[0].status, 'waiting');
    const pidBefore = host.pid; await sdk.close(); sdk = newSdk(); await stop(host);
    host = start('host-recovered', process.execPath, [resolve('scripts/accept-sop-v4-approval.mjs'), '--host', root]); await hostReady(host); await sdk.connect();
    assert.notEqual(host.pid, pidBefore);
    const after = await call('sop_status', { runId: run.runId }); assert.deepEqual(after.calls, before.calls);
    const resume = { runId: run.runId, requestId: 'resume', callId: after.calls[0].id, waitId: after.calls[0].waitId, message: 'Approved by custom authority' };
    await assert.rejects(call('sop_resume_execution', resume, 'wrong'), /rejected/);
    await assert.rejects(call('sop_resume_execution', { ...resume, subjectUserId: 'custom:reviewer' }, 'custom-verified-credential'), /subject/);
    await call('sop_resume_execution', resume, 'custom-verified-credential');
    await call('sop_resume_execution', resume, 'custom-verified-credential');
    let state;
    for (let i = 0; i < 4; i++) { state = await call('sop_wait', { runId: run.runId, timeoutMs: 60000 }); if (state.status !== 'running') break; }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    await assert.rejects(access(join(root, 'auth.db')));
    report.checks.customApproval = { before, after, state, pidBefore, pidAfter: host.pid, noUserDatabase: true };
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); throw error; }
  finally { await sdk.close(); for (const child of children.reverse()) await stop(child); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ status: report.status, report: join(root, 'report.json') }));
}
