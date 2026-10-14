import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

const script = fileURLToPath(import.meta.url);
const checkout = resolve(dirname(script), '../../..');
const root = process.env.SOP_ACCEPTANCE_ENV_ROOT;
assert.ok(root, 'SOP_ACCEPTANCE_ENV_ROOT must name the existing isolated acceptance environment');
const sd = process.env.STAFFDECK_CHECKOUT;
const python = process.env.SOP_RUNTIME_PYTHON;
assert.ok(sd && python, 'STAFFDECK_CHECKOUT and SOP_RUNTIME_PYTHON are required');
const evidence = join(root, 'evidence');
const run = process.env.SOP_PUBLIC_APPROVAL_RUN || await mkdtemp(join(root, 'public-approval-'));
const project = join(run, 'project');
const home = join(run, 'home');
const ports = { sd: 26390, runtime: 26391, gateway: 26393, web: 26395, vite: 26396 };
const sdOrigin = `http://127.0.0.1:${ports.sd}`;
const runtimeOrigin = `http://127.0.0.1:${ports.runtime}`;
const webOrigin = `http://127.0.0.1:${ports.web}`;
const children = new Map();
const base = { ...process.env }; delete base.NODE_OPTIONS;
const envFile = join(run, 'env.json');

if (process.argv[2] === '--gateway') {
  Object.assign(process.env, JSON.parse(await readFile(envFile, 'utf8')));
  const { createLocalGateway } = await import('../../../dist/src/cli/createLocalGateway.js');
  const { startGatewayServer } = await import('../../../dist/src/gateway/server/GatewayServer.js');
  const local = createLocalGateway({ projectRoot: project, fallbackProjectRoot: project,
    pilotHome: home, permissionMode: 'bypassPermissions' });
  const server = await startGatewayServer({ gateway: local.gateway, host: '127.0.0.1', port: ports.gateway,
    token: (await readFile(join(home, 'server-token'), 'utf8')).trim(),
    publicApprovals: local.getPublicApprovals(), publicHostCapabilities: principal => local.getPublicHostCapabilities(principal) });
  local.bindServer(server);
  process.once('SIGTERM', async () => { await server.close(); await local.dispose(); process.exit(0); });
} else if (process.argv[2] === '--auth') {
  const express = createRequire(join(checkout, 'ui/package.json'))('express');
  const { initializeDatabase } = await import('../../../ui/server/database/db.js');
  const { default: auth } = await import('../../../ui/server/routes/auth.js');
  await initializeDatabase();
  const app = express(); app.use(express.json()); app.use('/api/auth', auth);
  const server = app.listen(ports.web, '127.0.0.1');
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  await main();
}

