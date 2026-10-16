import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify, parse } from 'yaml';
import { loadPilotConfig } from '../dist/src/pilot/config/loadPilotConfig.js';
import { createLocalGateway } from '../dist/src/cli/createLocalGateway.js';
import { KNOWLEDGE_CORE_METHODS, KNOWLEDGE_AGENT_METHODS } from '../src/composition/knowledgeCoreOperations.mjs';

const output = process.env.KM_AGENT_EVIDENCE;
assert.ok(output, 'KM_AGENT_EVIDENCE required');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'km-agent-management-'));
const endpoint = process.env.KM_AGENT_URL || 'http://127.0.0.1:18890';
const credentialEnv = process.env.KM_AGENT_CREDENTIAL_ENV;
const bearer = credentialEnv ? process.env[credentialEnv] : undefined;
assert.ok(!credentialEnv || bearer, 'KM Agent credential is unavailable');
const source = process.env.PD_MODEL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml';
const { config } = loadPilotConfig({ configPath: source });
const raw = parse(await readFile(source, 'utf8'));
const selected = process.env.PD_MODEL_ID || 'provider1/deepseek-v4-flash-0731';
const report = { status: 'not_accepted', model: selected, turns: [], readbacks: [] };
let gateway;
async function http(method, path, body) {
  const response = await fetch(endpoint + '/api/km/v1' + path, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  report.readbacks.push({ method, path, status: response.status, value });
  return value;
}
try {
  const space = await http('POST', '/spaces', { id: 'pd-agent-' + Date.now(), name: 'PD Agent ' + Date.now() });
  const base = await http('POST', '/knowledge-bases', { name: 'PD Agent management', space_id: space.id });
  const providers = Object.fromEntries(Object.entries(raw.model.providers).filter(([id]) => config.model.providers[id]).map(([id, value]) =>
    [id, { ...value, apiKey: config.model.providers[id].apiKey }]));
  const binding = { enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1',
    endpoint, ...(credentialEnv ? { credentialEnv } : {}), namespace: 'local', pilotDeckUserId: 'acceptance-user', spaceId: space.id, spaces: [{ id: space.id }],
    methods: [...KNOWLEDGE_CORE_METHODS], agentMethods: [...KNOWLEDGE_AGENT_METHODS], timeoutMs: 180000 };
  await writeFile(join(directory, 'pilotdeck.yaml'), stringify({ schemaVersion: 1, agent: { model: selected }, model: { providers },
    router: { enabled: false }, modules: { knowledge: binding, sop: { enabled: false } } }), { mode: 0o600 });
  gateway = createLocalGateway({ projectRoot: directory, fallbackProjectRoot: directory, pilotHome: directory,
    env: { ...process.env, NODE_OPTIONS: '', PILOTDECK_CONFIG_PATH: join(directory, 'pilotdeck.yaml') }, permissionMode: 'bypassPermissions' });
  const allowedTools = KNOWLEDGE_AGENT_METHODS.map(name => 'knowledge_' + name);
  const sessionKey = 'km-management-' + Date.now();
  async function turn(message, expected) {
    const events = [];
    for await (const event of gateway.gateway.submitTurn({ sessionKey, workspaceCwd: directory, channelKey: 'test',
      mode: 'bypassPermissions', allowedTools, message })) events.push(event);
    report.turns.push({ message, expected, events });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    for (const name of expected) assert.ok(events.some(event => event.type === 'tool_call_finished' && event.ok &&
      events.some(start => start.type === 'tool_call_started' && start.name === name && start.toolCallId === event.toolCallId)), 'Missing successful real Agent tool: ' + name);
  }
  const scope = '?space_id=' + encodeURIComponent(space.id) + '&knowledge_base_id=' + base.id;
  await turn(`在知识库 ${base.id} 中新增文档，标题 Agent receipts，Markdown 为 # Agent receipts\n\nExpense receipt code PDAGENT731 requires original invoices within 30 days. 使用知识工具，等待入库任务 succeeded 后才报告完成。`, ['knowledge_import_document', 'knowledge_get_job']);
  let documents = await http('GET', '/documents' + scope);
  assert.equal(documents.length, 1); const id = documents[0].id;
  await turn('查询知识中的 PDAGENT731 报销规则，调用引用解析工具读取实际来源，再回答。', ['knowledge_query', 'knowledge_resolve_citation']);
  await turn(`读取文档 ${id} 的当前修订，然后把正文修改成 # Agent receipts\n\nExpense receipt code PDAGENT731 requires original invoices within 45 days. 不得猜修订。`, ['knowledge_get_document', 'knowledge_update_document']);
  let document = await http('GET', '/documents/' + id + scope); assert.match(document.metadata.raw_text, /45 days/);
  await turn('再次查询 PDAGENT731，核实现在期限为45天。', ['knowledge_query']);
  const buckets = await http('GET', '/documents/' + id + '/buckets' + scope);
  const chunks = await http('GET', '/documents/' + id + '/chunks' + scope);
  await turn(`读取主题 ${buckets[0].id} 的修订并修改其内容为 PDAGENT731 expense receipt bucket 45 days。再读取片段 ${chunks[0].id} 的修订并修改为 PDAGENT731 expense receipt evidence 45 days。`, ['knowledge_get_bucket', 'knowledge_update_bucket', 'knowledge_get_chunk', 'knowledge_update_chunk']);
  await turn(`为文档 ${id} 在知识库 ${base.id} 新建 Wiki 页 agent/pdagent731，内容 # Receipt Wiki\n\nPDAGENT731 requires receipts within 45 days. 然后读取该 Wiki 页修订并编辑为 # Receipt Wiki\n\nPDAGENT731 verified Wiki 45 days.`, ['knowledge_upsert_concept', 'knowledge_get_concept']);
  const concepts = await http('GET', '/knowledge-bases/' + base.id + '/concepts' + scope);
  assert.ok(concepts.some(row => row.concept_id === 'agent/pdagent731' && row.content_md.includes('verified Wiki')));
  await turn(`读取文档 ${id} 最新修订，然后删除这个临时文档。`, ['knowledge_get_document', 'knowledge_delete_document']);
  document = await http('GET', '/documents/' + id + scope); assert.equal(document.status, 'archived');
  const result = await http('POST', '/query', { space_id: space.id, knowledge_base_ids: [base.id], query: 'PDAGENT731', use_model: false });
  assert.equal(result.chunks.length, 0); assert.equal(result.selected_concepts.length, 0);
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await gateway?.dispose(); await rm(directory, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, output }));
}
