import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';
import { SopExecutionClient } from '../dist/src/sop/execution/SopExecutionClient.js';
const root = resolve(process.argv[2]);
const meta = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(root, 'private.json'), 'utf8'));
const project = join(root, 'workspace');
const runtime = new SopExecutionClient(`http://127.0.0.1:${meta.ports.runtime}`, secrets.host);
const config = YAML.parse(await readFile(join(root, 'home/pilotdeck.yaml'), 'utf8'));
const parts = config.agent.model.split('/');
const primary = { provider: parts.shift(), model: parts.join('/') };
const secondary = { provider: primary.provider, model: process.env.SOP_V4_SECOND_MODEL ?? 'qwen3.6-flash-distill' };
const key = randomBytes(4).toString('hex');
const evidence = { startedAt: new Date().toISOString(), root, revision: meta.revision, runs: {}, checks: {} };
let sdk;
async function connect() { sdk = createPilotDeckClient({ gatewayUrl: `ws://127.0.0.1:${meta.ports.gateway}/ws`, authToken: secrets.gateway, projectKey: project }); await sdk.connect(); }
async function save() { await writeFile(join(root, `acceptance-${key}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
async function wait(runId) { for (let i = 0; i < 8; i++) { const v = await sdk.sop.call('sop_wait', { runId, timeoutMs: 60000 }); if (v.status !== 'running') return v; } throw Error(`Timeout ${runId}`); }
const call = (op, input, options) => sdk.sop.call(op, input, options);
const id = name => `${name}-${key}`;
async function publish(name, nodes) { await runtime.request('/v4/definitions', undefined, { schema: 'sop.definition/v4', skill_id: id(name), version: '1',
  start_node_id: nodes[0].node_id, terminal_node_ids: [nodes.at(-1).node_id], nodes, edges: [] }); }
async function control(action) {
  const p = spawn(process.execPath, ['scripts/sop-v4-source.mjs', action, root], { cwd: meta.repo, env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { p.once('exit', done); p.once('error', reject); }); if (code !== 0) throw Error(`Control ${action} failed`);
}
async function loginRequest(route, body) {
  const r = await fetch(`http://127.0.0.1:${meta.ports.web}/api/auth/${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const v = await r.json(); if (!r.ok) throw Error(`Login HTTP ${r.status}`); return v;
}
try {
  const auth = await loginRequest('status');
  let credentials;
  if (auth.needsSetup) { credentials = { username: 'source-owner', password: randomBytes(24).toString('base64url') }; await writeFile(join(root, 'owner-login.json'), JSON.stringify(credentials), { mode: 0o600 }); await loginRequest('register', credentials); }
  else credentials = JSON.parse(await readFile(join(root, 'owner-login.json'), 'utf8'));
  const owner = await loginRequest('login', credentials);
  const registration = await fetch(`http://127.0.0.1:${meta.ports.web}/api/projects/create-workspace`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ workspaceType: 'existing', path: project }),
  });
  assert.equal(registration.ok, true, await registration.text());
  await connect();
  await publish('invoice', [{ node_id: 'extract', model: primary, input: { fields: { invoice: { source: 'attachments' } } },
    instruction: 'Extract the single invoice from input.invoice. Return completed, output {id: invoice ID string, amount: numeric amount}, reply concise. Use structured_output. No questions.' }]);
  await publish('holder', [{ node_id: 'research', model: secondary,
    instruction: 'Return completed and output {name: input.item.name, checked:true}. Local fixture, no internet research. If item.failOnce is true and attempt is 1, return failed and error {code:FIXTURE_FAILURE}; on attempt 2 return completed.' }]);
  await publish('wrapper', [{ node_id: 'nested', type: 'subflow', subSop: { sopId: id('holder'), version: '1' }, input: { fields: { item: { source: 'item' } } } }]);
  for (const name of ['serial', 'parallel', 'failure']) await publish(name, [{ node_id: 'discover', type: 'foreach', subSop: { sopId: id(name === 'parallel' ? 'wrapper' : 'holder'), version: '1' },
    instruction: `Identify Alice, Bob, Carol from originalQuery. Return completed, reply summary and TOP LEVEL foreach {items:[{itemKey:name,input:{name${name === 'failure' ? ',failOnce:name equals Bob' : ''}}}],concurrency:${name === 'serial' ? 1 : 3}}. Do not execute children.` }]);
  const files = Array.from({ length: 12 }, (_, i) => ({ clientFileId: `file-${i + 1}`, relativePath: `invoice-${i + 1}.txt`, name: `invoice-${i + 1}.txt`,
    size: Buffer.byteLength(`Invoice ID: INV-${i + 1}\nAmount: ${i + 1}\n`), mimeType: 'text/plain' }));
  const session = await sdk.sessions.create();
  const upload = await sdk.uploads.create({ projectKey: project, files });
  for (let i = 0; i < files.length; i++) await sdk.uploads.part({ uploadId: upload.uploadId, clientFileId: files[i].clientFileId, contentBase64: Buffer.from(`Invoice ID: INV-${i + 1}\nAmount: ${i + 1}\n`).toString('base64') });
  await sdk.uploads.complete({ uploadId: upload.uploadId });
  const agent = sdk.runs.start({ sessionId: session.id, runId: `source-batch-${key}`, uploadedAttachments: [{ uploadId: upload.uploadId }],
    input: { type: 'text', text: `Use execute_code and from pilotdeck_tools import run_sop to launch SOP "${id('invoice')}" version "1" for all 12 registered files. One item per file, input {files:[file]}, unique itemKey. Decide concurrency between 2 and 4. requestId="batch-${key}". Print returned runId then end with short acknowledgement. Do not read invoice contents yourself; do not wait or poll.` } });
  const events = []; for await (const event of agent.events()) events.push(event);
  const text = JSON.stringify(events);
  assert.ok(text.includes('execute_code'), text.slice(-4000));
  const batchId = text.match(/\\?"runId\\?"\s*:\s*\\?"([a-f0-9]{32})/)?.[1];
  assert.ok(batchId, text.slice(-5000)); evidence.runs.batch = batchId; await save();
  const state = await wait(batchId); assert.equal(state.status, 'completed', JSON.stringify(state));
  const result = await call('sop_result', { runId: batchId });
  assert.deepEqual(result.items.map(i => i.output.id).sort(), files.map((_, i) => `INV-${i + 1}`).sort());
  assert.equal(result.items.reduce((sum, i) => sum + i.output.amount, 0), 78);
  evidence.checks.files = { count: 12, sum: 78, concurrency: state.concurrency, state, result };
  console.log('PASS real source Agent upload + execute_code + 12 files');
  for (const name of ['serial', 'parallel', 'failure']) {
    const run = await call('run_sop', { requestId: `${name}-${key}`, sopId: id(name), version: '1', concurrency: name === 'serial' ? 1 : 3,
      input: { originalQuery: 'Company shareholders are Alice, Bob and Carol. Investigate each with configured subSOP.' } });
    evidence.runs[name] = run.runId; await save();
    let done = await wait(run.runId);
    if (name === 'failure') {
      assert.equal(done.status, 'failed', JSON.stringify(done));
      const failed = done.calls.filter(c => c.status === 'failed' && c.nodeId === 'research'); assert.equal(failed.length, 1); assert.equal(failed[0].itemKey.toLowerCase(), 'bob');
      await call('sop_retry', { runId: run.runId, requestId: `retry-${key}`, callIds: [failed[0].id] }); done = await wait(run.runId);
      assert.equal(done.calls.find(c => c.id === failed[0].id).attempt, 2);
      assert.ok(done.calls.filter(c => c.nodeId === 'research' && c.id !== failed[0].id).every(c => c.attempt === 1));
    }
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.ok(done.calls.some(c => c.nodeId === 'research' && c.model.model === secondary.model));
    const result = await call('sop_result', { runId: run.runId });
    const holders = result.items[0].output.map(item => name === 'parallel' ? item.output.output : item.output);
    assert.deepEqual(holders.map(item => item.name.toLowerCase()).sort(), ['alice', 'bob', 'carol']);
    assert.ok(holders.every(item => item.checked === true));
    evidence.checks[name] = { state: done, result };
    console.log(`PASS real source shareholders ${name}`);
  }
  await publish('approval', [{ node_id: 'approve', type: 'approval', assigneeUserId: String(owner.user.id), model: primary, instruction: 'After authorized approval return completed, reply approved, output {approved:true} using structured_output.' }]);
  const approval = await call('run_sop', { requestId: `approval-${key}`, sopId: id('approval'), version: '1', input: { originalQuery: 'Approve source acceptance' } });
  evidence.runs.approval = approval.runId;
  const before = await call('sop_status', { runId: approval.runId }); assert.equal(before.calls[0].status, 'waiting');
  const pidsBefore = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8'));
  await sdk.close(); sdk = undefined; await control('stop'); await control('start'); await connect();
  const after = await call('sop_status', { runId: approval.runId }); assert.deepEqual(after.calls, before.calls);
  const loggedIn = await loginRequest('login', credentials);
  const moduleResponse = await fetch(`http://127.0.0.1:${meta.ports.web}/api/modules/runtime`, {
    headers: { authorization: `Bearer ${loggedIn.token}` }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(moduleResponse.status, 200);
  evidence.checks.moduleRuntime = await moduleResponse.json();
  assert.equal(evidence.checks.moduleRuntime.runtime.gatewayState, 'ready');
  if (config.modules.sop?.contract === 'sop.lifecycle/v4') {
    assert.equal(evidence.checks.moduleRuntime.modules.sop.contract, 'sop.lifecycle/v4');
    assert.equal(evidence.checks.moduleRuntime.modules.sop.ready, true);
    assert.ok(!evidence.checks.moduleRuntime.runtime.unavailableSlots.includes('sop'));
  }
  const page = await fetch(`http://127.0.0.1:${meta.ports.web}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('/assets/'));
  evidence.checks.builtLoginPage = true;
  const resume = { runId: approval.runId, requestId: `resume-${key}`, callId: after.calls[0].id, waitId: after.calls[0].waitId, message: 'Approved after all source processes restarted' };
  await assert.rejects(call('sop_resume_execution', resume));
  await call('sop_resume_execution', resume, { approverAuthorization: `Bearer ${loggedIn.token}` });
  await call('sop_resume_execution', resume, { approverAuthorization: `Bearer ${loggedIn.token}` });
  const approved = await wait(approval.runId); assert.equal(approved.status, 'completed', JSON.stringify(approved));
  assert.equal((await call('sop_status', { runId: batchId })).status, 'completed');
  evidence.checks.approval = { before, after, approved, pidsBefore, pidsAfter: JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) };
  const requests = [];
  async function inspect(directory) { for (const f of await readdir(directory, { withFileTypes: true })) { const path = join(directory, f.name); if (f.isDirectory()) await inspect(path);
    else if (f.name.endsWith('.jsonl')) for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) { const v = JSON.parse(line); if (v.type === 'model_request') requests.push(v); } } }
  await inspect(join(root, 'home/projects'));
  const invoice = requests.filter(v => v.sessionId?.startsWith(`sop-v4:${batchId}:`)); assert.equal(invoice.length, 12);
  for (const v of invoice) assert.equal(new Set(JSON.stringify(v.request.messages).match(/INV-\d+/g)).size, 1);
  const roots = requests.filter(v => v.sessionId === session.id); assert.ok(roots.length); assert.ok(roots.every(v => !/INV-\d+/.test(JSON.stringify(v.request.messages))));
  evidence.checks.inputIsolation = { invoiceRequests: invoice.length, rootRequests: roots.length, onlyOwnInvoice: true, rootNoAttachmentBodies: true };
  evidence.checks.models = [...new Set(requests.filter(v => Object.values(evidence.runs).some(r => v.sessionId?.startsWith(`sop-v4:${r}:`))).map(v => `${v.request.provider}/${v.request.model}`))];
  evidence.status = 'PASS'; evidence.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: 'PASS', root, evidence: join(root, `acceptance-${key}.json`), runs: evidence.runs, models: evidence.checks.models }));
} catch (error) { evidence.status = 'FAIL'; evidence.error = String(error.stack ?? error); await save(); throw error; }
finally { await sdk?.close(); }
