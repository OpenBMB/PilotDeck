import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { createRequire } from 'node:module';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const envPath = join(qa, 'env.json'), env = JSON.parse(readFileSync(envPath, 'utf8'));
const credentials = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [];
const originalEnv = { ...env }, originalConfig = readFileSync(env.PILOTDECK_CONFIG_PATH, 'utf8');
const legacy = process.env.BINDING_QA_LEGACY === 'true';
function counts() {
  const result = spawnSync(process.env.BINDING_QA_PYTHON, [join(pd, 'scripts/staffdeck-binding/counts.py')], {
    env: { ...process.env, DATABASE_URL: `sqlite:///${qa}/sd.sqlite` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const initialCounts = counts();
const resultPath = join(qa, `special-runtime-result${process.env.BINDING_QA_RUN_LABEL ? '-' + process.env.BINDING_QA_RUN_LABEL : ''}.json`);
function restart(...names) {
  const value = spawnSync(process.execPath, [join(pd, 'scripts/staffdeck-binding/restart.mjs'), ...names], {
    cwd: pd, env: { ...process.env, BINDING_QA_ROOT: qa, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(value.status, 0, 'Isolated service restart failed');
}
async function ready(origin, path) {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + path)).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Isolated service startup timed out');
}
async function call(operation, input) {
  const response = await fetch(`${web}/api/modules/sop/management/call`, { method: 'POST',
    headers: { 'X-PilotDeck-Project': projects.a.name, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
  const value = await response.json(); assert.ok(response.ok, `${operation}: ${JSON.stringify(value)}`); return value.result;
}
async function native(path, input, kind = 'stranger') {
  const response = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/v1/pilotdeck/approvals' + path, {
    method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${credentials[kind].token}`, 'content-type': 'application/json' },
    body: input ? JSON.stringify(input) : undefined });
  const value = await response.json(); assert.ok(response.ok, `Approval HTTP ${response.status}: ${JSON.stringify(value)}`); return value;
}
let transport;
async function browserReply(sessionKey, decision, repetition) {
  const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('@playwright/test');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const viewport = repetition % 2 ? { width: 390, height: 844 } : { width: 1440, height: 960 };
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => localStorage.setItem('auth-token', 'binding-local-bypass'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${web}/p/${projects.a.name}/c/${sessionKey}`);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.locator('#approver-username').fill('binding-stranger');
    await page.locator('#approver-password').fill('binding-acceptance-only');
    await page.getByRole('dialog').getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.locator('textarea[aria-label="人工回复"]').fill(`Human decision: ${decision}. Finish the procedure with this decision.`);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/sop/resume') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /回复并恢复|Reply and resume|Reply & Resume/i }).click(),
    ]);
    assert.ok(response.ok(), await response.text());
    const receipt = await response.json();
    assert.equal(receipt.sessionId, sessionKey);
    assert.equal(receipt.accepted, true);
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(qa, `browser-approval-${decision}-${viewport.width}.png`), fullPage: true });
    return receipt;
  } finally { await browser.close(); }
}
const state = sessionKey => JSON.parse(readFileSync(join(qa,
  legacy ? 'home/sop/sessions' : `home/staffdeck/${projects.a.staffdeckBinding.bindingId}/state/sessions`,
  `${Buffer.from(sessionKey).toString('base64url')}.json`), 'utf8'));
async function turn(sessionKey, message, project = projects.a) {
  const events = [];
  for await (const event of transport.stream('submit_turn', { projectKey: project.fullPath, workspaceCwd: project.fullPath,
    sessionKey, channelKey: 'binding-test', message, mode: 'bypassPermissions' })) events.push(event);
  writeFileSync(join(qa, `${sessionKey}.json`), JSON.stringify(events, null, 2));
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
  return events;
}
async function connect() {
  transport = new GatewayTransport({ url: env.PILOTDECK_GATEWAY_URL,
    token: readFileSync(join(qa, 'home/server-token'), 'utf8').trim(), clientName: 'test', requestTimeoutMs: 180000 });
  await transport.connect();
}
async function check(name, repetition, action) {
  const start = Date.now();
  try { results.push({ name, repetition, status: 'PASS', evidence: await action(), elapsedMs: Date.now() - start }); }
  catch (error) { results.push({ name, repetition, status: 'FAIL', error: error.message, elapsedMs: Date.now() - start }); }
  writeFileSync(resultPath, JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, name, repetition);
}
try {
  // Create the supported single-user installation owner through the normal registration route.
  env.PILOTDECK_DISABLE_LOCAL_AUTH = '0'; env.STAFFDECK_APPROVAL_USER_ID = credentials.stranger.userId;
  writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 }); restart('web'); await ready(web, '/api/auth/status');
  const auth = await (await fetch(web + '/api/auth/status')).json();
  if (auth.needsSetup) {
    const response = await fetch(web + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'binding-owner', password: 'binding-isolated-owner-only' }) });
    assert.ok(response.ok); const value = await response.json();
    assert.equal(String(value.user.id), env.STAFFDECK_COPY_PILOTDECK_USER_ID);
    writeFileSync(join(qa, 'pd-owner.json'), JSON.stringify(value), { mode: 0o600 });
  }
  env.PILOTDECK_DISABLE_LOCAL_AUTH = '1'; writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 });
  if (legacy) {
    const { applyProjectBinding } = await import(join(pd, 'dist/src/pilot/staffdeck/projectBinding.js'));
    const fixed = applyProjectBinding(parse(originalConfig), projects.a.fullPath, env);
    fixed.modules.knowledge.callPath = '/v2/module/call';
    fixed.modules.knowledge.manifestPath = '/module-manifest';
    delete fixed.modules.knowledge.credentialEnv;
    env.STAFFDECK_PROJECT_BINDING_ENABLED = 'false';
    env.STAFFDECK_COPY_TARGET_AGENT_ID = projects.a.staffdeckBinding.agentId;
    writeFileSync(env.PILOTDECK_CONFIG_PATH, stringify(fixed), { mode: 0o600 });
    writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 });
  }
  restart('web', 'gateway', 'sd'); await ready(web, '/api/projects'); await ready(env.STAFFDECK_FORMAL_API_ORIGIN, '/api/health');
  await connect();
  const bases = await (await fetch(`${web}/api/modules/knowledge/call`, { method: 'POST', headers: {
    'X-PilotDeck-Project': projects.a.name, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list_bases', input: {} }) })).json();
  const kb = bases.result?.find(row => row.capability_scope === 'sop_specific');
  if (process.env.BINDING_QA_ONLY !== 'approvals') assert.ok(kb);
  const prefix = Date.now();
  const knowledgeId = `binding_private_${prefix}`, approvalId = `binding_approval_${prefix}`;
  for (const card of [
    { skill_id: knowledgeId, name: 'Cobalt private knowledge procedure', version: '1.0.0', description: 'Retrieve the cobalt approval code during authorized SOP execution',
      trigger_intents: ['BINDING_PRIVATE_COBALT'], nodes: [{ node_id: 'answer', type: 'response', name: 'Retrieve cobalt code',
        instruction: 'You must call knowledge_query for cobalt approval verification code, cite its evidence, then submit completed. Do not guess.',
        allowed_actions: process.env.BINDING_QA_REQUIRED_KNOWLEDGE === 'true' ? ['answer_user', 'call_tool:knowledge_query'] : ['answer_user'],
        capability_refs: { knowledge_base_ids: kb ? [kb.id] : [] } }], edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] },
    { skill_id: approvalId, name: 'Project A binding approval procedure', version: '1.0.0', description: 'Wait for human approval and finish with the human decision',
      trigger_intents: ['BINDING_HUMAN_APPROVAL'], nodes: [{ node_id: 'approval', type: 'handoff', name: 'Human approval',
        assignee_user_id: credentials.stranger.userId,
        instruction: 'On first entry submit_step_result status handoff and ask for approval. After a human reply, submit completed and quote the approved or rejected decision. Do not wait again.',
        allowed_actions: ['answer_user'], capability_refs: { knowledge_base_ids: [] } }],
      edges: [], start_node_id: 'approval', terminal_node_ids: ['approval'] },
  ]) {
    const draft = await call('create', { content: card });
    assert.equal((await call('validate', { sopId: card.skill_id, draftId: draft.id })).valid, true);
    await call('publish', { sopId: card.skill_id, draftId: draft.id });
  }
  for (let repetition = 0; repetition < Number(process.env.BINDING_QA_REPETITIONS || 3); repetition++) {
    if (process.env.BINDING_QA_ONLY !== 'approvals') {
    await check('L3-SOP-PRIVATE', repetition, async () => {
      const sessionKey = `binding-private-${prefix}-${repetition}`;
      const events = await turn(sessionKey, 'BINDING_PRIVATE_COBALT: execute the Cobalt private knowledge procedure to retrieve the cobalt approval verification code.');
      assert.ok(JSON.stringify(events).includes('knowledge_query'));
      assert.ok(JSON.stringify(events).includes('COBALT_SOP_8624'));
      assert.equal(state(sessionKey).state.status, 'completed');
      return { sessionKey, sopId: knowledgeId, knowledgeBaseId: kb.id, finalStatus: 'completed' };
    });
    }
    if (process.env.BINDING_QA_ONLY === 'knowledge') continue;
    for (const decision of ['approved', 'rejected']) await check(`L3-APPROVAL-${decision}`, repetition, async () => {
      const sessionKey = `binding-approval-${decision}-${prefix}-${repetition}`;
      let phase = 'create-wait';
      try {
      await turn(sessionKey, 'BINDING_HUMAN_APPROVAL: execute Project A binding approval procedure, wait for the human decision.');
      assert.equal(state(sessionKey).state.status, 'handoff');
      phase = 'switch-and-restart';
      await turn(`binding-switch-${prefix}-${repetition}-${decision}`, 'Hello, reply briefly', projects.b);
      if (repetition === 0) {
        transport.close(); restart('gateway', 'sd'); await ready(env.STAFFDECK_FORMAL_API_ORIGIN, '/api/health'); await connect();
      }
      const waiting = (await native('/' + encodeURIComponent(sessionKey))).status;
      assert.equal(waiting.state.status, 'handoff');
      const foreign = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/v1/pilotdeck/approvals/' + encodeURIComponent(sessionKey), {
        headers: { authorization: `Bearer ${credentials.other.token}` } });
      assert.equal(foreign.status, 403);
      const input = { session_key: sessionKey, request_id: `approval-${decision}-${prefix}-${repetition}`,
        wait_id: waiting.wait.id, expected_revision: waiting.revision, message: `Human decision: ${decision}. Finish the procedure with this decision.` };
      const browserApproval = process.env.BINDING_QA_BROWSER_APPROVAL === 'true';
      const receipt = browserApproval ? await browserReply(sessionKey, decision, repetition) : await native('/reply', input);
      if (!browserApproval) await native('/reply', input);
      assert.equal(receipt.accepted, true);
      phase = 'resume-decision';
      await turn(sessionKey, receipt.message);
      assert.equal(state(sessionKey).state.status, 'completed');
      const bState = join(qa, 'home/staffdeck', projects.b.staffdeckBinding.bindingId, 'state/sessions', `${Buffer.from(sessionKey).toString('base64url')}.json`);
      assert.equal(existsSync(bState), false);
      return { sessionKey, decision, sopId: approvalId, legacyFixedTarget: legacy, browserApproval, finalStatus: 'completed', replay: !browserApproval, receipt };
      } catch (error) { throw new Error(`${phase}: ${error.message}`, { cause: error }); }
    });
  }
} catch (error) { results.push({ name: 'L3-SPECIAL-SETUP', status: 'FAIL', error: error.message }); }
finally {
  transport?.close();
  if (legacy) {
    writeFileSync(env.PILOTDECK_CONFIG_PATH, originalConfig, { mode: 0o600 });
    writeFileSync(envPath, JSON.stringify(originalEnv), { mode: 0o600 });
    restart('web', 'gateway', 'sd'); await ready(web, '/api/projects');
    await ready(env.STAFFDECK_FORMAL_API_ORIGIN, '/api/health');
    const response = await fetch(`${web}/api/projects/${projects.a.name}/staffdeck-binding/ensure`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const restored = await response.json();
    const finalCounts = counts();
    results.push({ name: 'C01-RESTORE', status: restored.status === 'bound' && restored.agentId === projects.a.staffdeckBinding.agentId
      && JSON.stringify(finalCounts) === JSON.stringify(initialCounts) ? 'PASS' : 'FAIL', restored, initialCounts, finalCounts });
  }
  writeFileSync(resultPath, JSON.stringify(results, null, 2));
}
if (results.some(row => row.status === 'FAIL')) process.exitCode = 1;
