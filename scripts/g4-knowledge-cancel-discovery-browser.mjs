import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const python = process.env.STAFFDECK_PYTHON || join(staffRoot, 'backend/.venv/bin/python');
const kmRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const kmPython = process.env.KM_PYTHON || python;
const harnessRoot = process.env.HARNESS_V3_ROOT || '/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2';
const ports = { km: 16130, staffApi: 16124, staffVite: 16125, pilotApi: 16126, pilotVite: 16127, gateway: 16128, model: 16129 };
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-cancel-discovery-browser');
const upgrade = process.env.KM_UPGRADE_ACCEPTANCE === '1';
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-cancel-discovery-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const kmDatabase = join(tempRoot, 'knowledge-owner.sqlite');
const kmIdentityFile = join(tempRoot, 'km-identity.json');
const kmBearer = 'g4-cancel-discovery-km-token';
const publisherBearer = 'g4-cancel-discovery-publisher-token';
const kmModelConfig = join(tempRoot, 'km-model.json');
const blockFile = join(tempRoot, 'block-ingest');
const fixtureStartedFile = join(tempRoot, 'ingest-fixture-started');
const fixtureDir = join(tempRoot, 'fixture-python');
const pilotHome = join(tempRoot, 'pilot-home');
const configPath = join(tempRoot, 'pilotdeck.yaml');
const output = {
  ports,
  startup: 'formal_app_main_with_harness_v3',
  modelFixture: 'local_openai_compatible_discovery_response',
  actions: [],
  coverage: {
    staffdeck_native_cancel: 'not_run',
    staffdeck_native_discoveries_confirm_reject: 'not_run',
    pilotdeck_adapter_cancel: 'not_run',
    pilotdeck_adapter_discoveries_confirm_reject: 'not_run',
  },
  staffdeck: { actions: [], requests: [], persistence: {} },
  pilotdeck: { actions: [], requests: [], persistence: {} },
  cleanup: { tempRoot },
};

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  return { child, logs: () => logs };
}

async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(handle) {
  if (!handle?.child || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  try { process.kill(handle.child.pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 20000;
  while (handle.child.exitCode === null && handle.child.signalCode === null && Date.now() < deadline) await new Promise(resolveStop => setTimeout(resolveStop, 100));
  handle.forced = handle.child.exitCode === null && handle.child.signalCode === null;
  if (handle.forced) {
    try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {}
    try { process.kill(handle.child.pid, 'SIGKILL'); } catch {}
    await new Promise(resolveStop => handle.child.once('exit', resolveStop));
  }
}

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(message);
}

async function findBase(page, name) {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 20_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/搜索知识库名称(?:、描述、状态或版本)?|Search knowledge bases/i);
    if (await search.count() && attempt === 0) await search.fill(name);
    const row = page.locator('tr').filter({ hasText: name }).first();
    if (await row.count() && await row.isVisible()) return row;
    const next = page.getByRole('button', { name: /下一页|Next Page/i }).last();
    if (await next.count() && !(await next.isDisabled())) await next.click();
    await page.waitForTimeout(400);
  }
  throw new Error(`Knowledge base ${name} not visible`);
}

async function writeFixture() {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, 'sitecustomize.py'), `import os\nimport time\n\ndef _fixture_delay(original):\n    def delayed(self, job_id, *args):\n        started = os.environ.get('G4_INGEST_FIXTURE_STARTED_FILE', '')\n        if started:\n            with open(started, 'w', encoding='utf8') as marker:\n                marker.write(job_id)\n        marker = os.environ.get('G4_INGEST_BLOCK_FILE', '')\n        deadline = time.time() + 120\n        while marker and os.path.exists(marker) and time.time() < deadline:\n            time.sleep(0.1)\n        return original(self, job_id, *args)\n    return delayed\n\nfrom knowledge_core.kernel.use_cases import Tasks\nTasks.run = _fixture_delay(Tasks.run)\n`, 'utf8');
}

