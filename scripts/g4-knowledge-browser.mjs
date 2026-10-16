import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const python = process.env.STAFFDECK_PYTHON || join(staffRoot, 'backend/.venv/bin/python');
const harnessRoot = process.env.HARNESS_V3_ROOT || '/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2';
const useKnowledgeWrapper = false;
assert.notEqual(process.env.G4_KNOWLEDGE_WRAPPER, '1', 'Acceptance requires the complete app.main lifespan');
const ports = { knowledge: 16100, vite: 16101, api: 16102, gateway: 16103, staffApi: 16104, staffVite: 16105 };
const kmPort = Number(process.env.G4_KM_PORT || 16106);
const kmRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const kmPython = process.env.KM_PYTHON || python;
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-browser');
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const kmIdentityFile = join(tempRoot, 'km-identity.json');
const kmBearer = 'g4-browser-km-token';
const pilotHome = join(tempRoot, 'pilot-home');
const configPath = join(tempRoot, 'pilotdeck.yaml');
const output = {
  ports,
  actions: [],
  requests: [],
  jobs: [],
  persistence: {},
  sd: { actions: [], requests: [], jobs: [], persistence: {} },
  operationCoverage: {
    import_document: 'real_ui_pd_and_sd',
    update_document: 'real_ui_pd_and_sd',
    query: 'real_ui_pd_and_sd',
    resolve_citation: 'api_only_pd_module_protocol',
    list_versions: 'real_ui_sd_native',
    rollback_version: 'real_ui_sd_native',
    cancel_job: 'not_run_real_ui_pending_long_job_fixture',
    structure_buckets_chunks: 'real_ui_sd_native',
    okf_import_export_lint: 'real_ui_sd_native_export_lint_import_failure',
    discoveries_confirm_reject: 'real_ui_sd_empty_state_confirm_reject_not_available',
  },
  cleanup: { tempRoot },
};
output.staffdeckStartup = useKnowledgeWrapper ? 'knowledge_wrapper_only' : 'formal_app_main_with_harness_v3';
for (const operation of Object.keys(output.operationCoverage)) output.operationCoverage[operation] = 'not_run';

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env, PATH: dirname(process.execPath) + ':' + (env.PATH || process.env.PATH || '') }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  return { child, logs: () => logs };
}

async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function stop(handle) {
  if (!handle?.child) return;
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 20000;
  while (handle.child.exitCode === null && handle.child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolveStop => setTimeout(resolveStop, 100));
  }
  handle.forced = handle.child.exitCode === null && handle.child.signalCode === null;
  if (handle.forced) {
    try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {}
    await new Promise(resolveStop => handle.child.once('exit', resolveStop));
  }
}

async function findKnowledgeBaseRow(page, baseName) {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 20_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/搜索知识库名称(?:、描述、状态或版本)?|Search knowledge bases/i);
    if (await search.count() && attempt === 0) {
      await search.fill(baseName);
      await page.waitForTimeout(300);
    }
    const row = page.locator('tr').filter({ hasText: baseName }).first();
    if (await row.count() && await row.isVisible()) return row;
    const label = page.getByText(baseName, { exact: true }).first();
    if (await label.count() && await label.isVisible()) {
      const tableRow = label.locator('xpath=ancestor::tr[1]');
      if (await tableRow.count()) return tableRow;
      return label;
    }
    const partialLabel = page.getByText(baseName, { exact: false }).first();
    if (await partialLabel.count() && await partialLabel.isVisible()) {
      const tableRow = partialLabel.locator('xpath=ancestor::tr[1]');
      if (await tableRow.count()) return tableRow;
      return partialLabel;
    }
    const next = page.getByRole('button', { name: /下一页|Next Page/i }).last();
    if (await next.count() && !(await next.isDisabled())) {
      await next.click();
    }
    if (attempt > 0 && attempt % 20 === 19) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 20_000 });
      const refreshedSearch = page.getByPlaceholder(/搜索知识库名称(?:、描述、状态或版本)?|Search knowledge bases/i);
      if (await refreshedSearch.count()) await refreshedSearch.fill(baseName);
    }
    await page.waitForTimeout(1_000);
  }
  const finalBody = await page.locator('body').innerText().catch(() => '');
  throw new Error(`Persisted ${baseName} base was not found in the Knowledge table pages; body=${finalBody.slice(-1800)}`);
}