async function start(name, command, args, cwd, env) {
  const log = await open(join(run, `${name}.log`), 'a', 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  await log.close(); children.set(name, child);
  child.once('error', error => { child.launchError = error; });
  return child.pid;
}
async function stop(name) {
  const child = children.get(name);
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(done => child.once('exit', done));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  await exited; clearTimeout(timeout);
}
async function ready(name, url) {
  for (let i = 0; i < 240; i++) {
    const child = children.get(name);
    assert.ok(!child?.launchError && child?.exitCode === null, `${name} stopped; inspect ${run}/${name}.log`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`${name} startup timed out; inspect ${run}/${name}.log`);
}
async function json(url, { token, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${new URL(url).pathname}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function main() {
  await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  const credentials = JSON.parse(await readFile(join(evidence, 'credentials.json'), 'utf8'));
  const source = YAML.parse(await readFile(process.env.SOP_ACCEPTANCE_MODEL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml', 'utf8'));
  const selected = process.env.SOP_ACCEPTANCE_MODEL || 'provider1/qwen3.6-flash-distill';
  const [providerId, modelId] = selected.split('/');
  const provider = structuredClone(source.model.providers[providerId]);
  provider.models = { [modelId]: provider.models[modelId] };
  const sopId = `public_approval_${Date.now()}`;
  const card = { skill_id: sopId, version: '1.0.0', name: `Public approval ${sopId}`,
    description: 'Wait for human approval, then quote the human decision and complete.', trigger_intents: [sopId],
    start_node_id: 'approval', terminal_node_ids: ['approval'], edges: [], nodes: [{ node_id: 'approval',
      name: 'Human approval', type: 'handoff', assignee_user_id: 'sop-reviewer', assignee_notify_channel: 'web',
      instruction: 'On first entry submit_step_result status handoff. After human reply, submit completed quoting the decision. Do not wait again.' }] };
  const config = { schemaVersion: 1, agent: { model: selected, maxContextTokens: 65536, maxOutputTokens: 8192 },
    model: { providers: { [providerId]: provider } }, memory: { enabled: false },
    webui: { runtime: { host: '127.0.0.1', serverPort: ports.web, databasePath: join(home, 'auth.db'), workspacesRoot: run } },
    modules: { agentLoop: { enabled: true, provider: 'pilotdeck' }, modelProvider: { enabled: true, provider: 'pilotdeck' },
      tools: { enabled: true, provider: 'pilotdeck' }, sop: { enabled: true, implementationId: 'portable-sop',
        contract: 'sop.lifecycle/v3', transport: 'sop-http-v3', endpoint: runtimeOrigin, manifestPath: '/healthz',
        definitionsPath: join(project, 'onboarding.yaml'), defaultSopId: sopId,
        runtimeSopScope: { tenantId: 'sop-acceptance', agentId: credentials.agentId },
        discoveryEndpoint: `${sdOrigin}/api/v1`, discoveryAgentId: credentials.agentId,
        discoveryApiKey: credentials.management.key, timeoutMs: 120000 } } };
  await writeFile(join(home, 'pilotdeck.yaml'), YAML.stringify(config), { mode: 0o600 });
  await writeFile(join(project, 'onboarding.yaml'), YAML.stringify({ sops: [card] }));
  await writeFile(join(home, 'server-token'), 'sop-public-approval-local-only', { mode: 0o600 });
  let env = { ...base, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'),
    DATABASE_PATH: join(home, 'auth.db'), PILOTDECK_DISABLE_LOCAL_AUTH: '0', HOST: '127.0.0.1', SERVER_PORT: String(ports.web),
    STAFFDECK_PROJECT_BINDING_ENABLED: 'false', STAFFDECK_FORMAL_API_ORIGIN: sdOrigin,
    STAFFDECK_COPY_TENANT_ID: 'sop-acceptance', STAFFDECK_COPY_ACTOR_USER_ID: 'sop-actor',
    STAFFDECK_COPY_TARGET_AGENT_ID: credentials.agentId, STAFFDECK_COPY_USER_TOKEN: credentials['sop-actor'].token,
    STAFFDECK_SOP_MANAGEMENT_API_KEY: credentials.management.key,
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: credentials.management.credentialId, STAFFDECK_APPROVAL_USER_ID: 'sop-reviewer',
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_GATEWAY_TOKEN_PATH: join(home, 'server-token'),
    SOP_PUBLIC_APPROVAL_RUN: run };
  let remote;
  const result = { status: 'RUNNING', run, model: selected, sopId, cases: [] };
  const staffOnly = process.env.SOP_ACCEPTANCE_STAFF_RESTART_ONLY === 'true';
  const save = async () => writeFile(join(evidence, staffOnly ? 'staffdeck-process-restart.json' : 'pilotdeck-public-approval.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  try {
    await start('auth', process.execPath, ['--import', 'tsx', script, '--auth'], checkout, env);
    await ready('auth', `${webOrigin}/api/auth/status`);
    const owner = await json(`${webOrigin}/api/auth/register`, { body: { username: 'sop-owner', password: 'sop-local-owner-only' } });
    await writeFile(join(run, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    env.STAFFDECK_COPY_PILOTDECK_USER_ID = String(owner.user.id);
    await writeFile(envFile, JSON.stringify(env), { mode: 0o600 });
    await stop('auth');
    const sdEnv = { ...base, ULTRARAG_DOTENV: join(root, 'absent.env'),
      DATABASE_URL: `sqlite:///${root}/staffdeck.sqlite`, DEMO_SEED_ENABLED: 'false', APP_SECRET: 'sop-isolated-local-acceptance',
      HARNESS_V3_ROOT: process.env.HARNESS_V3_ROOT, HARNESS_V3_HOME: join(root, 'sd-home'),
      HARNESS_RUNTIME_CONFIG_PATH: join(root, 'sd-runtime.json'), SOP_RUNTIME_ENDPOINT: runtimeOrigin, SOP_RUNTIME_LEGACY_WRITES: 'disabled',
      PYTHONPATH: `${sd}/backend:${sd}/backend/src:${sd}/portable_sop/src`, PILOTDECK_DOMAIN_HOST_ENABLED: 'true',
      PILOTDECK_GATEWAY_URL: env.PILOTDECK_GATEWAY_URL, PILOTDECK_GATEWAY_TOKEN_PATH: env.PILOTDECK_GATEWAY_TOKEN_PATH,
      PILOTDECK_USER_ID: env.STAFFDECK_COPY_PILOTDECK_USER_ID, STAFFDECK_COPY_TENANT_ID: 'sop-acceptance',
      STAFFDECK_COPY_ACTOR_USER_ID: 'sop-actor', STAFFDECK_COPY_TARGET_AGENT_ID: credentials.agentId };
    const startSD = async () => { const pid = await start('sd', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.sd)], sd, sdEnv);
      await ready('sd', `${sdOrigin}/api/health`); return pid; };
    const startGateway = async () => { const pid = await start('gateway', process.execPath, [script, '--gateway'], project, env);
      await ready('gateway', `http://127.0.0.1:${ports.gateway}/health`); return pid; };
    await start('runtime', python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.api:app', '--host', '127.0.0.1', '--port', String(ports.runtime)], sd,
      { ...base, PYTHONPATH: `${sd}/portable_sop/src`, SOP_RUNTIME_DB: join(root, 'runtime.sqlite') });
    await ready('runtime', `${runtimeOrigin}/healthz`);
    let sdPid = await startSD();
    const created = await json(`${sdOrigin}/api/enterprise/skills?agent_id=${credentials.agentId}`, {
      token: credentials['sop-actor'].token, body: { tenant_id: 'sop-acceptance', content: card } });
    assert.equal(created.skill_id, sopId);
    await json(`${sdOrigin}/api/enterprise/skills/${sopId}/publish?tenant_id=sop-acceptance&agent_id=${credentials.agentId}`, {
      token: credentials['sop-actor'].token, method: 'POST' });
    let gatewayPid = await startGateway();
    await start('web', process.execPath, ['--import', 'tsx', join(checkout, 'ui/server/index.js')], checkout, env);
    await ready('web', `${webOrigin}/api/auth/status`);
    const registered = await json(`${webOrigin}/api/projects/create`, { token: owner.token, body: { path: project } });
    const generation = await start('generate', process.execPath, [join(checkout, 'scripts/generate-frontend-modules.mjs')], checkout, env);
    await new Promise(done => children.get('generate').once('exit', done));
    assert.equal(children.get('generate').exitCode, 0, `frontend generation failed (${generation})`);
    await start('vite', process.execPath, [join(checkout, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(ports.vite), '--strictPort'], join(checkout, 'ui'), env);
    await ready('vite', `http://127.0.0.1:${ports.vite}`);
    const { RemoteGateway } = await import('../../../dist/src/gateway/client/RemoteGateway.js');
    const { GatewayWsClient } = await import('../../../dist/src/gateway/client/GatewayWsClient.js');
    const connect = async () => {
      const client = new GatewayWsClient({ url: env.PILOTDECK_GATEWAY_URL,
        token: 'sop-public-approval-local-only', requestTimeoutMs: 180000 });
      await client.connect();
      const gateway = new RemoteGateway(client);
      gateway.close = () => client.close();
      return gateway;
    };
    remote = await connect();
    const turn = async (sessionKey, message) => {
      const events = [];
      for await (const event of remote.submitTurn({ sessionKey, projectKey: project, workspaceCwd: project,
        channelKey: 'public-approval', message, mode: 'bypassPermissions' })) events.push(event);
      await writeFile(join(run, `${sessionKey}-events-${Date.now()}.json`), JSON.stringify(events), { mode: 0o600 });
      assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
      return events;
    };
    const { chromium } = createRequire(join(checkout, 'ui/package.json'))('@playwright/test');
    for (const width of staffOnly ? [] : [1440, 390]) {
      const sessionKey = `web:s_${randomUUID()}`;
      await turn(sessionKey, `Execute ${sopId}, ${card.name}; request operator approval and wait for the human decision.`);
      const statusInput = { sessionKey, projectKey: project, approverAuthorization: `Bearer ${credentials['sop-reviewer'].token}` };
      const before = await remote.sopStatus(statusInput);
      assert.equal(before?.state.status, 'handoff'); assert.ok(before.approval);
      remote.close(); await stop('gateway'); await stop('sd');
      const oldPids = { sd: sdPid, gateway: gatewayPid };
      sdPid = await startSD(); gatewayPid = await startGateway(); remote = await connect();
      const after = await remote.sopStatus(statusInput);
      assert.deepEqual(after, before, 'original public approval changed across host restart');
      const browser = await chromium.launch({ headless: true, channel: 'chrome' });
      try {
        const context = await browser.newContext({ viewport: { width, height: 960 } });
        await context.addInitScript(token => localStorage.setItem('auth-token', token), owner.token);
        const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
        page.setDefaultTimeout(30000);
        await page.goto(`http://127.0.0.1:${ports.vite}/p/${encodeURIComponent(registered.project.name)}/c/${sessionKey}`, { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: join(evidence, `pd-shell-${width}.png`), fullPage: true });
        await writeFile(join(run, `browser-body-${width}.txt`), await page.locator('body').innerText());
        await page.locator('button').filter({ has: page.locator('svg.lucide-log-in') }).click();
        await page.locator('#approver-username').fill('sop-reviewer');
        await page.locator('#approver-password').fill('sop-acceptance-local-only');
        await page.getByRole('dialog').locator('button[type=submit]').click();
        await page.locator('textarea[aria-label="人工回复"]').fill(`Approved SOP_PUBLIC_${width}. Complete with this human decision.`);
        await page.screenshot({ path: join(evidence, `pd-approval-before-${width}.png`), fullPage: true });
        const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/sop/resume') && r.request().method() === 'POST'),
          page.getByRole('button', { name: '回复并恢复' }).click()]);
        assert.ok(response.ok(), await response.text());
        const receipt = await response.json(); assert.equal(receipt.accepted, true);
        const originalInput = response.request().postDataJSON();
        const duplicate = await json(`${webOrigin}/api/sop/resume`, { token: owner.token, body: originalInput,
          headers: { 'X-StaffDeck-Approver-Authorization': `Bearer ${credentials['sop-reviewer'].token}` } });
        assert.equal(duplicate.duplicate, true);
        await page.locator('button.home-send-button[type=submit]').click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: join(evidence, `pd-approval-after-${width}.png`), fullPage: true });
        assert.deepEqual(errors, []); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        // The existing browser interaction prepares the message, then the user sends it.
        let completed;
        for (let i = 0; i < 120; i++) {
          completed = await remote.sopStatus(statusInput);
          if (completed?.state.status === 'completed') break;
          await new Promise(done => setTimeout(done, 1000));
        }
        assert.equal(completed?.state.status, 'completed');
        result.cases.push({ width, sessionKey, status: 'PASS', oldPids, restartedPids: { sd: sdPid, gateway: gatewayPid },
          waitId: before.wait.id, waitingRevision: before.revision, finalRevision: completed.revision, duplicate: duplicate.duplicate });
        await save(); console.log(`PASS public browser approval ${width}, hosts restarted, revision ${completed.revision}`);
      } finally { await browser.close(); }
    }
    await stop('sd'); sdEnv.PILOTDECK_DOMAIN_HOST_ENABLED = 'false'; sdPid = await startSD();
    const staffSession = await json(`${sdOrigin}/api/chat/sessions`, { token: credentials['sop-actor'].token,
      body: { tenant_id: 'sop-acceptance', agent_id: credentials.agentId, title: 'StaffDeck process restart approval' } });
    const staffTurn = await json(`${sdOrigin}/api/chat/turn`, { token: credentials['sop-actor'].token, body: {
      tenant_id: 'sop-acceptance', agent_id: credentials.agentId, session_id: staffSession.id,
      model_config_id: credentials.modelConfigId, message: `/sop ${sopId} Request human approval and wait.` } });
    await writeFile(join(run, 'staff-turn.json'), JSON.stringify(staffTurn), { mode: 0o600 });
    const handoffs = await json(`${sdOrigin}/api/chat/handoffs?tenant_id=sop-acceptance&status=all`, { token: credentials['sop-reviewer'].token });
    const pending = handoffs.find(row => row.session_id === staffSession.id && row.status === 'pending');
    assert.ok(pending, 'StaffDeck did not persist the human wait');
    const beforeSD = sdPid; await stop('sd'); sdPid = await startSD();
    const reply = await json(`${sdOrigin}/api/chat/handoffs/${pending.id}/reply`, { token: credentials['sop-reviewer'].token,
      body: { tenant_id: 'sop-acceptance', reply: 'Approved STAFFDECK_RESTART_1014. Finish with this decision.' } });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    const runtimeIds = database.prepare('SELECT session_id FROM sop_sessions').all()
      .map(row => row.session_id).filter(id => id.includes(staffSession.id));
    database.close(); assert.ok(runtimeIds.length, 'StaffDeck Runtime state missing');
    let resumedHandoff, completedStates;
    for (let i = 0; i < 120; i++) {
      const rows = await json(`${sdOrigin}/api/chat/handoffs?tenant_id=sop-acceptance&status=all`, { token: credentials['sop-reviewer'].token });
      resumedHandoff = rows.find(row => row.id === pending.id);
      completedStates = await Promise.all(runtimeIds.map(id => json(`${runtimeOrigin}/v1/sessions/${encodeURIComponent(id)}`)));
      if (completedStates.every(value => value.state.status === 'completed')) break;
      await new Promise(done => setTimeout(done, 1000));
    }
    assert.ok(completedStates.every(value => value.state.status === 'completed'), 'StaffDeck did not complete after restart');
    result.cases.push({ host: 'staffdeck', status: 'PASS', sessionKey: staffSession.id, handoffId: pending.id,
      oldPid: beforeSD, restartedPid: sdPid, replyStatus: reply.status, handoffStatus: resumedHandoff.status,
      runtimeStates: completedStates.map(value => value.state) });
    result.status = 'PASS'; await save();
  } catch (error) {
    result.status = 'FAIL'; result.error = error.message; await save(); throw error;
  } finally {
    remote?.close();
    for (const name of ['vite', 'web', 'gateway', 'sd', 'runtime', 'auth']) await stop(name);
  }
}
