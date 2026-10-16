import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { loadPilotConfig } from '../dist/src/pilot/config/loadPilotConfig.js';
import { KNOWLEDGE_CORE_METHODS, KNOWLEDGE_AGENT_METHODS } from '../src/composition/knowledgeCoreOperations.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.KM_REVIEW_EVIDENCE || 'artifacts/pr656-review/real');
const python = process.env.KM_REVIEW_PYTHON;
assert.ok(python, 'KM_REVIEW_PYTHON must identify an independently installed wheel');
const { config: source } = loadPilotConfig({ configPath: process.env.PD_MODEL_CONFIG || join(homedir(), '.pilotdeck/pilotdeck.yaml') });
const model = process.env.PD_MODEL_ID || source.agent.model;
const providerId = model.slice(0, model.indexOf('/'));
const modelId = model.slice(model.indexOf('/') + 1);
const provider = source.model.providers[providerId];
assert.ok(provider?.models[modelId], 'Selected real model is not configured');
await mkdir(output, { recursive: true });
const report = { status: 'not_accepted', model, checks: [], pageErrors: [], failedRequests: [] };
let child, exited, browser, logFile, hostToken;
const owner = randomUUID(), capability = randomUUID();
const env = { ...process.env, NODE_OPTIONS: '', PILOT_HOME: join(output, 'home'),
  PILOTDECK_CONFIG_PATH: join(output, 'pilotdeck.yaml'), DATABASE_PATH: join(output, 'auth.sqlite'),
  HOST: '127.0.0.1', PILOTDECK_SKIP_BROWSER_OPEN: '1', PILOTDECK_DISABLE_LOCAL_AUTH: '0',
  PR656_MODEL_KEY: provider.apiKey, KM_REVIEW_OWNER: owner, KM_REVIEW_CAPABILITY: capability };
delete env.PILOTDECK_FRONTEND_PROFILE;
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
const ports = { km: await freePort(), web: await freePort(), gateway: await freePort() };
env.SERVER_PORT = String(ports.web);
env.PILOTDECK_GATEWAY_PORT = String(ports.gateway);
env.PILOTDECK_GATEWAY_URL = `ws://127.0.0.1:${ports.gateway}/ws`;
const origin = `http://127.0.0.1:${ports.web}`;
const endpoint = `http://127.0.0.1:${ports.km}`;
const binding = { enabled: true, implementationId: 'knowledge-core', frontendModule: 'knowledge-core',
  contract: 'knowledge-core/v1', transport: 'rest-http-v1', endpoint, credentialEnv: 'KM_REVIEW_OWNER',
  capabilitiesCredentialEnv: 'KM_REVIEW_CAPABILITY', pilotDeckUserId: '1', namespace: 'review',
  spaceId: 'review', spaces: [{ id: 'review', name: 'Review knowledge' }],
  methods: [...KNOWLEDGE_CORE_METHODS], agentMethods: [...KNOWLEDGE_AGENT_METHODS], timeoutMs: 120000,
  localRuntime: { python: resolve(python), dataDirectory: join(output, 'data'),
    configFile: join(output, 'configuration.json'), identityFile: join(output, 'identity.json'),
    capabilitiesFile: join(output, 'capabilities.json') } };
