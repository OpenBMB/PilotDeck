import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const kmUrl = process.env.STAFFDECK_KM_URL || 'http://127.0.0.1:18798';
const kmBearer = process.env.STAFFDECK_KM_BEARER || '';
const ports = { api: 16236, vite: 16237, gateway: 16238 };
const temp = await mkdtemp(join(tmpdir(), 'pd-km-core-'));
const config = join(temp, 'pilotdeck.yaml');
const home = join(temp, 'home');
const space = process.env.PD_KM_SPACE || 'sd:tenant_demo:agent_f2828efc2a2a476d';
let pilot;
function start() { return spawn(process.execPath, ['scripts/dev-launcher.mjs'], { cwd: root, env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: config, PILOTDECK_FRONTEND_PROFILE: config, SERVER_PORT: String(ports.api), VITE_PORT: String(ports.vite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1', PILOTDECK_DISABLE_LOCAL_AUTH: '0', STAFFDECK_KM_BEARER: kmBearer }, stdio: process.env.PD_DEBUG ? 'inherit' : 'ignore' }); }
async function wait(url) { for (let i = 0; i < 180; i += 1) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error(`timeout ${url}`); }
await mkdir(home, { recursive: true });
await writeFile(config, `schemaVersion: 1\nwebui:\n  runtime:\n    serverPort: ${ports.api}\n    vitePort: ${ports.vite}\n    databasePath: ${join(home, 'auth.db')}\n    workspacesRoot: ${join(home, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: knowledge-core\n    frontendModule: staffdeck.knowledge\n    contract: knowledge-core/v1\n    transport: http\n    endpoint: ${kmUrl}\n    credentialEnv: STAFFDECK_KM_BEARER\n    pilotDeckUserId: __USER__\n    spaces:\n      - id: ${space}\n        name: PilotDeck acceptance\n    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');
if (!kmBearer) await writeFile(config, (await readFile(config, 'utf8')).replace('    credentialEnv: STAFFDECK_KM_BEARER\n', ''));
await writeFile(config, (await readFile(config, 'utf8')).replace('transport: http', 'transport: rest-http-v1').replace('    spaces:\n', `    spaceId: ${space}\n    spaces:\n`).replace(
  'schemaVersion: 1\n',
  'schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator: {}\n',
));
pilot = start();
try {
  await wait(`http://127.0.0.1:${ports.vite}/api/auth/status`);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const credentials = { username: `pd-km-${Date.now()}`, password: 'pd-km-core-acceptance-password' };
  const registration = await context.request.post(`http://127.0.0.1:${ports.vite}/api/auth/register`, { data: credentials });
  const account = registration.ok() ? await registration.json() : await (await context.request.post(`http://127.0.0.1:${ports.vite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof account.token, 'string');
  await context.request.post(`http://127.0.0.1:${ports.vite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${account.token}` } });
  await writeFile(config, (await readFile(config, 'utf8')).replace('__USER__', JSON.stringify(String(account.user?.id ?? account.id))));
  pilot.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  pilot = start();
  await wait(`http://127.0.0.1:${ports.vite}/api/auth/status`);
  const page = await context.newPage();
  const kmTrace = [];
  page.on('response', async response => {
    if (!response.url().includes('/api/modules/knowledge/core')) return;
    const entry = { method: response.request().method(), url: response.url(), status: response.status() };
    try { entry.body = (await response.text()).slice(0, 2000); } catch {}
    kmTrace.push(entry);
  });
  await page.addInitScript(token => localStorage.setItem('auth-token', token), account.token);
  await page.goto(`http://127.0.0.1:${ports.vite}/knowledge/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if ((await page.getByText('First-time setup', { exact: true }).count())) {
    await page.getByRole('button', { name: /Start setup/i }).click();
    for (let i = 0; i < 5; i += 1) {
      const next = page.getByRole('button', { name: /Next|Continue|完成|Finish|跳过/i }).last();
      if (!(await next.count())) break;
      await next.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1000);
    await page.goto(`http://127.0.0.1:${ports.vite}/knowledge/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForTimeout(5000);
  if (!(await page.getByLabel('新建知识库', { exact: true }).count())) {
    throw new Error(`PilotDeck KM UI did not mount: ${(await page.locator('body').innerText()).slice(0, 4000)}`);
  }
  await page.getByLabel('新建知识库', { exact: true }).click();
  const name = `PD Core ${Date.now()}`;
  await page.getByRole('dialog').getByLabel('名称').fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  try { await page.getByRole('heading', { name, exact: true }).waitFor(); }
  catch (error) { throw new Error(`${error.message}\nKM_TRACE=${JSON.stringify(kmTrace)}`); }
  await page.locator('input[type=file]').first().setInputFiles({ name: 'pd-core.md', mimeType: 'text/markdown', buffer: Buffer.from('# PD core\n\nPilotDeck independent knowledge evidence.') });
  await page.locator('.job').first().getByText('完成', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.document-list button').first().click();
  await page.getByLabel('文档正文').fill('# PD core\n\nPilotDeck independent knowledge evidence updated.');
  await page.getByLabel('保存正文', { exact: true }).click();
  const structure = page.getByText('主题与片段', { exact: true });
  await structure.waitFor({ timeout: 10000 });
  await structure.click();
  await page.locator('.bucket-section').first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '编辑主题', exact: true }).first().click();
  await page.getByLabel('结构正文').fill('PD structure topic persisted.');
  await page.getByRole('button', { name: '保存结构', exact: true }).click();
  await page.getByText('PD structure topic persisted.', { exact: false }).waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: 'Wiki', exact: true }).click();
  const wikiRow = page.locator('.wiki-row').first();
  await wikiRow.waitFor({ timeout: 10000 });
  await wikiRow.click();
  await page.getByRole('button', { name: '编辑', exact: true }).last().click();
  await page.getByLabel('Wiki 正文').fill('# PD Wiki\n\nWiki edit persisted.');
  await page.getByRole('button', { name: '保存', exact: true }).last().click();
  await page.getByText('Wiki edit persisted.', { exact: false }).waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: '关系图', exact: true }).click();
  await page.locator('[aria-label="知识图谱画布"]').waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: '检索', exact: true }).click();
  await page.getByLabel('检索问题').fill('PilotDeck independent knowledge');
  await page.getByRole('button', { name: '检索', exact: true }).click();
  await page.locator('.citation').first().click();
  await page.getByRole('dialog').getByRole('heading', { name: '引用来源' }).waitFor();
  await page.getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '版本', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.locator('tbody tr').nth(1).waitFor();
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await page.getByText('已发布', { exact: true }).waitFor();
  const rollback = page.getByRole('button', { name: '回滚', exact: true }).first();
  await rollback.waitFor({ timeout: 10000 });
  await rollback.click();
  await page.waitForTimeout(500);
  const download = page.waitForEvent('download');
  await page.getByRole('tab', { name: '文档', exact: true }).click();
  await page.getByRole('tab', { name: 'Wiki', exact: true }).click();
  await page.getByLabel('导出 OKF', { exact: true }).click();
  await download;
  await page.getByRole('button', { name: '删除知识库', exact: true }).click();
  await page.getByRole('button', { name: '隐藏当前绑定', exact: true }).click();
  await page.getByRole('button', { name: '恢复隐藏绑定', exact: true }).click();
  await page.getByRole('button', { name: '恢复', exact: true }).first().click();
  await page.screenshot({ path: '/tmp/pd-km-core-acceptance.png', fullPage: true });
  console.log(JSON.stringify({ name, workflow: ['create', 'upload', 'edit', 'bucket-edit', 'wiki-edit', 'graph', 'search', 'citation', 'copy', 'sync', 'publish', 'rollback', 'okf-export', 'hide', 'restore'], pageErrors: [] }));
  await browser.close();
} finally {
  pilot?.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}