const modelResponses = { discovery: 0, buckets: 0, requests: [] };
const modelServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404); response.end(); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body || '{}');
  const system = String(parsed.messages?.[0]?.content || '');
  const user = String(parsed.messages?.[1]?.content || '');
  const isDiscovery = user.includes('"document"') && user.includes('"buckets"');
  const isBucketization = user.includes('"sections"');
  modelResponses.requests.push({ system: system.slice(0, 160), user: user.slice(0, 500), isDiscovery, isBucketization });
  let payload;
  if (isDiscovery) {
    modelResponses.discovery += 1;
    const suffix = modelResponses.discovery;
    payload = { discoveries: [
      { suggestion_type: 'tool', title: `Fixture discovery ${suffix}`, reason: 'Isolated publication workflow fixture.', payload: { name: `fixture.discovery.${suffix}`, display_name: `Fixture discovery ${suffix}`, method: 'POST', url: `http://127.0.0.1:16129/fixture/${suffix}`, headers: {}, auth: {}, input_schema: {}, output_schema: {} }, source_refs: [{ filename: `g4-discovery-${suffix}.md` }] },
      { suggestion_type: 'procedure', title: `Fixture skill ${suffix}`, reason: 'Isolated publication workflow fixture.', payload: { steps: ['Verify the original receipt', 'Approve the expense claim'] }, source_refs: [{ filename: `g4-discovery-${suffix}.md` }] },
    ] };
  } else if (isBucketization) {
    modelResponses.buckets += 1;
    payload = { buckets: [] };
  } else {
    payload = {};
  }
  const result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(result);
});

await mkdir(artifactRoot, { recursive: true });
await mkdir(pilotHome, { recursive: true });
await writeFixture();
await writeFile(kmIdentityFile, JSON.stringify({
  [kmBearer]: { id: 'g4-cancel-discovery-owner', tenant_id: 'tenant_demo', display_name: 'G4 KM owner', spaces: ['*'], permissions: ['read', 'write'] },
}, null, 2), 'utf8');
await writeFile(kmModelConfig, JSON.stringify({
  base_url: `http://127.0.0.1:${ports.model}/v1`, model: 'fixture-model', api_key: 'fixture-key', timeout_seconds: 120,
}, null, 2), 'utf8');
await rm(blockFile, { force: true });
await writeFile(configPath, `schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator:\n          capabilities:\n            supportsToolUse: true\nwebui:\n  runtime:\n    serverPort: ${ports.pilotApi}\n    vitePort: ${ports.pilotVite}\n    databasePath: ${join(pilotHome, 'auth.db')}\n    workspacesRoot: ${join(pilotHome, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: staffdeck.knowledge\n    frontendModule: staffdeck.knowledge\n    contract: staffdeck.knowledge/v1\n    transport: module-http-v2\n    endpoint: http://127.0.0.1:${ports.staffApi}\n    callPath: /v2/module/call\n    tenantId: tenant_demo\n    actorUserId: admin\n    methods: [list_bases, get_base, list_documents, get_document, import_document, get_job, list_jobs, cancel_job, list_discoveries, confirm_discovery, reject_discovery]\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('reject_discovery]', 'reject_discovery, query]'), 'utf8');
await writeFile(configPath, (await readFile(configPath, 'utf8'))
  .replace('implementationId: staffdeck.knowledge', 'implementationId: knowledge-core')
  .replace('contract: staffdeck.knowledge/v1', 'contract: knowledge-core/v1')
  .replace('transport: module-http-v2', 'transport: rest-http-v1')
  .replace(`endpoint: http://127.0.0.1:${ports.staffApi}`, `endpoint: http://127.0.0.1:${ports.km}`)
  .replace('    callPath: /v2/module/call\n', '    credentialEnv: STAFFDECK_KM_BEARER\n    pilotDeckUserId: "__PILOT_USER__"\n    spaceId: sd:tenant_demo:agent_preset_sales_001\n    spaces:\n      - id: sd:tenant_demo:agent_preset_sales_001\n        name: PilotDeck acceptance\n')
  .replace('    tenantId: tenant_demo\n    actorUserId: admin\n', '')
  .replace('methods: [list_bases, get_base, list_documents, get_document, import_document, get_job, list_jobs, cancel_job, list_discoveries, confirm_discovery, reject_discovery, query]', 'methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, get_job, list_jobs, cancel_job, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]'), 'utf8');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('__PILOT_USER__', '1'), 'utf8');
output.pilotdeck.config = await readFile(configPath, 'utf8');
const { KNOWLEDGE_CORE_METHODS } = await import('../src/composition/knowledgeCoreOperations.mjs');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(/methods: \[[^\]]+\]/, `methods: [${KNOWLEDGE_CORE_METHODS.join(', ')}]`).replace('    pilotDeckUserId:', '    capabilitiesCredentialEnv: STAFFDECK_KM_BEARER\n    pilotDeckUserId:'));

