import crypto from 'node:crypto';
import path from 'node:path';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { createNotificationEvent, notifyUserIfEnabled } from './notification-orchestrator.js';
import { groupChatDb } from './group-chat-db.js';

const MAX_MESSAGE_CHARS = 20_000;
const MAX_MEMBERS = 8;
const MEMBER_TIMEOUT_MS = 5 * 60_000;
const activeRooms = new Set();

export const MOCK_EMPLOYEES = [
  {
    id: 'mock-researcher',
    kind: 'staffdeck_mock',
    name: 'Mock 研究员',
    role: '研究分析',
    description: '收集证据、澄清假设并比较不同方案。',
  },
  {
    id: 'mock-engineer',
    kind: 'staffdeck_mock',
    name: 'Mock 工程师',
    role: '方案实现',
    description: '将目标转换为实现方案，并指出集成约束。',
  },
  {
    id: 'mock-reviewer',
    kind: 'staffdeck_mock',
    name: 'Mock 评审员',
    role: '风险评审',
    description: '挑战方案、识别失败模式并给出验证建议。',
  },
];

const LOCAL_TEMPLATES = [
  {
    id: 'local-researcher',
    kind: 'pilotdeck_local',
    name: 'PilotDeck 研究员',
    role: '研究分析',
    description: '只读调查、证据整理与方案比较。',
  },
  {
    id: 'local-engineer',
    kind: 'pilotdeck_local',
    name: 'PilotDeck 工程师',
    role: '技术实现',
    description: '从工程角度给出架构和实现建议。',
  },
  {
    id: 'local-reviewer',
    kind: 'pilotdeck_local',
    name: 'PilotDeck 评审员',
    role: '独立评审',
    description: '独立审查风险、遗漏和验收条件。',
  },
];

