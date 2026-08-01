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
}));

vi.mock('../../utils/api', () => ({ api: apiMock }));

const now = '2026-08-01T12:00:00.000Z';

function member(id: string, name: string, kind: AgentGroupMember['kind'], position: number): AgentGroupMember {
  return {
    id,
    roomId: 'group-1',
    kind,
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
    status: 'completed', createdAt: now, updatedAt: now,
  },
  {
    id: 'm2', roomId: group.id, senderType: 'agent', senderMemberId: 'engineer',
    senderName: 'Mock 工程师', content: '工程建议', status: 'completed', createdAt: now, updatedAt: now,
  },
  {
    id: 'm3', roomId: group.id, senderType: 'agent', senderMemberId: 'main',
    senderName: 'PilotDeck 主智能体', content: '综合结论', status: 'completed', createdAt: now, updatedAt: now,
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
    const textarea = await screen.findByPlaceholderText(/@智能体 或 @所有人/);

    fireEvent.change(textarea, { target: { value: '@所有人 请开始评审' } });
    fireEvent.click(screen.getByRole('button', { name: '发送群组消息' }));

    await waitFor(() => {
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, {
        content: '@所有人 请开始评审',
        mentionedMemberIds: [],
        mentionAll: true,
      });
    });
  });
});
