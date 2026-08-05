import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StaffDeckClient } from '../../../src/collaboration/participants/StaffDeckClient.js';
import { instancesDb, userDb } from '../database/db.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { createNotificationEvent, notifyUserIfEnabled } from './notification-orchestrator.js';
import { groupChatDb } from './group-chat-db.js';
import {
  createGroupDelegationGrant,
  revokeGroupDelegationGrants,
} from './group-delegation-grants.js';
import { assertApprovedRemoteInstance } from './instance-service.js';

const MAX_MESSAGE_CHARS = 20_000;
const MAX_GROUP_ATTACHMENTS = 10;
const MAX_GROUP_ATTACHMENT_DATA_CHARS = 28 * 1024 * 1024;
const MAX_MEMBERS = 8;
const configuredMemberTimeout = Number(process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS);
const MEMBER_TIMEOUT_MS = Number.isFinite(configuredMemberTimeout) && configuredMemberTimeout >= 100
  ? configuredMemberTimeout
  : 5 * 60_000;
const configuredTurnTimeout = Number(process.env.PILOTDECK_GROUP_TURN_TIMEOUT_MS);
// The entry agent owns delegation and final synthesis, so its wall-clock budget
// must outlive a delegated member's budget. Otherwise the main turn fails first
// and leaves the member request running without a coordinator to consume it.
const ENTRY_TURN_TIMEOUT_MS = Number.isFinite(configuredTurnTimeout) && configuredTurnTimeout >= 100
  ? configuredTurnTimeout
  : MEMBER_TIMEOUT_MS + 60_000;
const configuredStaffDeckPollInterval = Number(process.env.STAFFDECK_POLL_INTERVAL_MS);
const STAFFDECK_POLL_INTERVAL_MS = Number.isFinite(configuredStaffDeckPollInterval) && configuredStaffDeckPollInterval >= 0
  ? configuredStaffDeckPollInterval
  : 1_000;
const staffDeckClient = new StaffDeckClient({
  timeoutMs: MEMBER_TIMEOUT_MS,
  pollIntervalMs: STAFFDECK_POLL_INTERVAL_MS,
});
const MAX_REQUIRED_DELEGATE_RETRIES = 1;
const MAX_DELEGATIONS_PER_TURN = MAX_MEMBERS + 2;
const MAX_DELEGATIONS_PER_MEMBER_PER_TURN = 2;
const GROUP_MEMBER_DELEGATE_TOOL = 'group_member_delegate';
const GROUP_READ_ONLY_DENY_RULES = [
  'bash', 'write_file', 'edit_file', 'edit_notebook', 'execute_code',
  'agent', 'group_chat', 'task_create', 'task_stop', 'todo_write', 'mcp__*',
].map((toolName) => ({ source: 'policy', behavior: 'deny', toolName }));
const dispatchingConversations = new Set();
const activeMainTurns = new Map();
const activeRoundExecutions = new Map();
const USER_STOPPED_ERROR = '本轮执行已由用户停止。';

function abortReason(signal, fallback = USER_STOPPED_ERROR) {
  if (!signal?.aborted) return fallback;
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason || fallback);
}

function stoppedMetadata(metadata, errorMessage) {
  return errorMessage === USER_STOPPED_ERROR
    ? { ...metadata, stoppedByUser: true }
    : metadata;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(USER_STOPPED_ERROR);
  }
}

function memberCategory(kind) {
  if (kind === 'pilotdeck_main' || kind === 'pilotdeck_remote') return 'pilotdeck_instance';
  if (kind === 'pilotdeck_local') return 'agent';
  return 'employee';
}

function categoryLabel(kind) {
  const category = memberCategory(kind);
  if (category === 'pilotdeck_instance') return 'PilotDeck 实例';
  if (category === 'agent') return '智能体';
  return '数字员工';
}

