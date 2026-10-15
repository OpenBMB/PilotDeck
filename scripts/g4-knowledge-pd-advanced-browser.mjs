import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const python = process.env.STAFFDECK_PYTHON || '/tmp/staffdeck-shared-venv/bin/python';
const kmPython = process.env.KM_PYTHON || join(staffRoot, 'knowledge_core/.venv/bin/python');
const harnessRoot = process.env.HARNESS_V3_ROOT || '/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2';
const ports = { staffApi: 16134, pilotApi: 16136, pilotVite: 16137, gateway: 16138 };
const kmPort = Number(process.env.G4_KM_PORT || 16135);
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-pd-advanced-browser');
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-pd-advanced-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const kmIdentityFile = join(tempRoot, 'km-identity.json');
const kmBearer = 'g4-pd-advanced-km-token';
const pilotHome = join(tempRoot, 'pilot-home');
const configPath = join(tempRoot, 'pilotdeck.yaml');
const branchAgentId = 'agent_7d062081c03b4e16';
const output = { ports, startup: 'formal_app_main_with_harness_v3', scope: branchAgentId, actions: [], requests: [], persistence: {}, coverage: { versions_rollback: 'not_run', structure_buckets_chunks: 'not_run', okf_export_lint: 'not_run', okf_import_failure: 'not_run' }, cleanup: { tempRoot } };

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  return { child };
}
async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function stop(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  try { process.kill(handle.child.pid, 'SIGTERM'); } catch {}
  await new Promise((resolveStop) => setTimeout(resolveStop, 800));
  if (handle.child.exitCode === null) { try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {} try { process.kill(handle.child.pid, 'SIGKILL'); } catch {} }
}
async function findBase(page, name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
    if (await search.count() && attempt === 0) await search.fill(name);
    const row = page.locator('tr').filter({ hasText: name }).first();
    if (await row.count() && await row.isVisible()) return row;
    const exactNames = page.getByText(name, { exact: false });
    for (let index = 0; index < await exactNames.count(); index += 1) {
      const exactName = exactNames.nth(index);
      if (await exactName.isVisible()) return exactName;
    }
    const next = page.getByRole('button', { name: /Next Page|下一页/ }).last();
    if (await next.count() && !(await next.isDisabled())) await next.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: join(artifactRoot, `find-base-failure-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
  output.findBaseDebug = { url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 5000) };
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function selectBase(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: false });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const candidate = names.nth(index);
      if (await candidate.isVisible()) {
        await candidate.click();
        return;
      }
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function visibleBaseName(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: false });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const candidate = names.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function forceSelectBase(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: false });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (await names.count()) {
      await names.first().evaluate((element) => (element.closest('tr') || element).dispatchEvent(new MouseEvent('click', { bubbles: true })));
      return;
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not attached`);
}
async function openBaseActionsFor(page, name) {
  const names = page.getByText(name, { exact: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const nameCell = names.nth(index);
      if (!(await nameCell.isVisible())) continue;
      const ancestor = nameCell.locator('xpath=ancestor::*[.//button[contains(@aria-label, "Knowledge Base Actions")]][1]');
      const action = ancestor.getByRole('button', { name: /Knowledge Base Actions|知识库操作/i }).first();
      if (await action.count()) {
        await action.evaluate((element) => element.click());
        return;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Knowledge base actions trigger not found for ${name}`);
}
function responseFor(operation) { return output.requests.find((item) => item.operation === operation && Number.isInteger(item.responseStatus)); }
async function waitResponse(operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const response = responseFor(operation); if (response) return response; await new Promise((resolveDelay) => setTimeout(resolveDelay, 300)); }
  throw new Error(`Timed out waiting for ${operation} response`);
}

await mkdir(artifactRoot, { recursive: true });
await mkdir(pilotHome, { recursive: true });
await writeFile(kmIdentityFile, JSON.stringify({
  [kmBearer]: { id: 'g4-pd-advanced-km-owner', tenant_id: 'tenant_demo', display_name: 'G4 PilotDeck KM owner', spaces: ['*'], permissions: ['read', 'write'] },
}, null, 2));
await writeFile(configPath, `schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator:\n          capabilities:\n            supportsToolUse: true\nwebui:\n  runtime:\n    serverPort: ${ports.pilotApi}\n    vitePort: ${ports.pilotVite}\n    databasePath: ${join(pilotHome, 'auth.db')}\n    workspacesRoot: ${join(pilotHome, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: staffdeck.knowledge\n    frontendModule: staffdeck.knowledge\n    contract: staffdeck.knowledge/v1\n    transport: module-http-v2\n    endpoint: http://127.0.0.1:${ports.staffApi}\n    callPath: /v2/module/call\n    tenantId: tenant_demo\n    actorUserId: admin\n    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');
await writeFile(configPath, (await readFile(configPath, 'utf8'))
  .replace('implementationId: staffdeck.knowledge', 'implementationId: knowledge-core')
  .replace('contract: staffdeck.knowledge/v1', 'contract: knowledge-core/v1')
  .replace('transport: module-http-v2', 'transport: rest-http-v1')
  .replace(`endpoint: http://127.0.0.1:${ports.staffApi}`, `endpoint: http://127.0.0.1:${kmPort}`)
  .replace('    callPath: /v2/module/call\n    tenantId: tenant_demo\n    actorUserId: admin\n', '    credentialEnv: STAFFDECK_KM_BEARER\n    pilotDeckUserId: __USER__\n    spaceId: sd:tenant_demo:agent_tenant_demo_overall\n    spaces:\n      - id: sd:tenant_demo:agent_tenant_demo_overall\n        name: Overall\n')
  .replace('    methods:', '    methods:'), 'utf8');

let kmOwnerService; let service; let pilot; let browser; let page;
try {
  kmOwnerService = start(kmPython, ['-m', 'knowledge_core.cli', '--database-url', `sqlite:///${join(tempRoot, 'knowledge-owner.sqlite')}`, '--identity-file', kmIdentityFile, '--host', '127.0.0.1', '--port', String(kmPort)], { PYTHONPATH: join(staffRoot, 'knowledge_core/src') }, tempRoot);
  await waitFor(`http://127.0.0.1:${kmPort}/health/ready`);
  service = start(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.staffApi), '--log-level', 'warning'], {
    PYTHONPATH: `${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}`,
    DATABASE_URL: `sqlite:///${database}`, STAFFDECK_KM_URL: `http://127.0.0.1:${kmPort}`, STAFFDECK_KM_BEARER: kmBearer,
    STAFFDECK_KNOWLEDGE_SEED: 'true', STAFFDECK_KNOWLEDGE_TENANT_ID: 'tenant_demo', STAFFDECK_KNOWLEDGE_USER_ID: 'admin',
    APP_SECRET: 'g4-pd-advanced-secret', DEMO_SEED_ENABLED: 'true', STARTUP_ORPHAN_CLEANUP_ENABLED: 'false',
    HARNESS_V3_ROOT: harnessRoot, HARNESS_V3_HOME: join(tempRoot, 'harness-home'), HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'), HARNESS_V3_ENABLED: 'true', HARNESS_ADMIN_API_ENABLED: 'true',
  }, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.staffApi}/api/health`);
  pilot = start(process.execPath, ['scripts/dev-launcher.mjs'], { NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath, PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0', STAFFDECK_KM_BEARER: kmBearer, SERVER_PORT: String(ports.pilotApi), VITE_PORT: String(ports.pilotVite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1' }, root);
  await waitFor(`http://127.0.0.1:${ports.pilotVite}/api/auth/status`);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/modules/knowledge/call') {
      output.requests.push({ operation: request.postDataJSON?.().operation, input: request.postDataJSON?.().input || {} });
    } else if (url.pathname.startsWith('/api/modules/knowledge/core/')) {
      output.requests.push({ operation: undefined, method: request.method(), path: url.pathname, input: request.postDataJSON?.() ?? null });
    }
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/modules/knowledge/call') {
      output.requests.push({ operation: response.request().postDataJSON?.().operation, responseStatus: response.status(), responseBody: await response.text().catch(() => '') });
    } else if (url.pathname.startsWith('/api/modules/knowledge/core/')) {
      const method = response.request().method();
      const operation = method === 'POST' && /\/documents$/.test(url.pathname)
        ? 'import_document'
        : method === 'POST' && url.pathname.endsWith('/query') ? 'query'
          : method === 'PUT' && url.pathname.includes('/chunks/') ? 'update_chunk'
            : method === 'POST' && url.pathname.includes('/versions/rollback') ? 'rollback_version'
              : method === 'GET' && url.pathname.endsWith('/okf') ? 'export_okf'
                : method === 'POST' && url.pathname.endsWith('/okf/lint') ? 'lint_okf'
                  : method === 'POST' && url.pathname.endsWith('/okf') ? 'import_okf' : undefined;
      output.requests.push({ operation, method, path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') });
    }
  });
  const credentials = { username: 'g4-pd-advanced-owner', password: 'g4-pd-advanced-owner-password' };
  const registration = await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/register`, { data: credentials });
  const account = registration.ok() ? await registration.json() : await (await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof account.token, 'string');
  const pilotDeckUserId = account.user?.id ?? account.user?.user_id ?? account.id ?? account.userId;
  assert.ok(pilotDeckUserId, `PilotDeck registration did not return a user id: ${JSON.stringify(account)}`);
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('__USER__', JSON.stringify(String(pilotDeckUserId))), 'utf8');
  await stop(pilot);
  pilot = start(process.execPath, ['scripts/dev-launcher.mjs'], { NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath, PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0', STAFFDECK_KM_BEARER: kmBearer, SERVER_PORT: String(ports.pilotApi), VITE_PORT: String(ports.pilotVite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1' }, root);
  await waitFor(`http://127.0.0.1:${ports.pilotVite}/api/auth/status`);
  await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${account.token}` } });
  await page.addInitScript((session) => { localStorage.setItem('auth-token', session.token); localStorage.setItem('ultrarag_enterprise_agent_scope', session.agentId); }, { token: account.token, agentId: branchAgentId });

  await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' });
  const advancedBaseName = `G4 PD Advanced ${Date.now()}`;
  await page.getByLabel('新建知识库', { exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称').fill(advancedBaseName);
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('heading', { name: advancedBaseName, exact: true }).waitFor({ timeout: 20_000 });
  const source = join(tempRoot, 'g4-pd-advanced.md'); await writeFile(source, '# PilotDeck Advanced Policy\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n', 'utf8');
  await page.locator('input[type=file]').first().setInputFiles(source);
  const upload = await waitResponse('import_document', 30_000); assert.equal(upload.responseStatus, 202); output.actions.push('upload branch-scoped advanced document through PilotDeck shared UI');
  await page.waitForTimeout(4_000);
  await forceSelectBase(page, advancedBaseName);
  await page.getByText(/Knowledge graph|知识图谱|文档|Wiki|关系图|检索|版本/).last().waitFor({ timeout: 30_000 });
  // The shared KM page opens a document from the document-list row; hosted
  // pages may expose a separate Details button, so support both surfaces.
  const detailButton = page.getByRole('button', { name: /详情|Details/ }).last();
  if (await detailButton.count()) await detailButton.click();
  else await page.locator('.document-list button').filter({ hasText: 'g4-pd-advanced' }).first().click();
  const evidenceDetail = page.locator('.knowledge-detail-modal').last();
  if (await evidenceDetail.count()) {
    await evidenceDetail.waitFor({ state: 'visible', timeout: 10_000 });
    await evidenceDetail.getByRole('button', { name: /Edit|编辑|修改/ }).first().click();
    const bucketDialog = page.locator('[role=dialog]').last();
    await bucketDialog.locator('textarea').nth(2).waitFor({ state: 'visible', timeout: 15_000 });
    await bucketDialog.locator('textarea').last().fill('Owner approval is required.\n\nUnchanged field: retain this paragraph.\n\nPD bucket edit persisted.');
    await bucketDialog.getByRole('button', { name: /Save|保存/ }).last().click();
  } else {
    const structure = page.locator('details.document-structure');
    await structure.locator('summary').click();
    await structure.getByRole('button', { name: /编辑片段|Edit chunk/ }).first().click();
    await page.getByLabel('结构正文').fill('Owner approval is required.\n\nUnchanged field: retain this paragraph.\n\nPD bucket edit persisted.');
    await page.getByRole('button', { name: /保存结构|Save structure/ }).click();
  }
  const chunkSave = await waitResponse('update_chunk'); assert.equal(chunkSave.responseStatus, 200); output.actions.push('edit and save bucket/chunk through PilotDeck shared UI');
  await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' }); await forceSelectBase(page, advancedBaseName); await page.getByText(/Knowledge graph|知识图谱|文档|Wiki|关系图|检索|版本/).last().waitFor({ timeout: 30_000 }); await page.locator('.document-list button').filter({ hasText: 'g4-pd-advanced' }).first().click(); const reloadedStructure = page.locator('details.document-structure'); await reloadedStructure.locator('summary').click(); await reloadedStructure.getByText('PD bucket edit persisted', { exact: false }).waitFor({ timeout: 15_000 }); output.persistence.bucketReload = (await reloadedStructure.innerText()).slice(-1800); output.coverage.structure_buckets_chunks = 'real_ui_pd_shared_adapter_edit_reload';

  await page.keyboard.press('Escape').catch(() => undefined);

  // Export/lint/import use the populated branch head. A rollback to the
  // initial empty upload version is intentionally hidden by the shared page,
  // so perform these row-scoped actions before the final rollback check.
  const downloadEvent = page.waitForEvent('download'); await page.getByLabel('导出 OKF', { exact: true }).click(); const download = await downloadEvent; assert.match(download.suggestedFilename(), /\.zip/i); const exportResponse = await waitResponse('export_okf'); assert.equal(exportResponse.responseStatus, 200); output.persistence.export = { filename: download.suggestedFilename(), status: exportResponse.responseStatus }; await page.getByRole('tab', { name: 'Wiki', exact: true }).click(); await page.getByRole('button', { name: /检查|Lint/ }).click(); await page.getByRole('alert').or(page.getByText(/检查|lint/i)).first().waitFor({ timeout: 10_000 }).catch(() => undefined); const lint = await waitResponse('lint_okf'); assert.equal(lint.responseStatus, 200); output.persistence.lint = { status: lint.responseStatus }; output.coverage.okf_export_lint = 'real_ui_pd_shared_adapter_export_lint'; output.actions.push('export and lint OKF through PilotDeck shared UI');

  const invalid = join(tempRoot, 'invalid.okf.zip'); await writeFile(invalid, 'not a zip archive', 'utf8'); await page.locator('input[type=file]').nth(1).setInputFiles(invalid); const importFailure = await waitResponse('import_okf'); assert.ok(importFailure.responseStatus >= 400 && importFailure.responseStatus < 500); output.persistence.invalidImport = { status: importFailure.responseStatus, body: importFailure.responseBody }; output.coverage.okf_import_failure = 'real_ui_pd_shared_adapter_invalid_archive_failure'; output.actions.push('exercise invalid OKF import failure through PilotDeck shared UI');

  await page.getByRole('tab', { name: '版本', exact: true }).click(); const versionRows = page.locator('tbody tr'); await versionRows.nth(1).waitFor({ timeout: 10_000 }); assert.ok(await versionRows.count() >= 2); await page.getByRole('button', { name: /回滚|Roll back/ }).first().click(); const rollback = await waitResponse('rollback_version'); assert.equal(rollback.responseStatus, 200); output.persistence.rollback = rollback.responseBody; output.coverage.versions_rollback = 'real_ui_pd_shared_adapter_branch_version_list_and_rollback'; output.actions.push('list branch versions and rollback through PilotDeck shared UI');
  await page.screenshot({ path: join(artifactRoot, 'g4-knowledge-pd-advanced.png'), fullPage: true }).catch(() => undefined); await context.close();
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  if (page) {
    output.failureDiagnostics = {
      url: page.url(),
      dialogs: await page.locator('[role=dialog]').evaluateAll((nodes) => nodes.map((node) => ({ className: node.className, text: (node.textContent || '').slice(0, 2500), html: node.outerHTML.slice(0, 5000) }))).catch(() => []),
      visibleButtons: await page.getByRole('button').evaluateAll((nodes) => nodes.filter((node) => { const style = window.getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden'; }).map((node) => ({ aria: node.getAttribute('aria-label'), text: (node.textContent || '').trim() })).slice(-80)).catch(() => []),
      body: (await page.locator('body').innerText().catch(() => '')).slice(-8000),
    };
  }
  throw error;
}
finally { await stop(pilot); await stop(service); await stop(kmOwnerService); await browser?.close(); output.cleanup.processesStopped = true; await mkdir(artifactRoot, { recursive: true }); await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8'); await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined); }

console.log(JSON.stringify({ artifactRoot, coverage: output.coverage }, null, 2));