function cleanText(value, field, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} 不能为空。`);
  if (text.length > max) throw new Error(`${field} 不能超过 ${max} 个字符。`);
  return text;
}

function normalizeMemberInput(input) {
  const allowedKinds = new Set(['pilotdeck_local', 'pilotdeck_remote', 'staffdeck', 'staffdeck_mock']);
  if (!allowedKinds.has(input?.kind)) throw new Error('不支持的智能体类型。');
  const id = cleanText(input.id || input.employeeId || `member-${crypto.randomUUID()}`, '成员 ID', 100)
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  if (id === 'main') throw new Error('main 是主智能体的保留 ID。');
  const config = input.config && typeof input.config === 'object' ? { ...input.config } : {};
  if (input.kind === 'staffdeck' || input.kind === 'staffdeck_mock') {
    config.employeeId = cleanText(input.employeeId || config.employeeId || id, '员工 ID', 200);
  }
  if (input.kind === 'pilotdeck_remote') {
    config.endpoint = normalizeRemoteEndpoint(input.endpoint || config.endpoint);
    if (input.tokenEnv || config.tokenEnv) {
      const tokenEnv = cleanText(input.tokenEnv || config.tokenEnv, '令牌环境变量', 100);
      if (!/^PILOTDECK_GROUP_[A-Z0-9_]+$/.test(tokenEnv)) {
        throw new Error('远程令牌变量必须以 PILOTDECK_GROUP_ 开头。');
      }
      config.tokenEnv = tokenEnv;
    }
  }
  return {
    id,
    kind: input.kind,
    name: cleanText(input.name, '成员名称', 100),
    role: typeof input.role === 'string' ? input.role.trim().slice(0, 160) : '',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '',
    config,
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
  const baseUrl = process.env.STAFFDECK_BASE_URL?.trim().replace(/\/$/, '');
  const tenantId = process.env.STAFFDECK_TENANT_ID?.trim();
  if (!baseUrl || !tenantId) return [];
  const url = new URL('/api/chat/agents', `${baseUrl}/`);
  url.searchParams.set('tenant_id', tenantId);
  const token = process.env.STAFFDECK_API_TOKEN?.trim();
  const payload = await fetchJson(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((employee) => {
    const id = typeof employee?.id === 'string' ? employee.id.trim() : '';
    const name = typeof employee?.name === 'string' ? employee.name.trim() : '';
    if (!id || !name) return [];
    return [{
      id,
      kind: 'staffdeck',
      name,
      role: 'StaffDeck 数字员工',
      description: typeof employee.description === 'string' ? employee.description : '',
      employeeId: id,
    }];
  });
}

function formatTranscript(messages) {
  return messages
    .filter((message) =>
      (message.status === 'completed' && message.content) || message.status === 'failed')
    .slice(-30)
    .map((message) => message.status === 'failed'
      ? `[${message.senderName}]（回复失败：${message.error || '未知错误'}）`
      : `[${message.senderName}] ${message.content}`)
    .join('\n\n');
}

function buildMemberContext(room, member, transcript, isMain) {
  return [
    `你正在群组“${room.title}”中以“${member.name}”身份发言。`,
    member.role ? `你的角色：${member.role}。` : '',
    member.description ? `职责说明：${member.description}` : '',
    `群组绑定工作空间：${room.projectName}。`,
    isMain
      ? '你是群组主智能体。其他成员已经依次发言；请结合他们的观点给用户一个清晰的综合结论，指出共识、分歧和下一步。'
      : '请从自己的专业角度直接回应用户。不要冒充其他成员，也不要描述内部调度或适配器机制。',
    '以下是群组最近的公开发言，供你理解上下文：',
    transcript || '（暂无历史发言）',
  ].filter(Boolean).join('\n');
}

async function invokeLocalPilotDeck(room, member, userMessage, transcript) {
  const gateway = await getPilotDeckGateway();
  const runId = crypto.randomUUID();
  const sessionKey = `group:${room.id}:${member.id}`;
  const groupProjectKey = path.join(resolvePilotHome(process.env), 'group-runtime');
  let output = '';
  let failure = null;
  for await (const event of gateway.submitTurn({
    sessionKey,
    channelKey: 'group',
    projectKey: groupProjectKey,
    workspaceCwd: room.projectPath,
    message: userMessage,
    runMode: 'ask',
    mode: 'default',
    canPrompt: false,
    timeoutMs: MEMBER_TIMEOUT_MS,
    runId,
    syntheticMessages: [{
      purpose: 'group_chat_context',
      text: buildMemberContext(room, member, transcript, member.id === 'main'),
    }],
    telemetry: {
      ownerModule: 'session',
      executionKind: 'user_session',
      phase: 'group_chat',
    },
  })) {
    if (event.type === 'assistant_text_delta') output += event.text || '';
    if (event.type === 'error') failure = event.message || event.code || 'PilotDeck 调用失败';
  }
  if (failure) throw new Error(failure);
  if (!output.trim()) throw new Error('智能体没有返回可显示的内容。');
  return output.trim();
}

async function invokeRemotePilotDeck(room, member, userMessage, transcript) {
  const endpoint = member.config?.endpoint;
  if (!endpoint) throw new Error('远程 PilotDeck 成员缺少 endpoint。');
  const token = member.config?.tokenEnv ? process.env[member.config.tokenEnv] : undefined;
  const target = endpoint.endsWith('/v1/chat/completions')
    ? endpoint
    : `${endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const payload = await fetchJson(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hermes-Session-Id': encodeURIComponent(`group:${room.id}:${member.id}`).slice(0, 240),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: 'pilotdeck-gateway',
      stream: false,
      messages: [{
        role: 'user',
        content: `${buildMemberContext(room, member, transcript, false)}\n\n当前用户消息：\n${userMessage}`,
      }],
    }),
  }, MEMBER_TIMEOUT_MS);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('远程 PilotDeck 返回了空内容。');
  return content.trim();
}

async function invokeStaffDeck(room, member, userMessage, transcript, userId) {
  if (member.kind === 'staffdeck_mock') {
    return invokeLocalPilotDeck(room, member, userMessage, transcript);
  }
  const baseUrl = process.env.STAFFDECK_BASE_URL?.trim().replace(/\/$/, '');
  const tenantId = process.env.STAFFDECK_TENANT_ID?.trim();
  if (!baseUrl || !tenantId) throw new Error('StaffDeck 尚未配置。');
  const token = process.env.STAFFDECK_API_TOKEN?.trim();
  const payload = await fetchJson(new URL('/api/chat/turn', `${baseUrl}/`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      agent_id: member.config?.employeeId || member.id,
      ...(member.config?.staffdeckSessionId ? { session_id: member.config.staffdeckSessionId } : {}),
      channel: 'pilotdeck_group_chat',
      message: `${buildMemberContext(room, member, transcript, false)}\n\n当前用户消息：\n${userMessage}`,
    }),
  }, MEMBER_TIMEOUT_MS);
  if (typeof payload?.session_id === 'string' && payload.session_id.trim()) {
    groupChatDb.updateMemberConfig(userId, room.id, member.id, {
      ...member.config,
      staffdeckSessionId: payload.session_id.trim(),
    });
  }
  if (typeof payload?.reply !== 'string' || !payload.reply.trim()) throw new Error('StaffDeck 员工返回了空内容。');
  return payload.reply.trim();
}

