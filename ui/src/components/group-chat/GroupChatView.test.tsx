// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGroup, AgentGroupMessage, AgentGroupMember } from '../../types/group';
import GroupChatView from './GroupChatView';

const apiMock = vi.hoisted(() => ({
  group: vi.fn(),
  groupMessages: vi.fn(),
  markGroupRead: vi.fn(),
  sendGroupMessage: vi.fn(),
  updateGroup: vi.fn(),
  reorderGroupMembers: vi.fn(),
  archiveGroup: vi.fn(),
  availableGroupMembers: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  groupParticipants: vi.fn(),
  groupParticipantCandidates: vi.fn(),
  instances: { list: vi.fn() },
}));

vi.mock('../../utils/api', () => ({ api: apiMock }));
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'owner' } }) }));

const now = '2026-08-01T12:00:00.000Z';

function member(id: string, name: string, kind: AgentGroupMember['kind'], position: number): AgentGroupMember {
  return {
    id,
    roomId: 'group-1',
    kind,
    category: kind === 'pilotdeck_main' ? 'pilotdeck_instance' : 'employee',
    name,
    position,
    config: {},
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

const group: AgentGroup = {
  id: 'group-1',
  title: '学生系统评审组',
  projectName: 'pilotdeck',
  projectPath: '/workspace/PilotDeck',
  triggerMode: 'mentions',
  muted: false,
  status: 'active',
  participantRole: 'owner',
  unreadCount: 0,
  hasSilentUnread: false,
  lastMessagePreview: '综合结论',
  members: [
    member('engineer', 'Mock 工程师', 'staffdeck_mock', 0),
    member('main', 'PilotDeck 主智能体', 'pilotdeck_main', 10_000),
  ],
  createdAt: now,
  updatedAt: now,
};

const messages: AgentGroupMessage[] = [
  {
    id: 'm1', roomId: group.id, senderType: 'user', senderName: '你', content: '@所有人 请评审',
    sequence: 1, kind: 'chat', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
  },
  {
    id: 'm2', roomId: group.id, senderType: 'agent', senderMemberId: 'engineer',
    senderName: 'Mock 工程师', content: '工程建议', sequence: 2, kind: 'chat', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
  },
  {
    id: 'm3', roomId: group.id, senderType: 'agent', senderMemberId: 'main',
    senderName: 'PilotDeck 主智能体', content: '综合结论', sequence: 3, kind: 'chat', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderGroup() {
  return render(
    <GroupChatView
      groupId={group.id}
      onGroupsChanged={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
}

beforeEach(() => {
  apiMock.group.mockResolvedValue(jsonResponse({ group }));
  apiMock.groupMessages.mockResolvedValue(jsonResponse({ messages }));
  apiMock.markGroupRead.mockResolvedValue(new Response(null, { status: 204 }));
  apiMock.sendGroupMessage.mockResolvedValue(jsonResponse({ roundId: 'round-1' }, 202));
  apiMock.groupParticipants.mockResolvedValue(jsonResponse({ participants: [] }));
  apiMock.groupParticipantCandidates.mockResolvedValue(jsonResponse({ candidates: [] }));
  apiMock.instances.list.mockResolvedValue(jsonResponse({ instances: [] }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GroupChatView', () => {
  it('renders a dedicated speaker timeline and the mention-only rule', async () => {
    renderGroup();

    expect(await screen.findByRole('heading', { name: group.title })).toBeTruthy();
    expect(screen.getByText('仅 @ 触发')).toBeTruthy();
    expect(screen.getAllByText('Mock 工程师').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PilotDeck 主智能体').length).toBeGreaterThan(0);
    expect(screen.getByText('工程建议')).toBeTruthy();
    expect(screen.getByText('综合结论')).toBeTruthy();
    expect(screen.getByText(/未 @ 的消息仍会保存在时间线中/)).toBeTruthy();
  });

  it('sends @所有人 as an explicit all-member mention', async () => {
    renderGroup();
    const editor = await screen.findByRole('textbox', { name: '群组消息' });
    fireEvent.click(screen.getByRole('button', { name: /提及成员/ }));
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '发送群组消息' }));

    await waitFor(() => {
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, {
        content: '@所有人',
        mentionedMemberIds: [],
        mentionAll: true,
      });
    });
  });

  it('selects a named mention with arrow keys and deletes it atomically', async () => {
    renderGroup();
    const editor = await screen.findByRole('textbox', { name: '群组消息' });
    fireEvent.click(screen.getByRole('button', { name: /提及成员/ }));
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });

    const chip = editor.querySelector<HTMLElement>('[data-mention-id="engineer"]');
    expect(chip?.textContent).toBe('@Mock 工程师');
    expect(chip?.contentEditable).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '发送群组消息' }));
    await waitFor(() => {
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, {
        content: '@Mock 工程师',
        mentionedMemberIds: ['engineer'],
        mentionAll: false,
      });
    });

    apiMock.sendGroupMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /提及成员/ }));
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor, editor.childNodes.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(editor.querySelector('[data-mention-id="engineer"]')).toBeNull();
  });

  it('renders persisted reasoning and a real delegation before the member reply', async () => {
    const collaboration: AgentGroupMessage[] = [
      {
        id: 'u1', roomId: group.id, roundId: 'r1', sequence: 1, kind: 'chat', senderType: 'user',
        senderUserId: 1, senderName: '你', content: '帮我问问工程师', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'a1', roomId: group.id, roundId: 'r1', sequence: 2, kind: 'activity', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '需要工程师提供真实说明。',
        metadata: { activityType: 'reasoning', state: 'completed' }, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'd1', roomId: group.id, roundId: 'r1', sequence: 3, kind: 'delegation', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '请介绍你的实现职责。',
        metadata: { state: 'completed', targetMemberId: 'engineer', targetMemberName: 'Mock 工程师', responseMessageId: 'm1' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'm1', roomId: group.id, roundId: 'r1', sequence: 4, kind: 'chat', senderType: 'agent',
        senderMemberId: 'engineer', senderName: 'Mock 工程师', replyToMessageId: 'd1', content: '我是工程实现成员。',
        metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'm2', roomId: group.id, roundId: 'r1', sequence: 5, kind: 'chat', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '工程师已经完成介绍。',
        metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
    ];
    apiMock.groupMessages.mockResolvedValue(jsonResponse({ messages: collaboration }));
    renderGroup();

    expect(await screen.findByText('@Mock 工程师')).toBeTruthy();
    expect(screen.getByText('已询问')).toBeTruthy();
    expect(screen.getByText('我是工程实现成员。')).toBeTruthy();
    expect(screen.getByText('工程师已经完成介绍。')).toBeTruthy();
    fireEvent.click(screen.getByText(/已完成思考/));
    expect(screen.getByText('需要工程师提供真实说明。')).toBeTruthy();
  });

  it('hides group management actions from regular members', async () => {
    apiMock.group.mockResolvedValue(jsonResponse({ group: { ...group, participantRole: 'member' } }));
    renderGroup();

    expect(await screen.findByRole('heading', { name: group.title })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '邀请' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '群组设置' }));
    expect(await screen.findByRole('heading', { name: '群组设置' })).toBeTruthy();
    expect(screen.getByDisplayValue(group.title).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: '仅 @ 触发' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '归档群组' })).toBeNull();
    expect(screen.queryByRole('button', { name: '邀请' })).toBeNull();
  });
});
