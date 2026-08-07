import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  delete process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS;
  delete process.env.PILOTDECK_GROUP_TURN_TIMEOUT_MS;
  delete process.env.PILOTDECK_AUTH_MODE;
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
  return { user, groupChatDb, database };
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

    const rebound = groupChatDb.updateRoom(user.id, room.id, {
      projectName: 'office',
      projectPath: '/workspace/office_01',
    });
    expect(rebound).toMatchObject({
      projectName: 'office',
      projectPath: '/workspace/office_01',
    });

    groupChatDb.createMessage(user.id, room.id, {
      senderType: 'agent', senderMemberId: 'reviewer', senderName: 'Reviewer', content: 'Looks good.',
    });
    expect(groupChatDb.listRooms(user.id)[0].unreadCount).toBe(1);

    groupChatDb.setParticipantMuted(user.id, room.id, true);
    const muted = groupChatDb.listRooms(user.id)[0];
    expect(muted.unreadCount).toBe(0);
    expect(muted.hasSilentUnread).toBe(true);

    groupChatDb.markRead(user.id, room.id);
    expect(groupChatDb.listRooms(user.id)[0].hasSilentUnread).toBe(false);
  });

  it('keeps timelines, titles, and read state isolated between conversations in one group', async () => {
    const { user, groupChatDb } = await setup();
    const room = groupChatDb.createRoom(user.id, {
      title: 'Multi conversation group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: false,
    });
    const first = room.conversations[0];
    groupChatDb.createMessage(user.id, room.id, {
      conversationId: first.id,
      senderType: 'user', senderUserId: user.id, senderName: 'Owner', content: 'First topic',
    });
    const second = groupChatDb.createConversation(user.id, room.id);
    const reusedSecond = groupChatDb.createConversation(user.id, room.id);
    expect(reusedSecond.id).toBe(second.id);
    expect(groupChatDb.listConversations(user.id, room.id)).toHaveLength(2);

    groupChatDb.createMessage(user.id, room.id, {
      conversationId: second.id,
      senderType: 'user', senderUserId: user.id, senderName: 'Owner', content: 'Second topic',
    });
    groupChatDb.createMessage(user.id, room.id, {
      conversationId: second.id,
      senderType: 'agent', senderMemberId: 'main', senderName: 'Main', content: 'Second reply',
    });

    expect(groupChatDb.listMessages(user.id, room.id, first.id, 20).map((message) => message.content))
      .toEqual(['First topic']);
    expect(groupChatDb.listMessages(user.id, room.id, second.id, 20).map((message) => message.content))
      .toEqual(['Second topic', 'Second reply']);
    const conversations = groupChatDb.listConversations(user.id, room.id);
    expect(conversations.map((conversation) => conversation.title)).toEqual(['Second topic', 'First topic']);
    expect(conversations.find((conversation) => conversation.id === second.id).unreadCount).toBe(1);
    groupChatDb.markRead(user.id, room.id, second.id);
    expect(groupChatDb.listConversations(user.id, room.id)
      .find((conversation) => conversation.id === second.id).unreadCount).toBe(0);
  });

  it('reuses an untouched draft and can archive the final conversation', async () => {
    const { user, groupChatDb } = await setup();
    const room = groupChatDb.createRoom(user.id, {
      title: 'Draft reuse group', projectName: 'general', projectPath: '/workspace/general',
      triggerMode: 'auto', muted: false,
    });
    const initial = room.conversations[0];

    expect(groupChatDb.createConversation(user.id, room.id).id).toBe(initial.id);
    expect(groupChatDb.listConversations(user.id, room.id)).toHaveLength(1);
    expect(groupChatDb.archiveConversation(user.id, room.id, initial.id)).toBe(true);
    expect(groupChatDb.listConversations(user.id, room.id)).toEqual([]);

    const replacement = groupChatDb.createConversation(user.id, room.id);
    expect(replacement.id).not.toBe(initial.id);
    expect(groupChatDb.listConversations(user.id, room.id)).toHaveLength(1);
  });

  it('routes the main member through a remote coordinator instance when one is bound', async () => {
    const { user, groupChatDb, database } = await setup();
    const remote = database.instancesDb.createRemote({
      id: 'remote-main', ownerUserId: user.id, name: 'Remote main', endpoint: 'http://127.0.0.1:8642',
    });
    const room = groupChatDb.createRoom(user.id, {
      title: 'Remote coordinator', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', coordinatorInstanceId: remote.id,
    });
    expect(room.members[0]).toMatchObject({ id: 'main', kind: 'pilotdeck_remote', instanceId: remote.id });
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
  it('records an entry timeout in the process timeline without a failed assistant reply', async () => {
    const { user, groupChatDb } = await setup();
    const abortTurn = vi.fn(async () => undefined);
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        abortTurn,
        submitTurn: async function* () {
          yield { type: 'assistant_thinking_delta', text: '正在等待数字员工。' };
          yield {
            type: 'error', code: 'turn_timeout',
            message: 'Turn exceeded the 300000ms timeout.', recoverable: false,
          };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Timeout group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    const conversationId = room.conversations[0].id;
    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: 'ask a slow employee', clientMessageId: 'timeout-1',
    });

    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, sent.roundId).status).toBe('failed'));
    const messages = groupChatDb.listMessages(user.id, room.id, conversationId, 50);
    expect(messages.filter((message) => message.senderMemberId === 'main' && message.kind === 'chat' && message.status === 'failed'))
      .toHaveLength(0);
    const mainActivities = messages.filter((message) => message.senderMemberId === 'main' && message.kind === 'activity');
    expect(mainActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'completed', metadata: expect.objectContaining({ activityType: 'reasoning' }),
      }),
      expect.objectContaining({
        status: 'failed', metadata: expect.objectContaining({ activityType: 'execution' }),
        error: 'Turn exceeded the 300000ms timeout.',
      }),
    ]));
    expect(mainActivities.find((message) => message.metadata?.activityType === 'execution').sequence)
      .toBeGreaterThan(mainActivities.find((message) => message.metadata?.activityType === 'reasoning').sequence);
    expect(messages.filter((message) => ['thinking', 'queued'].includes(message.status))).toHaveLength(0);
    expect(abortTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'system:group_timeout' }));
  });

  it('stops the active group turn, clears queued turns, and allows the conversation to recover', async () => {
    const { user, groupChatDb } = await setup();
    let releaseFirst;
    let callCount = 0;
    const abortTurn = vi.fn(async () => releaseFirst?.());
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        abortTurn,
        submitTurn: async function* () {
          callCount += 1;
          if (callCount === 1) {
            yield { type: 'assistant_thinking_delta', text: '正在执行一个较长任务。' };
            await new Promise((resolve) => { releaseFirst = resolve; });
            yield { type: 'error', code: 'aborted', message: '本轮执行已由用户停止。' };
            return;
          }
          yield { type: 'assistant_text_delta', text: '停止后已恢复。' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Stop group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    const conversationId = room.conversations[0].id;
    const first = groupChatService.sendMessage(user.id, room.id, { content: 'long-running', clientMessageId: 'stop-1' });
    const queued = groupChatService.sendMessage(user.id, room.id, { content: 'queued-after-first', clientMessageId: 'stop-2' });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, first.roundId).status).toBe('running'));

    const stopped = await groupChatService.stopConversation(user.id, room.id, conversationId);
    expect(stopped).toMatchObject({ stopped: true });
    expect(stopped.turnIds).toEqual([first.roundId, queued.roundId]);
    expect(abortTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user:group_stop' }));
    await vi.waitFor(() => {
      expect(groupChatDb.getTurn(user.id, room.id, first.roundId)).toMatchObject({ status: 'failed', error: '本轮执行已由用户停止。' });
      expect(groupChatDb.getTurn(user.id, room.id, queued.roundId)).toMatchObject({ status: 'failed', error: '本轮执行已由用户停止。' });
    });
    const stoppedMessages = groupChatDb.listMessages(user.id, room.id, conversationId, 50);
    expect(stoppedMessages
      .filter((message) => message.status === 'thinking' || message.status === 'queued')).toHaveLength(0);
    expect(stoppedMessages
      .filter((message) => message.error === '本轮执行已由用户停止。'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ stoppedByUser: true }) }),
      ]));

    const recovered = groupChatService.sendMessage(user.id, room.id, { content: 'recover', clientMessageId: 'stop-3' });
    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, recovered.roundId).status).toBe('completed'));
    expect(groupChatDb.listMessages(user.id, room.id, conversationId, 50).at(-1)).toMatchObject({
      senderMemberId: 'main', content: '停止后已恢复。', status: 'completed',
    });
  });

  it('persists concurrent human messages and executes them in FIFO order with each sender entry instance', async () => {
    const { user, groupChatDb, database } = await setup();
    const alice = database.userDb.createUser('alice-fifo', 'hash', { displayName: 'Alice' });
    const ownerInstance = database.instancesDb.ensureLocalForUser(user);
    const aliceInstance = database.instancesDb.ensureLocalForUser(alice);
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push({ sessionKey: input.sessionKey, message: input.message });
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield { type: 'assistant_text_delta', text: `reply:${input.message}` };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'FIFO group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', coordinatorInstanceId: ownerInstance.id,
    });
    groupChatDb.addParticipant(user.id, room.id, {
      userId: alice.id, displayName: 'Alice', role: 'member',
      instanceId: aliceInstance.id, instanceKind: 'local', instanceName: 'Alice PilotDeck',
    });

    const first = groupChatService.sendMessage(alice.id, room.id, { content: 'alice-first', clientMessageId: 'm-1' });
    const second = groupChatService.sendMessage(user.id, room.id, { content: 'owner-second', clientMessageId: 'm-2' });
    expect(first.roundId).toBeTruthy();
    expect(second.roundId).toBeTruthy();
    await vi.waitFor(() => {
      expect(groupChatDb.getTurn(alice.id, room.id, first.roundId).status).toBe('completed');
      expect(groupChatDb.getTurn(user.id, room.id, second.roundId).status).toBe('completed');
    });
    expect(gatewayCalls).toEqual([
      { sessionKey: `group:${room.id}:${room.conversations[0].id}:user-${alice.id}`, message: 'alice-first' },
      { sessionKey: `group:${room.id}:${room.conversations[0].id}:main`, message: 'owner-second' },
    ]);
    const userMessages = groupChatDb.listMessages(user.id, room.id, 50).filter((message) => message.senderType === 'user');
    expect(userMessages.map((message) => message.content)).toEqual(['alice-first', 'owner-second']);
  });

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
      `group:${room.id}:${room.conversations[0].id}:engineer`,
      `group:${room.id}:${room.conversations[0].id}:main`,
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

    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([
      `group:${room.id}:${room.conversations[0].id}:main`,
    ]);
    expect(gatewayCalls.every((call) => call.workspaceCwd === '/workspace/PilotDeck')).toBe(true);
    expect(gatewayCalls.every((call) => call.projectKey === '/workspace/PilotDeck')).toBe(true);
    expect(gatewayCalls[0]).toMatchObject({
      runMode: 'agent',
      mode: 'default',
      basePermissionMode: 'default',
      canPrompt: true,
    });
    expect(gatewayCalls[0].permissionRules?.deny || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'write_file' }),
    ]));
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('主智能体');
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('group_member_delegate');
    expect(gatewayCalls[0].syntheticMessages[0].text).toContain('id=reviewer');
  });

  it('persists plan and full-access choices and forwards them to the same gateway agent loop', async () => {
    const { user, groupChatDb } = await setup();
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: 'done' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Mode parity', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });

    const plan = groupChatService.sendMessage(user.id, room.id, {
      conversationId: room.conversations[0].id,
      content: 'Plan this change',
      runMode: 'plan',
      permissionMode: 'plan',
      basePermissionMode: 'bypassPermissions',
    });
    expect(groupChatDb.getTurnById(plan.roundId)).toMatchObject({
      runMode: 'plan', permissionMode: 'plan', basePermissionMode: 'bypassPermissions',
    });
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(1));
    expect(gatewayCalls[0]).toMatchObject({
      runMode: 'plan', mode: 'plan', basePermissionMode: 'bypassPermissions', allowPlanModeTools: true,
    });

    const secondConversation = groupChatDb.createConversation(user.id, room.id);
    const full = groupChatService.sendMessage(user.id, room.id, {
      conversationId: secondConversation.id,
      content: 'Implement this change',
      runMode: 'agent',
      permissionMode: 'bypassPermissions',
      basePermissionMode: 'bypassPermissions',
    });
    expect(groupChatDb.getTurnById(full.roundId)).toMatchObject({
      runMode: 'agent', permissionMode: 'bypassPermissions', basePermissionMode: 'bypassPermissions',
    });
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
    expect(gatewayCalls[1]).toMatchObject({
      runMode: 'agent', mode: 'bypassPermissions', basePermissionMode: 'bypassPermissions',
    });
  });

  it('persists gateway permission requests and resumes the blocked group turn after a decision', async () => {
    const { user, groupChatDb } = await setup();
    let resolveDecision;
    const decision = new Promise((resolve) => { resolveDecision = resolve; });
    const gateway = {
      submitTurn: async function* () {
        yield { type: 'permission_request', requestId: 'permission-1', toolName: 'write_file', payload: { path: 'index.html' } };
        await decision;
        yield { type: 'assistant_text_delta', text: 'File created.' };
        yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
      },
      permissionDecide: vi.fn(async (input) => {
        resolveDecision(input);
        return { delivered: true };
      }),
    };
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(async () => gateway) }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Permission parity', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });

    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: 'Create index.html', runMode: 'agent', permissionMode: 'default',
    });
    await vi.waitFor(() => {
      expect(groupChatDb.listMessages(user.id, room.id, room.conversations[0].id, 50)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'activity', status: 'thinking',
          metadata: expect.objectContaining({ activityType: 'permission', state: 'awaiting', requestId: 'permission-1' }),
        }),
      ]));
    });

    expect(await groupChatService.respondToInteraction(
      user.id, room.id, room.conversations[0].id, 'permission-1', { allow: true },
    )).toEqual({ delivered: true });
    await vi.waitFor(() => expect(groupChatDb.getTurnById(sent.roundId).status).toBe('completed'));
    expect(gateway.permissionDecide).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'permission-1', decision: 'allow',
    }));
    const permissionMessage = groupChatDb.listMessages(user.id, room.id, room.conversations[0].id, 50)
      .find((message) => message.metadata.requestId === 'permission-1');
    expect(permissionMessage).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ decision: 'allow' }) });
  });

  it('enforces the project viewer ceiling even when the client requests agent full access', async () => {
    const { user, groupChatDb, database } = await setup();
    process.env.PILOTDECK_AUTH_MODE = 'true';
    database.projectAccessDb.setRole('/workspace/PilotDeck', user.id, 'viewer', user.id);
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: 'read-only reply' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Viewer group', projectName: 'pilotdeck', projectPath: '/workspace/PilotDeck',
      triggerMode: 'auto', muted: true,
    });
    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: 'Try to write', runMode: 'agent', permissionMode: 'bypassPermissions',
    });

    expect(groupChatDb.getTurnById(sent.roundId)).toMatchObject({
      runMode: 'ask', permissionMode: 'default', basePermissionMode: 'default',
    });
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(1));
    expect(gatewayCalls[0]).toMatchObject({ runMode: 'ask', mode: 'default', canPrompt: false });
    expect(gatewayCalls[0].permissionRules.deny).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'write_file', behavior: 'deny' }),
      expect.objectContaining({ toolName: 'bash', behavior: 'deny' }),
    ]));
  });

  it('persists uploaded group attachments and forwards them to the entry PilotDeck turn', async () => {
    const { user, groupChatDb } = await setup();
    const projectPath = mkdtempSync(join(tmpdir(), 'pilotdeck-group-attachments-'));
    tempDirs.push(projectPath);
    const attachmentDir = join(projectPath, '.tmp', 'chat-attachments', 'round-1');
    mkdirSync(attachmentDir, { recursive: true });
    const imagePath = join(attachmentDir, 'diagram.png');
    const filePath = join(attachmentDir, 'notes.md');
    writeFileSync(imagePath, 'image');
    writeFileSync(filePath, '# notes');
    const gatewayCalls = [];
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          gatewayCalls.push(input);
          yield { type: 'assistant_text_delta', text: '附件已收到' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: 'Attachment group', projectName: 'attachment-project', projectPath,
      triggerMode: 'auto', muted: true,
    });

    const result = groupChatService.sendMessage(user.id, room.id, {
      content: '分析这些材料',
      images: [{
        name: 'diagram.png', path: imagePath, size: 5, mimeType: 'image/png',
        data: 'data:image/png;base64,aW1hZ2U=',
      }],
      attachments: [{ name: 'notes.md', path: filePath, size: 7, mimeType: 'text/markdown' }],
    });

    await vi.waitFor(() => expect(groupChatDb.getTurn(user.id, room.id, result.roundId).status).toBe('completed'));
    const saved = groupChatDb.getUserMessageForTurn(result.roundId);
    expect(saved.metadata).toMatchObject({
      images: [expect.objectContaining({ name: 'diagram.png', path: imagePath })],
      attachments: [expect.objectContaining({ name: 'notes.md', path: filePath })],
    });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0].message).toContain('图片：diagram.png');
    expect(gatewayCalls[0].message).toContain('附件：notes.md');
    expect(gatewayCalls[0].attachments).toEqual([
      expect.objectContaining({ type: 'image', name: 'diagram.png', content: 'aW1hZ2U=', path: imagePath }),
      expect.objectContaining({ type: 'file', name: 'notes.md', path: filePath }),
    ]);
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
                sourceSessionId: input.sessionKey,
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
      `group:${room.id}:${room.conversations[0].id}:main`,
      `group:${room.id}:${room.conversations[0].id}:reviewer`,
      `group:${room.id}:${room.conversations[0].id}:engineer`,
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
    expect(gatewayCalls[0].sessionKey).toBe(
      `group:${room.id}:${room.conversations[0].id}:reviewer`,
    );
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
              sourceSessionId: input.sessionKey, sourceTurnId: 'turn-natural',
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
    expect(timeline.find((message) => message.kind === 'activity' && message.metadata.activityType === 'reasoning').content)
      .toContain('评审员本人');
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
                sourceSessionId: input.sessionKey, sourceTurnId: 'turn-retry',
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
    const activities = timeline.filter((message) => message.kind === 'activity' && message.metadata.activityType !== 'queue');

    expect(activities).toHaveLength(3);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'completed', metadata: expect.objectContaining({ activityType: 'reasoning' }) }),
      expect.objectContaining({ status: 'failed', metadata: expect.objectContaining({ activityType: 'tool' }) }),
      expect.objectContaining({ status: 'failed', metadata: expect.objectContaining({ activityType: 'execution' }) }),
    ]));
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

    expect(gatewayCalls).toEqual([
      `group:${room.id}:${room.conversations[0].id}:main`,
      `group:${room.id}:${room.conversations[0].id}:engineer`,
    ]);
    expect(chats.some((message) => message.senderMemberId === 'main' && message.status === 'failed')).toBe(true);
    expect(chats.at(-1)).toMatchObject({ senderMemberId: 'engineer', content: '工程师仍然完成了回复。' });
  });
});