let kmOwnerService; let staffService; let staffFrontend; let pilotService; let browser;
const uiDirectory = join(tempRoot, 'km-ui');
async function artifactState(directory) {
  const rows = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else { const info = await stat(path); rows.push({ path: path.slice(directory.length), size: info.size, mtime: info.mtimeMs }); }
    }
  }
  await scan(directory); return rows.sort((a, b) => a.path.localeCompare(b.path));
}
try {
  if (upgrade) {
    await cp(join(kmRoot, 'knowledge_core/src/knowledge_core/ui'), uiDirectory, { recursive: true });
    await writeFile(join(uiDirectory, 'version.json'), JSON.stringify({ protocol: 'knowledge-frame/v1', version: 'upgrade-before' }));
    output.upgrade = { status: 'not_accepted', before: { sd: await artifactState(join(staffRoot, 'frontend-enterprise/dist')), pd: await artifactState(join(root, 'ui/dist')) } };
  }
  await new Promise((resolveListen) => modelServer.listen(ports.model, '127.0.0.1', resolveListen));
  await writeFile(join(tempRoot, 'km-full.json'), JSON.stringify({ preset: 'full', modules: { authentication: true } }));
  const kmArgs = ['-m', 'knowledge_core.cli', '--config', join(tempRoot, 'km-full.json'), '--database-url', `sqlite:///${kmDatabase}`, '--identity-file', kmIdentityFile, '--model-config', kmModelConfig, '--publisher-url', `http://127.0.0.1:${ports.staffApi}/api/internal/km/publications`, '--publisher-bearer', publisherBearer, '--host', '127.0.0.1', '--port', String(ports.km), ...(upgrade ? ['--ui-dir', uiDirectory] : [])];
  const kmEnv = {
    PYTHONPATH: `${fixtureDir}:${join(kmRoot, 'knowledge_core/src')}`,
    G4_INGEST_BLOCK_FILE: blockFile,
    G4_INGEST_FIXTURE_STARTED_FILE: fixtureStartedFile,
  };
  kmOwnerService = start(kmPython, kmArgs, kmEnv, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.km}/health/ready`);
  const env = {
    PYTHONPATH: `${fixtureDir}:${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}:${join(staffRoot, 'knowledge_core/src')}`,
    DATABASE_URL: `sqlite:///${database}`, APP_SECRET: 'g4-cancel-discovery-secret', DEMO_SEED_ENABLED: 'true',
    STARTUP_ORPHAN_CLEANUP_ENABLED: 'false', HARNESS_V3_ROOT: harnessRoot, HARNESS_V3_HOME: join(tempRoot, 'harness-home'),
    HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'), HARNESS_V3_ENABLED: 'true', HARNESS_ADMIN_API_ENABLED: 'true',
    DEMO_MODEL_API_KEY: 'fixture-key', DEMO_MODEL_BASE_URL: `http://127.0.0.1:${ports.model}/v1`, DEMO_MODEL_NAME: 'fixture-model',
    G4_INGEST_BLOCK_FILE: blockFile,
    G4_INGEST_FIXTURE_STARTED_FILE: fixtureStartedFile,
    STAFFDECK_KM_URL: `http://127.0.0.1:${ports.km}`,
    STAFFDECK_KM_BEARER: kmBearer,
    STAFFDECK_KM_PUBLISHER_BEARER: publisherBearer,
  };
  staffService = start(python, ['-m', 'uvicorn', upgrade ? 'single_port_app:app' : 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.staffApi), '--log-level', 'info'], env, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.staffApi}/api/health`);
  if (upgrade) ports.staffVite = ports.staffApi;
  else staffFrontend = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.staffVite), '--strictPort'], { NODE_OPTIONS: '', VITE_PROXY_TARGET: `http://127.0.0.1:${ports.staffApi}`, VITE_TENANT_ID: 'tenant_demo' }, join(staffRoot, 'frontend-enterprise'));
  await waitFor(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`);
  if (upgrade) ports.pilotVite = ports.pilotApi;
  pilotService = start(process.execPath, upgrade ? ['ui/server/webRuntimeSupervisor.js', 'start-built'] : ['scripts/dev-launcher.mjs'], { NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath, PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0', STAFFDECK_KM_BEARER: kmBearer, SERVER_PORT: String(ports.pilotApi), VITE_PORT: String(ports.pilotVite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1' }, root);
  try { await waitFor(`http://127.0.0.1:${ports.pilotVite}/api/auth/status`); }
  catch (error) { output.pilotdeck.startupLogs = pilotService?.logs?.().slice(-12000); throw error; }
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let native = await nativeContext.newPage();
  native.on('request', (request) => { const url = new URL(request.url()); if (/\/api\/(enterprise\/knowledge|km\/)/.test(url.pathname)) output.staffdeck.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null }); });
  native.on('response', async (response) => { const url = new URL(response.url()); if (/\/api\/(enterprise\/knowledge|km\/)/.test(url.pathname)) output.staffdeck.requests.push({ method: response.request().method(), path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') }); });
  const login = await nativeContext.request.post(`http://127.0.0.1:${ports.staffVite}/api/auth/login`, { data: { tenant_id: 'tenant_demo', username: 'admin', password: 'admin' } });
  assert.equal(login.ok(), true); const account = await login.json();
  const agentsResponse = await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/agents?tenant_id=tenant_demo`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(agentsResponse.ok(), true); const agents = await agentsResponse.json(); const branch = agents.find((item) => !item.is_overall)?.id; assert.ok(branch);
  await native.addInitScript((session) => { localStorage.setItem('ultrarag_auth', JSON.stringify(session.account)); localStorage.setItem('ultrarag_enterprise_agent_scope', session.agentId); localStorage.setItem('staffdeck_onboarding_guide_seen', '1'); localStorage.setItem('staffdeck_quick_start_guide_seen', '1'); }, { account, agentId: branch });

  const { runKnowledgeAcceptance, knowledgeSurface } = await import(pathToFileURL(join(staffRoot, 'packages/knowledge-ui/browser-acceptance.mjs')).href);
  await native.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  output.staffdeck.mainWorkflow = await runKnowledgeAcceptance(native, { screenshotPrefix: join(artifactRoot, 'staffdeck-main') });
  native = await knowledgeSurface(native);
  await native.setViewportSize({ width: 1440, height: 1000 });

  async function newBase(page, name) {
    await page.getByLabel('新建知识库', { exact: true }).click();
    await page.getByRole('dialog').getByLabel('名称').fill(name);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByRole('tab', { name: '文档', exact: true }).click();
  }

  await rm(fixtureStartedFile, { force: true });
  await writeFile(blockFile, 'hold ingest worker until UI cancellation\n', 'utf8');
  await newBase(native, 'SD cancellation');
  await native.locator('input[type=file]').first().setInputFiles(await (async () => { const path = join(tempRoot, 'g4-native-cancel.md'); await writeFile(path, '# Native cancel fixture\n\nThis upload is intentionally held by an isolated worker-delay fixture.\n', 'utf8'); return path; })());
  await waitUntil(() => existsSync(fixtureStartedFile), 'Ingest worker did not enter the cancellation fixture');
  await native.getByRole('button', { name: /^(取消|取消入库)$/ }).waitFor({ state: 'visible', timeout: 20_000 });
  output.staffdeck.actions.push('wait for persisted queued native job and click native cancel');
  await native.getByRole('button', { name: /^(取消|取消入库)$/ }).click();
  // Keep the worker blocked long enough to observe the persisted cancel request;
  // then release it so the job can reach its terminal cancelled state.
  await native.waitForTimeout(500);
  await rm(blockFile, { force: true });
  try { await native.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 }); }
  catch (error) { output.staffdeck.cancelPageBody = (await native.locator('body').innerText().catch(() => '')).slice(-6000); throw error; }
  output.staffdeck.persistence.cancelBeforeReload = await native.locator('body').innerText();
  await native.reload({ waitUntil: 'domcontentloaded' });
  await native.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 });
  output.staffdeck.persistence.cancelAfterReload = await native.locator('body').innerText();
  assert.doesNotMatch(output.staffdeck.persistence.cancelAfterReload, /正在取消|取消中/);
  output.coverage.staffdeck_native_cancel = 'real_ui_persisted_cancel_and_reload';
  output.staffdeck.actions.push('reload native page and verify terminal cancelled state persists');

  async function nativeDiscovery(fileName, mode) {
    const path = join(tempRoot, fileName); await writeFile(path, `# Traceable discovery input\n\nThe fixture exposes POST http://127.0.0.1:16129/${mode} with a JSON response field.\n`, 'utf8');
    await newBase(native, fileName);
    await native.locator('input[type=file]').first().setInputFiles(path);
    const tab = native.getByRole('tab', { name: '发现建议' });
    try {
      await tab.waitFor({ state: 'visible', timeout: 45_000 });
      await waitUntil(async () => {
        await tab.click();
        return await native.locator('.suggestion').filter({ hasText: 'Fixture discovery' }).count() > 0;
      }, 'Independent KM discovery suggestion was not rendered in the discovery tab', 45_000);
    }
    catch (error) {
      output.staffdeck.discoveryPageBody = (await native.locator('body').innerText().catch(() => '')).slice(-7000);
      output.staffdeck.discoveryDiagnostics = { branch, km: [], staff: null };
      try {
        const kmSpaces = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/spaces`, { headers: { authorization: `Bearer ${kmBearer}` } });
        output.staffdeck.discoveryDiagnostics.kmSpaces = { status: kmSpaces.status(), body: await kmSpaces.json().catch(() => null) };
        const spaces = output.staffdeck.discoveryDiagnostics.kmSpaces.body || [];
        const scoped = spaces.filter((space) => String(space.id || '').includes(branch));
        for (const space of scoped) {
          const bases = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/knowledge-bases?space_id=${encodeURIComponent(space.id)}`, { headers: { authorization: `Bearer ${kmBearer}` } });
          const baseRows = await bases.json().catch(() => []);
          for (const base of baseRows) {
            const suggestions = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/knowledge-bases/${base.id}/suggestions?space_id=${encodeURIComponent(space.id)}`, { headers: { authorization: `Bearer ${kmBearer}` } });
            output.staffdeck.discoveryDiagnostics.km.push({ space: space.id, base: base.id, status: suggestions.status(), rows: await suggestions.json().catch(() => null) });
          }
        }
      } catch (diagnosticError) { output.staffdeck.discoveryDiagnostics.kmError = String(diagnosticError); }
      try {
        const staff = await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/knowledge/discoveries?tenant_id=tenant_demo&agent_id=${encodeURIComponent(branch)}`, { headers: { authorization: `Bearer ${account.token}` } });
        output.staffdeck.discoveryDiagnostics.staff = { status: staff.status(), body: await staff.json().catch(() => null) };
      } catch (diagnosticError) { output.staffdeck.discoveryDiagnostics.staffError = String(diagnosticError); }
      throw error;
    }
    const card = native.locator('.suggestion').filter({ hasText: 'Fixture discovery' }).last(); await card.waitFor({ state: 'visible' });
    if (mode === 'confirm') {
      await card.getByRole('button', { name: /审核/ }).click();
      await native.waitForTimeout(1_000);
      output.staffdeck.discoveryTransitions ??= [];
      output.staffdeck.discoveryTransitions.push({ mode, afterReviewBody: (await native.locator('body').innerText()).slice(-2500) });
      const reviewedCard = native.locator('.suggestion').filter({ hasText: 'reviewed' }).filter({ hasText: 'Fixture discovery' }).last();
      await reviewedCard.getByRole('button', { name: /发布/ }).click();
      const skillCard = native.locator('.suggestion').filter({ hasText: 'Fixture skill' }).last();
      await skillCard.getByRole('button', { name: /审核/ }).click();
      await skillCard.getByText('reviewed', { exact: true }).waitFor();
      await skillCard.getByRole('button', { name: /发布/ }).click();
      await skillCard.getByText('confirmed', { exact: true }).waitFor();
    } else {
      await card.getByRole('button', { name: /拒绝/ }).click();
    }
    await native.waitForTimeout(1_000);
    await native.reload({ waitUntil: 'domcontentloaded' });
  }
  await nativeDiscovery('g4-native-discovery-confirm.md', 'confirm');
  await nativeDiscovery('g4-native-discovery-reject.md', 'reject');
  const allDiscoveries = await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/knowledge/discoveries?tenant_id=tenant_demo&agent_id=${encodeURIComponent(branch)}`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(allDiscoveries.ok(), true); const discoveryRows = await allDiscoveries.json();
  const kmSpaces = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/spaces`, { headers: { authorization: `Bearer ${kmBearer}` } });
  const allSpaces = await kmSpaces.json();
  const kmDiscoveryRows = [];
  for (const space of allSpaces) {
    const basesResponse = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/knowledge-bases?space_id=${encodeURIComponent(space.id)}`, { headers: { authorization: `Bearer ${kmBearer}` } });
    for (const base of await basesResponse.json()) {
      const response = await nativeContext.request.get(`http://127.0.0.1:${ports.km}/api/km/v1/knowledge-bases/${base.id}/suggestions?space_id=${encodeURIComponent(space.id)}`, { headers: { authorization: `Bearer ${kmBearer}` } });
      kmDiscoveryRows.push(...await response.json());
    }
  }
  output.staffdeck.persistence.discoveryRowsBeforeAssertions = { host: discoveryRows, km: kmDiscoveryRows };
  const confirmedRows = kmDiscoveryRows.filter((row) => row.status === 'confirmed'); const rejectedRows = kmDiscoveryRows.filter((row) => row.status === 'rejected');
  assert.ok(confirmedRows.some((row) => row.title.includes('Fixture discovery'))); assert.ok(rejectedRows.some((row) => row.title.includes('Fixture discovery')));
  output.staffdeck.persistence.discoveryAfterReload = { confirmed: confirmedRows, rejected: rejectedRows };
  output.staffdeck.persistence.hostResources = JSON.parse(execFileSync(python, ['-c', `import sqlite3,json
db=sqlite3.connect('file:' + ${JSON.stringify(database)} + '?mode=ro',uri=True)
print(json.dumps({"tools":db.execute("select id,name,display_name from tools where name like 'fixture.discovery.%'").fetchall(),"skills":db.execute("select id,skill_id,name from skills where name like 'Fixture skill%'").fetchall(),"receipts":db.execute("select suggestion_id,target_reference_json from knowledge_publication_receipts").fetchall()}))
db.close()`], { encoding: 'utf8' }));
  assert.ok(output.staffdeck.persistence.hostResources.tools.length > 0, 'Published Tool not stored in host');
  assert.ok(output.staffdeck.persistence.hostResources.skills.length > 0, 'Published Skill not stored in host');
  output.coverage.staffdeck_native_discoveries_confirm_reject = 'real_ui_model_fixture_pending_confirm_reject_and_reload_readback';
  output.staffdeck.actions.push('confirm and reject model-fixture discoveries in native UI and read back persisted statuses after reload');

  const pilotContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let pilot = await pilotContext.newPage();
  pilot.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.includes('/api/modules/knowledge')) output.pilotdeck.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null }); });
  pilot.on('response', async (response) => { const url = new URL(response.url()); if (url.pathname.includes('/api/modules/knowledge/')) output.pilotdeck.requests.push({ path: url.pathname, method: response.request().method(), operation: response.request().postDataJSON?.()?.operation, responseStatus: response.status(), responseBody: await response.text().catch(() => '') }); });
  const credentials = { username: 'g4-cancel-discovery-owner', password: 'g4-cancel-discovery-owner-password' };
  const registration = await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/register`, { data: credentials });
  const pilotAccount = registration.ok() ? await registration.json() : await (await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof pilotAccount.token, 'string'); await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${pilotAccount.token}` } });
  const pilotUserId = String(pilotAccount.user?.id ?? pilotAccount.id ?? '');
  output.pilotdeck.pilotUserId = pilotUserId;
  assert.equal(pilotUserId, '1');
  output.pilotdeck.configAfterAuth = await readFile(configPath, 'utf8');
  await pilot.addInitScript((token) => localStorage.setItem('auth-token', token), pilotAccount.token);
  await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' });
  output.pilotdeck.mainWorkflow = await runKnowledgeAcceptance(pilot, { screenshotPrefix: join(artifactRoot, 'pilotdeck-main') });
  pilot = await knowledgeSurface(pilot);
  await pilot.setViewportSize({ width: 1440, height: 1000 });
  await rm(fixtureStartedFile, { force: true });
  await writeFile(blockFile, 'hold PilotDeck ingest until adapter cancel\n', 'utf8');
  await newBase(pilot, 'PD cancellation');
  await pilot.waitForTimeout(1_500);
  if (!(await pilot.locator('input[type=file]').count())) {
    output.pilotdeck.pageBodyBeforeFallback = (await pilot.locator('body').innerText().catch(() => '')).slice(0, 2400);
    await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' });
    const createButton = pilot.getByRole('button', { name: /新建知识库|New knowledge/i }).first();
    output.pilotdeck.createButtonCount = await createButton.count();
    if (await createButton.count()) await createButton.click();
    await pilot.waitForTimeout(1_000);
    output.pilotdeck.pageBodyAfterFallback = (await pilot.locator('body').innerText().catch(() => '')).slice(0, 4000);
    await pilot.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 });
  }
  const pilotCancelFile = join(tempRoot, 'g4-pilot-cancel.md'); await writeFile(pilotCancelFile, '# PilotDeck cancel fixture\n\nAdapter cancellation must persist.\n', 'utf8');
  await pilot.locator('input[type=file]').first().setInputFiles(pilotCancelFile);
  await waitUntil(() => existsSync(fixtureStartedFile), 'PilotDeck ingest worker did not enter the cancellation fixture');
  try { await pilot.getByRole('button', { name: /^(取消|取消入库|Cancel)$/ }).waitFor({ state: 'visible', timeout: 20_000 }); } catch (error) { output.pilotdeck.cancelPageBody = (await pilot.locator('body').innerText().catch(() => '')).slice(-5000); throw error; }
  await pilot.getByRole('button', { name: /^(取消|取消入库|Cancel)$/ }).click();
  await pilot.waitForTimeout(500);
  await rm(blockFile, { force: true });
  await pilot.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 }); await pilot.reload({ waitUntil: 'domcontentloaded' }); await pilot.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 });
  output.pilotdeck.persistence.cancelAfterReload = await pilot.locator('body').innerText(); output.coverage.pilotdeck_adapter_cancel = 'real_shared_page_adapter_persisted_cancel_and_reload'; output.pilotdeck.actions.push('cancel queued job through PilotDeck shared Knowledge page and verify after reload');
  async function pilotDiscovery(fileName, mode) {
    const path = join(tempRoot, fileName); await writeFile(path, `# PilotDeck traceable discovery ${mode}\n\nThe fixture exposes POST http://127.0.0.1:16129/${mode}.\n`, 'utf8');
    await newBase(pilot, fileName);
    await pilot.waitForTimeout(500);
    if (!(await pilot.locator('input[type=file]').count())) { await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' }); await pilot.getByRole('button', { name: /新建知识库|New knowledge/i }).first().click(); await pilot.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 }); }
    await pilot.locator('input[type=file]').first().setInputFiles(path);
    const tab = pilot.getByRole('tab', { name: '发现建议' });
    await tab.waitFor({ state: 'visible', timeout: 45_000 });
    await waitUntil(async () => { await tab.click(); return await pilot.locator('.suggestion').filter({ hasText: 'Fixture discovery' }).count() > 0; }, 'PilotDeck discovery suggestion was not rendered in the discovery tab', 45_000);
    const card = pilot.locator('.suggestion').filter({ hasText: 'Fixture discovery' }).last();
    if (mode === 'confirm') {
      await card.getByRole('button', { name: /审核/ }).click();
    } else await card.getByRole('button', { name: /拒绝/ }).click();
    await pilot.waitForTimeout(800); await pilot.reload({ waitUntil: 'domcontentloaded' });
  }
  try {
    await pilotDiscovery('g4-pilot-discovery-confirm.md', 'confirm'); await pilotDiscovery('g4-pilot-discovery-reject.md', 'reject');
    const directHeaders = { authorization: `Bearer ${kmBearer}` };
    const baseResponse = await pilotContext.request.get(`http://127.0.0.1:${ports.pilotVite}/api/modules/knowledge/core/knowledge-bases?space_id=${encodeURIComponent('sd:tenant_demo:agent_preset_sales_001')}`, { headers: { authorization: `Bearer ${pilotAccount.token}` } });
    assert.equal(baseResponse.ok(), true);
    const baseRows = await baseResponse.json();
    const directRows = [];
    for (const base of baseRows) {
      const response = await pilotContext.request.get(`http://127.0.0.1:${ports.pilotVite}/api/modules/knowledge/core/knowledge-bases/${base.id}/suggestions?space_id=${encodeURIComponent('sd:tenant_demo:agent_preset_sales_001')}`, { headers: { authorization: `Bearer ${pilotAccount.token}` } });
      assert.equal(response.ok(), true);
      directRows.push(...await response.json());
    }
    const pdConfirmed = directRows.filter((row) => row.status === 'reviewed' && row.title?.includes('Fixture discovery'));
    const pdRejected = directRows.filter((row) => row.status === 'rejected' && row.title?.includes('Fixture discovery'));
    assert.ok(pdConfirmed.length > 0); assert.ok(pdRejected.length > 0);
    const { loadPilotConfig } = await import('../dist/src/pilot/config/loadPilotConfig.js');
    const { createKnowledgeModulePort } = await import('../dist/src/composition/domainPorts.js');
    const binding = loadPilotConfig({ configPath }).config.modules.knowledge;
    process.env.STAFFDECK_KM_BEARER = kmBearer;
    const runtime = createKnowledgeModulePort(binding);
    output.pilotdeck.runtimeManagement = [];
    const runtimeCall = async (operation, input) => {
      const result = await runtime.call(operation, input);
      output.pilotdeck.runtimeManagement.push({ operation, input, result });
      return result;
    };
    const pending = directRows.find(row => row.status === 'pending' && row.title?.includes('Fixture skill'));
    assert.ok(pending, 'Runtime review requires a pending generic suggestion');
    const reviewed = await runtimeCall('confirm_discovery', { suggestion_id: pending.id });
    assert.equal(reviewed.status, 'reviewed');
    const reread = await runtimeCall('get_discovery', { suggestion_id: pending.id });
    assert.equal(reread.status, 'reviewed');
    const exported = await runtimeCall('export_discovery', { suggestion_id: pending.id });
    assert.ok(exported, 'Runtime suggestion export is empty');
    output.pilotdeck.persistence.discoveryAfterReload = { reviewed: pdConfirmed, rejected: pdRejected, externalPublication: 'not_requested_by_independent_PilotDeck_UI' }; output.coverage.pilotdeck_adapter_discoveries_confirm_reject = 'real_shared_page_adapter_model_fixture_pending_review_reject_and_reload_readback'; output.pilotdeck.actions.push('review and reject through PilotDeck shared adapter and read back persisted statuses');
  } catch (error) {
    output.coverage.pilotdeck_adapter_discoveries_confirm_reject = 'blocked';
    output.requiredFailures = ['pilotdeck_adapter_discoveries_confirm_reject'];
    process.exitCode = 1;
    output.pilotdeck.persistence.discoveryBoundary = { status: 'BLOCKED', reason: 'PilotDeck discovery flow did not reach its terminal readback.', error: error instanceof Error ? error.message : String(error) };
  }
  await native.screenshot({ path: join(artifactRoot, 'g4-knowledge-cancel-discovery-staffdeck.png'), fullPage: true }).catch(() => undefined); await pilot.screenshot({ path: join(artifactRoot, 'g4-knowledge-cancel-discovery-pilotdeck.png'), fullPage: true }).catch(() => undefined);
  if (upgrade) {
    const versions = async () => ({
      sd: await (await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/km-ui/ui/v1/version.json`)).json(),
      pd: await (await pilotContext.request.get(`http://127.0.0.1:${ports.pilotVite}/km-ui/ui/v1/version.json`)).json(),
    });
    output.upgrade.initialVersions = await versions();
    assert.equal(output.upgrade.initialVersions.sd.version, 'upgrade-before');
    assert.equal(output.upgrade.initialVersions.pd.version, 'upgrade-before');
    await stop(kmOwnerService);
    await writeFile(join(artifactRoot, 'km-before-upgrade.log'), kmOwnerService.logs());
    await writeFile(join(uiDirectory, 'version.json'), JSON.stringify({ protocol: 'knowledge-frame/v1', version: 'upgrade-after' }));
    const replacement = join(uiDirectory, 'assets/upgrade-marker.js');
    await writeFile(replacement, `document.documentElement.dataset.kmUiVersion='upgrade-after';`);
    const index = join(uiDirectory, 'index.html');
    await writeFile(index, (await readFile(index, 'utf8')).replace('</head>', '<script type="module" src="./assets/upgrade-marker.js"></script></head>'));
    kmOwnerService = start(kmPython, kmArgs, kmEnv, tempRoot);
    await waitFor(`http://127.0.0.1:${ports.km}/health/ready`);
    output.upgrade.afterVersions = await versions();
    for (const [name, page] of [['sd', native], ['pd', pilot]]) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.kmUiVersion), 'upgrade-after');
      output.upgrade[name] = await runKnowledgeAcceptance(page, { screenshotPrefix: join(artifactRoot, name + '-upgraded') });
    }
    output.upgrade.after = { sd: await artifactState(join(staffRoot, 'frontend-enterprise/dist')), pd: await artifactState(join(root, 'ui/dist')) };
    assert.deepEqual(output.upgrade.after, output.upgrade.before);
    assert.equal(output.upgrade.afterVersions.sd.version, 'upgrade-after');
    assert.equal(output.upgrade.afterVersions.pd.version, 'upgrade-after');
    output.upgrade.status = 'passed';
  }
  await nativeContext.close(); await pilotContext.close();
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await stop(pilotService); await stop(staffFrontend); await stop(staffService); await stop(kmOwnerService); await new Promise((resolveClose) => modelServer.close(resolveClose));
  output.cleanup.blockFileRemoved = !existsSync(blockFile); output.cleanup.processesStopped = true;
  output.modelFixtureRequests = modelResponses.requests;
  output.modelFixtureCounts = { discovery: modelResponses.discovery, buckets: modelResponses.buckets };
  output.lifecycle = {};
  for (const [name, handle] of Object.entries({ pilotService, staffFrontend, staffService, kmOwnerService })) {
    if (!handle) continue;
    await writeFile(join(artifactRoot, `${name}.log`), handle.logs().replace(/([?&](?:token|auth)=)[^&\s]+/g, '$1[redacted]'), 'utf8');
    output.lifecycle[name] = { exitCode: handle.child.exitCode, signal: handle.child.signalCode, forced: !!handle.forced };
  }
  output.status = output.error || output.requiredFailures?.length || Object.values(output.lifecycle).some(item => item.forced) ? 'failed' : 'passed';
  await mkdir(artifactRoot, { recursive: true }); await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (browser) await browser.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
