import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { chromium } from 'playwright';
import { loadPilotConfig } from '../dist/src/pilot/config/loadPilotConfig.js';
import { createModelRuntime } from '../dist/src/model/ModelRuntime.js';
import { createKnowledgeModulePort, createKnowledgeQueryTool } from '../dist/src/composition/domainPorts.js';
import { createLocalGateway } from '../dist/src/cli/createLocalGateway.js';
import { KNOWLEDGE_CORE_METHODS } from '../src/composition/knowledgeCoreOperations.mjs';

const root = resolve(import.meta.dirname, '..');
const staff = process.env.STAFFDECK_ROOT;
assert.ok(staff, 'STAFFDECK_ROOT supplies build artifacts, never runtime imports');
const evidence = process.env.KM_PLUGIN_EVIDENCE || join(staff, 'knowledge_core/acceptance/2026-10-14/plugin-convergence/pd-model');
const temp = await mkdtemp(join(tmpdir(), 'km-pd-plugin-'));
const ports = { km: 18871, api: 18872, vite: 18873, gateway: 18874 };
const report = { status: 'not_accepted', isolation: { staffdeck_service: false, km_from_wheel: true }, requests: [], modelProbe: [] };
const children = [];
const runtimeRoot = join(temp, 'pilotdeck-artifact');
const browserScript = join(temp, 'browser-acceptance.mjs');
let browser;
let acceptancePage;
let agentGateway;
await mkdir(evidence, { recursive: true });
function start(name, executable, args, env, cwd = root) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const handle = { name, child, logs: () => logs }; children.push(handle); return handle;
}
async function stop(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
    const deadline = Date.now() + 20000;
    while (handle.child.exitCode === null && handle.child.signalCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.forced = true;
      const exited = new Promise(resolve => handle.child.once('exit', resolve));
      process.kill(-handle.child.pid, 'SIGKILL');
      await exited;
    }
  }
}
async function wait(url) {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw Error('Service did not become ready: ' + url);
}
try {
  await mkdir(runtimeRoot, { recursive: true });
  await cp(join(root, 'dist/src'), join(runtimeRoot, 'src'), { recursive: true });
  await cp(join(root, 'ui/server'), join(runtimeRoot, 'ui/server'), { recursive: true, filter: path => !/\.test\.[cm]?js$/.test(path) });
  await cp(join(root, 'ui/dist'), join(runtimeRoot, 'ui/dist'), { recursive: true });
  await cp(join(root, 'ui/public'), join(runtimeRoot, 'ui/public'), { recursive: true });
  await cp(join(root, 'ui/shared'), join(runtimeRoot, 'ui/shared'), { recursive: true });
  await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
  await cp(join(root, 'scripts/check-node-runtime.mjs'), join(runtimeRoot, 'scripts/check-node-runtime.mjs'));
  await writeFile(join(runtimeRoot, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(runtimeRoot, 'node_modules'), 'dir');
  await symlink(join(root, 'ui/node_modules'), join(runtimeRoot, 'ui/node_modules'), 'dir');
  await cp(join(staff, 'packages/knowledge-ui/browser-acceptance.mjs'), browserScript);
  report.isolation.staffdeck_source = false;
  report.isolation.pilotdeck_from_build = true;
  const source = process.env.PD_MODEL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml';
  const { config: existing } = loadPilotConfig({ configPath: source });
  const raw = parse(await readFile(source, 'utf8'));
  const modelRuntime = createModelRuntime(existing.model);
  const candidates = Object.entries(existing.model.providers).flatMap(([provider, row]) => Object.keys(row.models).map(model => ({ id: provider + '/' + model, provider, model })))
    .filter(candidate => !process.env.PD_MODEL_ID || candidate.id === process.env.PD_MODEL_ID)
    .sort((a, b) => Number(b.id === existing.agent.model.id) - Number(a.id === existing.agent.model.id) || a.id.localeCompare(b.id));
  let selected;
  for (const candidate of candidates) {
    try {
      const result = await modelRuntime.complete({ provider: candidate.provider, model: candidate.model,
        systemPrompt: 'Return exactly a JSON object with km_acceptance set to true.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Temporary knowledge acceptance' }] }], maxOutputTokens: 128 },
        { signal: AbortSignal.timeout(30000) });
      const text = result.content.filter(row => row.type === 'text').map(row => row.text).join('');
      assert.equal(JSON.parse(text.replace(/^\`\`\`(?:json)?\s*/, '').replace(/\s*\`\`\`$/, '')).km_acceptance, true);
      report.modelProbe.push({ ...candidate, status: 'passed', valid_result: true }); selected = candidate; break;
    } catch (error) { report.modelProbe.push({ ...candidate, status: 'failed', error_type: error.name }); }
  }
  assert.ok(selected, 'Existing PD models are unavailable; a stub cannot pass');
  report.selectedModel = selected;
  const hostEnv = { KM_PD_OWNER: 'isolated-km-owner', KM_PD_CAPABILITY: 'isolated-km-capability',
    PILOT_HOME: join(temp, 'pd-home'), PILOTDECK_CONFIG_PATH: join(temp, 'pd.yaml'), PILOTDECK_FRONTEND_PROFILE: join(temp, 'pd.yaml'),
    SERVER_PORT: String(ports.api), VITE_PORT: String(ports.vite), PILOTDECK_GATEWAY_PORT: String(ports.gateway),
    PILOTDECK_GATEWAY_URL: 'ws://127.0.0.1:' + ports.gateway + '/ws', PILOTDECK_MODULE_ADMIN: '1', PILOTDECK_DISABLE_LOCAL_AUTH: '0',
    NODE_OPTIONS: '', STAFFDECK_KM_URL: '', PYTHONPATH: '' };
  const providers = {};
  for (const [id, provider] of Object.entries(raw.model.providers)) {
    if (!existing.model.providers[id]) continue;
    const envName = 'KM_ACCEPTANCE_PROVIDER_' + Object.keys(providers).length;
    hostEnv[envName] = existing.model.providers[id].apiKey;
    providers[id] = { ...provider, apiKey: '${' + envName + '}' };
  }
  const binding = { enabled: true, implementationId: 'knowledge-core', frontendModule: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1',
    endpoint: 'http://127.0.0.1:' + ports.km, credentialEnv: 'KM_PD_OWNER', capabilitiesCredentialEnv: 'KM_PD_CAPABILITY',
    namespace: 'pd-acceptance', pilotDeckUserId: '__USER__', spaceId: 'pd-space', spaces: [{ id: 'pd-space', name: 'PilotDeck acceptance' }],
    methods: [...KNOWLEDGE_CORE_METHODS], timeoutMs: 120000 };
  const profile = { schemaVersion: 1, agent: { model: selected.id }, model: { providers }, router: { enabled: false },
    webui: { runtime: { serverPort: ports.api, vitePort: ports.vite, databasePath: join(temp, 'auth.sqlite'), workspacesRoot: join(temp, 'workspaces') } },
    modules: { knowledge: binding, sop: { enabled: false } }, frontend: { businessModules: { 'agent.routing': { enabled: false } } } };
  await writeFile(hostEnv.PILOTDECK_CONFIG_PATH, stringify(profile));
  await mkdir(hostEnv.PILOT_HOME, { recursive: true });
  const identity = join(temp, 'identity.json'), capabilities = join(temp, 'capabilities.json');
  await writeFile(identity, JSON.stringify({ [hostEnv.KM_PD_OWNER]: { id: 'pd-owner', tenant_id: binding.namespace, spaces: ['*'], permissions: ['read', 'write'] } }));
  await writeFile(capabilities, JSON.stringify([{ tenant_id: binding.namespace, space_id: binding.spaceId, endpoint: 'http://127.0.0.1:' + ports.api + '/api/internal/km/capabilities', credential_env: 'KM_PD_CAPABILITY' }]));
  execFileSync('/Users/a1/.local/bin/uv', ['venv', join(temp, 'venv'), '--python', join(staff, 'backend/.venv/bin/python')], { stdio: 'ignore' });
  execFileSync('/Users/a1/.local/bin/uv', ['pip', 'install', '--python', join(temp, 'venv/bin/python'), join(staff, 'knowledge_core/dist/knowledge_core-0.1.0-py3-none-any.whl')], { stdio: 'ignore' });
  const kmConfig = join(temp, 'km-full.json');
  await writeFile(kmConfig, JSON.stringify({ preset: 'full', modules: { authentication: true } }));
  start('km', join(temp, 'venv/bin/python'), ['-m', 'knowledge_core.cli', '--config', kmConfig, '--database-url', 'sqlite:///' + join(temp, 'km.sqlite'), '--identity-file', identity, '--capabilities-file', capabilities, '--port', String(ports.km)], hostEnv, temp);
  await wait(binding.endpoint + '/health/ready');
  const authHeaders = { authorization: 'Bearer ' + hostEnv.KM_PD_OWNER, 'content-type': 'application/json' };
  assert.equal((await fetch(binding.endpoint + '/api/km/v1/spaces', { method: 'POST', headers: authHeaders, body: JSON.stringify({ id: binding.spaceId, name: 'PD acceptance' }) })).status, 201);
  ports.vite = ports.api;
  let pd = start('pilotdeck-bootstrap', process.execPath, ['ui/server/index.js'], hostEnv, runtimeRoot);
  await wait('http://127.0.0.1:' + ports.vite + '/api/auth/status');
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const registration = await context.request.post('http://127.0.0.1:' + ports.vite + '/api/auth/register', { data: { username: 'km-acceptance', password: 'temporary-knowledge-password' } });
  assert.ok(registration.ok(), await registration.text());
  const account = await registration.json(); binding.pilotDeckUserId = String(account.user.id);
  await context.request.post('http://127.0.0.1:' + ports.vite + '/api/user/complete-onboarding', { headers: { authorization: 'Bearer ' + account.token } });
  await writeFile(hostEnv.PILOTDECK_CONFIG_PATH, stringify(profile));
  await stop(pd);
  pd = start('pilotdeck', process.execPath, ['ui/server/index.js'], hostEnv, runtimeRoot);
  start('gateway', process.execPath, ['src/cli/pilotdeck.js', 'server'], hostEnv, runtimeRoot);
  await wait('http://127.0.0.1:' + ports.vite + '/api/auth/status');
  await wait('http://127.0.0.1:' + ports.gateway + '/health');
  const page = await context.newPage(); acceptancePage = page;
  report.pageErrors = []; page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', async response => {
    if (!response.url().includes('/api/modules/knowledge')) return;
    const row = { url: response.url(), method: response.request().method(), status: response.status(), body: response.request().postDataJSON() };
    try { row.response = await response.json(); } catch {} report.requests.push(row);
  });
  await page.addInitScript(token => localStorage.setItem('auth-token', token), account.token);
  await page.goto('http://127.0.0.1:' + ports.vite + '/knowledge');
  await page.locator('iframe[title="Knowledge"]').waitFor({ timeout: 60000 });
  const { runKnowledgeAcceptance } = await import(browserScript);
  report.browser = await runKnowledgeAcceptance(page, { screenshotPrefix: join(evidence, 'pilotdeck'), requireModelSelector: true, expectedModelId: selected.id });
  process.env.KM_PD_OWNER = hostEnv.KM_PD_OWNER;
  const port = createKnowledgeModulePort(binding);
  report.runtime = [];
  const call = async (operation, input = {}) => {
    const result = await port.call(operation, input);
    report.runtime.push({ operation, input, result });
    return result;
  };
  const base = await call('create_base', { name: 'Runtime policy' });
  const ids = { knowledge_base_id: base.id };
  const upload = await call('import_document', { ...ids, filename: 'runtime.md', model_id: selected.id,
    content_base64: Buffer.from('# Runtime expense policy\n\nExpense reimbursement requires original receipts within 30 days.').toString('base64') });
  let job;
  for (let i = 0; i < 240; i++) {
    job = await port.call('get_job', { job_id: upload.id });
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  report.runtime.push({ operation: 'get_job', result: job });
  await call('list_bases'); await call('get_base', ids); await call('list_bindings'); await call('list_jobs');
  const documents = await call('list_documents', ids);
  const document = await call('get_document', { document_id: documents[0].id });
  await call('update_document', { document_id: document.id, expected_updated_at: document.updated_at,
    content_md: '# Runtime policy\n\nExpense reimbursement requires original receipts within 30 days.' });
  const buckets = await call('list_document_buckets', { document_id: document.id });
  const bucket = await call('get_bucket', { bucket_id: buckets[0].id });
  await call('update_bucket', { bucket_id: bucket.id, expected_updated_at: bucket.updated_at, summary: 'Receipts policy' });
  await call('list_bucket_chunks', { bucket_id: bucket.id });
  const chunks = await call('list_document_chunks', { document_id: document.id });
  const chunk = await call('get_chunk', { chunk_id: chunks[0].id });
  await call('update_chunk', { chunk_id: chunk.id, expected_updated_at: chunk.updated_at,
    content_md: 'Expense reimbursement requires original receipts within 30 days.' });
  await call('resolve_citation', { chunk_id: chunk.id });
  const concepts = await call('list_okf_concepts', ids);
  await call('get_okf_concept', { ...ids, concept_id: concepts[0].concept_id });
  const concept = await call('get_concept', { concept_id: concepts[0].id });
  await call('update_concept', { concept_id: concept.id, expected_updated_at: concept.updated_at, content_md: '# Receipts\n\nKeep original receipts.' });
  await call('lint_okf', ids);
  const exported = await call('export_okf', ids);
  assert.ok(Buffer.from(exported.content_base64, 'base64').subarray(0, 2).equals(Buffer.from('PK')));
  await call('import_okf', { ...ids, filename: exported.filename, content_base64: exported.content_base64 });
  const versions = await call('list_versions', ids);
  await call('copy_version', ids); await call('publish_version', ids);
  await call('rollback_version', { ...ids, version_id: versions[0].id }); await call('sync_base', ids);
  await call('list_discoveries', ids);
  await mkdir(join(temp, 'agent-project'), { recursive: true });
  await writeFile(join(temp, 'agent-project/pilotdeck.yaml'), stringify(profile));
  agentGateway = createLocalGateway({ projectRoot: join(temp, 'agent-project'), fallbackProjectRoot: join(temp, 'agent-project'),
    pilotHome: join(temp, 'agent-project'), env: { ...process.env, ...hostEnv }, permissionMode: 'bypassPermissions' });
  report.agentEvents = [];
  report.agentAttempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const events = [];
    for await (const event of agentGateway.gateway.submitTurn({ sessionKey: 'km-plugin-real-agent-' + attempt,
    workspaceCwd: join(temp, 'agent-project'), channelKey: 'test', mode: 'bypassPermissions', allowedTools: ['knowledge_query'],
    message: 'Call knowledge_query with query "Expense reimbursement original receipts", model_id "' + selected.id + '". Answer with the policy and evidence citation. Do not answer before calling the tool.' })) events.push(event);
    report.agentAttempts.push(events);
    report.agentEvents = events;
    if (events.some(event => event.type === 'tool_call_finished' && event.ok)) break;
    if (!events.some(event => event.type === 'error' && /RPM|rate.?limit|concurrency|429/i.test(String(event.message || event.error)))) break;
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
  assert.ok(report.agentEvents.some(event => event.type === 'tool_call_started' && event.name === 'knowledge_query'), 'Real Agent did not call knowledge_query');
  const startEvent = report.agentEvents.find(event => event.type === 'tool_call_started' && event.name === 'knowledge_query');
  const finish = report.agentEvents.find(event => event.type === 'tool_call_finished' && event.toolCallId === startEvent.toolCallId);
  assert.equal(finish?.ok, true, 'Real Agent knowledge call did not finish successfully');
  assert.ok(finish.data?.evidence_pack?.length, 'Real Agent returned no knowledge evidence');
  assert.ok(!finish.data.route_trace.some(row => /fallback|failed|invalid|lexical/.test(row.phase)), 'Real Agent used fallback');
  assert.match(JSON.stringify(report.agentEvents), /receipts/i);
  const tool = createKnowledgeQueryTool(port, binding);
  report.agentTool = await tool.execute({ query: 'Expense reimbursement original receipts', model_id: selected.id });
  assert.ok(report.agentTool.data.evidence_pack?.length, 'Agent tool returned no evidence');
  assert.ok(report.agentTool.data.route_trace.some(row => row.phase === 'document_route'));
  assert.ok(!report.agentTool.data.route_trace.some(row => /fallback|failed|invalid|lexical/.test(row.phase)), 'Agent query fallback cannot pass');
  const queried = report.requests.filter(row => row.url.endsWith('/query') || row.url.includes('/query?')).at(-1);
  assert.ok(queried?.response?.evidence_pack?.length);
  assert.ok(!queried.response.route_trace.some(row => /fallback|failed|invalid|lexical/.test(row.phase)), 'Browser query fallback cannot pass');
  const calls = pd.logs().split('\n').filter(line => line.includes('KM_MODEL_RESULT'));
  assert.ok(calls.length >= 5, 'PD provider result evidence missing'); report.modelCalls = calls;
  const kmLog = children.find(row => row.name === 'km').logs();
  report.correlatedModelCalls = calls.map(line => JSON.parse(line.split('KM_MODEL_RESULT ')[1])).filter(row => kmLog.includes(row.call_id));
  assert.equal(report.correlatedModelCalls.length, calls.length, 'Host/KM model correlation incomplete');
  assert.deepEqual(report.pageErrors, []); report.status = 'passed';
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (acceptancePage) {
    await acceptancePage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    report.frameState = await Promise.all(acceptancePage.frames().map(async frame => ({ url: frame.url(), text: await frame.locator('body').innerText().catch(() => '') })));
  }
}
finally {
  await agentGateway?.dispose();
  await browser?.close();
  // Release the UI gateway connection before waiting for the gateway listener.
  const shutdownOrder = [...children].sort((a, b) => ({ pilotdeck: 0, gateway: 1, km: 2 }[a.name] ?? 0) - ({ pilotdeck: 0, gateway: 1, km: 2 }[b.name] ?? 0));
  for (const handle of shutdownOrder) { await stop(handle); await writeFile(join(evidence, handle.name + '.log'), handle.logs().replace(/([?&](?:token|auth)=)[^&\s]+/g, '$1[redacted]')); }
  report.lifecycle = children.map(row => ({ name: row.name, exitCode: row.child.exitCode, signal: row.child.signalCode, forced: Boolean(row.forced) }));
  if (report.lifecycle.some(row => row.forced)) report.status = 'not_accepted';
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2).replace(/<ak-[^>]+>/g, '<credential-redacted>'));
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, error: report.error, evidence, selectedModel: report.selectedModel }));
