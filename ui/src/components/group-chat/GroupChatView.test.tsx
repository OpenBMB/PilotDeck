// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGroup, AgentGroupMessage, AgentGroupMember } from '../../types/group';
import GroupChatView from './GroupChatView';

const apiMock = vi.hoisted(() => ({
  group: vi.fn(),
  groupMessages: vi.fn(),
  groupMessageImageUrl: vi.fn((groupId: string, messageId: string, imageIndex: number) => (
    `/api/groups/${groupId}/messages/${messageId}/images/${imageIndex}`
  )),
  markGroupRead: vi.fn(),
  sendGroupMessage: vi.fn(),
  stopGroupConversation: vi.fn(),
  uploadProjectAttachments: vi.fn(),
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
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import('react');
  const Icon = React.forwardRef<SVGSVGElement, React.SVGProps<SVGSVGElement>>((props, ref) => (
    <svg ref={ref} {...props} />
  ));
  return Object.fromEntries(Object.keys(actual).map((name) => [name, Icon]));
});

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
  conversations: [{
    id: 'conversation-1',
    roomId: 'group-1',
    title: '学生系统评审讨论',
    status: 'active',
    unreadCount: 0,
    hasSilentUnread: false,
    lastMessagePreview: '综合结论',
    createdByUserId: 1,
    createdAt: now,
    updatedAt: now,
  }],
  members: [
    member('finance', '财务', 'staffdeck', 0),
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
    id: 'm2', roomId: group.id, senderType: 'agent', senderMemberId: 'finance',
    senderName: '财务', content: '财务建议', sequence: 2, kind: 'chat', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
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

function renderGroup(onOpenFiles = vi.fn(), extraProps: Partial<ComponentProps<typeof GroupChatView>> = {}) {
  return render(
    <GroupChatView
      groupId={group.id}
      conversationId="conversation-1"
      onGroupsChanged={vi.fn()}
      onArchived={vi.fn()}
      onOpenFiles={onOpenFiles}
      {...extraProps}
    />,
  );
}

beforeEach(() => {
  apiMock.group.mockResolvedValue(jsonResponse({ group }));
  apiMock.groupMessages.mockResolvedValue(jsonResponse({ messages }));
  apiMock.markGroupRead.mockResolvedValue(new Response(null, { status: 204 }));
  apiMock.sendGroupMessage.mockResolvedValue(jsonResponse({ roundId: 'round-1' }, 202));
  apiMock.stopGroupConversation.mockResolvedValue(jsonResponse({ stopped: true, turnIds: ['round-1'] }));
  apiMock.uploadProjectAttachments.mockResolvedValue(jsonResponse({ images: [], files: [] }));
  apiMock.groupParticipants.mockResolvedValue(jsonResponse({ participants: [] }));
  apiMock.groupParticipantCandidates.mockResolvedValue(jsonResponse({ candidates: [] }));
  apiMock.instances.list.mockResolvedValue(jsonResponse({ instances: [] }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GroupChatView', () => {
  it('shows a real stop control for the latest running round and calls the group stop API', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [
        { ...messages[0], roundId: 'round-running' },
        {
          id: 'queue-running', roomId: group.id, roundId: 'round-running', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '正在处理', sequence: 2, kind: 'activity',
          metadata: { activityType: 'queue', state: 'running' }, status: 'thinking', createdAt: now, updatedAt: now,
        },
      ],
    }));
    renderGroup();

    const stopButton = await screen.findByRole('button', { name: '停止群组执行' });
    expect(screen.queryByRole('button', { name: '发送群组消息' })).toBeNull();
    fireEvent.click(stopButton);
    await waitFor(() => {
      expect(apiMock.stopGroupConversation).toHaveBeenCalledWith(group.id, 'conversation-1');
    });
  });

  it('does not let a stale historical thinking message lock a completed latest round', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [
        { ...messages[0], id: 'old-user', roundId: 'round-old', sequence: 1 },
        {
          id: 'old-thinking', roomId: group.id, roundId: 'round-old', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '旧过程', sequence: 2, kind: 'activity', metadata: {},
          status: 'thinking', createdAt: now, updatedAt: now,
        },
        { ...messages[0], id: 'latest-user', roundId: 'round-latest', sequence: 3, content: '最新问题' },
        { ...messages[2], id: 'latest-reply', roundId: 'round-latest', sequence: 4, content: '最新回复' },
      ],
    }));
    renderGroup();

    expect(await screen.findByRole('button', { name: '发送群组消息' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止群组执行' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '群组消息' }).getAttribute('contenteditable')).toBe('true');
  });

  it('renders a user-stopped round as stopped instead of a collaboration failure', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [
        { ...messages[0], id: 'stopped-user', roundId: 'round-stopped', sequence: 1, content: '执行一个较长任务' },
        {
          id: 'stopped-reasoning', roomId: group.id, roundId: 'round-stopped', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '正在执行一个较长任务。', sequence: 2, kind: 'activity',
          metadata: { activityType: 'reasoning', state: 'failed', stoppedByUser: true }, status: 'failed',
          error: '本轮执行已由用户停止。', createdAt: now, updatedAt: now,
        },
        {
          id: 'stopped-reply', roomId: group.id, roundId: 'round-stopped', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '', sequence: 3, kind: 'chat', metadata: { stoppedByUser: true },
          status: 'failed', error: '本轮执行已由用户停止。', createdAt: now, updatedAt: now,
        },
        {
          id: 'late-staffdeck-event', roomId: group.id, roundId: 'round-stopped', senderType: 'agent', senderMemberId: 'finance',
          senderName: '财务', content: '停止后迟到的远端事件', sequence: 4, kind: 'activity',
          metadata: { activityType: 'staffdeck', state: 'running', staffDeckLabel: '开始执行任务' },
          status: 'thinking', createdAt: now, updatedAt: now,
        },
      ],
    }));
    renderGroup();

    expect(await screen.findByText('PilotDeck 主智能体 · 已停止')).toBeTruthy();
    expect(screen.getByText('已停止思考')).toBeTruthy();
    expect(screen.getByText('已停止：本轮执行已由用户停止。')).toBeTruthy();
    expect(screen.queryByText(/协作有异常/)).toBeNull();
    expect(screen.queryByText(/回复失败/)).toBeNull();
    expect(screen.queryByRole('button', { name: '停止群组执行' })).toBeNull();
    expect(screen.getByRole('button', { name: '发送群组消息' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看完整协作过程，共 2 步' }));
    const detail = screen.getByRole('complementary', { name: '协作过程详情' });
    expect(within(detail).getByText('已由用户停止 · 共 2 步')).toBeTruthy();
  });

  it('keeps a historical entry timeout in the process timeline instead of a failed reply bubble', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [
        { ...messages[0], id: 'timeout-user', roundId: 'round-timeout', sequence: 1, content: '人事有哪些可用的知识库？' },
        {
          id: 'timeout-reasoning', roomId: group.id, roundId: 'round-timeout', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '正在等待人事数字员工返回。', sequence: 2, kind: 'activity',
          metadata: { activityType: 'reasoning', state: 'failed' }, status: 'failed',
          error: 'Turn exceeded the 300000ms timeout.', createdAt: now, updatedAt: now,
        },
        {
          id: 'staffdeck-step', roomId: group.id, roundId: 'round-timeout', senderType: 'agent', senderMemberId: 'finance',
          senderName: '财务', content: '能力检索已完成。', sequence: 3, kind: 'activity',
          metadata: { activityType: 'staffdeck', state: 'completed', staffDeckLabel: '能力调用完成 capability_search' },
          status: 'completed', createdAt: now, updatedAt: now,
        },
        {
          id: 'timeout-reply', roomId: group.id, roundId: 'round-timeout', senderType: 'agent', senderMemberId: 'main',
          senderName: 'PilotDeck 主智能体', content: '', sequence: 4, kind: 'chat', metadata: {}, status: 'failed',
          error: 'Turn exceeded the 300000ms timeout.', createdAt: now, updatedAt: now,
        },
      ],
    }));
    renderGroup();

    expect(await screen.findByText('PilotDeck 主智能体 · 协作有异常')).toBeTruthy();
    expect(screen.queryByText('回复失败：Turn exceeded the 300000ms timeout.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看完整协作过程，共 2 步' }));
    const detail = screen.getByRole('complementary', { name: '协作过程详情' });
    expect(within(detail).getByRole('button', { name: '1. 能力调用完成 capability_search' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '2. 执行超时' })).toBeTruthy();
    expect(within(detail).getByText('Turn exceeded the 300000ms timeout.')).toBeTruthy();
  });

  it('renders a dedicated speaker timeline and the mention-only rule', async () => {
    renderGroup();

    expect(await screen.findByRole('heading', { name: '学生系统评审讨论' })).toBeTruthy();
    expect(screen.getByText('仅 @ 触发')).toBeTruthy();
    expect(screen.getAllByText('财务').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PilotDeck 主智能体').length).toBeGreaterThan(0);
    expect(screen.getByText('财务建议')).toBeTruthy();
    expect(screen.getByText('综合结论')).toBeTruthy();
    expect(screen.getByText(/未 @ 的消息仍会保存在时间线中/)).toBeTruthy();
  });

  it('exposes the shared search and Files tools in the group header', async () => {
    const onOpenFiles = vi.fn();
    renderGroup(onOpenFiles);

    expect(await screen.findByRole('heading', { name: '学生系统评审讨论' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '搜索当前群组' }));
    const search = screen.getByRole('searchbox', { name: '搜索群组消息' });
    fireEvent.change(search, { target: { value: '财务建议' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('searchbox', { name: '搜索群组消息' })).toBeNull();
  });

  it('reuses the same group timeline in the compact Files assistant', async () => {
    const onCollapse = vi.fn();
    renderGroup(vi.fn(), { compact: true, onCollapse });

    expect(await screen.findByRole('heading', { name: '学生系统评审讨论' })).toBeTruthy();
    expect(screen.getByText('财务建议')).toBeTruthy();
    expect(screen.getByText('综合结论')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起群组对话' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('pastes an image, selects a file, uploads both, and sends them with the group message', async () => {
    const image = new File(['image-bytes'], 'clipboard.png', { type: 'image/png' });
    const document = new File(['report'], 'report.txt', { type: 'text/plain' });
    apiMock.uploadProjectAttachments.mockResolvedValue(jsonResponse({
      images: [{
        name: image.name,
        data: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
        path: '/workspace/PilotDeck/.tmp/chat-attachments/clipboard.png',
        size: image.size,
        mimeType: image.type,
      }],
      files: [{
        name: document.name,
        path: '/workspace/PilotDeck/.tmp/chat-attachments/report.txt',
        size: document.size,
        mimeType: document.type,
      }],
    }));
    renderGroup();

    const editor = await screen.findByRole('textbox', { name: '群组消息' });
    fireEvent.paste(editor, {
      clipboardData: { files: [image], getData: () => '' },
    });
    fireEvent.change(screen.getByLabelText('添加附件'), { target: { files: [document] } });
    expect(await screen.findByAltText('clipboard.png')).toBeTruthy();
    expect(screen.getByText('report.txt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '发送群组消息' }));
    await waitFor(() => {
      expect(apiMock.uploadProjectAttachments).toHaveBeenCalledWith(group.projectName, [image, document]);
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, expect.objectContaining({
        content: '请查看附件。',
        conversationId: 'conversation-1',
        images: expect.arrayContaining([expect.objectContaining({ name: 'clipboard.png' })]),
        attachments: expect.arrayContaining([expect.objectContaining({ name: 'report.txt' })]),
      }));
    });
  });

  it('keeps a just-pasted image when Enter is pressed before React commits the preview state', async () => {
    const image = new File(['fresh-image-bytes'], 'fast-paste.png', { type: 'image/png' });
    apiMock.uploadProjectAttachments.mockResolvedValue(jsonResponse({
      images: [{
        name: image.name,
        data: 'data:image/png;base64,ZnJlc2gtaW1hZ2UtYnl0ZXM=',
        path: '/workspace/PilotDeck/.tmp/chat-attachments/fast-paste.png',
        size: image.size,
        mimeType: image.type,
      }],
      files: [],
    }));
    renderGroup();

    const editor = await screen.findByRole('textbox', { name: '群组消息' });
    editor.textContent = '这是什么';
    fireEvent.input(editor);
    await act(async () => {
      fireEvent.paste(editor, {
        clipboardData: { files: [image], items: [], getData: () => '' },
      });
      fireEvent.keyDown(editor, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(apiMock.uploadProjectAttachments).toHaveBeenCalledWith(group.projectName, [image]);
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, expect.objectContaining({
        content: '这是什么',
        images: [expect.objectContaining({ name: 'fast-paste.png' })],
      }));
    });
  });

  it('renders persisted image and file attachments in the group timeline', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [{
        ...messages[0],
        content: '请查看附件。',
        metadata: {
          images: [{ name: 'diagram.png', data: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png' }],
          attachments: [{ name: 'notes.md', path: '/workspace/PilotDeck/notes.md', size: 2048, mimeType: 'text/markdown' }],
        },
      }],
    }));
    renderGroup();

    expect(await screen.findByAltText('diagram.png')).toBeTruthy();
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
  });

  it('renders path-backed images through the group message image endpoint', async () => {
    apiMock.groupMessages.mockResolvedValue(jsonResponse({
      messages: [{
        ...messages[0],
        id: 'message-with-path-image',
        metadata: {
          images: [{
            name: 'image.png',
            path: '/legacy/general/users/1/general/.tmp/chat-attachments/image.png',
            mimeType: 'image/png',
          }],
        },
      }],
    }));
    renderGroup();

    const image = await screen.findByAltText('image.png');
    expect(image.getAttribute('src')).toBe('/api/groups/group-1/messages/message-with-path-image/images/0');
    expect(apiMock.groupMessageImageUrl).toHaveBeenCalledWith('group-1', 'message-with-path-image', 0);
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
        conversationId: 'conversation-1',
      });
    });
  });

  it('selects a named mention with arrow keys and deletes it atomically', async () => {
    renderGroup();
    const editor = await screen.findByRole('textbox', { name: '群组消息' });
    fireEvent.click(screen.getByRole('button', { name: /提及成员/ }));
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });

    const chip = editor.querySelector<HTMLElement>('[data-mention-id="finance"]');
    expect(chip?.textContent).toBe('@财务');
    expect(chip?.contentEditable).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '发送群组消息' }));
    await waitFor(() => {
      expect(apiMock.sendGroupMessage).toHaveBeenCalledWith(group.id, {
        content: '@财务',
        mentionedMemberIds: ['finance'],
        mentionAll: false,
        conversationId: 'conversation-1',
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
    expect(editor.querySelector('[data-mention-id="finance"]')).toBeNull();
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
        metadata: { state: 'completed', targetMemberId: 'finance', targetMemberName: '财务', responseMessageId: 'm1' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'm1', roomId: group.id, roundId: 'r1', sequence: 4, kind: 'chat', senderType: 'agent',
        senderMemberId: 'finance', senderName: '财务', replyToMessageId: 'd1', content: '我是财务数字员工。',
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

    expect(await screen.findByText('PilotDeck 主智能体 · 已完成 2 步')).toBeTruthy();
    expect(screen.getByText('最近 2 步')).toBeTruthy();
    expect(screen.getByText('已调用 财务')).toBeTruthy();
    expect(screen.getByText('我是财务数字员工。')).toBeTruthy();
    expect(screen.getByText('工程师已经完成介绍。')).toBeTruthy();
    expect(screen.queryByText('需要工程师提供真实说明。')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看完整协作过程，共 2 步' }));
    const detail = screen.getByRole('complementary', { name: '协作过程详情' });
    expect(within(detail).getByText('需要工程师提供真实说明。')).toBeTruthy();
    expect(within(detail).getByText('请介绍你的实现职责。')).toBeTruthy();
    expect(within(detail).getByText('我是财务数字员工。')).toBeTruthy();
  });

  it('shows only the latest three process steps and includes StaffDeck delegation in the detail drawer', async () => {
    const staffMember = {
      ...member('staff-analyst', 'StaffDeck 分析师', 'staffdeck', 1),
      role: '经营数据分析',
      description: '分析经营数据并给出可执行的业务建议。',
      config: {
        employeeId: 'staff-analyst',
        staffdeckAccess: 'public',
        creatorDisplayName: 'StaffDeck 发布者',
        expertiseTags: ['经营分析', '指标诊断'],
      },
    };
    const staffGroup = { ...group, members: [staffMember, ...group.members] };
    const collaboration: AgentGroupMessage[] = [
      {
        id: 'u1', roomId: group.id, roundId: 'r2', sequence: 1, kind: 'chat', senderType: 'user',
        senderUserId: 1, senderName: '你', content: '请让员工分析', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'a1', roomId: group.id, roundId: 'r2', sequence: 2, kind: 'activity', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '先理解需求和成员能力。',
        metadata: { activityType: 'reasoning', state: 'completed' }, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'a2', roomId: group.id, roundId: 'r2', sequence: 3, kind: 'activity', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '找到项目资料。',
        metadata: { activityType: 'tool', toolName: 'glob', state: 'completed' }, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'a3', roomId: group.id, roundId: 'r2', sequence: 4, kind: 'activity', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '读取了需求文档。',
        metadata: { activityType: 'tool', toolName: 'read_file', state: 'completed' }, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'd1', roomId: group.id, roundId: 'r2', sequence: 5, kind: 'delegation', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '请基于资料给出分析。',
        metadata: { state: 'completed', targetMemberId: staffMember.id, targetMemberName: staffMember.name, responseMessageId: 'm1' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'm1', roomId: group.id, roundId: 'r2', sequence: 6, kind: 'chat', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, replyToMessageId: 'd1', content: '分析完成。',
        metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
    ];
    apiMock.group.mockResolvedValue(jsonResponse({ group: staffGroup }));
    apiMock.groupMessages.mockResolvedValue(jsonResponse({ messages: collaboration }));
    renderGroup();

    expect(await screen.findByText('PilotDeck 主智能体 · 已完成 4 步')).toBeTruthy();
    expect(screen.getByText('最近 3 步')).toBeTruthy();
    expect(screen.queryByText('已完成思考')).toBeNull();
    expect(screen.getByText('已调用 glob')).toBeTruthy();
    expect(screen.getByText('已调用 read_file')).toBeTruthy();
    expect(screen.getByText('已调用 StaffDeck 分析师')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看完整协作过程，共 4 步' }));
    const detail = screen.getByRole('complementary', { name: '协作过程详情' });
    expect(within(detail).getByText('先理解需求和成员能力。')).toBeTruthy();
    expect(within(detail).getByText('StaffDeck')).toBeTruthy();
    expect(within(detail).getByText('公开员工')).toBeTruthy();
    expect(within(detail).getByText('经营数据分析 · 员工 ID：staff-analyst')).toBeTruthy();
    expect(within(detail).getByText('创建者：StaffDeck 发布者')).toBeTruthy();
    expect(within(detail).getByText('专长：经营分析 · 指标诊断')).toBeTruthy();
    expect(within(detail).getByText('分析经营数据并给出可执行的业务建议。')).toBeTruthy();
    expect(within(detail).getByText('请基于资料给出分析。')).toBeTruthy();
    expect(within(detail).getByText('分析完成。')).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: '关闭协作过程详情' }));
    expect(screen.queryByRole('complementary', { name: '协作过程详情' })).toBeNull();
  });

  it('collapses StaffDeck stream steps in the timeline and expands every step in the detail drawer', async () => {
    const staffMember = {
      ...member('finance-stream', '财务', 'staffdeck', 1),
      role: '财务数字员工',
      config: { employeeId: 'finance-stream', staffdeckAccess: 'owned' },
    };
    const staffGroup = { ...group, members: [staffMember, member('main', 'PilotDeck 主智能体', 'pilotdeck_main', 10_000)] };
    const collaboration: AgentGroupMessage[] = [
      {
        id: 'u-stream', roomId: group.id, roundId: 'r-stream', sequence: 1, kind: 'chat', senderType: 'user',
        senderUserId: 1, senderName: '你', content: '请让财务分析', metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'a-main', roomId: group.id, roundId: 'r-stream', sequence: 2, kind: 'activity', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '需要财务员工提供专业意见。',
        metadata: { activityType: 'reasoning', state: 'completed' }, status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'd-stream', roomId: group.id, roundId: 'r-stream', sequence: 3, kind: 'delegation', senderType: 'agent',
        senderMemberId: 'main', senderName: 'PilotDeck 主智能体', content: '请评估预算。',
        metadata: { state: 'completed', targetMemberId: staffMember.id, targetMemberName: staffMember.name, responseMessageId: 'm-stream' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'sd-queued', roomId: group.id, roundId: 'r-stream', sequence: 4, kind: 'activity', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, content: 'Run 已进入执行队列。',
        metadata: { activityType: 'staffdeck', state: 'completed', staffDeckEventType: 'job.queued', staffDeckRunId: 'apijob-1', staffDeckLabel: '等待 StaffDeck 调度' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'sd-planning', roomId: group.id, roundId: 'r-stream', sequence: 5, kind: 'activity', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, content: '阶段：planning',
        metadata: { activityType: 'staffdeck', state: 'completed', staffDeckEventType: 'run.status', staffDeckPhase: 'planning', staffDeckRunId: 'apijob-1', staffDeckLabel: '正在规划本轮任务' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'sd-output', roomId: group.id, roundId: 'r-stream', sequence: 6, kind: 'activity', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, content: '第 2 个动作',
        metadata: {
          activityType: 'staffdeck', state: 'completed', staffDeckEventType: 'run.capability.completed',
          staffDeckRunId: 'apijob-1', staffDeckLabel: '能力调用完成 knowledge_search',
          staffDeckStepKind: 'tool', staffDeckToolName: 'knowledge_search',
          staffDeckOutputTitle: '能力调用结果', staffDeckOutput: '{\n  "match_count": 3,\n  "title": "报销政策"\n}',
        },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'sd-final-output', roomId: group.id, roundId: 'r-stream', sequence: 7, kind: 'activity', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, content: '预算充足，可以执行。',
        metadata: { activityType: 'staffdeck', state: 'completed', staffDeckEventType: 'run.output.completed', staffDeckRunId: 'apijob-1', staffDeckLabel: '数字员工已生成回复' },
        status: 'completed', createdAt: now, updatedAt: now,
      },
      {
        id: 'm-stream', roomId: group.id, roundId: 'r-stream', sequence: 8, kind: 'chat', senderType: 'agent',
        senderMemberId: staffMember.id, senderName: staffMember.name, replyToMessageId: 'd-stream', content: '预算充足，可以执行。',
        metadata: {}, status: 'completed', createdAt: now, updatedAt: now,
      },
    ];
    apiMock.group.mockResolvedValue(jsonResponse({ group: staffGroup }));
    apiMock.groupMessages.mockResolvedValue(jsonResponse({ messages: collaboration }));
    renderGroup();

    expect(await screen.findByText('PilotDeck 主智能体 · 已完成 6 步')).toBeTruthy();
    expect(screen.getByText('最近 3 步')).toBeTruthy();
    expect(screen.getByRole('button', { name: '能力调用完成 knowledge_search' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Run 已进入执行队列。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '能力调用完成 knowledge_search' }));
    expect(screen.getByText('能力调用结果')).toBeTruthy();
    expect(screen.getByText(/报销政策/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看完整协作过程，共 6 步' }));
    const detail = screen.getByRole('complementary', { name: '协作过程详情' });
    expect(within(detail).getByText('Run 已进入执行队列。')).toBeTruthy();
    expect(within(detail).getAllByText('阶段：planning')).toHaveLength(2);
    expect(within(detail).getByText('能力：knowledge_search')).toBeTruthy();
    expect(within(detail).getByText('能力调用结果')).toBeTruthy();
    expect(within(detail).getByText('事件：run.output.completed')).toBeTruthy();
    expect(within(detail).getAllByText('Run：apijob-1')).toHaveLength(4);
    expect(within(detail).getByRole('button', { name: '3. 等待 StaffDeck 调度' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(detail).getByRole('button', { name: '5. 能力调用完成 knowledge_search' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(detail).getByRole('button', { name: '6. 数字员工已生成回复' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('groups StaffDeck discovery by owned and public metadata without a local allowlist', async () => {
    apiMock.availableGroupMembers.mockResolvedValue(jsonResponse({
      local: [],
      mocks: [],
      staffdeckConfigured: true,
      staffdeckError: null,
      staffdeck: [
        {
          id: 'owned-1', kind: 'staffdeck', category: 'employee', name: '我的员工', role: '研发',
          employeeId: 'owned-1', staffdeckAccess: 'owned', creatorUsername: 'owner',
          expertiseTags: ['TypeScript'], publishedToGallery: false,
        },
        {
          id: 'public-1', kind: 'staffdeck', category: 'employee', name: '公开法务', role: '法务',
          employeeId: 'public-1', staffdeckAccess: 'public', creatorDisplayName: '公开发布者',
          publishedToGallery: true, usedByCurrentUser: false,
        },
      ],
    }));
    renderGroup();

    fireEvent.click(await screen.findByRole('button', { name: '邀请' }));
    expect(await screen.findByRole('heading', { name: '我创建的 StaffDeck 数字员工' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '公开可用的 StaffDeck 数字员工' })).toBeTruthy();
    expect(screen.getByText('我的员工')).toBeTruthy();
    expect(screen.getByText('公开法务')).toBeTruthy();
    expect(screen.getByText('创建者：owner')).toBeTruthy();
    expect(screen.getByText('创建者：公开发布者')).toBeTruthy();
    expect(screen.getByText('专长：TypeScript')).toBeTruthy();
    expect(screen.queryByText(/Mock/)).toBeNull();
  });

  it('hides group management actions from regular members', async () => {
    apiMock.group.mockResolvedValue(jsonResponse({ group: { ...group, participantRole: 'member' } }));
    renderGroup();

    expect(await screen.findByRole('heading', { name: '学生系统评审讨论' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '邀请' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '更多群组操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '群组设置' }));
    expect(await screen.findByRole('heading', { name: '群组设置' })).toBeTruthy();
    expect(screen.getByDisplayValue(group.title).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: '仅 @ 触发' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '归档群组' })).toBeNull();
    expect(screen.queryByRole('button', { name: '邀请' })).toBeNull();
  });
});
