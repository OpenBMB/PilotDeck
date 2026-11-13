/**
 * Shared helper for StaffDeck UI plugins running without a StaffDeck backend.
 *
 * Implements the local-fallback surface of the core routes each plugin claims
 * via `serverRoutes` in plugin.json: synthetic-but-well-shaped empty data so
 * the vendored StaffDeck pages render their empty state instead of an error.
 *
 * Protocol: the host spawns `node server.js`; the process must print one JSON
 * line `{"ready":true,"port":<number>}` on stdout within 10 seconds.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function localJobId(prefix = 'local') {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** /api/modules/staffdeck-copy/call — empty-but-valid directory/resources. */
export async function handleStaffDeckCopyCall(req, res, userId) {
  const body = await readBody(req);
  const operation = typeof body.operation === 'string' ? body.operation : '';
  if (operation === 'list_agents') {
    // Shape required by copy-scope.ts loadDirectory(): a non-overall
    // copy_target agent with a tenant id.
    return json(res, 200, { result: [{
      id: userId, tenant_id: 'local', name: '当前用户',
      is_overall: false, active: true, can_manage: true, copy_target: true,
    }] });
  }
  if (operation === 'list_knowledge_bases' || operation === 'list_skills' || operation === 'list_staffdeck_model_catalog') {
    return json(res, 200, { result: [] });
  }
  return json(res, 501, { error: { code: 'COPY_LOCAL_UNSUPPORTED', message: 'Local copy fallback does not support this operation.' } });
}

/** /api/modules/sop/management — synthetic owner status. */
export function handleSopManagementStatus(req, res, userId) {
  return json(res, 200, {
    enabled: true,
    methods: SOP_MANAGEMENT_METHODS,
    agentId: userId,
    tenantId: 'local',
    actorUserId: userId,
    runtime: { receipts: [] },
  });
}

// Local SOP definitions live next to the other PilotDeck plugin data.
const SOP_STORE_DIR = path.join(os.homedir(), '.pilotdeck', 'plugins', 'staffdeck-sop');
const SOP_STORE_FILE = path.join(SOP_STORE_DIR, 'sops.json');
const SOP_MANAGEMENT_METHODS = [
  'list', 'create', 'get_draft', 'replace_draft', 'validate',
  'publish', 'archive', 'list_versions', 'get_version', 'rollback',
];

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === 'string' && value.trim() ? value : undefined; }

function readSopStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOP_STORE_FILE, 'utf8'));
    return Array.isArray(parsed?.sops) ? { sops: parsed.sops } : { sops: [] };
  } catch {
    return { sops: [] };
  }
}

