import crypto from 'node:crypto';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { createNotificationEvent, notifyUserIfEnabled } from './notification-orchestrator.js';
import { groupChatDb } from './group-chat-db.js';

const MAX_MESSAGE_CHARS = 20_000;
const MAX_MEMBERS = 8;
const MEMBER_TIMEOUT_MS = 5 * 60_000;
const MAX_REQUIRED_DELEGATE_RETRIES = 1;
const GROUP_MEMBER_DELEGATE_TOOL = 'group_member_delegate';
const activeRooms = new Set();
const activeMainTurns = new Map();

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

for (const employee of MOCK_EMPLOYEES) employee.category = memberCategory(employee.kind);

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

for (const template of LOCAL_TEMPLATES) template.category = memberCategory(template.kind);

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
      category: 'employee',
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
    .map((candidate) => `- ${candidate.name}: id=${candidate.id}, 类型=${categoryLabel(candidate.kind)}, 角色=${candidate.role || '未设置'}`)
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
          '如果其他成员已经在本轮发言，请结合他们的观点给用户清晰的综合结论；不要重复调用已经给出本轮回复的成员。',
        ].join('\n')
      : '请从自己的专业角度直接回应用户。不要冒充其他成员，也不要描述内部调度或适配器机制。',
    '以下是群组最近的公开发言，供你理解上下文：',
    transcript || '（暂无历史发言）',
  ].filter(Boolean).join('\n');
}

function boundedPreview(value, max = 4_000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

async function invokeLocalPilotDeck(room, member, userMessage, transcript, userId, options = {}) {
  const gateway = await getPilotDeckGateway();
  const runId = crypto.randomUUID();
  const sessionKey = `group:${room.id}:${member.id}`;
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
    runMode: 'ask',
    mode: 'default',
    canPrompt: false,
    timeoutMs: MEMBER_TIMEOUT_MS,
    runId,
    syntheticMessages: [{
      purpose: 'group_chat_context',
      text: buildMemberContext(
        room,
        member,
        transcript,
        member.id === 'main',
        options.requiredDelegateIds || [],
      ),
    }],
    telemetry: {
      ownerModule: 'session',
      executionKind: 'user_session',
      phase: 'group_chat',
    },
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
      if (event.type === 'error') failure = event.message || event.code || 'PilotDeck 调用失败';
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (reasoningMessage) {
      groupChatDb.updateMessage(reasoningMessage.id, {
        content: reasoning || (failure ? '本轮分析失败。' : '已完成本轮分析。'),
        metadata: { activityType: 'reasoning', state: failure ? 'failed' : 'completed' },
        status: failure ? 'failed' : 'completed',
        error: failure,
      });
    }
    if (failure) {
      for (const [toolCallId, activityId] of toolMessages) {
        groupChatDb.updateMessage(activityId, {
          metadata: { activityType: 'tool', state: 'failed', toolCallId },
          status: 'failed',
          error: failure,
        });
      }
    }
  }
  if (failure) throw new Error(failure);
  return { content: output.trim(), sawDelegation };
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

async function invokeMember(room, member, userMessage, transcript, userId, options = {}) {
  if (member.kind === 'pilotdeck_remote') {
    return { content: await invokeRemotePilotDeck(room, member, userMessage, transcript), sawDelegation: false };
  }
  if (member.kind === 'staffdeck' || member.kind === 'staffdeck_mock') {
    if (member.kind === 'staffdeck_mock') {
      return invokeLocalPilotDeck(room, member, userMessage, transcript, userId, options);
    }
    return { content: await invokeStaffDeck(room, member, userMessage, transcript, userId), sawDelegation: false };
  }
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
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const hintedVisible = hintedOrder.filter((id) => visibleIds.has(id));
  const hintedVisibleSet = new Set(hintedVisible);
  const mentionedMemberIds = [
    ...hintedVisible,
    ...visible
      .filter((entry) => !hintedVisibleSet.has(entry.id))
      .sort((left, right) => left.position - right.position)
      .map((entry) => entry.id),
  ];
  return { mentionAll, mentionedMemberIds };
}

function notifyRoundCompleted(userId, roomId, roundId) {
  const room = groupChatDb.getRoom(userId, roomId);
  if (!room || room.muted) return;
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider: 'pilotdeck',
      kind: 'info',
      code: 'agent.notification',
      meta: {
        message: `群组“${room.title}”已完成本轮回复`,
        groupId: roomId,
        groupName: room.title,
      },
      dedupeKey: `group:${roomId}:round:${roundId}`,
    }),
  });
}

