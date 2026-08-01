import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('runs secondary members in order and the main agent last', async () => {
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
    expect(result.targetMemberIds).toEqual(['engineer', 'reviewer', 'main']);

    await vi.waitFor(() => {
      expect(groupChatDb.listMessages(user.id, room.id, 20).filter((message) => message.senderType === 'agent'))
        .toHaveLength(3);
      expect(groupChatDb.listMessages(user.id, room.id, 20).some((message) => message.status === 'thinking'))
        .toBe(false);
    });

    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([
      `group:${room.id}:engineer`,
      `group:${room.id}:reviewer`,
      `group:${room.id}:main`,
    ]);
    expect(gatewayCalls.every((call) => call.workspaceCwd === '/workspace/PilotDeck')).toBe(true);
    expect(gatewayCalls[2].syntheticMessages[0].text).toContain('主智能体');
  });

  it('lets concrete mentions override automatic all-member dispatch while preserving group order', async () => {
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

    expect(result.targetMemberIds).toEqual(['engineer', 'reviewer']);
    await vi.waitFor(() => expect(gatewayCalls).toHaveLength(2));
    expect(gatewayCalls.map((call) => call.sessionKey)).toEqual([
      `group:${room.id}:engineer`,
      `group:${room.id}:reviewer`,
    ]);
  });
});