function writeSopStore(store) {
  fs.mkdirSync(SOP_STORE_DIR, { recursive: true });
  fs.writeFileSync(SOP_STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function draftRow(sopId, content, versionOf) {
  const timestamp = nowIso();
  const draft = {
    id: newId('row'),
    sop_id: sopId,
    draft_id: newId('draft'),
    draft_version: text(record(content).version) || text(versionOf) || '1.0.0',
    status: 'draft',
    content,
    etag: newId('etag'),
    created_at: timestamp,
    updated_at: timestamp,
  };
  return draft;
}

function sopError(res, status, message) {
  return json(res, status, { error: { code: 'SOP_LOCAL_STORE_REJECTED', message } });
}

/** Shared list payload: published version rows plus unreleased drafts. */
function sopListPayload() {
  const store = readSopStore();
  const data = [];
  const drafts = [];
  for (const sop of store.sops) {
    for (const row of sop.versions || []) data.push({ ...row });
    for (const row of sop.drafts || []) drafts.push({ ...row });
  }
  return { data, drafts };
}

/**
 * /api/modules/sop/management/call — local SOP store.
 *
 * StaffDeck's management API is not configured in a plain PilotDeck install,
 * so the plugin persists SOP drafts/versions to
 * `~/.pilotdeck/plugins/staffdeck-sop/sops.json`. Row shapes follow the
 * StaffDeck management contract so the vendored pages can create, reload,
 * publish and archive definitions without a remote backend. Generation is
 * still unavailable locally: only definition lifecycle is stored here.
 */
export async function handleSopManagementCall(req, res) {
  const body = await readBody(req);
  const operation = typeof body.operation === 'string' ? body.operation : '';
  const input = record(body.input);
  const store = readSopStore();
  const findSop = (sopId) => store.sops.find((item) => item.sop_id === sopId);
  const persist = (sop) => {
    if (!findSop(sop.sop_id)) store.sops.push(sop);
    writeSopStore(store);
  };
  if (operation === 'list') {
    return json(res, 200, { result: sopListPayload() });
  }

  if (operation === 'create') {
    const content = record(input.content);
    const existing = text(input.sopId) ? findSop(text(input.sopId)) : undefined;
    if (existing) {
      const row = draftRow(existing.sop_id, content, text(input.baseVersion));
      existing.drafts.push(row);
      writeSopStore(store);
      return json(res, 200, { result: row });
    }
    const sopId = text(content.skill_id) || text(input.sopId) || newId('sop');
    if (findSop(sopId)) return sopError(res, 409, `SOP ${sopId} already exists; create a new draft for that SOP instead.`);
    const row = draftRow(sopId, content);
    persist({ sop_id: sopId, status: 'active', drafts: [row], versions: [] });
    return json(res, 200, { result: row });
  }

  if (operation === 'get_draft') {
    const sop = findSop(text(input.sopId) ?? '');
    const row = sop?.drafts.find((item) => item.draft_id === text(input.draftId));
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    if (!row) return sopError(res, 404, `SOP draft ${input.draftId ?? ''} was not found.`);
    return json(res, 200, { result: row });
  }

  if (operation === 'replace_draft') {
    const sop = findSop(text(input.sopId) ?? '');
    const row = sop?.drafts.find((item) => item.draft_id === text(input.draftId));
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    if (!row) return sopError(res, 404, `SOP draft ${input.draftId ?? ''} was not found.`);
    if (text(input.etag) && text(input.etag) !== row.etag) {
      return sopError(res, 409, 'SOP draft revision conflict. Reload the editor before saving.');
    }
    row.content = record(input.content);
    row.draft_version = text(row.content.version) || row.draft_version;
    row.etag = newId('etag');
    row.updated_at = nowIso();
    writeSopStore(store);
    return json(res, 200, { result: row });
  }

  if (operation === 'get_version') {
    const sop = findSop(text(input.sopId) ?? '');
    const row = sop?.versions.find((item) => item.version === text(input.version));
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    if (!row) return sopError(res, 404, `SOP version ${input.version ?? ''} was not found.`);
    return json(res, 200, { result: row });
  }

  if (operation === 'list_versions') {
    const sop = findSop(text(input.sopId) ?? '');
    if (!sop) return json(res, 200, { result: { data: [] } });
    return json(res, 200, { result: { data: sop.versions.map((row) => ({ ...row })) } });
  }

  if (operation === 'publish') {
    const sop = findSop(text(input.sopId) ?? '');
    const row = sop?.drafts.find((item) => item.draft_id === text(input.draftId));
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    if (!row) return sopError(res, 404, `SOP draft ${input.draftId ?? ''} was not found.`);
    const timestamp = nowIso();
    const version = text(row.draft_version) || '1.0.0';
    const published = {
      id: newId('row'),
      sop_id: sop.sop_id,
      version,
      status: 'published',
      content: row.content,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const previous = sop.versions.find((item) => item.version === version);
    if (previous) Object.assign(previous, published, { id: previous.id, created_at: previous.created_at });
    else sop.versions.push(published);
    writeSopStore(store);
    return json(res, 200, { result: previous || published });
  }

  if (operation === 'archive') {
    const sop = findSop(text(input.sopId) ?? '');
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    sop.status = 'archived';
    writeSopStore(store);
    const row = sop.versions[0] || sop.drafts[0] || { sop_id: sop.sop_id };
    return json(res, 200, { result: { ...row, status: 'archived' } });
  }

  if (operation === 'rollback') {
    const sop = findSop(text(input.sopId) ?? '');
    const source = sop?.versions.find((item) => item.version === text(input.version));
    if (!sop) return sopError(res, 404, `SOP ${input.sopId ?? ''} is not managed by the local store.`);
    if (!source) return sopError(res, 404, `SOP version ${input.version ?? ''} was not found.`);
    const row = draftRow(sop.sop_id, source.content, source.version);
    sop.drafts.push(row);
    writeSopStore(store);
    return json(res, 200, { result: row });
  }

  if (operation === 'validate') return json(res, 200, { result: { valid: true, issues: [] } });
  return json(res, 501, { error: { code: 'SOP_LOCAL_UNSUPPORTED', message: `Local SOP store does not support ${operation}.` } });
}

/**
 * /api/modules/staffdeck-sdk/call — SOP page uses public SDK.
 * `preview_generate_sop` / `preview_rewrite_sop` queue a local job that the
 * events route executes with the model configured in `~/.pilotdeck/pilotdeck.yaml`,
 * so SOP preview works locally without a StaffDeck backend.
 */
export async function handleStaffdeckSdkCall(req, res) {
  const body = await readBody(req);
  const operation = typeof body.operation === 'string' ? body.operation : '';
  if (operation === 'list_sops') return json(res, 200, { result: sopListPayload() });
  if (operation === 'list_skills') return json(res, 200, { result: { data: [], drafts: [] } });
  if (operation === 'list_general_skills') return json(res, 200, { result: [] });
  if (operation === 'preview_generate_sop' || operation === 'preview_rewrite_sop') {
    const jobId = localJobId('preview');
    PREVIEW_JOBS.set(jobId, {
      kind: operation === 'preview_rewrite_sop' ? 'rewrite' : 'generate',
      input: record(body.input),
      createdAt: Date.now(),
    });
    return json(res, 202, { job_id: jobId });
  }
  if (operation === 'get_preview_job') {
    const jobId = text(record(body.input).jobId) || '';
    return PREVIEW_JOBS.has(jobId)
      ? json(res, 200, { result: { job_id: jobId, status: 'running' } })
      : json(res, 404, { error: { code: 'SOP_PREVIEW_JOB_NOT_FOUND', message: `Preview job ${jobId} was not found.` } });
  }
  return json(res, 200, { result: null });
}

/**
 * /api/modules/staffdeck-sdk/events — SSE for preview job tracking.
 * Runs the queued preview job against the locally configured model and streams
 * `status` / `chunk` / `complete` (or `error`) events, matching the frames the
 * vendored DistillPage consumes.
 */
export async function handleStaffdeckSdkEvents(req, res) {
  const url = new URL(req.url || '/', 'http://host.local');
  const operation = url.searchParams.get('operation');
  const jobId = url.searchParams.get('jobId') || localJobId('local');
  const job = operation === 'preview_job_events' ? PREVIEW_JOBS.get(jobId) : undefined;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!job) {
    send('error', { job_id: jobId, message: `Preview job ${jobId} was not found.` });
    return res.end();
  }
  PREVIEW_JOBS.delete(jobId);
  try {
    send('status', { text: job.kind === 'rewrite' ? '正在改写 SOP 草稿…' : '正在生成 SOP 草稿…' });
    const card = await generateSkillCard(job);
    const serialized = JSON.stringify(card);
    for (let offset = 0; offset < serialized.length; offset += 240) {
      send('chunk', { content: serialized.slice(offset, offset + 240) });
    }
    send('complete', { draft_skill: card, warnings: [], tool_suggestions: [] });
  } catch (error) {
    send('error', { message: String(error?.message || error) });
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Local SOP generation: uses the model already configured for PilotDeck.
// ---------------------------------------------------------------------------

const PREVIEW_JOBS = new Map();
const CONFIG_FILE = process.env.PILOTDECK_CONFIG_PATH || path.join(os.homedir(), '.pilotdeck', 'pilotdeck.yaml');

function resolveModel() {
  let config;
  try {
    config = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    throw new Error(`无法读取模型配置：${CONFIG_FILE}`);
  }
  const modelRef = text(record(config?.agent).model);
  if (!modelRef || !modelRef.includes('/')) throw new Error('agent.model 未配置为 "provider/model" 形式。');
  const slash = modelRef.indexOf('/');
  const providerId = modelRef.slice(0, slash);
  const modelName = modelRef.slice(slash + 1);
  const provider = record(record(record(config?.model).providers)[providerId]);
  const baseUrl = text(provider.url) || text(provider.baseUrl);
  const apiKey = text(provider.apiKey) || text(provider.api_key);
  if (!baseUrl || !apiKey) throw new Error(`模型提供方 ${providerId} 缺少 url 或 apiKey。`);
  const protocol = text(provider.protocol) || 'openai';
  if (protocol !== 'openai') throw new Error(`本地 SOP 生成暂只支持 openai 协议提供方，当前为 ${protocol}。`);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, modelName };
}

function skillJsonSchema() {
  return `{
  "skill_id": "skill_xxx",
  "name": "SOP 名称",
  "version": "1.0.0",
  "business_domain": "业务域",
  "description": "一句话描述",
  "capability_scope": "general",
  "trigger_intents": ["触发意图1"],
  "user_utterance_examples": ["用户可能这样说1"],
  "goal": ["目标1"],
  "required_info": ["需要收集的信息1"],
  "response_rules": ["回复规则1"],
  "nodes": [{"node_id": "n1", "name": "步骤名", "type": "response", "instruction": "该步骤要做什么"}],
  "edges": [{"source_node_id": "n1", "next_node_id": "n2", "condition": "", "priority": 0, "label": ""}],
  "start_node_id": "n1",
  "terminal_node_ids": ["n2"],
  "interruption_policy": {}
}`;
}

function buildPrompt(job) {
  const input = job.input;
  const payload = record(input.body);
  const system = [
    '你是企业 SOP（标准作业流程）设计助手。',
    '根据用户提供的素材生成一份可直接执行的 SOP 技能定义。',
    '只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏。',
    'JSON 必须符合以下结构：',
    skillJsonSchema(),
    '要求：节点 id 唯一，edges 以 source_node_id → next_node_id 串成单向流程，start_node_id 与 terminal_node_ids 必须引用真实节点。',
  ].join('\n');
  if (job.kind === 'rewrite') {
    const current = record(input.currentSkill) && Object.keys(record(input.currentSkill)).length
      ? record(input.currentSkill)
      : record(payload.current_skill);
    return {
      system,
      user: [
        '请按用户要求改写现有 SOP 定义，保留未被要求改动的字段。',
        `用户要求：${text(payload.instruction) || text(payload.prompt) || '优化表达与流程结构'}`,
        `现有 SOP：${JSON.stringify(current)}`,
        payload.conversation ? `对话记录：${JSON.stringify(payload.conversation)}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    system,
    user: [
      `标题：${text(payload.title) || '新 SOP'}`,
      `素材：${text(payload.raw_content) || text(payload.rawContent) || text(payload.prompt) || ''}`,
      payload.conversation ? `对话记录：${JSON.stringify(payload.conversation)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function parseSkillCard(content, fallbackName) {
  const textContent = String(content || '').replace(/```(?:json)?/gi, '');
  const start = textContent.indexOf('{');
  const end = textContent.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型没有返回可解析的 SOP JSON，返回片段：${textContent.slice(0, 200) || '(空)'}。`);
  let parsed;
  try {
    parsed = JSON.parse(textContent.slice(start, end + 1));
  } catch {
    throw new Error(`模型返回的 SOP JSON 无法解析：${textContent.slice(start, start + 200)}`);
  }
  return normalizeSkillCard(record(parsed), fallbackName);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeSkillCard(card, fallbackName) {
  const nodes = (Array.isArray(card.nodes) ? card.nodes : []).map((node, index) => {
    const item = record(node);
    return {
      node_id: text(item.node_id) || `n${index + 1}`,
      name: text(item.name) || `步骤 ${index + 1}`,
      type: text(item.type) || 'response',
      instruction: text(item.instruction) || '',
    };
  });
  if (nodes.length === 0) throw new Error('模型返回的 SOP 没有任何节点。');
  const ids = nodes.map((node) => node.node_id);
  const edges = (Array.isArray(card.edges) ? card.edges : [])
    .map((edge, index) => {
      const item = record(edge);
      return {
        source_node_id: text(item.source_node_id) || '',
        next_node_id: text(item.next_node_id) || '',
        condition: typeof item.condition === 'string' ? item.condition : '',
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index,
        label: typeof item.label === 'string' ? item.label : '',
      };
    })
    .filter((edge) => ids.includes(edge.source_node_id) && ids.includes(edge.next_node_id));
  const normalizedEdges = edges.length > 0
    ? edges
    : nodes.slice(0, -1).map((node, index) => ({
      source_node_id: node.node_id, next_node_id: nodes[index + 1].node_id, condition: '', priority: index, label: '',
    }));
  return {
    skill_id: text(card.skill_id) || `skill_${Date.now().toString(36)}`,
    name: text(card.name) || fallbackName,
    version: text(card.version) || '1.0.0',
    business_domain: text(card.business_domain) || '',
    description: text(card.description) || '',
    capability_scope: text(card.capability_scope) || 'general',
    trigger_intents: stringList(card.trigger_intents),
    user_utterance_examples: stringList(card.user_utterance_examples),
    goal: stringList(card.goal),
    required_info: stringList(card.required_info),
    response_rules: stringList(card.response_rules),
    nodes,
    edges: normalizedEdges,
    start_node_id: ids.includes(text(card.start_node_id)) ? text(card.start_node_id) : ids[0],
    terminal_node_ids: stringList(card.terminal_node_ids).filter((id) => ids.includes(id)).length > 0
      ? stringList(card.terminal_node_ids).filter((id) => ids.includes(id))
      : [ids[ids.length - 1]],
    interruption_policy: record(card.interruption_policy),
  };
}

async function generateSkillCard(job) {
  const model = resolveModel();
  const prompt = buildPrompt(job);
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify({
      model: model.modelName,
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`模型调用失败（HTTP ${response.status}）：${detail.slice(0, 300)}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const fallbackName = text(record(job.input.body).title) || '新SOP';
  return parseSkillCard(content, fallbackName);
}

/**
 * /api/modules/host-capabilities/call — PilotDeck local fallback.
 * Core host UI operations (list_tools, list_general_skills, list_model_catalog,
 * extract_sop_text) receive empty but well-shaped bodies so the DistillPage
 * and SkillsPage render their empty state rather than surfacing a 403. Other
 * operations that genuinely require a remote StaffDeck host return 501.
 */
export async function handleHostCapabilitiesCall(req, res) {
  const body = await readBody(req);
  const operation = typeof body.operation === 'string' ? body.operation : '';
  switch (operation) {
    case 'list_tools':
      return json(res, 200, { data: [] });
    case 'list_general_skills':
      return json(res, 200, { data: [] });
    case 'list_model_catalog':
      return json(res, 200, { data: [] });
    case 'extract_sop_text':
      return json(res, 200, { sop_id: undefined, sop: undefined });
    default:
      return json(res, 501, { error: { code: 'PILOTDECK_HOST_LOCAL_UNSUPPORTED', message: `Local host fallback does not support ${operation}.` } });
  }
}

/**
 * Start an HTTP server on an ephemeral port and report readiness to the host.
 * `routes` maps exact core paths (as claimed in serverRoutes) to handlers
 * `(req, res, userId)`.
 */
export function startLocalFallbackServer(routes) {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const handler = routes[`${req.method} ${path}`];
    const userId = req.headers['x-pilotdeck-user-id'] || '1';
    if (handler) {
      Promise.resolve(handler(req, res, userId)).catch((err) => {
        json(res, 500, { error: { code: 'PLUGIN_FALLBACK_ERROR', message: String(err?.message || err) } });
      });
    } else {
      json(res, 404, { error: { code: 'PLUGIN_ROUTE_NOT_FOUND', message: `No local fallback for ${req.method} ${path}` } });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
  });
}
