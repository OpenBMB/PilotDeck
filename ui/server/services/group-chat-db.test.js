import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const tempDirs = [];
let openDb = null;

afterEach(() => {
  try {
    openDb?.close();
  } catch {
    // Already closed.
  }
  openDb = null;
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.DATABASE_PATH;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-groups-'));
  tempDirs.push(dir);
  process.env.DATABASE_PATH = join(dir, 'groups.db');
  vi.resetModules();
  const database = await import('../database/db.js');
  openDb = database.db;
  await database.initializeDatabase();
  const user = database.userDb.createUser('group-test', 'not-a-real-password-hash');
  const { groupChatDb } = await import('./group-chat-db.js');
  return { user, groupChatDb };
}

describe('group chat persistence', () => {
  it('persists room settings, member order, messages, and mute-aware unread state', async () => {
    const { user, groupChatDb } = await setup();
    const room = groupChatDb.createRoom(user.id, {
      title: 'Architecture group',
      projectName: 'pilotdeck',
      projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto',
      muted: false,
    });

    expect(room.members.map((member) => member.id)).toEqual(['main']);
    expect(room.members[0].category).toBe('pilotdeck_instance');
    expect(groupChatDb.getRoomOwnerId(room.id)).toBe(user.id);
    expect(groupChatDb.getParticipant(user.id, room.id)).toMatchObject({
      userId: user.id,
      boundMemberId: 'main',
      role: 'owner',
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'Engineer', config: {},
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'staffdeck_mock', name: 'Reviewer', config: { employeeId: 'mock-reviewer' },
    });
    groupChatDb.reorderMembers(user.id, room.id, ['reviewer', 'engineer']);

    expect(groupChatDb.getRoom(user.id, room.id).members.map((member) => member.id))
      .toEqual(['reviewer', 'engineer', 'main']);

    groupChatDb.createMessage(user.id, room.id, {
      senderType: 'agent', senderMemberId: 'reviewer', senderName: 'Reviewer', content: 'Looks good.',
    });
    expect(groupChatDb.listRooms(user.id)[0].unreadCount).toBe(1);

    groupChatDb.updateRoom(user.id, room.id, { muted: true });
    const muted = groupChatDb.listRooms(user.id)[0];
    expect(muted.unreadCount).toBe(0);
    expect(muted.hasSilentUnread).toBe(true);

    groupChatDb.markRead(user.id, room.id);
    expect(groupChatDb.listRooms(user.id)[0].hasSilentUnread).toBe(false);
  });

  it('upgrades first-generation group messages without losing history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-groups-legacy-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'legacy.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        created_at DATETIME, last_login DATETIME, is_active BOOLEAN DEFAULT 1,
        git_name TEXT, git_email TEXT, has_completed_onboarding BOOLEAN DEFAULT 0
      );
      INSERT INTO users (id, username, password_hash, is_active) VALUES (1, 'legacy-user', 'hash', 1);
      CREATE TABLE group_rooms (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
        project_name TEXT NOT NULL, project_path TEXT NOT NULL,
        trigger_mode TEXT NOT NULL DEFAULT 'auto', muted BOOLEAN NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );
      INSERT INTO group_rooms VALUES (
        'legacy-room', 1, 'Legacy', 'general', '/workspace/general',
        'auto', 0, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE group_messages (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, round_id TEXT,
        sender_type TEXT NOT NULL, sender_member_id TEXT, sender_name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'completed', error TEXT,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
      );
      INSERT INTO group_messages VALUES (
        'legacy-message', 'legacy-room', 'legacy-round', 'user', NULL, '你',
        '保留这条消息', 'completed', NULL,
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );
    `);
    legacy.close();

    process.env.DATABASE_PATH = databasePath;
    vi.resetModules();
    const database = await import('../database/db.js');
    openDb = database.db;
    await database.initializeDatabase();
    const { groupChatDb } = await import('./group-chat-db.js');

    expect(database.db.prepare('PRAGMA table_info(group_messages)').all().map((column) => column.name))
      .toEqual(expect.arrayContaining(['sequence', 'message_kind', 'sender_user_id', 'reply_to_message_id', 'metadata_json']));
    expect(groupChatDb.getParticipant(1, 'legacy-room')).toMatchObject({ boundMemberId: 'main', role: 'owner' });
    expect(groupChatDb.listMessages(1, 'legacy-room', 10)[0]).toMatchObject({
      id: 'legacy-message', sequence: 1, kind: 'chat', content: '保留这条消息',
    });
  });
});

describe('group chat dispatch semantics', () => {
  it('saves unmentioned manual-mode messages without invoking a member', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: 'unexpected' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Manual group', projectName: 'general', projectPath: '/workspace/general',
      triggerMode: 'mentions', muted: false,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'Engineer', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: 'Just recording this.',
      mentionedMemberIds: ['engineer'],
    });
    const messages = groupChatDb.listMessages(user.id, room.id, 20);

    expect(result.targetMemberIds).toEqual([]);
    expect(gatewayCalls).toHaveLength(0);
    expect(messages.map((message) => message.senderType)).toEqual(['user', 'system']);
  });

  it('recognizes @所有人 from message text and still places the main agent last', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: `reply:${input.sessionKey}` };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Mention all group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'mentions', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'Engineer', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, { content: '@所有人 review this.' });
    expect(result.targetMemberIds).toEqual(['engineer', 'main']);

    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([
      `group:${room.id}:engineer`,
      `group:${room.id}:main`,
    ]);
  });

  it('routes automatic messages only to the sender-bound main agent', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: `reply:${input.sessionKey}` };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Auto group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'Engineer', config: {},
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'staffdeck_mock', name: 'Reviewer', config: { employeeId: 'mock-reviewer' },
    });

    const result = groupChatService.sendMessage(user.id, room.id, { content: 'Review the design.' });
    expect(result.targetMemberIds).toEqual(['main']);
    expect(result.entryMemberId).toBe('main');

    await vi.waitFor(() => {
      expect(groupChatDb.listMessages(user.id, room.id, 20).filter((message) =>
        message.kind === 'chat' && message.senderType === 'agent'))
        .toHaveLength(1);
      expect(groupChatDb.listMessages(user.id, room.id, 20).some((message) => message.status === 'thinking'))
        .toBe(false);
    });

    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([`group:${room.id}:main`]);
    expect(gatewayCalls.every((call) => call.workspaceCwd === '/workspace/PilotDeck')).toBe(true);
    expect(gatewayCalls.every((call) => call.projectKey === '/workspace/PilotDeck')).toBe(true);
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('主智能体');
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('group_member_delegate');
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('id=reviewer');
  });

  it('turns automatic-mode mentions into ordered required delegations through the main agent', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    let delegateMember;
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          if (input.sessionKey.endsWith(':main')) {
            for (const memberId of ['reviewer', 'engineer']) {
              yield { type: 'tool_call_started', toolCallId: `call-${memberId}`, name: 'group_member_delegate', argsPreview: '{}' };
              await delegateMember(user.id, room.id, {
                sourceSessionId: `group:${room.id}:main`,
                sourceTurnId: 'turn-main',
                memberId,
                message: `请 ${memberId} 回答`,
              });
              yield { type: 'tool_call_finished', toolCallId: `call-${memberId}`, toolName: 'group_member_delegate', ok: true, resultPreview: 'ok' };
            }
            yield { type: 'assistant_text_delta', text: '主智能体综合结论' };
          } else {
            yield { type: 'assistant_text_delta', text: `reply:${input.sessionKey}` };
          }
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    delegateMember = groupChatService.delegateMember.bind(groupChatService);
    const room = groupChatDb.createRoom(user.id, {
      title: 'Mention override group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'Engineer', config: {},
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'staffdeck_mock', name: 'Reviewer', config: { employeeId: 'mock-reviewer' },
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'researcher', kind: 'staffdeck_mock', name: 'Researcher', config: { employeeId: 'mock-researcher' },
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: '请@reviewer，和 @engineer 回答。',
    });

    expect(result.targetMemberIds).toEqual(['main']);
    expect(result.requiredDelegateIds).toEqual(['reviewer', 'engineer']);
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(3));
    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([
      `group:${room.id}:main`,
      `group:${room.id}:reviewer`,
      `group:${room.id}:engineer`,
    ]);
    await vi.waitFor(() => {
      const timeline = groupChatDb.listMessages(user.id, room.id, 30);
      expect(timeline.filter((message) => message.kind === 'delegation').map((message) => message.metadata.targetMemberId))
        .toEqual(['reviewer', 'engineer']);
      expect(timeline.at(-1).content).toBe('主智能体综合结论');
    });
  });

  it('accepts display-name mentions while validating structured member ids', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: `reply:${input.sessionKey}` };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Named mentions', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'mentions', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'PilotDeck 工程师', config: {},
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'pilotdeck_local', name: 'PilotDeck 评审员', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: '@PilotDeck 评审员，请介绍你的职责。',
      mentionedMemberIds: ['reviewer', 'engineer'],
    });

    expect(result.targetMemberIds).toEqual(['reviewer']);
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(1));
    expect(gatewayCalls[0].sessionKey).toBe(`group:${room.id}:reviewer`);
  });

  it('rejects delegation calls that are not attached to an active main-agent turn', async () => {
    const { user, groupChatDb } = await setup();
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Delegation group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'mentions', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'pilotdeck_local', name: 'PilotDeck 评审员', config: {},
    });

    await expect(groupChatService.delegateMember(user.id, room.id, {
      sourceSessionId: `group:${room.id}:main`, sourceTurnId: 'forged-turn',
      memberId: 'reviewer', message: '请介绍你的职责。',
    })).rejects.toThrow('没有可接受委派');
    expect(groupChatDb.listMessages(user.id, room.id, 20)).toHaveLength(0);
  });

  it('shows natural-language agentic delegation and keeps an empty post-tool answer out of the timeline', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    let delegateMember;
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          if (input.sessionKey.endsWith(':main')) {
            yield { type: 'assistant_thinking_delta', text: '这需要评审员本人提供信息。' };
            yield { type: 'tool_call_started', toolCallId: 'delegate-reviewer', name: 'group_member_delegate', argsPreview: '{}' };
            await delegateMember(user.id, room.id, {
              sourceSessionId: `group:${room.id}:main`, sourceTurnId: 'turn-natural',
              memberId: 'reviewer', message: '请介绍你的职责。',
            });
            yield { type: 'tool_call_finished', toolCallId: 'delegate-reviewer', toolName: 'group_member_delegate', ok: true, resultPreview: 'ok' };
          } else {
            yield { type: 'assistant_text_delta', text: '我是评审员，负责独立验收。' };
          }
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    delegateMember = groupChatService.delegateMember.bind(groupChatService);
    const room = groupChatDb.createRoom(user.id, {
      title: 'Agentic group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'pilotdeck_local', name: 'PilotDeck 评审员', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, { content: '帮我问问评审员他的职责。' });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, result.roundId).status).toBe('completed'));
    const timeline = groupChatDb.listMessages(user.id, room.id, 30);
    expect(timeline.map((message) => message.sequence)).toEqual([...timeline.map((message) => message.sequence)].sort((a, b) => a - b));
    expect(timeline.find((message) => message.kind === 'activity').content).toContain('评审员本人');
    expect(timeline.find((message) => message.kind === 'delegation').metadata).toMatchObject({
      state: 'completed', targetMemberId: 'reviewer',
    });
    expect(timeline.filter((message) => message.kind === 'chat' && message.senderMemberId === 'main')).toHaveLength(0);
    expect(timeline.at(-1)).toMatchObject({ senderMemberId: 'reviewer', content: '我是评审员，负责独立验收。' });
  });

  it('re-prompts the main agent when an explicit mention was not actually delegated', async () => {
    const { user, groupChatDb } = await setup();
    let mainAttempts = 0;
    let delegateMember;
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          if (input.sessionKey.endsWith(':main')) {
            mainAttempts += 1;
            if (mainAttempts === 1) {
              yield { type: 'assistant_text_delta', text: '这是一段未实际委派的草稿。' };
            } else {
              yield { type: 'tool_call_started', toolCallId: 'required-reviewer', name: 'group_member_delegate', argsPreview: '{}' };
              await delegateMember(user.id, room.id, {
                sourceSessionId: `group:${room.id}:main`, sourceTurnId: 'turn-retry',
                memberId: 'reviewer', message: '请直接回答用户。',
              });
              yield { type: 'tool_call_finished', toolCallId: 'required-reviewer', toolName: 'group_member_delegate', ok: true, resultPreview: 'ok' };
              yield { type: 'assistant_text_delta', text: '已根据评审员回复完成总结。' };
            }
          } else {
            yield { type: 'assistant_text_delta', text: '评审员真实回复。' };
          }
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    delegateMember = groupChatService.delegateMember.bind(groupChatService);
    const room = groupChatDb.createRoom(user.id, {
      title: 'Required delegation', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'reviewer', kind: 'pilotdeck_local', name: 'PilotDeck 评审员', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: '@PilotDeck 评审员 请回答', mentionedMemberIds: ['reviewer'],
    });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, result.roundId).status).toBe('completed'));
    const timeline = groupChatDb.listMessages(user.id, room.id, 40);
    expect(mainAttempts).toBe(2);
    expect(timeline.some((message) => message.content.includes('未实际委派的草稿'))).toBe(false);
    expect(timeline.filter((message) => message.kind === 'delegation')).toHaveLength(1);
    expect(timeline.at(-1).content).toBe('已根据评审员回复完成总结。');
  });

  it('finishes persisted activity records when the gateway throws', async () => {
    const { user, groupChatDb } = await setup();
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* () {
          yield { type: 'assistant_thinking_delta', text: '正在检查执行环境。' };
          yield {
            type: 'tool_call_started', toolCallId: 'tool-before-crash',
            name: 'inspect_workspace', argsPreview: '{"path":"."}',
          };
          throw new Error('gateway disconnected');
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Failure cleanup', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });

    const result = groupChatService.sendMessage(user.id, room.id, { content: '检查项目。' });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, result.roundId).status).toBe('failed'));
    const timeline = groupChatDb.listMessages(user.id, room.id, 20);
    const activities = timeline.filter((message) => message.kind === 'activity');

    expect(activities).toHaveLength(2);
    expect(activities.every((message) => message.status === 'failed')).toBe(true);
    expect(timeline.some((message) => message.status === 'thinking')).toBe(false);
    expect(timeline.at(-1)).toMatchObject({ senderMemberId: 'main', status: 'failed' });
  });

  it('continues ordered mention-only replies after the main agent fails', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input.sessionKey);
          if (input.sessionKey.endsWith(':main')) throw new Error('main unavailable');
          yield { type: 'assistant_text_delta', text: '工程师仍然完成了回复。' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Mention failure isolation', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'mentions', muted: true,
    });
    groupChatDb.addMember(user.id, room.id, {
      id: 'engineer', kind: 'pilotdeck_local', name: 'PilotDeck 工程师', config: {},
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: '@PilotDeck 主智能体 @PilotDeck 工程师 请分别回答。',
      mentionedMemberIds: ['main', 'engineer'],
    });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, result.roundId).status).toBe('completed'));
    const chats = groupChatDb.listMessages(user.id, room.id, 30).filter((message) => message.kind === 'chat');

    expect(gatewayCalls).toEqual([`group:${room.id}:main`, `group:${room.id}:engineer`]);
    expect(chats.some((message) => message.senderMemberId === 'main' && message.status === 'failed')).toBe(true);
    expect(chats.at(-1)).toMatchObject({ senderMemberId: 'engineer', content: '工程师仍然完成了回复。' });
  });
});
