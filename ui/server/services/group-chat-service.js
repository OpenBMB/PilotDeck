import crypto from 'node:crypto';
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
const MAX_MEMBERS = 8;
const configuredMemberTimeout = Number(process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS);
const MEMBER_TIMEOUT_MS = Number.isFinite(configuredMemberTimeout) && configuredMemberTimeout >= 100
  ? configuredMemberTimeout
  : 5 * 60_000;
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
const dispatchingRooms = new Set();
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

function cleanText(value, field, max = 200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} 不能为空。`);
  if (text.length > max) throw new Error(`${field} 不能超过 ${max} 个字符。`);
  return text;
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
    permissionRules: { deny: GROUP_READ_ONLY_DENY_RULES },
    timeoutMs: MEMBER_TIMEOUT_MS,
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

async function invokeRemoteGroupTurn(room, member, userMessage, transcript, userId, options = {}) {
  if (!member.instanceId) {
    throw new Error('远程 PilotDeck 必须引用经过管理员批准的实例。');
  }
  const { instance, binding, token } = await assertApprovedRemoteInstance(member.instanceId, room.projectPath);
  const controller = new AbortController();
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
        roundId: options.roundId,
        entryMemberId: member.id,
        workspaceKey: binding.workspace_key,
        message: userMessage,
        rosterContext: buildMemberContext(room, member, transcript, true, options.requiredDelegateIds || []),
        requiredDelegates: options.requiredDelegateIds || [],
        collaboration: options.collaboration || { canDelegate: false },
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new Error(controller.signal.aborted
      ? '远程 PilotDeck group-turn 调用超时。'
      : (error instanceof Error ? error.message : String(error)));
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    clearTimeout(timeout);
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
  return staffDeckClient.invoke({
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
      senderId: 'main',
      senderName: 'PilotDeck 主智能体',
      senderKind: 'pilotdeck_main',
      content: userMessage,
      createdAt: now,
    },
    transcript,
  }, prompt, connection);
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
    const result = await invokeMember(room, target, userMessage, transcript, userId, {
      roundId,
      requiredDelegateIds: [],
      collaboration: { canDelegate: false },
    });
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
    entryMemberId: entryMember.id,
    requiredDelegateIds: [...requiredDelegateIds],
    attemptedDelegateIds: new Set(),
    delegationCallCounts: new Map(),
    delegationSequence: [],
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
    turnId: roundId,
    entryMemberId: entryMember.id,
    canDelegate: true,
    coordinatorUrl: (process.env.PILOTDECK_PUBLIC_URL || process.env.PILOTDECK_GROUP_API_URL || `http://127.0.0.1:${process.env.SERVER_PORT || '3001'}`).replace(/\/$/u, ''),
    delegationToken: grant.token,
  };
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

async function dispatchMentionRound(userId, roomId, roundId, userMessage, targets) {
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
  }
}

async function dispatchSmartRound(userId, roomId, roundId, userMessage, entryMember, requiredDelegateIds) {
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
  }
}

async function executeQueuedTurn(turn) {
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
  if (turn.triggerSource === 'mentions') {
    const targetsById = new Map(room.members.map((member) => [member.id, member]));
    const targets = targetIds.flatMap((id) => targetsById.get(id) || []);
    await dispatchMentionRound(turn.senderUserId, turn.roomId, turn.id, message.content, targets);
    return;
  }
  const entryMember = room.members.find((member) => member.id === turn.entryMemberId && member.isActive !== false);
  if (!entryMember) {
    groupChatDb.updateTurn(turn.id, { status: 'failed', error: '入口 PilotDeck 实例不可用。' });
    return;
  }
  await dispatchSmartRound(turn.senderUserId, turn.roomId, turn.id, message.content, entryMember, targetIds);
}

function scheduleRoom(roomId) {
  if (dispatchingRooms.has(roomId)) return;
  dispatchingRooms.add(roomId);
  queueMicrotask(async () => {
    try {
      while (true) {
        const queued = groupChatDb.getNextQueuedTurn(roomId);
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
      dispatchingRooms.delete(roomId);
      if (groupChatDb.getNextQueuedTurn(roomId)) scheduleRoom(roomId);
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
      const messages = groupChatDb.listMessages(userId, roomId, 100) || [];
      const transcript = formatTranscript(messages.filter((candidate) => candidate.id !== placeholder.id));
      const result = await invokeMember(room, member, message, transcript, userId, {
        roundId,
        requiredDelegateIds: [],
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
    const content = cleanText(input.content, '消息', MAX_MESSAGE_CHARS);
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
      ? `${userId}:${input.clientMessageId.trim().slice(0, 140)}`
      : null;
    const turn = groupChatDb.createTurn(userId, roomId, {
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
      if (turn.status === 'queued') scheduleRoom(roomId);
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
      roundId,
      kind: 'chat',
      senderType: 'user',
      senderUserId: userId,
      senderName: participant.displayName || '你',
      content,
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
      scheduleRoom(roomId);
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
    for (const roomId of groupChatDb.listPendingRoomIds()) scheduleRoom(roomId);
  },
};