async function runDirectMember(userId, roomId, roundId, userMessage, target) {
  const room = groupChatDb.getRoom(userId, roomId);
  if (!room || room.status !== 'active') return;
  if (target.id === 'main') {
    try {
      await runEntryAgent(userId, room, roundId, userMessage, target, []);
    } catch (error) {
      groupChatDb.createMessage(userId, roomId, {
        roundId,
        kind: 'chat',
        senderType: 'agent',
        senderMemberId: target.id,
        senderName: target.name,
        content: '',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const placeholder = groupChatDb.createMessage(userId, roomId, {
    roundId,
    kind: 'chat',
    senderType: 'agent',
    senderMemberId: target.id,
    senderName: target.name,
    content: '',
    status: 'thinking',
  });
  try {
    const messages = groupChatDb.listMessages(userId, roomId, 100) || [];
    const transcript = formatTranscript(messages.filter((message) => message.id !== placeholder.id));
    const result = await invokeMember(room, target, userMessage, transcript, userId);
    if (!result.content) throw new Error('智能体没有返回可显示的内容。');
    groupChatDb.updateMessage(placeholder.id, {
      content: result.content,
      status: 'completed',
      error: null,
    });
  } catch (error) {
    groupChatDb.updateMessage(placeholder.id, {
      content: '',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runEntryAgent(userId, room, roundId, userMessage, entryMember, requiredDelegateIds) {
  const sessionId = `group:${room.id}:${entryMember.id}`;
  const turnContext = {
    userId,
    roomId: room.id,
    roundId,
    sessionId,
    requiredDelegateIds: [...requiredDelegateIds],
    attemptedDelegateIds: new Set(),
  };
  activeMainTurns.set(sessionId, turnContext);
  let result = { content: '', sawDelegation: false };
  try {
    for (let attempt = 0; attempt <= MAX_REQUIRED_DELEGATE_RETRIES; attempt += 1) {
      const currentRoom = groupChatDb.getRoom(userId, room.id);
      if (!currentRoom || currentRoom.status !== 'active') throw new Error('群组已经归档。');
      const missing = requiredDelegateIds.filter((id) => !turnContext.attemptedDelegateIds.has(id));
      if (attempt > 0 && missing.length === 0) break;
      const messages = groupChatDb.listMessages(userId, room.id, 100) || [];
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
        persistActivity: true,
        requiredDelegateIds: missing,
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
  }
}

async function dispatchMentionRound(userId, roomId, roundId, userMessage, targets) {
  activeRooms.add(roomId);
  groupChatDb.updateTurn(roundId, { status: 'running', error: null });
  try {
    for (const target of targets) {
      await runDirectMember(userId, roomId, roundId, userMessage, target);
    }
    groupChatDb.updateTurn(roundId, { status: 'completed', error: null });
    notifyRoundCompleted(userId, roomId, roundId);
  } catch (error) {
    groupChatDb.updateTurn(roundId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeRooms.delete(roomId);
  }
}

async function dispatchSmartRound(userId, roomId, roundId, userMessage, entryMember, requiredDelegateIds) {
  activeRooms.add(roomId);
  groupChatDb.updateTurn(roundId, { status: 'running', error: null });
  try {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') throw new Error('群组已经归档。');
    await runEntryAgent(userId, room, roundId, userMessage, entryMember, requiredDelegateIds);
    groupChatDb.updateTurn(roundId, { status: 'completed', error: null });
    notifyRoundCompleted(userId, roomId, roundId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    groupChatDb.createMessage(userId, roomId, {
      roundId,
      kind: 'chat',
      senderType: 'agent',
      senderMemberId: entryMember.id,
      senderName: entryMember.name,
      content: '',
      status: 'failed',
      error: message,
    });
    groupChatDb.updateTurn(roundId, { status: 'failed', error: message });
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

  async delegateMember(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') return null;
    const expectedSessionId = `group:${roomId}:main`;
    if (input.sourceSessionId !== expectedSessionId) {
      throw new Error('只有当前群组的主智能体可以委派成员。');
    }
    const activeTurn = activeMainTurns.get(expectedSessionId);
    if (!activeTurn || activeTurn.userId !== userId || activeTurn.roomId !== roomId) {
      throw new Error('当前群组没有可接受委派的主智能体轮次。');
    }
    const memberId = cleanText(input.memberId, '成员 ID', 100);
    if (memberId === 'main') throw new Error('主智能体不能委派给自己。');
    const member = room.members.find((candidate) => candidate.id === memberId && candidate.isActive !== false);
    if (!member) throw new Error('要调用的群成员不存在或已被移除。');
    const message = cleanText(input.message, '委派消息', MAX_MESSAGE_CHARS);
    const sourceTurnId = typeof input.sourceTurnId === 'string'
      ? input.sourceTurnId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
      : '';
    const roundId = activeTurn.roundId;
    activeTurn.attemptedDelegateIds.add(memberId);
    const main = room.members.find((candidate) => candidate.id === 'main');
    const delegation = groupChatDb.createMessage(userId, roomId, {
      roundId,
      kind: 'delegation',
      senderType: 'agent',
      senderMemberId: 'main',
      senderName: main?.name || 'PilotDeck 主智能体',
      content: message,
      metadata: {
        state: 'waiting',
        targetMemberId: member.id,
        targetMemberName: member.name,
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
      const messages = groupChatDb.listMessages(userId, roomId, 100) || [];
      const transcript = formatTranscript(messages.filter((candidate) => candidate.id !== placeholder.id));
      const result = await invokeMember(room, member, message, transcript, userId);
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
        status: 'failed',
        error: errorMessage,
      });
      groupChatDb.updateMessage(delegation.id, {
        metadata: { ...delegation.metadata, state: 'failed' },
        status: 'failed',
        error: errorMessage,
      });
      throw error;
    }
  },

  sendMessage(userId, roomId, input) {
    const room = groupChatDb.getRoom(userId, roomId);
    if (!room || room.status !== 'active') return null;
    if (activeRooms.has(roomId)) throw new Error('当前群组仍在处理上一轮消息，请等待回复完成。');
    const content = cleanText(input.content, '消息', MAX_MESSAGE_CHARS);
    // Mentions are derived from the saved text so callers cannot trigger an
    // unmentioned member by sending a forged `mentionedMemberIds` payload.
    const { mentionedMemberIds, mentionAll } = extractMentions(room, content, input.mentionedMemberIds);
    const participant = groupChatDb.getParticipant(userId, roomId);
    if (!participant) throw new Error('当前用户不是该群组的有效参与者。');
    const entryMember = resolveEntryMember(room, participant);
    if (!entryMember) throw new Error('群组没有可用的入口 PilotDeck 实例。');
    const directTargets = resolveMentionTargets(room, mentionedMemberIds, mentionAll);
    const turn = groupChatDb.createTurn(userId, roomId, {
      entryMemberId: room.triggerMode === 'auto' ? entryMember.id : (directTargets[0]?.id || entryMember.id),
      triggerSource: room.triggerMode,
      status: 'queued',
    });
    if (!turn) throw new Error('无法创建群组轮次。');
    const roundId = turn.id;
    const message = groupChatDb.createMessage(userId, roomId, {
      roundId,
      kind: 'chat',
      senderType: 'user',
      senderUserId: userId,
      senderName: '你',
      content,
      status: 'completed',
    });
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
    } else if (room.triggerMode === 'mentions') {
      void dispatchMentionRound(userId, roomId, roundId, content, directTargets);
    } else {
      const requiredDelegateIds = mentionAll
        ? room.members.filter((member) => member.id !== 'main' && member.isActive !== false).map((member) => member.id)
        : mentionedMemberIds.filter((id) => id !== entryMember.id);
      void dispatchSmartRound(userId, roomId, roundId, content, entryMember, requiredDelegateIds);
    }
    return {
      message,
      roundId,
      entryMemberId: entryMember.id,
      targetMemberIds: room.triggerMode === 'auto'
        ? [entryMember.id]
        : directTargets.map((member) => member.id),
      requiredDelegateIds: room.triggerMode === 'auto'
        ? (mentionAll
            ? room.members.filter((member) => member.id !== 'main' && member.isActive !== false).map((member) => member.id)
            : mentionedMemberIds.filter((id) => id !== entryMember.id))
        : [],
    };
  },
};