function cleanText(value, field, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} 不能为空。`);
  if (text.length > max) throw new Error(`${field} 不能超过 ${max} 个字符。`);
  return text;
}

function attachmentPathInProject(projectPath, candidatePath) {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(root, resolved);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved;
  throw new Error('附件必须位于群组绑定的项目目录中。');
}

function normalizeGroupMessageAttachments(room, input) {
  const images = [];
  const attachments = [];
  const rawImages = Array.isArray(input?.images) ? input.images : [];
  const rawFiles = Array.isArray(input?.attachments) ? input.attachments : [];
  if (rawImages.length + rawFiles.length > MAX_GROUP_ATTACHMENTS) {
    throw new Error(`每条消息最多添加 ${MAX_GROUP_ATTACHMENTS} 个附件。`);
  }
  for (const [index, candidate] of rawImages.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const name = cleanText(candidate.name || `image-${index + 1}.png`, '图片名称', 180);
    const mimeType = typeof candidate.mimeType === 'string' && candidate.mimeType.startsWith('image/')
      ? candidate.mimeType.slice(0, 120)
      : 'image/png';
    const data = typeof candidate.data === 'string' ? candidate.data : '';
    if (data && (data.length > MAX_GROUP_ATTACHMENT_DATA_CHARS || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/u.test(data))) {
      throw new Error(`图片“${name}”的数据格式无效或超过大小限制。`);
    }
    const storedPath = typeof candidate.path === 'string' && candidate.path.trim()
      ? attachmentPathInProject(room.projectPath, candidate.path)
      : '';
    if (!data && !storedPath) throw new Error(`图片“${name}”缺少可用内容。`);
    images.push({
      name,
      ...(data && !storedPath ? { data } : {}),
      ...(storedPath ? { path: storedPath } : {}),
      ...(Number.isFinite(Number(candidate.size)) ? { size: Math.max(0, Number(candidate.size)) } : {}),
      mimeType,
    });
  }
  for (const [index, candidate] of rawFiles.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const name = cleanText(candidate.name || `attachment-${index + 1}`, '附件名称', 180);
    const storedPath = attachmentPathInProject(room.projectPath, cleanText(candidate.path, '附件路径', 2_000));
    attachments.push({
      name,
      path: storedPath,
      ...(Number.isFinite(Number(candidate.size)) ? { size: Math.max(0, Number(candidate.size)) } : {}),
      ...(typeof candidate.mimeType === 'string' && candidate.mimeType.trim()
        ? { mimeType: candidate.mimeType.trim().slice(0, 120) }
        : {}),
    });
  }
  return { images, attachments };
}

function attachmentNote(bundle) {
  const entries = [
    ...(bundle?.images || []).map((image) => `图片：${image.name}${image.path ? `（${image.path}）` : ''}`),
    ...(bundle?.attachments || []).map((file) => `附件：${file.name}（${file.path}）`),
  ];
  return entries.length > 0 ? `\n\n本条消息附带以下文件：\n${entries.join('\n')}` : '';
}

async function toGatewayAttachments(bundle) {
  const images = await Promise.all((bundle?.images || []).map(async (image) => {
      const match = typeof image.data === 'string'
        ? image.data.match(/^data:([^;]+);base64,(.*)$/u)
        : null;
      const content = match?.[2] || (image.path ? (await readFile(image.path)).toString('base64') : '');
      return {
        type: 'image',
        name: image.name,
        ...(image.path ? { path: image.path } : {}),
        mimeType: image.mimeType || match?.[1] || 'image/png',
        ...(content ? { content } : {}),
        ...(typeof image.size === 'number' ? { bytes: image.size } : {}),
      };
    }));
  return [
    ...images,
    ...(bundle?.attachments || []).map((file) => ({
      type: 'file',
      name: file.name,
      path: file.path,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(typeof file.size === 'number' ? { bytes: file.size } : {}),
    })),
  ];
}

function normalizeMemberInput(input) {
  const allowedKinds = new Set(['pilotdeck_remote', 'staffdeck']);
  if (!allowedKinds.has(input?.kind)) throw new Error('仅支持已批准的远程 PilotDeck 实例和真实 StaffDeck 数字员工。');
  const id = cleanText(input.id || input.employeeId || `member-${crypto.randomUUID()}`, '成员 ID', 100)
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  if (id === 'main') throw new Error('main 是主智能体的保留 ID。');
  const config = input.config && typeof input.config === 'object' ? { ...input.config } : {};
  if (input.kind === 'staffdeck') {
    config.employeeId = cleanText(input.employeeId || config.employeeId || id, '员工 ID', 200);
    config.staffdeckAccess = ['owned', 'public', 'accessible'].includes(input.staffdeckAccess)
      ? input.staffdeckAccess
      : ['owned', 'public', 'accessible'].includes(config.staffdeckAccess)
        ? config.staffdeckAccess
        : 'accessible';
    for (const key of ['creatorUserId', 'creatorUsername', 'creatorDisplayName']) {
      const value = typeof input[key] === 'string' ? input[key].trim() : '';
      if (value) config[key] = value.slice(0, 200);
    }
    config.publishedToGallery = input.publishedToGallery === true;
    if (typeof input.usedByCurrentUser === 'boolean') config.usedByCurrentUser = input.usedByCurrentUser;
    for (const key of ['expertiseTags', 'workStyles', 'workModes']) {
      const values = Array.isArray(input[key])
        ? [...new Set(input[key].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
        : [];
      if (values.length > 0) config[key] = values.slice(0, 20);
    }
  }
  if (input.kind === 'pilotdeck_remote') {
    config.instanceId = cleanText(input.instanceId || config.instanceId, '已批准实例 ID', 200);
  }
  return {
    id,
    kind: input.kind,
    name: cleanText(input.name, '成员名称', 100),
    role: typeof input.role === 'string' ? input.role.trim().slice(0, 160) : '',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '',
    config,
    instanceId: input.kind === 'pilotdeck_remote' ? config.instanceId : undefined,
  };
}

function normalizeRemoteEndpoint(value) {
  let url;
  try {
    url = new URL(cleanText(value, '远程 PilotDeck 地址', 500));
  } catch {
    throw new Error('远程 PilotDeck 地址无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('远程 PilotDeck 地址必须使用 http/https，且不能内嵌凭据。');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function listStaffDeckEmployees() {
  const connection = staffDeckClient.resolveConnection(process.env);
  if (!connection) return [];
  const employees = await staffDeckClient.listEmployees(connection);
  return employees.map((employee) => ({
    id: employee.id,
    kind: 'staffdeck',
    category: 'employee',
    name: employee.name,
    role: employee.roleName || 'StaffDeck 数字员工',
    description: employee.description || '',
    employeeId: employee.id,
    staffdeckAccess: employee.access,
    creatorUserId: employee.creatorUserId,
    creatorUsername: employee.creatorUsername,
    creatorDisplayName: employee.creatorDisplayName,
    publishedToGallery: employee.publishedToGallery,
    usedByCurrentUser: employee.usedByCurrentUser,
    expertiseTags: employee.expertiseTags,
    workStyles: employee.workStyles,
    workModes: employee.workModes,
  }));
}

function formatTranscript(messages) {
  return messages
    .filter((message) =>
      message.kind === 'chat' &&
      ((message.status === 'completed' && message.content) || message.status === 'failed'))
    .slice(-30)
    .map((message) => message.status === 'failed'
      ? `[${message.senderName}]（回复失败：${message.error || '未知错误'}）`
      : `[${message.senderName}] ${message.content}`)
    .join('\n\n');
}

function buildMemberContext(room, member, transcript, isMain, requiredDelegateIds = []) {
  const roster = room.members
    .filter((candidate) => candidate.isActive !== false)
    .map((candidate) => {
      const details = [`id=${candidate.id}`, `类型=${categoryLabel(candidate.kind)}`, `角色=${candidate.role || '未设置'}`];
      if (candidate.description) details.push(`职责=${candidate.description}`);
      if (candidate.kind === 'staffdeck') {
        const access = candidate.config?.staffdeckAccess;
        details.push(`来源=${access === 'owned' ? '当前账号创建' : access === 'public' ? '公开员工' : '当前账号可访问'}`);
        const creator = candidate.config?.creatorDisplayName || candidate.config?.creatorUsername;
        if (creator) details.push(`创建者=${creator}`);
        const expertise = Array.isArray(candidate.config?.expertiseTags) ? candidate.config.expertiseTags : [];
        if (expertise.length > 0) details.push(`专长=${expertise.join('、')}`);
      }
      return `- ${candidate.name}: ${details.join(', ')}`;
    })
    .join('\n');
  return [
    `你正在群组“${room.title}”中以“${member.name}”身份发言。`,
    member.role ? `你的角色：${member.role}。` : '',
    member.description ? `职责说明：${member.description}` : '',
    `群组绑定工作空间：${room.projectName}。`,
    '当前群组成员名册（调用时必须使用这里的精确 id）：',
    roster,
    isMain
      ? [
          '你是群组主智能体。请基于用户意图自主决定是否需要调用具体成员。',
          '当用户要求你询问、咨询、介绍某个群成员，或该成员的专长确实必要时，必须调用 group_member_delegate 获取该成员的真实回答；不要替成员回答或编造其信息。',
          requiredDelegateIds.length > 0
            ? `本轮用户显式提及了以下成员，你必须按此顺序逐一调用 group_member_delegate，不能跳过：${requiredDelegateIds.join(' -> ')}。`
            : '',
          '界面会根据真实工具调用展示委派卡片，因此不要只在文字中声称“我去问”或伪造 @成员；请实际调用工具，并在拿到回复后继续回答。',
          '每次成员回复都会作为阻塞工具结果回到你当前的同一轮推理。收到结果后请重新判断信息是否充分：必要时可以继续调用另一位合适成员，一次调用一位；信息充分后停止委派并给出综合结论。',
          '不要机械轮询全部成员。只有确有必要时才再次追问同一成员，并避免重复问题或无休止委派。',
        ].join('\n')
      : '请从自己的专业角度直接回应用户。不要冒充其他成员，也不要描述内部调度或适配器机制。',
    '以下是群组最近的公开发言，供你理解上下文：',
    transcript || '（暂无历史发言）',
  ].filter(Boolean).join('\n');
}

function boundedPreview(value, max = 4_000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function staffDeckEventText(data, ...keys) {
  if (!data || typeof data !== 'object') return '';
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function staffDeckEventNumber(data, ...keys) {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function staffDeckEventList(data, key) {
  if (!data || typeof data !== 'object' || !Array.isArray(data[key])) return [];
  return data[key]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .slice(0, 12);
}

function staffDeckEventRecord(data, key) {
  const value = data && typeof data === 'object' ? data[key] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function staffDeckPayloadPreview(value, max = 4_000) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return boundedPreview(value, max);
  try {
    return boundedPreview(JSON.stringify(value, null, 2), max);
  } catch {
    return boundedPreview(String(value), max);
  }
}

function staffDeckTraceIdentity(event, ...keys) {
  const parts = keys.map((key) => staffDeckEventText(event.data, key)).filter(Boolean);
  return parts.length > 0 ? parts.join(':') : event.id || 'current';
}

function staffDeckFailureDetail(data) {
  const error = staffDeckEventRecord(data, 'error');
  return [
    staffDeckEventText(data, 'code', 'error_type'),
    staffDeckEventText(data, 'message', 'reason', 'text', 'detail'),
    staffDeckEventText(error, 'code'),
    staffDeckEventText(error, 'message'),
  ].filter((value, index, values) => value && values.indexOf(value) === index).join(' · ');
}

function staffDeckActivityDescriptor(event) {
  const phase = staffDeckEventText(event.data, 'phase', 'stage');
  const statusText = staffDeckEventText(event.data, 'text', 'message', 'detail');
  if (event.type === 'job.queued') {
    return { key: 'queued', label: '等待 StaffDeck 调度', detail: statusText || 'Run 已进入执行队列。', state: 'running' };
  }
  if (event.type === 'run.started') {
    return { key: 'started', label: '数字员工开始执行', detail: statusText || 'StaffDeck 已启动本轮任务。', state: 'running' };
  }
  if (event.type === 'run.executing') {
    const engine = staffDeckEventText(event.data, 'engine', 'execution_engine');
    return { key: 'executing', label: '进入 Agentic 执行', detail: statusText || (engine ? `执行引擎：${engine}` : '正在运行数字员工。'), state: 'running' };
  }
  if (event.type === 'run.status') {
    return {
      key: `status:${phase || statusText || 'working'}`,
      label: statusText || (phase ? `执行阶段：${phase}` : '数字员工处理中'),
      detail: phase && statusText ? `阶段：${phase}` : statusText,
      state: 'running',
      stepKind: 'system',
    };
  }
  if (event.type === 'run.plan') {
    const decision = staffDeckEventText(event.data, 'decision', 'mode');
    const reason = staffDeckEventText(event.data, 'reason', 'summary', 'rationale');
    return {
      key: 'trace:plan',
      label: '规划执行任务',
      detail: [decision ? `执行方式：${decision}` : '', reason].filter(Boolean).join(' · ') || '已生成本轮执行计划。',
      state: 'completed',
      stepKind: 'decision',
    };
  }
  if (event.type === 'run.intent') {
    const intent = staffDeckEventText(event.data, 'user_intent', 'intent', 'decision');
    const reason = staffDeckEventText(event.data, 'reason', 'detail', 'summary');
    return {
      key: 'trace:intent',
      label: intent ? `判断意图 ${intent}` : '判断意图',
      detail: reason || '已完成用户意图判断。',
      state: 'completed',
      stepKind: 'decision',
    };
  }
  if (event.type.startsWith('run.task_frame.')) {
    const frameId = staffDeckEventText(event.data, 'task_frame_id', 'task_id') || event.id || 'current';
    const kind = staffDeckEventText(event.data, 'kind');
    const stepId = staffDeckEventText(event.data, 'step_id');
    const status = staffDeckEventText(event.data, 'status');
    const actionCount = staffDeckEventNumber(event.data, 'action_count');
    const failed = ['failed', 'blocked', 'cancelled'].includes(status);
    if (event.type === 'run.task_frame.started') {
      return {
        key: `trace:task:${frameId}:started`,
        label: '开始执行任务',
        detail: [kind === 'sop' ? 'SOP TaskFrame' : '对话 TaskFrame', stepId ? `步骤：${stepId}` : ''].filter(Boolean).join(' · '),
        state: 'running',
        stepKind: 'task',
      };
    }
    if (event.type === 'run.task_frame.waiting') {
      return {
        key: `trace:task:${frameId}:waiting:${event.id || 'current'}`,
        label: '等待前置任务',
        detail: statusText || '当前任务正在等待依赖完成。',
        state: 'running',
        stepKind: 'task',
      };
    }
    if (event.type === 'run.task_frame.released') {
      return {
        key: `trace:task:${frameId}:released:${event.id || 'current'}`,
        label: '前置任务已完成',
        detail: statusText || '当前任务已恢复执行。',
        state: 'running',
        stepKind: 'task',
      };
    }
    return {
      key: `trace:task:${frameId}:finished:${event.type}`,
      label: failed ? '任务执行失败' : '任务执行完成',
      detail: [status ? `状态：${status}` : '', actionCount === undefined ? '' : `执行 ${actionCount} 个动作`].filter(Boolean).join(' · ') || statusText,
      state: failed ? 'failed' : 'completed',
      stepKind: 'task',
    };
  }
  if (event.type === 'run.capability.search') {
    const query = staffDeckEventText(event.data, 'query');
    const matches = staffDeckEventList(event.data, 'matches');
    const matchCount = staffDeckEventNumber(event.data, 'match_count');
    return {
      key: `trace:capability-search:${event.id || query || 'current'}`,
      label: '搜索可用能力',
      detail: [query ? `查询：${query}` : '', matchCount === undefined ? '' : `命中 ${matchCount} 项`, matches.length > 0 ? matches.join('、') : ''].filter(Boolean).join(' · '),
      state: 'completed',
      stepKind: 'tool',
      toolName: 'capability_search',
    };
  }
  if (event.type === 'run.capability.described') {
    const activated = staffDeckEventList(event.data, 'activated');
    const requested = staffDeckEventList(event.data, 'requested');
    const notFound = staffDeckEventList(event.data, 'not_found');
    const revoked = staffDeckEventList(event.data, 'revoked');
    const failed = activated.length === 0 && (notFound.length > 0 || revoked.length > 0);
    return {
      key: `trace:capability-described:${event.id || requested.join(',') || 'current'}`,
      label: failed ? '能力加载失败' : '加载能力定义',
      detail: [
        activated.length > 0 ? `已加载：${activated.join('、')}` : '',
        notFound.length > 0 ? `未找到：${notFound.join('、')}` : '',
        revoked.length > 0 ? `不可用：${revoked.join('、')}` : '',
      ].filter(Boolean).join(' · '),
      state: failed ? 'failed' : 'completed',
      stepKind: 'tool',
      toolName: 'capability_describe',
    };
  }
  if (event.type === 'run.capability.completed') {
    const toolName = staffDeckEventText(event.data, 'tool_name', 'name') || '未知能力';
    const success = event.data?.success !== false;
    const error = staffDeckEventRecord(event.data, 'error');
    const result = event.data?.result;
    return {
      key: `trace:capability:${staffDeckTraceIdentity(event, 'task_frame_id', 'iteration', 'tool_name')}`,
      label: `${success ? '能力调用完成' : '能力调用失败'} ${toolName}`,
      detail: success
        ? `第 ${staffDeckEventNumber(event.data, 'iteration') || 1} 个动作`
        : staffDeckFailureDetail(error || event.data),
      state: success ? 'completed' : 'failed',
      stepKind: 'tool',
      toolName,
      output: staffDeckPayloadPreview(result),
      outputTitle: '能力调用结果',
    };
  }
  if (event.type === 'run.citation') {
    const chunks = Array.isArray(event.data?.chunks) ? event.data.chunks.length : 0;
    const evidence = Array.isArray(event.data?.evidence_pack) ? event.data.evidence_pack.length : 0;
    const concepts = Array.isArray(event.data?.selected_concepts) ? event.data.selected_concepts.length : 0;
    return {
      key: `trace:citation:${event.id || 'current'}`,
      label: '读取业务资料',
      detail: [concepts ? `命中知识 ${concepts} 项` : '', chunks ? `读取 ${chunks} 个片段` : '', evidence ? `生成 ${evidence} 条引用候选` : ''].filter(Boolean).join(' · ') || statusText || '已取得知识库检索结果。',
      state: 'completed',
      stepKind: 'knowledge',
    };
  }
  if (event.type === 'run.tool.completed') {
    const content = staffDeckEventRecord(event.data, 'content');
    const toolName = staffDeckEventText(event.data, 'toolName', 'rawToolName', 'toolId')
      || staffDeckEventText(content, 'tool_name')
      || '工具';
    const success = event.data?.success === undefined ? !event.data?.isError : event.data.success === true;
    return {
      key: `trace:tool:${staffDeckTraceIdentity(event, 'toolCallId', 'tool_call_id', 'toolId')}`,
      label: `${success ? '工具调用完成' : '工具调用失败'} ${toolName}`,
      detail: success ? statusText : staffDeckFailureDetail(event.data),
      state: success ? 'completed' : 'failed',
      stepKind: 'tool',
      toolName,
      output: staffDeckPayloadPreview(content || event.data?.result),
      outputTitle: '工具调用结果',
    };
  }
  if (event.type === 'run.sop.state') {
    const runtimeDecision = staffDeckEventText(event.data, 'runtimeDecision');
    const currentSkills = Array.isArray(event.data?.currentSkills) ? event.data.currentSkills : [];
    const names = currentSkills.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const name = staffDeckEventText(entry, 'name', 'skillId');
      return name ? [name] : [];
    }).slice(0, 8);
    return {
      key: `trace:sop-state:${event.id || runtimeDecision || 'current'}`,
      label: '更新 SOP 状态',
      detail: [runtimeDecision, names.length > 0 ? names.join('、') : ''].filter(Boolean).join(' · '),
      state: 'completed',
      stepKind: 'skill',
    };
  }
  if (event.type === 'run.sop.step') {
    const toolCall = staffDeckEventRecord(event.data, 'tool_call');
    const knowledgeQuery = staffDeckEventRecord(event.data, 'knowledge_query');
    const toolName = staffDeckEventText(toolCall, 'name');
    const query = staffDeckEventText(knowledgeQuery, 'query');
    const nextStep = staffDeckEventText(event.data, 'next_step_id');
    return {
      key: `trace:sop-step:${event.id || nextStep || toolName || query || 'current'}`,
      label: toolName ? `决定调用工具 ${toolName}` : query ? '决定查询知识库' : nextStep ? '决定下一步' : '完成步骤判断',
      detail: [nextStep ? `下一节点：${nextStep}` : '', query ? `查询：${query}` : ''].filter(Boolean).join(' · ') || staffDeckEventText(event.data, 'reply'),
      state: toolName || query ? 'running' : 'completed',
      stepKind: toolName ? 'tool' : query ? 'knowledge' : 'decision',
      toolName: toolName || undefined,
    };
  }
  if (event.type === 'run.skill.trace') {
    const message = staffDeckEventText(event.data, 'message', 'text');
    const skillPhase = staffDeckEventText(event.data, 'phase');
    const skillName = staffDeckEventText(event.data, 'skill_name', 'skill_slug');
    const failed = /(?:failed|error|timeout)/iu.test(skillPhase);
    const output = staffDeckPayloadPreview(
      event.data?.structured_result
      ?? event.data?.stdout_preview
      ?? event.data?.stderr_preview,
    );
    return {
      key: `trace:skill:${event.id || staffDeckTraceIdentity(event, 'skill_slug', 'phase')}`,
      label: message || (skillName ? `执行通用技能 ${skillName}` : '执行通用技能'),
      detail: [skillPhase ? `阶段：${skillPhase}` : '', staffDeckEventText(event.data, 'rationale')].filter(Boolean).join(' · '),
      state: failed ? 'failed' : 'completed',
      stepKind: 'skill',
      output,
      outputTitle: output ? '技能运行结果' : undefined,
    };
  }
  if (event.type === 'run.skill.completed') {
    const success = event.data?.success !== false;
    const skillName = staffDeckEventText(event.data, 'skill_name', 'skill_slug');
    return {
      key: `trace:skill-completed:${event.id || skillName || 'current'}`,
      label: `通用技能${success ? '运行完成' : '运行失败'}${skillName ? ` ${skillName}` : ''}`,
      detail: staffDeckEventText(event.data, 'operation'),
      state: success ? 'completed' : 'failed',
      stepKind: 'skill',
      output: staffDeckPayloadPreview(event.data?.structured_result),
      outputTitle: '技能运行结果',
    };
  }
  if (event.type === 'run.loop.continued') {
    const targetTool = staffDeckEventText(event.data, 'target_tool_name');
    return {
      key: `trace:loop:${event.id || staffDeckEventText(event.data, 'iteration') || 'current'}`,
      label: '重新分析执行动作',
      detail: targetTool ? `决定继续调用工具 ${targetTool}` : '继续下一轮 Agentic 执行。',
      state: 'completed',
      stepKind: 'decision',
    };
  }
  if (event.type === 'run.loop.completed') {
    return {
      key: `trace:loop:${event.id || staffDeckEventText(event.data, 'iteration') || 'completed'}`,
      label: '数字员工完成分析',
      detail: statusText || 'Agentic Loop 已完成。',
      state: 'completed',
      stepKind: 'decision',
    };
  }
  if (event.type === 'handoff.created') {
    return {
      key: `trace:handoff:${event.id || 'current'}`,
      label: '转交人工处理',
      detail: statusText || staffDeckFailureDetail(event.data),
      state: 'completed',
      stepKind: 'handoff',
    };
  }
  if (event.type.startsWith('run.output.')) {
    return {
      key: 'output',
      label: event.type === 'run.output.completed' ? '数字员工已生成回复' : '数字员工正在生成回复',
      detail: boundedPreview(event.output || statusText || '正在流式生成回复。'),
      state: event.type === 'run.output.completed' ? 'completed' : 'running',
      stepKind: 'output',
    };
  }
  if (event.type === 'run.awaiting_input') {
    return { key: 'awaiting_input', label: '数字员工需要补充信息', detail: statusText || '等待用户补充信息。', state: 'completed' };
  }
  if (event.type === 'run.failed' || event.type === 'run.cancelled') {
    return { key: 'failure', label: event.type === 'run.cancelled' ? '数字员工执行已取消' : '数字员工执行失败', detail: staffDeckFailureDetail(event.data) || statusText, state: 'failed', stepKind: 'system' };
  }
  if (event.type === 'run.succeeded') {
    return { key: 'run-completed', label: 'StaffDeck 执行完成', detail: statusText || '数字员工本轮任务已完成。', state: 'completed', stepKind: 'system' };
  }
  return null;
}

function createStaffDeckActivityRecorder({ userId, room, member, roundId, signal }) {
  const messages = new Map();
  let activeKey = '';
  let lastOutputWriteAt = 0;
  const updateState = (key, state, error = null) => {
    const entry = messages.get(key);
    if (!entry) return;
    entry.metadata = stoppedMetadata({ ...entry.metadata, state }, error);
    groupChatDb.updateMessage(entry.id, {
      metadata: entry.metadata,
      status: state === 'running' ? 'thinking' : state === 'failed' ? 'failed' : 'completed',
      error,
    });
  };
  return {
    async consume(event) {
      if (signal?.aborted) return;
      const descriptor = staffDeckActivityDescriptor(event);
      if (!descriptor) return;
      if (activeKey && activeKey !== descriptor.key) {
        updateState(
          activeKey,
          descriptor.state === 'failed' ? 'failed' : 'completed',
          descriptor.state === 'failed' ? descriptor.detail || 'StaffDeck 执行失败' : null,
        );
      }
      activeKey = descriptor.state === 'running' ? descriptor.key : '';
      const metadata = {
        activityType: 'staffdeck',
        state: descriptor.state,
        staffDeckEventType: event.type,
        staffDeckPhase: staffDeckEventText(event.data, 'phase', 'stage') || undefined,
        staffDeckRunId: event.runId || undefined,
        staffDeckLabel: descriptor.label,
        staffDeckStepKind: descriptor.stepKind || 'system',
        staffDeckToolName: descriptor.toolName || undefined,
        staffDeckOutput: descriptor.output || undefined,
        staffDeckOutputTitle: descriptor.outputTitle || undefined,
        targetMemberId: member.id,
        targetMemberName: member.name,
      };
      const existing = messages.get(descriptor.key);
      const now = Date.now();
      const throttledOutput = descriptor.key === 'output'
        && descriptor.state === 'running'
        && now - lastOutputWriteAt < 160;
      if (existing) {
        existing.metadata = metadata;
        if (!throttledOutput || descriptor.state !== 'running') {
          groupChatDb.updateMessage(existing.id, {
            content: descriptor.detail,
            metadata,
            status: descriptor.state === 'running' ? 'thinking' : descriptor.state === 'failed' ? 'failed' : 'completed',
            error: descriptor.state === 'failed' ? descriptor.detail || 'StaffDeck 执行失败' : null,
          });
          if (descriptor.key === 'output') lastOutputWriteAt = now;
        }
        return;
      }
      const created = groupChatDb.createMessage(userId, room.id, {
        roundId,
        kind: 'activity',
        senderType: 'agent',
        senderMemberId: member.id,
        senderName: member.name,
        content: descriptor.detail,
        metadata,
        status: descriptor.state === 'running' ? 'thinking' : descriptor.state === 'failed' ? 'failed' : 'completed',
        error: descriptor.state === 'failed' ? descriptor.detail || 'StaffDeck 执行失败' : null,
      });
      if (created) messages.set(descriptor.key, { id: created.id, metadata });
      if (descriptor.key === 'output') lastOutputWriteAt = now;
    },
    finish(error) {
      const resolvedError = signal?.aborted ? abortReason(signal) : error;
      if (activeKey) updateState(activeKey, resolvedError ? 'failed' : 'completed', resolvedError || null);
      if (resolvedError && messages.size === 0) {
        const created = groupChatDb.createMessage(userId, room.id, {
          roundId,
          kind: 'activity',
          senderType: 'agent',
          senderMemberId: member.id,
          senderName: member.name,
          content: resolvedError,
          metadata: stoppedMetadata({
            activityType: 'staffdeck', state: 'failed', staffDeckLabel: '数字员工执行失败',
            targetMemberId: member.id, targetMemberName: member.name,
          }, resolvedError),
          status: 'failed',
          error: resolvedError,
        });
        if (created) messages.set('failure', { id: created.id, metadata: created.metadata });
      }
      activeKey = '';
    },
  };
}

async function invokeLocalPilotDeck(room, member, userMessage, transcript, userId, options = {}) {
  const gateway = await getPilotDeckGateway();
  const runId = crypto.randomUUID();
  const sessionKey = `group:${room.id}:${options.conversationId || 'default'}:${member.id}`;
  throwIfAborted(options.signal);
  if (options.execution) {
    options.execution.gateway = gateway;
    options.execution.sessionKey = sessionKey;
    options.execution.runId = runId;
  }
  const abortGateway = () => {
    const reason = abortReason(options.signal);
    const abortPromise = gateway.abortTurn({
      sessionKey,
      runId,
      reason: reason === USER_STOPPED_ERROR ? 'user:group_stop' : 'system:group_timeout',
    }).catch(() => undefined);
    if (options.execution) options.execution.abortPromise = abortPromise;
  };
  options.signal?.addEventListener('abort', abortGateway, { once: true });
  let output = '';
  let failure = null;
  let sawDelegation = false;
  let reasoning = '';
  let reasoningMessage = null;
  const toolMessages = new Map();
  if (options.persistActivity) {
    reasoningMessage = groupChatDb.createMessage(userId, room.id, {
      roundId: options.roundId,
      kind: 'activity',
      senderType: 'agent',
      senderMemberId: member.id,
      senderName: member.name,
      content: '正在理解问题并决定是否需要协调其他成员。',
      metadata: { activityType: 'reasoning', state: 'running' },
      status: 'thinking',
    });
  }
  try {
    for await (const event of gateway.submitTurn({
    sessionKey,
    channelKey: 'group',
      projectKey: room.projectPath,
    workspaceCwd: room.projectPath,
    message: userMessage,
    ...(options.messageAttachments ? { attachments: await toGatewayAttachments(options.messageAttachments) } : {}),
    runMode: 'ask',
    mode: 'default',
    canPrompt: false,
    permissionRules: { deny: GROUP_READ_ONLY_DENY_RULES },
    timeoutMs: ENTRY_TURN_TIMEOUT_MS,
    runId,
    syntheticMessages: [{
      purpose: 'group_chat_context',
      text: buildMemberContext(
        room,
        member,
        transcript,
        options.collaboration?.canDelegate === true,
        options.requiredDelegateIds || [],
      ),
    }],
    telemetry: {
      ownerModule: 'session',
      executionKind: 'user_session',
      phase: 'group_chat',
    },
    ...(options.collaboration ? { collaboration: options.collaboration } : {}),
    })) {
      if (event.type === 'assistant_text_delta') output += event.text || '';
      if (event.type === 'assistant_thinking_delta' && reasoningMessage) {
        reasoning = boundedPreview(`${reasoning}${event.text || ''}`, MAX_MESSAGE_CHARS);
        groupChatDb.updateMessage(reasoningMessage.id, {
          content: reasoning || '正在思考…',
          metadata: { activityType: 'reasoning', state: 'running' },
          status: 'thinking',
        });
      }
      if (event.type === 'tool_call_started') {
        if (event.name === GROUP_MEMBER_DELEGATE_TOOL) {
          sawDelegation = true;
        } else if (options.persistActivity) {
          const activity = groupChatDb.createMessage(userId, room.id, {
            roundId: options.roundId,
            kind: 'activity',
            senderType: 'agent',
            senderMemberId: member.id,
            senderName: member.name,
            content: boundedPreview(event.argsPreview),
            metadata: {
              activityType: 'tool',
              state: 'running',
              toolCallId: event.toolCallId,
              toolName: event.name,
            },
            status: 'thinking',
          });
          if (activity) toolMessages.set(event.toolCallId, activity.id);
        }
      }
      if (event.type === 'tool_call_finished' && options.persistActivity && event.toolName !== GROUP_MEMBER_DELEGATE_TOOL) {
        const activityId = toolMessages.get(event.toolCallId);
        if (activityId) {
          groupChatDb.updateMessage(activityId, {
            content: boundedPreview(event.resultPreview),
            metadata: {
              activityType: 'tool',
              state: event.ok ? 'completed' : 'failed',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              errorCode: event.errorCode || undefined,
            },
            status: event.ok ? 'completed' : 'failed',
            error: event.ok ? null : (event.errorCode || '工具调用失败'),
          });
          toolMessages.delete(event.toolCallId);
        }
      }
      if (event.type === 'error') {
        failure = event.message || event.code || 'PilotDeck 调用失败';
        if (event.code === 'turn_timeout' && options.execution && !options.execution.signal.aborted) {
          // Gateway wall-clock timeouts abort only the agent session itself.
          // Abort the owning group execution too so an in-flight delegate sees
          // the same terminal state and can cancel its StaffDeck Run.
          options.execution.abortController.abort(new Error(failure));
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    options.signal?.removeEventListener('abort', abortGateway);
    if (options.execution?.runId === runId) {
      options.execution.gateway = null;
      options.execution.sessionKey = '';
      options.execution.runId = '';
    }
    if (reasoningMessage) {
      const stopped = failure === USER_STOPPED_ERROR;
      groupChatDb.updateMessage(reasoningMessage.id, {
        content: reasoning || (stopped ? '本轮分析已停止。' : '已完成本轮分析。'),
        metadata: stoppedMetadata({ activityType: 'reasoning', state: stopped ? 'failed' : 'completed' }, failure),
        status: stopped ? 'failed' : 'completed',
        error: stopped ? failure : null,
      });
    }
    if (failure) {
      for (const [toolCallId, activityId] of toolMessages) {
        groupChatDb.updateMessage(activityId, {
          metadata: stoppedMetadata({ activityType: 'tool', state: 'failed', toolCallId }, failure),
          status: 'failed',
          error: failure,
        });
      }
      // A gateway error is terminal state, not the state of the reasoning
      // activity that began at the start of the turn. Append a distinct event
      // so its sequence reflects when the failure actually occurred (after any
      // delegated StaffDeck trace), instead of moving an early step in time.
      if (options.persistActivity && failure !== USER_STOPPED_ERROR) {
        groupChatDb.createMessage(userId, room.id, {
          roundId: options.roundId,
          kind: 'activity',
          senderType: 'agent',
          senderMemberId: member.id,
          senderName: member.name,
          content: '主智能体未能完成本轮执行。',
          metadata: { activityType: 'execution', state: 'failed' },
          status: 'failed',
          error: failure,
        });
      }
    }
  }
  if (failure) throw new Error(failure);
  return { content: output.trim(), sawDelegation };
}

async function invokeRemoteGroupTurn(room, member, userMessage, transcript, userId, options = {}) {
  if (!member.instanceId) {
    throw new Error('远程 PilotDeck 必须引用经过管理员批准的实例。');
  }
  const { instance, binding, token } = await assertApprovedRemoteInstance(member.instanceId, room.projectPath);
  const controller = new AbortController();
  throwIfAborted(options.signal);
  const forwardAbort = () => controller.abort(options.signal?.reason ?? new Error(USER_STOPPED_ERROR));
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('远程 PilotDeck group-turn 调用超时。')), MEMBER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${instance.endpoint.replace(/\/$/u, '')}/v1/group/turn`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        roomId: room.id,
        conversationId: options.conversationId,
        roundId: options.roundId,
        entryMemberId: member.id,
        workspaceKey: binding.workspace_key,
        message: userMessage,
        ...(options.messageAttachments ? { attachments: options.messageAttachments } : {}),
        rosterContext: buildMemberContext(room, member, transcript, true, options.requiredDelegateIds || []),
        requiredDelegates: options.requiredDelegateIds || [],
        collaboration: options.collaboration || { canDelegate: false },
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    throw new Error(controller.signal.aborted
      ? (options.signal?.aborted ? USER_STOPPED_ERROR : '远程 PilotDeck group-turn 调用超时。')
      : (error instanceof Error ? error.message : String(error)));
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    throw new Error(payload.error || `远程 PilotDeck group-turn 请求失败（HTTP ${response.status}）。`);
  }
  let output = '';
  let failure = null;
  let sawDelegation = false;
  let buffer = '';
  let reasoning = '';
  const toolMessages = new Map();
  const reasoningMessage = options.persistActivity
    ? groupChatDb.createMessage(userId, room.id, {
        roundId: options.roundId,
        kind: 'activity',
        senderType: 'agent',
        senderMemberId: member.id,
        senderName: member.name,
        content: '远程实例正在理解问题并决定是否需要协调其他成员。',
        metadata: { activityType: 'reasoning', state: 'running', remote: true },
        status: 'thinking',
      })
    : null;
  const consumeEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'assistant_text_delta') output += event.text || '';
    if (event.type === 'assistant_thinking_delta' && reasoningMessage) {
      reasoning = boundedPreview(`${reasoning}${event.text || ''}`, MAX_MESSAGE_CHARS);
      groupChatDb.updateMessage(reasoningMessage.id, {
        content: reasoning || '正在思考…',
        metadata: { activityType: 'reasoning', state: 'running', remote: true },
        status: 'thinking',
      });
    }
    if (event.type === 'tool_call_started') {
      if (event.name === GROUP_MEMBER_DELEGATE_TOOL) sawDelegation = true;
      else if (options.persistActivity) {
        const activity = groupChatDb.createMessage(userId, room.id, {
          roundId: options.roundId,
          kind: 'activity', senderType: 'agent', senderMemberId: member.id, senderName: member.name,
          content: boundedPreview(event.argsPreview),
          metadata: { activityType: 'tool', state: 'running', toolCallId: event.toolCallId, toolName: event.name, remote: true },
          status: 'thinking',
        });
        if (activity) toolMessages.set(event.toolCallId, activity.id);
      }
    }
    if (event.type === 'tool_call_finished' && event.toolName !== GROUP_MEMBER_DELEGATE_TOOL) {
      const activityId = toolMessages.get(event.toolCallId);
      if (activityId) {
        groupChatDb.updateMessage(activityId, {
          content: boundedPreview(event.resultPreview),
          metadata: { activityType: 'tool', state: event.ok ? 'completed' : 'failed', toolCallId: event.toolCallId, toolName: event.toolName, remote: true },
          status: event.ok ? 'completed' : 'failed',
          error: event.ok ? null : (event.errorCode || '远程工具调用失败'),
        });
        toolMessages.delete(event.toolCallId);
      }
    }
    if (event.type === 'error') failure = event.message || event.code || '远程 PilotDeck 调用失败';
  };
  try {
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        consumeEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) consumeEvent(JSON.parse(buffer));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    if (reasoningMessage) {
      groupChatDb.updateMessage(reasoningMessage.id, {
        content: reasoning || (failure ? '远程分析失败。' : '远程分析完成。'),
        metadata: { activityType: 'reasoning', state: failure ? 'failed' : 'completed', remote: true },
        status: failure ? 'failed' : 'completed',
        error: failure,
      });
    }
  }
  if (failure) throw new Error(failure);
  return { content: output.trim(), sawDelegation };
}

