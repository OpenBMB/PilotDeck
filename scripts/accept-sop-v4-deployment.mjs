import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, cp, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import YAML from 'yaml';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: node scripts/accept-sop-v4-deployment.mjs /deployment/directory');
const secrets = Object.fromEntries((await readFile(join(root, 'private.env'), 'utf8')).trim().split('\n').map(line => line.split('=')));
const evidence = { startedAt: new Date().toISOString(), deployment: root, checks: {}, processSnapshots: [] };
const suffix = randomBytes(5).toString('hex');
let sdk;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function save() { await writeFile(join(root, `evidence-${suffix}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
async function command(args, env = {}) {
  const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw Error(`docker ${args[0]} failed: ${err.slice(-2000)}`);
  return out.trim();
}
const compose = (args, env) => command(['compose', '-p', 'sop-v4-acceptance', '-f', join(root, 'compose.yaml'), ...args], env);
async function request(url, body, headers = {}) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
const runtime = (path, body) => request(`http://127.0.0.1:18914${path}`, body, { authorization: `Bearer ${secrets.SOP_V4_HOST_TOKEN}`, 'x-sop-scope': '/workspace' });
const call = (operation, input, options) => sdk.sop.call(operation, input, options);
async function connect() {
  await sdk?.close();
  sdk = createPilotDeckClient({ gatewayUrl: 'ws://127.0.0.1:18814/ws', authToken: secrets.PILOTDECK_GATEWAY_TOKEN, projectKey: '/workspace' });
  await sdk.connect();
}
async function until(fn, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(500); }
  throw Error(`Timed out: ${label}`);
}
async function snapshot(stage) {
  const value = JSON.parse(await compose(['ps', '--format', 'json']).then(text => `[${text.split('\n').filter(Boolean).join(',')}]`));
  const inspected = JSON.parse(await command(['inspect', ...value.map(v => v.ID)]));
  evidence.processSnapshots.push({ stage, at: new Date().toISOString(), containers: value.map(v => {
    const details = inspected.find(item => item.Id.startsWith(v.ID));
    return { service: v.Service, id: v.ID, state: v.State, health: v.Health, startedAt: details.State.StartedAt,
      hostPid: details.State.Pid, restartCount: details.RestartCount, command: details.Config.Cmd };
  }) });
  await save();
}
const definition = (id, nodes) => ({ schema: 'sop.definition/v4', skill_id: id, version: '1', start_node_id: nodes[0].node_id,
  terminal_node_ids: [nodes.at(-1).node_id], nodes, edges: [] });
async function rejected(fn, label) {
  try { await fn(); } catch (error) { return { rejected: true, message: String(error.message).slice(0, 500) }; }
  throw Error(`Expected rejection: ${label}`);
}
async function leaseFor(runId) {
  const code = 'import sqlite3,json,sys; c=sqlite3.connect("/data/runtime.sqlite"); print(json.dumps([json.loads(r[0]) for r in c.execute("SELECT payload FROM sop_v4_calls WHERE run_id=?",(sys.argv[1],))]))';
  return JSON.parse(await compose(['exec', '-T', 'sop-runtime', 'python', '-c', code, runId]));
}
try {
  await compose(['config', '--quiet']);
  await snapshot('initial');
  evidence.checks.runtimeHealth = await runtime('/healthz');
  assert.equal(evidence.checks.runtimeHealth.contract, 'sop.lifecycle/v4');
  const unauth = await fetch('http://127.0.0.1:18914/v4/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  let credentials;
  const authStatus = await request('http://127.0.0.1:23314/api/auth/status');
  assert.equal(authStatus.authDisabled, undefined);
  if (authStatus.needsSetup) {
    credentials = { username: 'sop-owner', password: randomBytes(24).toString('base64url') };
    await writeFile(join(root, 'owner-login.json'), JSON.stringify(credentials), { mode: 0o600 });
    await request('http://127.0.0.1:23314/api/auth/register', credentials);
  } else credentials = JSON.parse(await readFile(join(root, 'owner-login.json'), 'utf8'));
  const login = () => request('http://127.0.0.1:23314/api/auth/login', credentials);
  const firstLogin = await login();
  evidence.checks.login = { actualHttpLogin: true, ownerId: String(firstLogin.user.id) };
  await connect();
  const modelConfig = YAML.parse(await readFile(join(root, 'home/pilotdeck.yaml'), 'utf8'));
  const modelParts = modelConfig.agent.model.split('/');
  const model = { provider: modelParts.shift(), model: modelParts.join('/') };
  const approvalId = `approval-${suffix}`;
  await runtime('/v4/definitions', definition(approvalId, [{ node_id: 'approve', type: 'approval', assigneeUserId: String(firstLogin.user.id), model,
    instruction: 'After the authorized approval response, return structured_output with status completed, reply approved and output {approved:true}. No questions or other tools.' }]));
  const run = await call('run_sop', { requestId: `approval-${suffix}`, sopId: approvalId, version: '1', concurrency: 2,
    items: [{ itemKey: 'A', input: { originalQuery: 'Approve item A' } }, { itemKey: 'B', input: { originalQuery: 'Approve item B' } }] });
  const before = await call('sop_status', { runId: run.runId });
  assert.equal(before.calls.length, 2); assert.ok(before.calls.every(c => c.status === 'waiting'));
  const cursor = (await call('sop_events', { runId: run.runId })).nextSequence;
  evidence.approvalRunId = run.runId;
  evidence.checks.approvalBeforeRestart = before;
  await save();
  await sdk.close(); sdk = undefined;
  await compose(['stop', 'web', 'gateway', 'sop-runtime']);
  await compose(['up', '-d', '--wait']);
  await snapshot('after-full-restart');
  await connect();
  const after = await call('sop_status', { runId: run.runId });
  assert.deepEqual(after.calls.map(c => [c.id, c.waitId, c.status]), before.calls.map(c => [c.id, c.waitId, c.status]));
  const loggedIn = await login();
  const a = after.calls.find(c => c.itemKey === 'A'), b = after.calls.find(c => c.itemKey === 'B');
  const resume = { runId: run.runId, requestId: `resume-A-${suffix}`, callId: a.id, waitId: a.waitId, message: 'Approve item A after process restart' };
  evidence.checks.missingApprovalIdentity = await rejected(() => call('sop_resume_execution', resume), 'missing token');
  evidence.checks.invalidApprovalIdentity = await rejected(() => call('sop_resume_execution', resume, { approverAuthorization: 'Bearer invalid' }), 'invalid token');
  evidence.checks.forgedSubject = await rejected(() => call('sop_resume_execution', { ...resume, subjectUserId: String(firstLogin.user.id) },
    { approverAuthorization: `Bearer ${loggedIn.token}` }), 'caller supplied identity');
  const authorization = { approverAuthorization: `Bearer ${loggedIn.token}` };
  await call('sop_resume_execution', resume, authorization);
  await call('sop_resume_execution', resume, authorization);
  const one = await until(async () => {
    const state = await call('sop_status', { runId: run.runId });
    const item = state.calls.find(c => c.id === a.id);
    if (['failed', 'result_unknown'].includes(item.status)) throw Error(JSON.stringify(state));
    return item.status === 'completed' && state;
  }, 'approved item A real model');
  assert.equal(one.calls.find(c => c.id === b.id).status, 'waiting');
  evidence.checks.onlyApprovedItemResumed = one;
  await call('sop_resume_execution', { ...resume, requestId: `resume-B-${suffix}`, callId: b.id, waitId: b.waitId, message: 'Approve B' }, authorization);
  const completed = await until(async () => { const state = await call('sop_status', { runId: run.runId }); return state.status !== 'running' && state; }, 'approval batch completed');
  assert.equal(completed.status, 'completed');
  const tail = await call('sop_events', { runId: run.runId, after: cursor });
  assert.ok(tail.events.every(e => e.sequence > cursor));
  assert.equal(tail.events.filter(e => e.type === 'approval_resumed').length, 2);
  evidence.checks.approvalCompleted = completed;
  evidence.checks.eventsReconnect = { cursor, tail };
  await save();
  console.log('PASS actual login + approval across full process restart + item isolation + event reconnect');

  await sdk.close(); sdk = undefined;
  await compose(['up', '-d', '--force-recreate', '--wait', 'gateway'], { SOP_V4_ACCEPTANCE_LEDGER: '/workspace/effects.jsonl' });
  await connect();
  const effectId = `effect-${suffix}`;
  const sideId = `side-effect-${suffix}`;
  await runtime('/v4/definitions', definition(sideId, [{ node_id: 'effect', tools: ['acceptance_ledger'], model,
    instruction: `You MUST call acceptance_ledger exactly once with effectId "${effectId}" before structured_output. The tool deliberately waits for the acceptance operator; do not substitute another tool.` }]));
  const killedRun = await call('run_sop', { requestId: sideId, sopId: sideId, version: '1', concurrency: 1, input: { originalQuery: 'Execute acceptance ledger once.' } });
  evidence.killedRunId = killedRun.runId;
  const ledger = async () => {
    try { return (await readFile(join(root, 'workspace/effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.effectId === effectId); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  await until(async () => (await ledger()).length === 1, 'durable effect from real model');
  const leased = (await leaseFor(killedRun.runId))[0];
  assert.equal(leased.status, 'running');
  evidence.checks.beforeKill = { callId: leased.id, status: leased.status, attempt: leased.attempt, leaseUntil: leased.lease.until, ledger: await ledger() };
  await snapshot('before-sigkill');
  await save();
  await sdk.close(); sdk = undefined;
  await compose(['kill', '-s', 'SIGKILL', 'gateway']);
  evidence.checks.kill = { signal: 'SIGKILL', at: new Date().toISOString(), target: 'gateway' };
  await compose(['up', '-d', '--wait', 'gateway'], { SOP_V4_ACCEPTANCE_LEDGER: '/workspace/effects.jsonl' });
  await snapshot('after-sigkill');
  await connect();
  const unknown = await until(async () => { const state = await call('sop_status', { runId: killedRun.runId }); return state.status !== 'running' && state; }, 'real wall clock lease expiry', 100000);
  assert.equal(unknown.status, 'result_unknown');
  assert.equal(unknown.calls[0].attempt, 1);
  assert.equal(unknown.calls[0].error.code, 'SOP_LEASE_EXPIRED');
  assert.equal((await ledger()).length, 1);
  evidence.checks.unknownRetryRejected = await rejected(() => call('sop_retry', { runId: killedRun.runId, requestId: `unknown-retry-${suffix}`, callIds: [leased.id] }), 'retry unknown');
  evidence.checks.staleSubmitRejected = await rejected(() => runtime(`/v4/calls/${leased.id}/submit`, {
    requestId: `stale-${suffix}`, leaseToken: leased.lease.token, status: 'completed', output: { fake: true } }), 'stale lease result');
  await pause(11000);
  assert.equal((await ledger()).length, 1);
  evidence.checks.sideEffectReconciliation = { status: unknown.status, call: unknown.calls[0], effectCount: (await ledger()).length,
    effectId, expectedCount: 1, reconciled: true, replayed: false, scope: 'Durable local fixture ledger; no payment/email/external business transaction' };
  await sdk.close(); sdk = undefined;
  // Remove the deliberately blocking fixture and leave the deployment usable.
  await compose(['up', '-d', '--force-recreate', '--wait', 'gateway']);
  await snapshot('final-fixture-disabled');
  const requests = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.jsonl')) for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
        const value = JSON.parse(line);
        if (value.type === 'model_request' && value.sessionId?.startsWith(`sop-v4:${run.runId}:`)) {
          requests.push({ sessionId: value.sessionId, provider: value.request.provider, model: value.request.model,
            hasAuthorizedApprovalResponse: JSON.stringify(value.request.messages).includes('Authorized approval response:') });
        }
      }
    }
  }
  await inspect(join(root, 'home/projects'));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(value => value.hasAuthorizedApprovalResponse));
  evidence.checks.actualApprovalModelRequests = requests;
  // Quiesce all writers before copying persistent data, then verify an independent restore.
  await compose(['stop', 'web', 'gateway', 'sop-runtime']);
  const backup = join(root, `backup-${suffix}`);
  await mkdir(backup, { mode: 0o700 });
  for (const directory of ['home', 'workspace', 'runtime-data']) await cp(join(root, directory), join(backup, directory), { recursive: true });
  await compose(['up', '-d', '--wait']);
  const restoredName = `sop-v4-restore-${suffix}`;
  try {
    await command(['run', '-d', '--name', restoredName, '--env-file', join(root, 'private.env'), '-e', 'SOP_V4_DB=/data/runtime.sqlite',
      '-v', `${join(backup, 'runtime-data')}:/data`, '-p', '127.0.0.1::8091', 'sop-v4-acceptance-sop-runtime']);
    const info = JSON.parse(await command(['inspect', restoredName]))[0];
    const port = info.NetworkSettings.Ports['8091/tcp'][0].HostPort;
    const restoredStatus = async runId => request(`http://127.0.0.1:${port}/v4/runs/${runId}`, undefined,
      { authorization: `Bearer ${secrets.SOP_V4_HOST_TOKEN}`, 'x-sop-scope': '/workspace' });
    const restored = await until(async () => { try { return await restoredStatus(run.runId); } catch { return false; } }, 'independent backup restore', 30000);
    assert.equal(restored.status, 'completed');
    assert.equal((await restoredStatus(killedRun.runId)).status, 'result_unknown');
    evidence.checks.backupRestore = { backup, independentContainer: true, approval: 'completed', sideEffect: 'result_unknown' };
  } finally { await command(['rm', '-f', restoredName]); }
  await snapshot('after-backup-restore');
  evidence.finishedAt = new Date().toISOString(); evidence.status = 'PASS';
  await save();
  console.log(JSON.stringify({ status: evidence.status, deployment: root, evidence: join(root, `evidence-${suffix}.json`), approvalRunId: run.runId,
    killedRunId: killedRun.runId, ledgerCount: 1, fixtureDisabled: true }));
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = String(error.stack ?? error); await save(); throw error;
} finally { await sdk?.close(); }
