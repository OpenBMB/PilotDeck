import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import YAML from 'yaml';
import { createPilotDeckClient } from '../dist/packages/sdk/src/index.js';
import { SopExecutionClient } from '../dist/src/sop/execution/SopExecutionClient.js';
import { createKnowledgeModulePort } from '../dist/src/composition/domainPorts.js';
const root = resolve(process.argv[2]);
const meta = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(root, 'private.json'), 'utf8'));
const config = YAML.parse(await readFile(join(root, 'home/pilotdeck.yaml'), 'utf8'));
if (config.modules.knowledge.credentialEnv && !process.env[config.modules.knowledge.credentialEnv]) process.env[config.modules.knowledge.credentialEnv] = secrets.knowledge;
const project = process.env.ACCEPT_PROJECT ?? join(root, 'workspace');
const km = createKnowledgeModulePort(config.modules.knowledge);
const runtime = new SopExecutionClient(config.modules.sop.endpoint, secrets.host);
const sdk = createPilotDeckClient({ gatewayUrl: process.env.ACCEPT_GATEWAY ?? `ws://127.0.0.1:${meta.ports.gateway}/ws`, authToken: secrets.gateway, projectKey: project });
const key = randomBytes(4).toString('hex'), evidence = { key, startedAt: new Date().toISOString(), checks: {} };
const began = performance.now();
try {
  const base = await km.call('create_base', { name: `Source policy ${key}` });
  evidence.baseId = base.id;
  const job = await km.call('import_document', { knowledge_base_id: base.id, filename: 'expense.md',
    content_base64: Buffer.from('# Expense policy\n\nReimbursement requires original receipts. Submit expenses within 30 days. The acceptance code is KM42.').toString('base64') });
  let completed;
  for (let i = 0; i < 240; i++) {
    const value = await km.call('get_job', { job_id: job.id });
    if (value.status === 'succeeded') { completed = value; break; }
    if (['failed', 'cancelled'].includes(value.status)) throw Error(`Ingest ${value.status}: ${JSON.stringify(value.error)}`);
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(completed, 'Ingest timeout'); evidence.checks.ingest = completed;
  const query = await km.call('query', { query: 'What is the expense submission deadline and acceptance code?', knowledge_base_ids: [base.id], use_model: true });
  assert.ok(query.chunks?.length, 'No query evidence'); evidence.checks.query = query;
  evidence.checks.citation = await km.call('resolve_citation', { chunk_id: query.chunks[0].id });
  evidence.firstBusinessMs = performance.now() - began;
  const sopId = `km-policy-${key}`;
  await runtime.request('/v4/definitions', undefined, { schema: 'sop.definition/v4', skill_id: sopId, version: '1', start_node_id: 'research', terminal_node_ids: ['research'],
    nodes: [{ node_id: 'research', tools: ['knowledge_query', 'knowledge_resolve_citation'],
      instruction: `Call knowledge_query for expense policy in knowledge_base_ids ["${base.id}"], then knowledge_resolve_citation on an actual returned chunk id. Only after both succeed, complete with structured_output status completed, reply mentioning the deadline and code, output {deadlineDays:30,code:"KM42",citationResolved:true}.` }], edges: [] });
  await sdk.connect();
  const run = await sdk.sop.call('run_sop', { requestId: key, sopId, version: '1', input: { originalQuery: 'Research the reimbursement policy.' } });
  evidence.runId = run.runId;
  let state;
  for (let i = 0; i < 8; i++) { state = await sdk.sop.call('sop_wait', { runId: run.runId, timeoutMs: 60000 }); if (state.status !== 'running') break; }
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const results = await sdk.sop.call('sop_result', { runId: run.runId });
  assert.equal(results.items[0].output.deadlineDays, 30); assert.equal(results.items[0].output.code, 'KM42');
  const result = results.items[0].output; assert.equal(result.citationResolved, true);
  const calls = await runtime.call('sop_status', project, { runId: run.runId });
  evidence.checks.sop = { state, results }; evidence.checks.sopStatus = calls;
  const toolCalls = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
  else if (entry.name.endsWith('.jsonl')) {
        for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.sessionId?.startsWith(`sop-v4:${run.runId}:`)) toolCalls.push(record);
        }
      }
    }
  }
  if (!process.env.ACCEPT_GATEWAY) {
    await inspect(join(root, 'home/projects'));
    const invoked = toolCalls.filter(record => record.type === 'tool_call').map(record => record.call.name);
    assert.ok(invoked.includes('knowledge_query'), 'No actual KM query in node trajectory');
    assert.ok(invoked.includes('knowledge_resolve_citation'), 'No actual citation call in node trajectory');
    evidence.checks.nodeToolCalls = invoked;
  }
  const events = await runtime.call('sop_events', project, { runId: run.runId, after: 0 });
  evidence.checks.events = events;
  evidence.status = 'PASS';
} catch (error) { evidence.status = 'FAIL'; evidence.error = String(error.stack ?? error); throw error; }
finally { await sdk.close(); await writeFile(join(root, `km-acceptance-${key}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
console.log(JSON.stringify({ status: evidence.status, runId: evidence.runId, firstBusinessMs: evidence.firstBusinessMs, report: join(root, `km-acceptance-${key}.json`) }));