await mkdir(artifactRoot, { recursive: true });
await mkdir(pilotHome, { recursive: true });
await writeFile(kmIdentityFile, JSON.stringify({
  [kmBearer]: { id: 'g4-km-owner', tenant_id: 'tenant_demo', display_name: 'G4 KM owner', spaces: ['*'], permissions: ['read', 'write'] },
}, null, 2));
await writeFile(configPath, `schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator:\n          capabilities:\n            supportsToolUse: true\nwebui:\n  runtime:\n    serverPort: ${ports.api}\n    vitePort: ${ports.vite}\n    databasePath: ${join(pilotHome, 'auth.db')}\n    workspacesRoot: ${join(pilotHome, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: staffdeck.knowledge\n    frontendModule: staffdeck.knowledge\n    contract: staffdeck.knowledge/v1\n    transport: module-http-v2\n    endpoint: http://127.0.0.1:${ports.knowledge}\n    callPath: /v2/module/call\n    tenantId: tenant_g4_browser\n    actorUserId: g4-owner\n    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]\n  sop:\n    enabled: false\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');

await writeFile(configPath, (await readFile(configPath, 'utf8'))
  .replace('tenant_g4_browser', 'tenant_demo')
  .replace('g4-owner', 'admin')
  .replace('implementationId: staffdeck.knowledge', 'implementationId: knowledge-core')
  .replace('frontendModule: staffdeck.knowledge', 'frontendModule: staffdeck.knowledge')
  .replace('contract: staffdeck.knowledge/v1', 'contract: knowledge-core/v1')
  .replace('transport: module-http-v2', 'transport: rest-http-v1')
  .replace('    tenantId: tenant_demo\n', '')
  .replace('    actorUserId: admin\n', '')
  .replace(`endpoint: http://127.0.0.1:${ports.knowledge}`, `endpoint: http://127.0.0.1:${kmPort}`)
  .replace(`callPath: /v2/module/call`, `credentialEnv: STAFFDECK_KM_BEARER\n    pilotDeckUserId: __USER__\n    spaceId: sd:tenant_demo:agent_tenant_demo_overall\n    spaces:\n      - id: sd:tenant_demo:agent_tenant_demo_overall\n        name: Overall`), 'utf8');
const staffEntrypoint = join(tempRoot, 'staffdeck_g4_app.py');
const { KNOWLEDGE_CORE_METHODS } = await import('../src/composition/knowledgeCoreOperations.mjs');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(/methods: \[[^\]]+\]/, `methods: [${KNOWLEDGE_CORE_METHODS.join(', ')}]`));
/* Kept only as a separately labeled Knowledge integration harness. The main
 * evidence run uses the unmodified formal app.main startup path below. */
await writeFile(staffEntrypoint, `from fastapi import FastAPI
from app.main import app
from app.async_jobs import shutdown_async_jobs, start_async_jobs
from app.db import init_db
from app.db import engine
from app.db.seed import seed_demo_data
from sqlmodel import Session

app.router.on_startup.clear()
app.router.on_shutdown.clear()

@app.on_event('startup')
def g4_startup():
    init_db()
    if __import__('os').environ.get('DEMO_SEED_ENABLED', 'true').lower() in {'1', 'true', 'yes', 'on'}:
        with Session(engine) as db:
            seed_demo_data(db)
    start_async_jobs()

@app.on_event('shutdown')
def g4_shutdown():
    shutdown_async_jobs()
`, 'utf8');