async function invokeStaffDeck(room, member, userMessage, transcript, userId, options = {}) {
  const connection = staffDeckClient.resolveConnection(process.env);
  if (!connection) throw new Error('StaffDeck 尚未配置 API Key。');
  const now = new Date().toISOString();
  const employeeId = member.config?.employeeId || member.id;
  const prompt = `${buildMemberContext(room, member, transcript, false)}\n\n当前用户消息：\n${userMessage}`;
  const staffDeckAttachments = options.messageAttachments
    ? await toGatewayAttachments(options.messageAttachments)
    : [];
  const activityRecorder = createStaffDeckActivityRecorder({
    userId,
    room,
    member,
    roundId: options.roundId,
    signal: options.signal,
  });
  try {
    const result = await staffDeckClient.invoke({
      room: {
        id: room.id,
        ownerSessionId: `user-${userId}`,
        title: room.title,
        status: 'active',
        participants: [{
          id: member.id,
          kind: 'staffdeck',
          name: member.name,
          role: member.role,
          description: member.description,
          employeeId,
        }],
        messages: [],
        createdAt: room.createdAt || now,
        updatedAt: room.updatedAt || now,
      },
      participant: {
        id: member.id,
        kind: 'staffdeck',
        name: member.name,
        role: member.role,
        description: member.description,
        employeeId,
      },
      sourceMessage: {
        id: options.roundId || `group-message-${crypto.randomUUID()}`,
        roomId: room.id,
        conversationId: options.conversationId,
        senderId: 'main',
        senderName: 'PilotDeck 主智能体',
        senderKind: 'pilotdeck_main',
        content: userMessage,
        createdAt: now,
      },
      transcript,
      ...(staffDeckAttachments.length > 0 ? { attachments: staffDeckAttachments } : {}),
    }, prompt, connection, options.signal, activityRecorder.consume);
    activityRecorder.finish(null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    activityRecorder.finish(message);
    throw error;
  }
}

async function invokeMember(room, member, userMessage, transcript, userId, options = {}) {
  const participant = groupChatDb.listParticipants(userId, room.id)
    ?.find((candidate) => candidate.boundMemberId === member.id);
  if (participant && !participant.isActive) {
    throw new Error(`成员“${member.name}”的账号已停用。`);
  }
  if (member.kind === 'pilotdeck_main') {
    return invokeLocalPilotDeck(room, member, userMessage, transcript, userId, options);
  }
  if (member.kind === 'pilotdeck_remote') {
    return invokeRemoteGroupTurn(room, member, userMessage, transcript, userId, options);
  }
  if (member.kind === 'staffdeck') {
    return { content: await invokeStaffDeck(room, member, userMessage, transcript, userId, options), sawDelegation: false };
  }
  // Migration-only compatibility for an old round that was already queued before
  // local/Mock members were removed. New additions reject both legacy kinds and
  // the migration deactivates every persisted legacy member.
  return invokeLocalPilotDeck(room, member, userMessage, transcript, userId, options);
}

function resolveMentionTargets(room, mentionedMemberIds, mentionAll) {
  const active = room.members.filter((member) => member.isActive !== false);
  if (mentionAll) {
    const secondary = active.filter((member) => member.id !== 'main');
    const main = active.find((member) => member.id === 'main');
    return [...secondary, ...(main ? [main] : [])];
  }
  const membersById = new Map(active.map((member) => [member.id, member]));
  return (mentionedMemberIds || []).flatMap((id) => membersById.get(id) || []);
}

function resolveEntryMember(room, participant) {
  const active = room.members.filter((member) => member.isActive !== false);
  const preferred = active.find((member) => member.id === participant?.boundMemberId);
  if (preferred && memberCategory(preferred.kind) === 'pilotdeck_instance') return preferred;
  return active.find((member) => member.id === 'main') || null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsMention(content, label) {
  return new RegExp(
    `(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(label)}(?=\\s|$|[,.!?;:，。！？；：、])`,
    'iu',
  ).test(content);
}

function mentionPosition(content, label) {
  const match = new RegExp(
    `(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(label)}(?=\\s|$|[,.!?;:，。！？；：、])`,
    'iu',
  ).exec(content);
  if (!match) return Number.POSITIVE_INFINITY;
  const atOffset = match[0].lastIndexOf('@');
  return match.index + Math.max(0, atOffset);
}

function extractMentions(room, content, hintedMemberIds = []) {
  const mentionAll = /(?:^|[^a-zA-Z0-9_@])@(所有人|all)(?=\s|$|[,.!?;:，。！？；：、])/iu.test(content);
  const hintedOrder = Array.isArray(hintedMemberIds)
    ? [...new Set(hintedMemberIds.filter((id) => typeof id === 'string'))]
    : [];
  const hinted = new Set(hintedOrder);
  const visible = room.members
    .filter((member) => {
      const visibleMention = containsMention(content, member.name) || containsMention(content, member.id);
      if (!visibleMention) return false;
      // Structured ids disambiguate equal display names, while plain text
      // input remains backwards-compatible with both names and legacy ids.
      const sameNameCount = room.members.filter((candidate) => candidate.name === member.name).length;
      return sameNameCount <= 1 || hinted.size === 0 || hinted.has(member.id);
    })
    .map((member) => ({
      id: member.id,
      position: Math.min(
        mentionPosition(content, member.name),
        mentionPosition(content, member.id),
      ),
    }));
  const hintedIndex = new Map(hintedOrder.map((id, index) => [id, index]));
  const mentionedMemberIds = visible
    .sort((left, right) => left.position - right.position
      || (hintedIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (hintedIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => entry.id);
  return { mentionAll, mentionedMemberIds };
}

function notifyRoundCompleted(userId, roomId, roundId) {
  const participants = groupChatDb.listParticipants(userId, roomId) || [];
  for (const participant of participants) {
    if (participant.muted || !participant.isActive) continue;
    notifyUserIfEnabled({
      userId: participant.userId,
      event: createNotificationEvent({
        provider: 'pilotdeck',
        kind: 'info',
        code: 'agent.notification',
        meta: {
          message: `群组“${groupChatDb.getRoom(participant.userId, roomId)?.title || '群组'}”已完成本轮回复`,
          groupId: roomId,
          groupName: groupChatDb.getRoom(participant.userId, roomId)?.title || '',
        },
        dedupeKey: `group:${roomId}:round:${roundId}:user:${participant.userId}`,
      }),
    });
  }
}

async function runDirectMember(userId, roomId, conversationId, roundId, userMessage, target, messageAttachments, execution) {
  throwIfAborted(execution?.signal);
  const room = groupChatDb.getRoom(userId, roomId);
  if (!room || room.status !== 'active') return;
  if (target.id === 'main') {
    try {
      await runEntryAgent(userId, room, conversationId, roundId, userMessage, target, [], messageAttachments, execution);
    } catch (error) {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: '',
        metadata: stoppedMetadata({}, error instanceof Error ? error.message : String(error)),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  // StaffDeck emits its own persisted streaming activities. Delay its final
  // chat message until the stream completes so the visible order remains
  // process -> reply instead of reply -> process after the placeholder update.
  let placeholder = target.kind === 'staffdeck'
    ? null
    : groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: '',
        status: 'thinking',
      });
  try {
    const messages = groupChatDb.listMessages(userId, roomId, conversationId, 100) || [];
    const transcript = formatTranscript(messages.filter((message) => message.id !== placeholder?.id));
    const result = await invokeMember(room, target, userMessage, transcript, userId, {
      roundId,
      conversationId,
      requiredDelegateIds: [],
      messageAttachments,
      signal: execution?.signal,
      execution,
      collaboration: { canDelegate: false },
    });
    if (!result.content) throw new Error('智能体没有返回可显示的内容。');
    if (placeholder) {
      groupChatDb.updateMessage(placeholder.id, {
        content: result.content,
        status: 'completed',
        error: null,
      });
    } else {
      placeholder = groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: result.content,
        status: 'completed',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (placeholder) {
      groupChatDb.updateMessage(placeholder.id, {
        content: '',
        metadata: stoppedMetadata(placeholder.metadata, errorMessage),
        status: 'failed',
        error: errorMessage,
      });
    } else {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: '',
        metadata: stoppedMetadata({}, errorMessage),
        status: 'failed',
        error: errorMessage,
      });
    }
  }
}

async function runEntryAgent(userId, room, conversationId, roundId, userMessage, entryMember, requiredDelegateIds, messageAttachments, execution) {
  const sessionId = `group:${room.id}:${conversationId}:${entryMember.id}`;
  const turnContext = {
    userId,
    roomId: room.id,
    conversationId,
    roundId,
    sessionId,
    entryMemberId: entryMember.id,
    requiredDelegateIds: [...requiredDelegateIds],
    attemptedDelegateIds: new Set(),
    delegationCallCounts: new Map(),
    delegationSequence: [],
    messageAttachments,
    signal: execution?.signal,
    execution,
  };
  activeMainTurns.set(sessionId, turnContext);
  const grant = createGroupDelegationGrant({
    roomId: room.id,
    turnId: roundId,
    entryInstanceId: entryMember.instanceId || room.coordinatorInstanceId || entryMember.id,
  });
  const collaboration = {
    version: 1,
    kind: 'group_turn',
    roomId: room.id,
    conversationId,
    turnId: roundId,
    entryMemberId: entryMember.id,
    canDelegate: true,
    coordinatorUrl: (process.env.PILOTDECK_PUBLIC_URL || process.env.PILOTDECK_GROUP_API_URL || `http://127.0.0.1:${process.env.SERVER_PORT || '3001'}`).replace(/\/$/u, ''),
    delegationToken: grant.token,
  };
  let result = { content: '', sawDelegation: false };
  try {
    for (let attempt = 0; attempt <= MAX_REQUIRED_DELEGATE_RETRIES; attempt += 1) {
      throwIfAborted(execution?.signal);
      const currentRoom = groupChatDb.getRoom(userId, room.id);
      if (!currentRoom || currentRoom.status !== 'active') throw new Error('群组已经归档。');
      const missing = requiredDelegateIds.filter((id) => !turnContext.attemptedDelegateIds.has(id));
      if (attempt > 0 && missing.length === 0) break;
      const messages = groupChatDb.listMessages(userId, room.id, conversationId, 100) || [];
      const transcript = formatTranscript(messages);
      const prompt = attempt === 0
        ? userMessage
        : [
            '系统校验：你刚才没有完成用户显式要求的成员委派。',
            `现在必须按顺序调用这些成员：${missing.join(' -> ')}。`,
            '完成真实工具调用后，再给出最终答复；不要只用文字模拟委派。',
          ].join('\n');
      result = await invokeMember(currentRoom, entryMember, prompt, transcript, userId, {
        roundId,
        conversationId,
        persistActivity: true,
        requiredDelegateIds: missing,
        ...(attempt === 0 && messageAttachments ? { messageAttachments } : {}),
        signal: execution?.signal,
        execution,
        collaboration,
      });
      if (requiredDelegateIds.every((id) => turnContext.attemptedDelegateIds.has(id))) break;
    }

    const missing = requiredDelegateIds.filter((id) => !turnContext.attemptedDelegateIds.has(id));
    if (missing.length > 0) {
      throw new Error(`主智能体未完成必选成员委派：${missing.join('、')}`);
    }
    if (result.content) {
      groupChatDb.createMessage(userId, room.id, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: entryMember.id,
        senderName: entryMember.name,
        content: result.content,
        status: 'completed',
      });
    } else if (turnContext.attemptedDelegateIds.size === 0 && !result.sawDelegation) {
      throw new Error('主智能体没有返回可显示的内容。');
    }
  } finally {
    if (activeMainTurns.get(sessionId) === turnContext) activeMainTurns.delete(sessionId);
    revokeGroupDelegationGrants(roundId);
  }
}

async function dispatchMentionRound(userId, roomId, conversationId, roundId, userMessage, targets, messageAttachments, execution) {
  try {
    for (const target of targets) {
      throwIfAborted(execution?.signal);
      await runDirectMember(userId, roomId, conversationId, roundId, userMessage, target, messageAttachments, execution);
    }
    throwIfAborted(execution?.signal);
    groupChatDb.updateTurn(roundId, { status: 'completed', error: null });
    notifyRoundCompleted(userId, roomId, roundId);
  } catch (error) {
    groupChatDb.updateTurn(roundId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dispatchSmartRound(userId, roomId, conversationId, roundId, userMessage, entryMember, requiredDelegateIds, messageAttachments, execution) {
  try {
    throwIfAborted(execution?.signal);
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') throw new Error('群组已经归档。');
    await runEntryAgent(userId, room, conversationId, roundId, userMessage, entryMember, requiredDelegateIds, messageAttachments, execution);
    throwIfAborted(execution?.signal);
    groupChatDb.updateTurn(roundId, { status: 'completed', error: null });
    notifyRoundCompleted(userId, roomId, roundId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existingFailure = (groupChatDb.listMessages(userId, roomId, conversationId, 200) || [])
      .some((candidate) => candidate.roundId === roundId
        && candidate.kind === 'activity'
        && candidate.senderMemberId === entryMember.id
        && candidate.status === 'failed');
    if (!existingFailure) {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'activity',
        senderType: 'agent',
        senderMemberId: entryMember.id,
        senderName: entryMember.name,
        content: message,
        metadata: stoppedMetadata({ activityType: 'execution', state: 'failed' }, message),
        status: 'failed',
        error: message,
      });
    }
    groupChatDb.updateTurn(roundId, { status: 'failed', error: message });
  }
}

async function executeQueuedTurn(turn) {
  const abortController = new AbortController();
  const execution = {
    userId: turn.senderUserId,
    roomId: turn.roomId,
    conversationId: turn.conversationId,
    roundId: turn.id,
    signal: abortController.signal,
    abortController,
    gateway: null,
    sessionKey: '',
    runId: '',
    abortPromise: null,
  };
  activeRoundExecutions.set(turn.id, execution);
  try {
    const queueMessage = groupChatDb.getMessage(turn.senderUserId, turn.roomId, `queue-${turn.id}`);
    if (queueMessage) {
      groupChatDb.updateMessage(queueMessage.id, {
        content: '已开始处理这条消息。',
        metadata: { ...queueMessage.metadata, state: 'completed' },
        status: 'completed',
        error: null,
      });
    }
    if (!userDb.getUserById(turn.senderUserId)) {
      groupChatDb.updateTurn(turn.id, { status: 'failed', error: '消息发送者账号已停用。' });
      return;
    }
    const message = groupChatDb.getUserMessageForTurn(turn.id);
    if (!message) {
      groupChatDb.updateTurn(turn.id, { status: 'failed', error: '群组轮次缺少用户消息。' });
      return;
    }
    const room = groupChatDb.getRoom(turn.senderUserId, turn.roomId);
    if (!room || room.status !== 'active') {
      groupChatDb.updateTurn(turn.id, { status: 'failed', error: '群组不存在或已经归档。' });
      return;
    }
    const targetIds = turn.requiredDelegates || [];
    const persistedAttachments = {
      images: Array.isArray(message.metadata?.images) ? message.metadata.images : [],
      attachments: Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [],
    };
    const messageAttachments = persistedAttachments.images.length > 0 || persistedAttachments.attachments.length > 0
      ? persistedAttachments
      : undefined;
    const userMessage = `${message.content}${attachmentNote(messageAttachments)}`;
    if (turn.triggerSource === 'mentions') {
      const targetsById = new Map(room.members.map((member) => [member.id, member]));
      const targets = targetIds.flatMap((id) => targetsById.get(id) || []);
      await dispatchMentionRound(turn.senderUserId, turn.roomId, turn.conversationId, turn.id, userMessage, targets, messageAttachments, execution);
      return;
    }
    const entryMember = room.members.find((member) => member.id === turn.entryMemberId && member.isActive !== false);
    if (!entryMember) {
      groupChatDb.updateTurn(turn.id, { status: 'failed', error: '入口 PilotDeck 实例不可用。' });
      return;
    }
    await dispatchSmartRound(turn.senderUserId, turn.roomId, turn.conversationId, turn.id, userMessage, entryMember, targetIds, messageAttachments, execution);
  } finally {
    if (activeRoundExecutions.get(turn.id) === execution) activeRoundExecutions.delete(turn.id);
  }
}

function scheduleConversation(roomId, conversationId) {
  const queueKey = `${roomId}:${conversationId}`;
  if (dispatchingConversations.has(queueKey)) return;
  dispatchingConversations.add(queueKey);
  queueMicrotask(async () => {
    try {
      while (true) {
        const queued = groupChatDb.getNextQueuedTurn(roomId, conversationId);
        if (!queued) break;
        const claimed = groupChatDb.claimQueuedTurn(queued.id);
        if (!claimed) continue;
        try {
          await executeQueuedTurn(claimed);
        } catch (error) {
          groupChatDb.updateTurn(claimed.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      dispatchingConversations.delete(queueKey);
      if (groupChatDb.getNextQueuedTurn(roomId, conversationId)) {
        scheduleConversation(roomId, conversationId);
      }
    }
  });
}

export const groupChatService = {
  async listAvailableMembers() {
    let staffdeck = [];
    let staffdeckError = null;
    try {
      staffdeck = await listStaffDeckEmployees();
    } catch (error) {
      staffdeckError = error instanceof Error ? error.message : String(error);
    }
    return {
      local: [],
      staffdeck,
      mocks: [],
      staffdeckConfigured: Boolean(staffDeckClient.resolveConnection(process.env)),
      staffdeckError,
    };
  },

  addMember(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room) return null;
    if (room.members.length >= MAX_MEMBERS + 1) throw new Error(`每个群组最多邀请 ${MAX_MEMBERS} 个成员。`);
    const member = normalizeMemberInput(input);
    if (member.kind === 'pilotdeck_remote') {
      const instance = instancesDb.get(member.instanceId);
      if (!instance || instance.kind !== 'remote' || instance.status !== 'approved') {
        throw new Error('远程 PilotDeck 实例尚未通过管理员批准。');
      }
      if (!instancesDb.getProjectBinding(instance.id, room.projectPath)) {
        throw new Error('远程 PilotDeck 实例没有绑定当前项目工作区。');
      }
      member.name = input.name?.trim() || instance.name;
    }
    if (room.members.some((existing) => existing.id === member.id)) throw new Error('该成员已经在群组中。');
    return groupChatDb.addMember(userId, roomId, member);
  },

  async delegateMember(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') return null;
    const sourceSessionId = typeof input.sourceSessionId === 'string' ? input.sourceSessionId : '';
    const activeTurn = activeMainTurns.get(sourceSessionId);
    if (!activeTurn || activeTurn.userId !== userId || activeTurn.roomId !== roomId) {
      throw new Error('当前群组没有可接受委派的入口智能体轮次。');
    }
    const memberId = cleanText(input.memberId, '成员 ID', 100);
    if (memberId === 'main') throw new Error('主智能体不能委派给自己。');
    const member = room.members.find((candidate) => candidate.id === memberId && candidate.isActive !== false);
    if (!member) throw new Error('要调用的群成员不存在或已被移除。');
    const nextRequired = activeTurn.requiredDelegateIds.find((id) => !activeTurn.attemptedDelegateIds.has(id));
    if (nextRequired && memberId !== nextRequired) {
      throw new Error(`必须先按用户提及顺序委派 ${nextRequired}，然后才能调用 ${memberId}。`);
    }
    if (activeTurn.delegationSequence.length >= MAX_DELEGATIONS_PER_TURN) {
      throw new Error('本轮成员委派次数已达上限，请基于现有结果完成回答。');
    }
    const memberCallCount = activeTurn.delegationCallCounts.get(memberId) || 0;
    if (memberCallCount >= MAX_DELEGATIONS_PER_MEMBER_PER_TURN) {
      throw new Error(`本轮已多次调用 ${member.name}，请基于现有回复继续或改问其他成员。`);
    }
    const message = cleanText(input.message, '委派消息', MAX_MESSAGE_CHARS);
    const sourceTurnId = typeof input.sourceTurnId === 'string'
      ? input.sourceTurnId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
      : '';
    const roundId = activeTurn.roundId;
    const delegationIndex = activeTurn.delegationSequence.length + 1;
    const delegationReason = activeTurn.requiredDelegateIds.includes(memberId) ? 'required' : 'agentic';
    activeTurn.attemptedDelegateIds.add(memberId);
    activeTurn.delegationCallCounts.set(memberId, memberCallCount + 1);
    activeTurn.delegationSequence.push(memberId);
    const entry = room.members.find((candidate) => candidate.id === activeTurn.entryMemberId);
    const delegation = groupChatDb.createMessage(userId, roomId, {
      roundId,
      kind: 'delegation',
      senderType: 'agent',
      senderMemberId: entry?.id || activeTurn.entryMemberId,
      senderName: entry?.name || 'PilotDeck 协调智能体',
      content: message,
      metadata: {
        state: 'waiting',
        targetMemberId: member.id,
        targetMemberName: member.name,
        delegationIndex,
        delegationReason,
        sourceTurnId: sourceTurnId || undefined,
      },
      status: 'thinking',
    });
    const placeholder = groupChatDb.createMessage(userId, roomId, {
      roundId,
      kind: 'chat',
      senderType: 'agent',
      senderMemberId: member.id,
      senderName: member.name,
      replyToMessageId: delegation?.id,
      content: '',
      status: 'thinking',
    });
    try {
      const messages = groupChatDb.listMessages(userId, roomId, activeTurn.conversationId, 100) || [];
      const transcript = formatTranscript(messages.filter((candidate) => candidate.id !== placeholder.id));
      const result = await invokeMember(room, member, message, transcript, userId, {
        roundId,
        conversationId: activeTurn.conversationId,
        requiredDelegateIds: [],
        signal: activeTurn.signal,
        execution: activeTurn.execution,
        ...(activeTurn.messageAttachments ? { messageAttachments: activeTurn.messageAttachments } : {}),
        collaboration: { canDelegate: false },
      });
      if (!result.content) throw new Error('被委派成员没有返回可显示的内容。');
      const completed = groupChatDb.updateMessage(placeholder.id, {
        content: result.content,
        status: 'completed',
        error: null,
      });
      groupChatDb.updateMessage(delegation.id, {
        metadata: {
          ...delegation.metadata,
          state: 'completed',
          responseMessageId: completed.id,
        },
        status: 'completed',
        error: null,
      });
      return { member, message: completed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      groupChatDb.updateMessage(placeholder.id, {
        content: '',
        metadata: stoppedMetadata(placeholder.metadata, errorMessage),
        status: 'failed',
        error: errorMessage,
      });
      groupChatDb.updateMessage(delegation.id, {
        metadata: stoppedMetadata({ ...delegation.metadata, state: 'failed' }, errorMessage),
        status: 'failed',
        error: errorMessage,
      });
      throw error;
    }
  },

  async stopConversation(userId, roomId, conversationId) {
    const conversation = groupChatDb.getConversation(userId, roomId, conversationId);
    if (!conversation) return null;
    const turns = groupChatDb.listActiveTurns(userId, roomId, conversationId) || [];
    const activeTurnIds = new Set(turns.map((turn) => turn.id));
    const executions = [...activeRoundExecutions.values()].filter((execution) => (
      execution.roomId === roomId && execution.conversationId === conversationId
    ));

    for (const turn of turns) {
      groupChatDb.updateTurn(turn.id, { status: 'failed', error: USER_STOPPED_ERROR });
    }

    let stoppedMessages = 0;
    const messages = groupChatDb.listMessages(userId, roomId, conversationId, 200) || [];
    for (const message of messages) {
      if (!['thinking', 'queued'].includes(message.status)) continue;
      if (activeTurnIds.size > 0 && message.roundId && !activeTurnIds.has(message.roundId)) continue;
      groupChatDb.updateMessage(message.id, {
        content: message.content,
        metadata: { ...message.metadata, state: 'failed', stoppedByUser: true },
        status: 'failed',
        error: USER_STOPPED_ERROR,
      });
      stoppedMessages += 1;
    }

    const aborts = [];
    for (const execution of executions) {
      if (!execution.signal.aborted) execution.abortController.abort(new Error(USER_STOPPED_ERROR));
      if (execution.abortPromise) {
        aborts.push(execution.abortPromise);
      } else if (execution.gateway && execution.sessionKey) {
        aborts.push(execution.gateway.abortTurn({
          sessionKey: execution.sessionKey,
          ...(execution.runId ? { runId: execution.runId } : {}),
          reason: 'user:group_stop',
        }).catch(() => undefined));
      }
    }
    if (aborts.length > 0) {
      await Promise.race([
        Promise.allSettled(aborts),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    return {
      stopped: turns.length > 0 || executions.length > 0 || stoppedMessages > 0,
      turnIds: turns.map((turn) => turn.id),
    };
  },

  sendMessage(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') return null;
    const conversationId = typeof input.conversationId === 'string'
      ? input.conversationId
      : room.conversations?.[0]?.id || '';
    const conversation = groupChatDb.getConversation(userId, roomId, conversationId);
    if (!conversation) throw new Error('群组会话不存在或已经归档。');
    const messageAttachments = normalizeGroupMessageAttachments(room, input);
    const hasAttachments = messageAttachments.images.length > 0 || messageAttachments.attachments.length > 0;
    const content = typeof input.content === 'string' && input.content.trim()
      ? cleanText(input.content, '消息', MAX_MESSAGE_CHARS)
      : hasAttachments
        ? '请查看附件。'
        : cleanText(input.content, '消息', MAX_MESSAGE_CHARS);
    // Mentions are derived from the saved text so callers cannot trigger an
    // unmentioned member by sending a forged `mentionedMemberIds` payload.
    const { mentionedMemberIds, mentionAll } = extractMentions(room, content, input.mentionedMemberIds);
    const participant = groupChatDb.getParticipant(userId, roomId);
    if (!participant) throw new Error('当前用户不是该群组的有效参与者。');
    let entryMember = resolveEntryMember(room, participant);
    if (!entryMember) throw new Error('群组没有可用的入口 PilotDeck 实例。');
    const directTargets = resolveMentionTargets(room, mentionedMemberIds, mentionAll);
    if (room.triggerMode === 'auto' && mentionAll) {
      entryMember = room.members.find((member) => member.id === 'main' && member.isActive !== false) || entryMember;
    }
    const requiredDelegateIds = room.triggerMode === 'mentions'
      ? directTargets.map((member) => member.id)
      : mentionAll
        ? room.members.filter((member) => member.id !== entryMember.id && member.isActive !== false).map((member) => member.id)
        : mentionedMemberIds.filter((id) => id !== entryMember.id);
    const idempotencyKey = typeof input.clientMessageId === 'string' && input.clientMessageId.trim()
      ? `${conversation.id}:${userId}:${input.clientMessageId.trim().slice(0, 140)}`
      : null;
    const turn = groupChatDb.createTurn(userId, roomId, {
      conversationId: conversation.id,
      entryMemberId: room.triggerMode === 'auto' ? entryMember.id : (directTargets[0]?.id || entryMember.id),
      triggerSource: room.triggerMode,
      status: 'queued',
      idempotencyKey,
      requiredDelegates: requiredDelegateIds,
    });
    if (!turn) throw new Error('无法创建群组轮次。');
    const roundId = turn.id;
    const existingMessage = groupChatDb.getUserMessageForTurn(roundId);
    if (existingMessage) {
      if (turn.status === 'queued') scheduleConversation(roomId, turn.conversationId);
      return {
        message: existingMessage,
        roundId,
        entryMemberId: turn.entryMemberId,
        targetMemberIds: turn.requiredDelegates,
        requiredDelegateIds: room.triggerMode === 'auto' ? turn.requiredDelegates : [],
        deduplicated: true,
      };
    }
    const message = groupChatDb.createMessage(userId, roomId, {
      conversationId: conversation.id,
      roundId,
      kind: 'chat',
      senderType: 'user',
      senderUserId: userId,
      senderName: participant.displayName || '你',
      content,
      metadata: messageAttachments,
      status: 'completed',
    });
    groupChatDb.setTurnMessageSequence(roundId, message.sequence);
    if (room.triggerMode === 'mentions' && directTargets.length === 0) {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'system',
        senderName: '系统',
        content: '当前已开启“仅 @ 触发”。本条消息已保存，但没有调用任何智能体。',
        status: 'completed',
      });
      groupChatDb.updateTurn(roundId, { status: 'completed', error: null });
    } else {
      groupChatDb.createMessage(userId, roomId, {
        id: `queue-${roundId}`,
        conversationId: conversation.id,
        roundId,
        kind: 'activity',
        senderType: 'agent',
        senderMemberId: entryMember.id,
        senderName: entryMember.name,
        content: '消息已进入当前会话的处理队列。',
        metadata: { activityType: 'queue', state: 'running' },
        status: 'queued',
      });
      scheduleConversation(roomId, conversation.id);
    }
    return {
      message,
      roundId,
      entryMemberId: entryMember.id,
      targetMemberIds: room.triggerMode === 'auto'
        ? [entryMember.id]
        : directTargets.map((member) => member.id),
      requiredDelegateIds: room.triggerMode === 'auto'
        ? requiredDelegateIds
        : [],
    };
  },

  recoverPendingTurns() {
    groupChatDb.requeueInterruptedTurns();
    for (const queue of groupChatDb.listPendingQueues()) {
      scheduleConversation(queue.roomId, queue.conversationId);
    }
  },
};