async function saveReport() { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
async function json(method, path, body, direct = false) {
  const response = await fetch((direct ? endpoint : origin) + path, { method,
    headers: { 'content-type': 'application/json', ...(direct ? { authorization: 'Bearer ' + owner } : hostToken ? { authorization: 'Bearer ' + hostToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify({ method, path, status: response.status, result }));
  return result;
}
async function ready(url) {
  for (let i = 0; i < 300; i++) {
    if (child?.exitCode != null || child?.signalCode != null) throw Error('PD exited before readiness');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(200);
  }
  throw Error('Readiness timed out: ' + url);
}
async function run(command, args, extraEnv = {}) {
  const processHandle = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  const [code] = await once(processHandle, 'close');
  assert.equal(code, 0, command + ' failed');
}
async function start() {
  child = spawn(process.execPath, ['ui/server/webRuntimeSupervisor.js', 'start-built'], {
    cwd: root, env, stdio: ['ignore', logFile.fd, logFile.fd] });
  exited = once(child, 'exit');
  await ready(endpoint + '/health/ready');
  await ready(origin + '/health');
  await ready(`http://127.0.0.1:${ports.gateway}/health`);
}
async function stop() {
  if (!child) return;
  child.kill('SIGINT');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Managed shutdown timed out')), 25000); })]); }
  finally { clearTimeout(timer); }
  child = undefined;
  await assert.rejects(fetch(endpoint + '/health/ready', { signal: AbortSignal.timeout(500) }));
}
try {
  await writeFile(binding.localRuntime.configFile, JSON.stringify({ preset: 'full', modules: { authentication: true } }));
  await writeFile(binding.localRuntime.identityFile, JSON.stringify({ [owner]: { id: 'review-owner', tenant_id: 'review', spaces: ['*'], permissions: ['read', 'write'] } }), { mode: 0o600 });
  await writeFile(binding.localRuntime.capabilitiesFile, JSON.stringify([{ tenant_id: 'review', space_id: 'review',
    endpoint: origin + '/api/internal/km/capabilities', credential_env: 'KM_REVIEW_CAPABILITY' }]));
  await writeFile(env.PILOTDECK_CONFIG_PATH, stringify({ schemaVersion: 1, agent: { model },
    model: { providers: { [providerId]: { ...provider, apiKey: '${PR656_MODEL_KEY}' } } }, router: { enabled: false },
    webui: { runtime: { serverPort: ports.web, databasePath: env.DATABASE_PATH, workspacesRoot: join(output, 'workspaces') } },
    modules: { knowledge: binding, sop: { enabled: false } }, frontend: { businessModules: {} } }));
  if (process.env.KM_REVIEW_SKIP_BUILD !== '1') await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web']);
  const { createKnowledgeModulePort } = await import('../dist/src/composition/domainPorts.js');
  const { createKnowledgeAgentTools } = await import('../dist/src/composition/knowledgeAgentTools.js');
  logFile = await open(join(output, 'service.log'), 'a');
  await start();
  const registration = await json('POST', '/api/auth/register', { username: 'review', password: randomUUID() });
  assert.equal(String(registration.user.id), binding.pilotDeckUserId);
  hostToken = registration.token;
  assert.ok(hostToken);
  await json('POST', '/api/km/v1/spaces', { id: 'review', name: 'Review knowledge' }, true);
  report.checks.push({ name: 'managed wheel with KM-prefixed hosted credential', status: 'passed' });
  const hosted = await fetch(origin + '/api/internal/km/capabilities/model', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + capability },
    body: JSON.stringify({ tenant_id: 'review', space_id: 'review', model_id: model,
      prompt: 'Return exactly a JSON object with review_acceptance set to true.', payload: {} }), signal: AbortSignal.timeout(120000) });
  const hostedResult = await hosted.json();
  assert.ok(hosted.ok, JSON.stringify(hostedResult));
  assert.equal(hostedResult.review_acceptance, true);
  report.checks.push({ name: 'real PD hosted model', status: 'passed', result: hostedResult });
  const parsed = await fetch(origin + '/api/internal/km/capabilities/parse', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + capability },
    body: JSON.stringify({ tenant_id: 'review', space_id: 'review', filename: 'review.md', content_base64: Buffer.from('# Review\nOriginal receipts.').toString('base64') }) });
  assert.ok(parsed.ok, await parsed.clone().text());
  report.checks.push({ name: 'real PD file parser', status: 'passed', result: await parsed.json() });
  await saveReport();
  process.env.KM_REVIEW_OWNER = owner;
  const port = createKnowledgeModulePort(binding);
  const base = await port.call('create_base', { name: 'Runtime review' });
  const job = await port.call('import_document', { knowledgeBaseId: base.id, filename: 'review.md', model_id: model,
    content_base64: Buffer.from('# Review receipts\n\nREVIEW656 requires original receipts within 30 days.').toString('base64') });
  let terminal;
  for (let i = 0; i < 360; i++) {
    terminal = await port.call('get_job', { jobId: job.id });
    if (['succeeded', 'failed', 'cancelled'].includes(terminal.status)) break;
    await delay(500);
  }
  assert.equal(terminal.status, 'succeeded', JSON.stringify(terminal));
  const docs = await port.call('list_documents', { knowledgeBaseId: base.id });
  assert.equal(docs.length, 1);
  const doc = await port.call('get_document', { documentId: docs[0].id });
  await assert.rejects(port.call('update_document', { documentId: doc.id, expected_updated_at: 'stale', content_md: 'must fail' }), { status: 409 });
  const query = await json('POST', '/api/modules/knowledge/query', { query: 'REVIEW656 original receipts', knowledge_base_ids: [base.id], use_model: false });
  assert.ok(query.result.chunks.length > 0);
  await json('POST', '/api/modules/knowledge/citation', { chunkId: query.result.chunks[0].id });
  await json('POST', '/api/km/v1/spaces', { id: 'unbound', name: 'Unbound' }, true);
  const spaces = await json('POST', '/api/modules/knowledge/call', { operation: 'list_spaces', input: {} });
  assert.deepEqual(spaces.result.map(row => row.id), ['review']);
  report.checks.push({ name: 'runtime ingestion, stale revision, legacy query and camelCase citation, space filtering', status: 'passed', document: doc.id });
  const tools = await createKnowledgeAgentTools(binding);
  const read = tools.find(tool => tool.name === 'knowledge_get_document');
  const context = { sessionId: 'review', turnId: 'review', cwd: output };
  const readback = await read.execute({ document_id: doc.id }, context);
  assert.equal(readback.data.id, doc.id);
  report.checks.push({ name: 'Agent tools against installed wheel', status: 'passed', tools: tools.map(tool => tool.name) });
  await saveReport();
  const { chromium } = createRequire(new URL('../ui/package.json', import.meta.url))('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(token => localStorage.setItem('auth-token', token), hostToken);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/modules/knowledge') && response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() }); });
  await page.goto(origin + '/knowledge');
  await page.waitForFunction(() => !document.body.textContent.includes('Reconnecting...') && !document.body.textContent.includes('Connection lost'));
  const harness = process.env.KM_BROWSER_HARNESS;
  assert.ok(harness, 'KM_BROWSER_HARNESS is required for full browser workflow');
  const { runKnowledgeAcceptance } = await import(pathToFileURL(resolve(harness)).href);
  report.browser = await runKnowledgeAcceptance(page, { screenshotPrefix: join(output, 'knowledge'), requireModelSelector: true, expectedModelId: model });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.failedRequests, []);
  await browser.close(); browser = undefined;
  await saveReport();
  await run(process.execPath, ['scripts/km-agent-management-acceptance.mjs'], {
    KM_AGENT_EVIDENCE: join(output, 'agent'), KM_AGENT_URL: endpoint,
    KM_AGENT_CREDENTIAL_ENV: 'KM_REVIEW_OWNER', PD_MODEL_ID: model,
    PD_MODEL_CONFIG: env.PILOTDECK_CONFIG_PATH,
  });
  const agent = JSON.parse(await readFile(join(output, 'agent/report.json'), 'utf8'));
  assert.equal(agent.status, 'passed');
  report.checks.push({ name: 'real Agent multi-turn management', status: 'passed', turns: agent.turns.length });
  await stop();
  await start();
  const persisted = await json('GET', '/api/km/v1/documents/' + doc.id + '?space_id=review', undefined, true);
  assert.equal(persisted.id, doc.id);
  await stop();
  report.checks.push({ name: 'restart persistence and managed shutdown', status: 'passed' });
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close();
  if (child) { try { await stop(); } catch (error) { report.cleanupError = error.stack; child?.kill('SIGKILL'); } }
  await logFile?.close();
  delete process.env.KM_REVIEW_OWNER;
  await saveReport();
  console.log(JSON.stringify({ status: report.status, error: report.error, output }));
}