let knowledgeService;
let kmOwnerService;
let staffFrontendService;
let pilotService;
let browser;
let pilotPage;
try {
  const capabilitiesBearer = 'g4-real-capabilities-token';
  const capabilitiesArgs = process.env.G4_REQUIRE_MODEL_SELECTOR === '1' ? ['--capabilities-url', `http://127.0.0.1:${ports.staffApi}/api/internal/km/capabilities`, '--capabilities-bearer', capabilitiesBearer] : [];
  const kmConfigPath = join(tempRoot, 'km-full.json');
  await writeFile(kmConfigPath, JSON.stringify({ preset: 'full', modules: { authentication: true } }));
  const kmArgs = ['-m', 'knowledge_core.cli', '--config', kmConfigPath, '--database-url', `sqlite:///${join(tempRoot, 'knowledge-owner.sqlite')}`, '--identity-file', kmIdentityFile, '--host', '127.0.0.1', '--port', String(kmPort)];
  kmOwnerService = start(kmPython, kmArgs, {
    PYTHONPATH: join(kmRoot, 'knowledge_core/src'),
  }, tempRoot);
  await waitFor(`http://127.0.0.1:${kmPort}/health/ready`);
  const staffAppTarget = useKnowledgeWrapper ? 'staffdeck_g4_app:app' : 'app.main:app';
  knowledgeService = start(python, ['-m', 'uvicorn', staffAppTarget, '--host', '127.0.0.1', '--port', String(ports.staffApi), '--log-level', 'info'], {
    PYTHONPATH: `${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}:${join(staffRoot, 'knowledge_core/src')}`,
    DATABASE_URL: `sqlite:///${database}`,
    STAFFDECK_KM_URL: `http://127.0.0.1:${kmPort}`,
    STAFFDECK_KM_BEARER: kmBearer,
    STAFFDECK_KM_CAPABILITIES_BEARER: capabilitiesBearer,
    APP_SECRET: 'g4-browser-secret',
    STAFFDECK_KNOWLEDGE_SEED: 'true',
    DEMO_SEED_ENABLED: 'false',
    STARTUP_ORPHAN_CLEANUP_ENABLED: 'false',
    STAFFDECK_KNOWLEDGE_USER_ID: 'admin',
    STAFFDECK_KNOWLEDGE_TENANT_ID: 'tenant_demo',
    DEMO_SEED_ENABLED: 'true',
    HARNESS_V3_ROOT: harnessRoot,
    HARNESS_V3_HOME: join(tempRoot, 'harness-home'),
    HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'),
    HARNESS_V3_ENABLED: useKnowledgeWrapper ? 'false' : 'true',
    HARNESS_ADMIN_API_ENABLED: useKnowledgeWrapper ? 'false' : 'true',
  }, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.staffApi}/api/health`);
  if (process.env.G4_REQUIRE_MODEL_SELECTOR === '1') {
    execFileSync(python, [join(staffRoot, 'knowledge_core/scripts/hosted_model_probe.py'), '--pilot-root', root, '--config', process.env.G4_EXISTING_MODEL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml', '--node', process.execPath, '--output', join(artifactRoot, 'model-probe.json')], {
      cwd: tempRoot, env: { ...process.env, PYTHONPATH: `${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}`, DATABASE_URL: `sqlite:///${database}`, APP_SECRET: 'g4-browser-secret', ULTRARAG_DOTENV: join(tempRoot, 'missing.env'), MODEL_API_TIMEOUT_SECONDS: '20', NODE_OPTIONS: '' }, stdio: 'pipe', timeout: 180000,
    });
    output.modelProbe = JSON.parse(await readFile(join(artifactRoot, 'model-probe.json'), 'utf8'));
    await stop(kmOwnerService);
    await writeFile(join(artifactRoot, 'km-bootstrap.log'), kmOwnerService.logs(), 'utf8');
    kmOwnerService = start(kmPython, [...kmArgs, ...capabilitiesArgs], { PYTHONPATH: join(kmRoot, 'knowledge_core/src') }, tempRoot);
    await waitFor(`http://127.0.0.1:${kmPort}/health/ready`);
  }
  staffFrontendService = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.staffVite), '--strictPort'], {
    NODE_OPTIONS: '', VITE_PROXY_TARGET: `http://127.0.0.1:${ports.staffApi}`, VITE_TENANT_ID: 'tenant_demo',
  }, join(staffRoot, 'frontend-enterprise'));
  await waitFor(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`);
  if (process.env.G4_SD_ONLY !== '1') {
  pilotService = start(process.execPath, ['scripts/dev-launcher.mjs'], {
    NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath,
    PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0',
    STAFFDECK_KM_BEARER: kmBearer,
    SERVER_PORT: String(ports.api), VITE_PORT: String(ports.vite),
    PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`,
    PILOTDECK_MODULE_ADMIN: '1',
  }, root);
  await waitFor(`http://127.0.0.1:${ports.vite}/api/auth/status`);
  }
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = pilotPage = await context.newPage();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/modules/knowledge')) output.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null });
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/modules/knowledge/call') {
      output.requests.push({
        operation: response.request().postDataJSON?.().operation,
        responseStatus: response.status(),
        responseBody: await response.text().catch(() => ''),
      });
    } else if (url.pathname.startsWith('/api/modules/knowledge/core/')) {
      const method = response.request().method();
      const operation = method === 'POST' && /\/documents$/.test(url.pathname)
        ? 'import_document'
        : method === 'POST' && url.pathname.endsWith('/query') ? 'query' : undefined;
      output.requests.push({ operation, method, path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') });
    }
  });
  if (process.env.G4_SD_ONLY !== '1') {
  const credentials = { username: 'g4-browser-owner', password: 'g4-browser-owner-password' };
  output.actions.push('register-or-login single-user owner');
  const registration = await context.request.post(`http://127.0.0.1:${ports.vite}/api/auth/register`, { data: credentials });
  const account = registration.ok() ? await registration.json() : await (await context.request.post(`http://127.0.0.1:${ports.vite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof account.token, 'string');
  const pilotDeckUserId = account.user?.id ?? account.user?.user_id ?? account.id ?? account.userId;
  assert.ok(pilotDeckUserId, `PilotDeck registration did not return a user id: ${JSON.stringify(account)}`);
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('__USER__', JSON.stringify(String(pilotDeckUserId))), 'utf8');
  await stop(pilotService);
  pilotService = start(process.execPath, ['scripts/dev-launcher.mjs'], {
    NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath,
    PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0',
    SERVER_PORT: String(ports.api), VITE_PORT: String(ports.vite),
    PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`,
    PILOTDECK_MODULE_ADMIN: '1', STAFFDECK_KM_BEARER: kmBearer,
  }, root);
  await waitFor(`http://127.0.0.1:${ports.vite}/api/auth/status`);
  await context.request.post(`http://127.0.0.1:${ports.vite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${account.token}` } });
  await page.addInitScript((token) => localStorage.setItem('auth-token', token), account.token);
  await page.goto(`http://127.0.0.1:${ports.vite}/knowledge/new`, { waitUntil: 'domcontentloaded' });
  output.actions.push('open Knowledge new page');
  const { runKnowledgeAcceptance } = await import(pathToFileURL(join(staffRoot, 'packages/knowledge-ui/browser-acceptance.mjs')).href);
  output.pilotIndependent = await runKnowledgeAcceptance(page, { screenshotPrefix: join(artifactRoot, 'pilotdeck-km'), requireModelSelector: false });
  output.actions.push(...output.pilotIndependent.workflow);
  assert.deepEqual(output.pageErrors || [], []);
  }
  await context.close();

  const sdContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const sdPage = await sdContext.newPage();
  output.sd.pageErrors = [];
  sdPage.on('pageerror', error => output.sd.pageErrors.push(error.message));
  sdPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/enterprise/knowledge') || url.pathname.startsWith('/api/km/')) output.sd.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null });
  });
  sdPage.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('/api/enterprise/knowledge') || url.pathname.startsWith('/api/km/')) {
      output.sd.requests.push({ method: response.request().method(), path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') });
    }
  });
  const sdLogin = await sdContext.request.post(`http://127.0.0.1:${ports.staffVite}/api/auth/login`, { data: { tenant_id: 'tenant_demo', username: 'admin', password: 'admin' } });
  assert.equal(sdLogin.ok(), true, `StaffDeck native login failed with HTTP ${sdLogin.status()}`);
  const sdAccount = await sdLogin.json();
  assert.equal(typeof sdAccount.token, 'string');
  const sdAgentsResponse = await sdContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/agents?tenant_id=tenant_demo`, { headers: { authorization: `Bearer ${sdAccount.token}` } });
  assert.equal(sdAgentsResponse.ok(), true, `StaffDeck native agent directory failed with HTTP ${sdAgentsResponse.status()}`);
  const sdAgents = await sdAgentsResponse.json();
  const overallAgentId = sdAgents.find((agent) => agent.is_overall)?.id || '';
  assert.ok(overallAgentId, 'StaffDeck native overall employee scope is required for Knowledge management');
  await sdPage.addInitScript((session) => {
    localStorage.setItem('ultrarag_auth', JSON.stringify(session));
    localStorage.setItem('ultrarag_enterprise_agent_scope', session.overallAgentId);
    localStorage.setItem('staffdeck_onboarding_guide_seen', '1');
    localStorage.setItem('staffdeck_quick_start_guide_seen', '1');
  }, { ...sdAccount, overallAgentId });
  await sdPage.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge/new`, { waitUntil: 'domcontentloaded' });
  output.sd.actions.push('open StaffDeck native Knowledge new page');
  const kmConfig = await sdContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/km/config`, { headers: { authorization: `Bearer ${sdAccount.token}` } });
  if (kmConfig.ok() && (await kmConfig.json()).enabled) {
    const { runKnowledgeAcceptance } = await import(pathToFileURL(join(staffRoot, 'packages/knowledge-ui/browser-acceptance.mjs')).href);
    output.sd.independent = await runKnowledgeAcceptance(sdPage, {
      screenshotPrefix: join(artifactRoot, 'staffdeck-km'),
      requireModelSelector: process.env.G4_REQUIRE_MODEL_SELECTOR === '1',
      expectedModelId: output.modelProbe?.selected_model_id,
    });
    output.sd.actions.push(...output.sd.independent.workflow);
    assert.deepEqual(output.sd.pageErrors, []);
    if (process.env.G4_REQUIRE_MODEL_SELECTOR === '1') {
      const selected = output.sd.independent.selectedModel;
      assert.equal(selected, output.modelProbe.selected_model_id);
      const modelRequests = output.sd.requests.filter(item => item.method === 'POST' && item.body && item.body.model_id === selected);
      assert.ok(modelRequests.length >= 2, `Hosted model id was not propagated to upload/query requests: ${JSON.stringify(modelRequests)}`);
      const modelCalls = knowledgeService.logs().split('\n').filter(line => line.includes('KM_MODEL_RESULT') && line.includes(`config_id=${selected}`));
      assert.ok(modelCalls.length >= 2, 'Real hosted inference must succeed for ingestion and query');
      for (const phase of ['ingestion', 'query']) assert.ok(knowledgeService.logs().includes(`phase=${phase}`), `No successful hosted model call for ${phase}`);
      const queryReply = output.sd.requests.filter(item => item.path.endsWith('/query') && item.responseStatus === 200).at(-1);
      assert.ok(queryReply, 'No successful hosted query response');
      const queryEvidence = JSON.parse(queryReply.responseBody);
      const routePhases = (queryEvidence.route_trace || []).map(item => item.phase);
      assert.ok(routePhases.includes('document_route'), 'Model document routing was not exercised');
      assert.ok(!routePhases.some(phase => /fallback|failed|invalid|document_route_lexical/.test(phase)),
        `Lexical fallback or invalid model output cannot pass hosted inference: ${routePhases}`);
      assert.ok(queryEvidence.evidence_pack?.length, 'Hosted query returned no valid evidence');
      output.realModel = { status: 'passed', selectedModel: selected, modelCalls };
    }
  } else {
  const sdFile = join(tempRoot, 'g4-policy-sd.md');
  await writeFile(sdFile, '# G4 StaffDeck Policy\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n', 'utf8');
  await sdPage.locator('input[type=file]').first().setInputFiles(sdFile);
  output.sd.actions.push('upload document through StaffDeck native UI');
  let sdUploadEvidence;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    sdUploadEvidence = output.sd.requests.find((item) => item.method === 'POST' && item.path.endsWith('/knowledge/documents') && Number.isInteger(item.responseStatus));
    if (sdUploadEvidence) break;
    await sdPage.waitForTimeout(1_000);
  }
  assert.ok(sdUploadEvidence, 'StaffDeck native file-input upload did not produce an import response');
  assert.ok(sdUploadEvidence.responseStatus >= 200 && sdUploadEvidence.responseStatus < 300, `StaffDeck native upload failed with HTTP ${sdUploadEvidence.responseStatus}`);
  output.sd.persistence.uploadResponse = JSON.parse(sdUploadEvidence.responseBody);
  output.sd.actions.push('confirm StaffDeck native UI upload response (new job row is refresh sensitive)');
  await sdPage.evaluate((scope) => {
    localStorage.setItem('ultrarag_enterprise_agent_scope', scope);
    window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: scope } }));
  }, overallAgentId);
  await sdPage.waitForTimeout(500);
  await sdPage.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  const sdRow = await findKnowledgeBaseRow(sdPage, 'g4-policy-sd');
  await sdRow.click();
  await sdPage.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  output.sd.actions.push('refresh StaffDeck native Knowledge management and locate persisted base');
  const sdViewButton = sdPage.locator('.knowledge-pageindex-card').getByRole('button', { name: /详情|Details/ });
  await sdViewButton.click();
  await sdPage.getByText(/文档详情|Document Details/).last().waitFor({ state: 'visible', timeout: 10_000 });
  const sdEditButton = sdPage.getByRole('button', { name: /修改|编辑|Modify|Edit/ }).last();
  assert.equal(await sdEditButton.count(), 1, 'StaffDeck native document detail did not expose edit');
  await sdEditButton.click();
  await sdPage.locator('textarea').last().fill('# G4 StaffDeck Policy Updated\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n');
  await sdPage.getByRole('button', { name: /保存并重建索引|Save and rebuild/ }).last().click();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const saved = output.sd.requests.find((item) => item.method === 'PUT' && item.path.includes('/api/enterprise/knowledge/documents/') && Number.isInteger(item.responseStatus));
    if (saved) {
      assert.ok(saved.responseStatus >= 200 && saved.responseStatus < 300, `StaffDeck native document update failed with HTTP ${saved.responseStatus}`);
      break;
    }
    await sdPage.waitForTimeout(1_000);
    if (attempt === 29) throw new Error('Timed out waiting for StaffDeck native update response');
  }
  output.sd.actions.push('edit and save through StaffDeck native UI');
  await sdPage.reload({ waitUntil: 'domcontentloaded' });
  const sdReloadedRow = await findKnowledgeBaseRow(sdPage, 'g4-policy-sd');
  await sdReloadedRow.click();
  await sdPage.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  await sdPage.locator('.knowledge-pageindex-card').getByRole('button', { name: /详情|Details/ }).click();
  await sdPage.getByText(/文档详情|Document Details/).last().waitFor({ state: 'visible', timeout: 10_000 });
  const sdAfterText = await sdPage.locator('body').innerText();
  assert.match(sdAfterText, /G4 StaffDeck Policy Updated/);
  assert.match(sdAfterText, /Unchanged field/);
  output.sd.persistence.detailAfter = sdAfterText.slice(-4000);
  output.sd.actions.push('reload and verify StaffDeck native unchanged field persisted');
  const sdDialog = sdPage.locator('[role="dialog"]').last();
  if (await sdDialog.count()) await sdDialog.click({ position: { x: 4, y: 4 } });
  await sdPage.waitForTimeout(300);
  const sdQueryInput = sdPage.getByPlaceholder(/输入知识问题|knowledge question/i);
  assert.equal(await sdQueryInput.count(), 1, 'StaffDeck native Knowledge query input is required');
  await sdQueryInput.fill('Owner approval');
  await sdPage.getByRole('button', { name: /检索|Search/i }).click();
  let sdQueryResponse;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    sdQueryResponse = output.sd.requests.find((item) => item.method === 'POST' && item.path.endsWith('/knowledge/search') && Number.isInteger(item.responseStatus));
    if (sdQueryResponse) break;
    await sdPage.waitForTimeout(1_000);
  }
  assert.ok(sdQueryResponse, 'Timed out waiting for StaffDeck native query response');
  assert.ok(sdQueryResponse.responseStatus >= 200 && sdQueryResponse.responseStatus < 300, `StaffDeck native query failed with HTTP ${sdQueryResponse.responseStatus}`);
  const sdQueryBody = JSON.parse(sdQueryResponse.responseBody);
  assert.ok(Array.isArray(sdQueryBody.evidence_pack) && sdQueryBody.evidence_pack.length > 0, 'StaffDeck native query returned no evidence pack');
  output.sd.persistence.queryApi = { status: sdQueryResponse.responseStatus, evidenceCount: sdQueryBody.evidence_pack.length };
  const evidenceTrigger = sdPage.getByText(/引用来源包|Evidence pack/).last();
  assert.equal(await evidenceTrigger.count(), 1, 'StaffDeck native evidence-pack interaction is required');
  await evidenceTrigger.click();
  const visibleEvidence = sdPage.locator('.knowledge-evidence-list');
  await visibleEvidence.waitFor({ state: 'visible', timeout: 10_000 });
  const evidenceText = await visibleEvidence.innerText();
  assert.match(evidenceText, /Owner approval/);
  assert.match(evidenceText, /Unchanged field/);
  output.sd.persistence.queryVisibleEvidence = evidenceText;
  output.sd.actions.push('query and verify StaffDeck native visible evidence source and excerpt');

  // Exercise the source product's bucket/chunk editor and prove the edited
  // citation source survives a reload, separately from document editing.
  const viewAllEvidence = sdPage.getByText('查看全部', { exact: true }).last();
  assert.equal(await viewAllEvidence.count(), 1, 'StaffDeck native evidence detail control is required');
  await viewAllEvidence.click();
  const evidenceDetail = sdPage.locator('.knowledge-detail-modal').last();
  await evidenceDetail.waitFor({ state: 'visible', timeout: 10_000 });
  const editBucketButton = evidenceDetail.getByRole('button', { name: /编辑|Edit/ }).first();
  assert.equal(await editBucketButton.count(), 1, 'StaffDeck native bucket editor is required');
  await editBucketButton.click();
  const bucketDialog = sdPage.locator('[role="dialog"]').last();
  await bucketDialog.waitFor({ state: 'visible', timeout: 10_000 });
  const bucketTextareas = bucketDialog.locator('textarea');
  assert.ok(await bucketTextareas.count() >= 2, 'StaffDeck native bucket/chunk editor did not render chunk fields');
  await bucketTextareas.last().fill('Owner approval is required.\n\nUnchanged field: retain this paragraph.\n\nBucket edit persisted.');
  await bucketDialog.getByRole('button', { name: /^保存$|Save/ }).last().click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chunkSave = output.sd.requests.find((item) => item.method === 'PUT' && item.path.includes('/api/enterprise/knowledge/chunks/') && Number.isInteger(item.responseStatus));
    if (chunkSave) {
      assert.ok(chunkSave.responseStatus >= 200 && chunkSave.responseStatus < 300, `StaffDeck native chunk update failed with HTTP ${chunkSave.responseStatus}`);
      break;
    }
    await sdPage.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for StaffDeck native chunk update response');
  }
  output.sd.actions.push('edit and save bucket/chunk content through StaffDeck native UI');
  await sdPage.reload({ waitUntil: 'domcontentloaded' });
  const bucketReloadRow = await findKnowledgeBaseRow(sdPage, 'g4-policy-sd');
  await bucketReloadRow.click();
  await sdPage.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  await sdPage.getByText('查看全部', { exact: true }).last().click();
  await sdPage.locator('.knowledge-detail-modal').last().getByText('Bucket edit persisted', { exact: false }).waitFor({ timeout: 10_000 });
  output.sd.persistence.bucketChunkAfterReload = (await sdPage.locator('.knowledge-detail-modal').last().innerText()).slice(-2000);
  output.sd.actions.push('reload and verify bucket/chunk edit persisted');

  // Exercise version listing and branch rollback on the native StaffDeck UI.
  const branchAgentId = sdAgents.find((agent) => !agent.is_overall && agent.name === '法务')?.id
    || sdAgents.find((agent) => !agent.is_overall)?.id
    || '';
  assert.ok(branchAgentId, 'StaffDeck native branch employee scope is required for rollback UI');
  await sdPage.evaluate((scope) => {
    localStorage.setItem('ultrarag_enterprise_agent_scope', scope);
    window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: scope } }));
  }, branchAgentId);
  await sdPage.waitForTimeout(500);
  await sdPage.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  const branchRow = await findKnowledgeBaseRow(sdPage, 'g4-policy-sd');
  const branchActions = branchRow.getByRole('button', { name: /知识库操作|Knowledge actions/ });
  assert.equal(await branchActions.count(), 1, 'StaffDeck native Knowledge actions menu is required');
  await branchActions.click();
  await sdPage.getByRole('menuitem', { name: /版本管理|Version/ }).click();
  const versionDialog = sdPage.locator('[role="dialog"]').last();
  await versionDialog.waitFor({ state: 'visible', timeout: 10_000 });
  const versionRows = versionDialog.locator('tbody tr');
  assert.ok(await versionRows.count() >= 2, 'StaffDeck native version history needs at least two persisted versions');
  const rollbackButton = versionDialog.getByRole('button', { name: /回滚|Rollback/ }).first();
  assert.equal(await rollbackButton.count(), 1, 'StaffDeck native rollback action is required');
  await rollbackButton.click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rollbackResponse = output.sd.requests.find((item) => item.method === 'POST' && item.path.includes('/knowledge-bases/') && item.path.endsWith('/rollback') && Number.isInteger(item.responseStatus));
    if (rollbackResponse) {
      assert.ok(rollbackResponse.responseStatus >= 200 && rollbackResponse.responseStatus < 300, `StaffDeck native rollback failed with HTTP ${rollbackResponse.responseStatus}`);
      output.sd.persistence.rollbackResponse = { status: rollbackResponse.responseStatus, body: rollbackResponse.responseBody };
      break;
    }
    await sdPage.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for StaffDeck native rollback response');
  }
  output.sd.actions.push('list versions and rollback a non-head branch version through StaffDeck native UI');

  // Exercise the native OKF export and lint actions. Import is also attempted
  // through the native picker with an invalid archive to preserve its failure evidence.
  await versionDialog.getByRole('button', { name: /关闭|Cancel/ }).click().catch(() => sdPage.keyboard.press('Escape'));
  await sdPage.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  const okfRow = await findKnowledgeBaseRow(sdPage, 'g4-policy-sd');
  await okfRow.getByRole('button', { name: /知识库操作|Knowledge actions/ }).click();
  const exportDownload = sdPage.waitForEvent('download');
  await sdPage.getByRole('menuitem', { name: /导出知识库备份包|Export/ }).click();
  const download = await exportDownload;
  assert.match(download.suggestedFilename(), /okf.*\.zip/i);
  const exportResponse = output.sd.requests.find((item) => item.method === 'GET' && item.path.includes('/okf/export') && Number.isInteger(item.responseStatus));
  assert.ok(exportResponse && exportResponse.responseStatus === 200, 'StaffDeck native OKF export did not return HTTP 200');
  output.sd.actions.push('export OKF backup through StaffDeck native UI');
  await okfRow.getByRole('button', { name: /知识库操作|Knowledge actions/ }).click();
  await sdPage.getByRole('menuitem', { name: /知识图谱检查|Lint/ }).click();
  const lintDialog = sdPage.getByRole('dialog').last();
  await lintDialog.waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await lintDialog.innerText(), /知识图谱检查/);
  const lintResponse = output.sd.requests.find((item) => item.method === 'POST' && item.path.includes('/okf/lint') && Number.isInteger(item.responseStatus));
  assert.ok(lintResponse && lintResponse.responseStatus === 200, 'StaffDeck native OKF lint did not return HTTP 200');
  output.sd.actions.push('lint OKF graph through StaffDeck native UI');
  await lintDialog.getByRole('button', { name: /关闭|Cancel/ }).click();
  await okfRow.getByRole('button', { name: /知识库操作|Knowledge actions/ }).click();
  await sdPage.getByRole('menuitem', { name: /导入知识库备份包|Import/ }).click();
  const invalidOkf = join(tempRoot, 'invalid-g4.okf.zip');
  await writeFile(invalidOkf, 'not a zip archive', 'utf8');
  await sdPage.locator('input[type=file]').last().setInputFiles(invalidOkf);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const importResponse = output.sd.requests.find((item) => item.method === 'POST' && item.path.endsWith('/knowledge/okf/import') && Number.isInteger(item.responseStatus));
    if (importResponse) {
      assert.ok(importResponse.responseStatus >= 400 && importResponse.responseStatus < 500, `Invalid OKF import unexpectedly returned HTTP ${importResponse.responseStatus}`);
      output.sd.persistence.invalidOkfImport = { status: importResponse.responseStatus, body: importResponse.responseBody };
      break;
    }
    await sdPage.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for native OKF import failure response');
  }
  output.sd.actions.push('exercise native OKF import failure state with invalid archive');

  await sdPage.screenshot({ path: join(artifactRoot, 'g4-knowledge-staffdeck-native.png'), fullPage: true });
  }
  await sdContext.close();
  await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  output.startupLogs = {
    kmOwnerService: kmOwnerService?.logs?.().slice(-12000),
    knowledgeService: knowledgeService?.logs?.().slice(-12000),
    staffFrontendService: staffFrontendService?.logs?.().slice(-12000),
    pilotService: pilotService?.logs?.().slice(-12000),
  };
  output.configText = await readFile(configPath, 'utf8').catch(() => undefined);
  if (pilotPage) {
    output.pageDiagnostics = {
      url: pilotPage.url(),
      body: await pilotPage.locator('body').innerText().catch(() => ''),
      inputs: await pilotPage.locator('input').evaluateAll(nodes => nodes.map(node => ({ type: node.type, aria: node.getAttribute('aria-label'), name: node.getAttribute('name') }))).catch(() => []),
      buttons: await pilotPage.getByRole('button').evaluateAll(nodes => nodes.map(node => ({ text: (node.textContent || '').trim(), aria: node.getAttribute('aria-label') })).slice(-80)).catch(() => []),
    };
  }
  output.tempRoot = tempRoot;
  await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  throw error;
} finally {
  await browser?.close();
  await stop(pilotService);
  await stop(staffFrontendService);
  await stop(knowledgeService);
  await stop(kmOwnerService);
  output.lifecycle = {};
  for (const [name, handle] of Object.entries({ pilotService, staffFrontendService, knowledgeService, kmOwnerService })) {
    if (!handle) continue;
    await writeFile(join(artifactRoot, `${name}.log`), handle.logs(), 'utf8');
    output.lifecycle[name] = { exitCode: handle.child.exitCode, signal: handle.child.signalCode, forced: !!handle.forced };
  }
  const completeHostedRun = process.env.G4_SD_ONLY === '1' && process.env.G4_REQUIRE_MODEL_SELECTOR === '1'
    && output.sd.independent && output.realModel?.status === 'passed';
  output.status = output.error || Object.values(output.lifecycle).some(item => item.forced) ? 'failed'
    : completeHostedRun || output.pilotIndependent && output.sd.independent ? 'passed' : 'partial';
  if (output.pilotIndependent && output.sd.independent) {
    for (const name of ['import_document', 'update_document', 'query', 'list_versions', 'rollback_version', 'resolve_citation', 'okf_import_export_lint', 'structure_buckets_chunks']) output.operationCoverage[name] = 'passed';
  }
  await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await rm(tempRoot, { recursive: true, force: true });
  output.cleanup.removed = true;
  await writeFile(join(artifactRoot, 'cleanup.json'), `${JSON.stringify(output.cleanup, null, 2)}\n`, 'utf8').catch(() => undefined);
}

console.log(JSON.stringify({ artifactRoot, actions: output.actions, requestCount: output.requests.length, jobSamples: output.jobs.length }, null, 2));