async function invokeMember(room, member, userMessage, transcript, userId) {
  if (member.kind === 'pilotdeck_remote') {
    return invokeRemotePilotDeck(room, member, userMessage, transcript);
  }
  if (member.kind === 'staffdeck' || member.kind === 'staffdeck_mock') {
    return invokeStaffDeck(room, member, userMessage, transcript, userId);
  }
  return invokeLocalPilotDeck(room, member, userMessage, transcript);
}

function resolveTargets(room, mentionedMemberIds, mentionAll) {
  const active = room.members.filter((member) => member.isActive !== false);
  const secondary = active.filter((member) => member.id !== 'main');
  const main = active.find((member) => member.id === 'main');
  if (mentionAll) {
    return [...secondary, ...(main ? [main] : [])];
  }
  const mentions = new Set(mentionedMemberIds || []);
  if (mentions.size > 0) {
    return [
      ...secondary.filter((member) => mentions.has(member.id)),
      ...(main && mentions.has('main') ? [main] : []),
    ];
  }
  return room.triggerMode === 'auto'
    ? [...secondary, ...(main ? [main] : [])]
    : [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMentions(room, content) {
  const mentionAll = /(?:^|[^a-zA-Z0-9_@])@(所有人|all)(?=\s|$|[,.!?;:，。！？；：、])/iu.test(content);
  const mentionedMemberIds = room.members
    .filter((member) => new RegExp(
      `(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(member.id)}(?=\\s|$|[,.!?;:，。！？；：、])`,
      'iu',
    ).test(content))
    .map((member) => member.id);
  return { mentionAll, mentionedMemberIds };
}

async function dispatchRound(userId, roomId, roundId, userMessage, targets) {
  activeRooms.add(roomId);
  try {
    for (const target of targets) {
      const room = groupChatDb.getRoom(userId, roomId);
      if (!room || room.status !== 'active') break;
      const placeholder = groupChatDb.createMessage(userId, roomId, {
        roundId,
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: '',
        status: 'thinking',
      });
      try {
        const messages = groupChatDb.listMessages(userId, roomId, 100) || [];
        const transcript = formatTranscript(messages.filter((message) => message.id !== placeholder.id));
        const content = await invokeMember(room, target, userMessage, transcript, userId);
        groupChatDb.updateMessage(placeholder.id, { content, status: 'completed', error: null });
      } catch (error) {
        groupChatDb.updateMessage(placeholder.id, {
          content: '',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const finalRoom = groupChatDb.getRoom(userId, roomId);
    if (finalRoom && !finalRoom.muted) {
      notifyUserIfEnabled({
        userId,
        event: createNotificationEvent({
          provider: 'pilotdeck',
          kind: 'info',
          code: 'agent.notification',
          meta: {
            message: `群组“${finalRoom.title}”已完成本轮回复`,
            groupId: roomId,
            groupName: finalRoom.title,
          },
          dedupeKey: `group:${roomId}:round:${roundId}`,
        }),
      });
    }
  } finally {
    activeRooms.delete(roomId);
  }
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
      local: LOCAL_TEMPLATES,
      staffdeck,
      mocks: MOCK_EMPLOYEES,
      staffdeckConfigured: Boolean(process.env.STAFFDECK_BASE_URL && process.env.STAFFDECK_TENANT_ID),
      staffdeckError,
    };
  },

  addMember(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room) return null;
    if (room.members.length >= MAX_MEMBERS + 1) throw new Error(`每个群组最多邀请 ${MAX_MEMBERS} 个成员。`);
    const member = normalizeMemberInput(input);
    if (room.members.some((existing) => existing.id === member.id)) throw new Error('该成员已经在群组中。');
    return groupChatDb.addMember(userId, roomId, member);
  },

  sendMessage(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') return null;
    if (activeRooms.has(roomId)) throw new Error('当前群组仍在处理上一轮消息，请等待回复完成。');
    const content = cleanText(input.content, '消息', MAX_MESSAGE_CHARS);
    // Mentions are derived from the saved text so callers cannot trigger an
    // unmentioned member by sending a forged `mentionedMemberIds` payload.
    const { mentionedMemberIds, mentionAll } = extractMentions(room, content);
    const roundId = `round_${crypto.randomUUID()}`;
    const message = groupChatDb.createMessage(userId, roomId, {
      roundId,
      senderType: 'user',
      senderName: '你',
      content,
      status: 'completed',
    });
    const targets = resolveTargets(room, mentionedMemberIds, mentionAll);
    if (targets.length === 0) {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        senderType: 'system',
        senderName: '系统',
        content: '当前已开启“仅 @ 触发”。本条消息已保存，但没有调用任何智能体。',
        status: 'completed',
      });
    } else {
      void dispatchRound(userId, roomId, roundId, content, targets);
    }
    return { message, roundId, targetMemberIds: targets.map((member) => member.id) };
  },
};
