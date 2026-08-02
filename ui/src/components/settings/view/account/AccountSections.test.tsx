// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  projectMembers: vi.fn(),
  projectMemberCandidates: vi.fn(),
}));

vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 2, username: 'alice', displayName: 'Alice', systemRole: 'member' },
    logout: vi.fn(),
  }),
}));

vi.mock('../../../../utils/api', () => ({
  api: {
    auth: {
      status: vi.fn(async () => new Response(JSON.stringify({ authEnabled: true }), { status: 200 })),
      enable: vi.fn(),
      changePassword: vi.fn(),
    },
    account: {
      sessions: vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
      update: vi.fn(),
      revokeSession: vi.fn(),
    },
    instances: {
      list: vi.fn(async () => new Response(JSON.stringify({ instances: [] }), { status: 200 })),
      create: vi.fn(), setDefault: vi.fn(), remove: vi.fn(),
    },
    projects: vi.fn(async () => new Response(JSON.stringify([
      { name: 'shared', displayName: 'Shared', fullPath: '/workspace/shared', projectRole: 'owner' },
    ]), { status: 200 })),
    projectMembers: mocks.projectMembers,
    projectMemberCandidates: mocks.projectMemberCandidates,
    setProjectMember: vi.fn(),
    removeProjectMember: vi.fn(),
    admin: {},
  },
}));

import AccountSections from './index';

describe('account and project access settings', () => {
  beforeEach(() => {
    mocks.projectMembers.mockReset().mockResolvedValue(new Response(JSON.stringify({
      members: [{ user_id: 2, username: 'alice', display_name: 'Alice', role: 'owner' }],
    }), { status: 200 }));
    mocks.projectMemberCandidates.mockReset().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ id: 3, username: 'bob', displayName: 'Bob' }],
    }), { status: 200 }));
  });

  it('lets a system member manage ACLs when they are the project owner', async () => {
    render(<AccountSections title="账号与成员" />);
    expect(await screen.findByText('项目成员权限')).toBeTruthy();
    expect(screen.queryByText('用户管理')).toBeNull();

    fireEvent.change(screen.getByDisplayValue('选择由你管理的项目'), { target: { value: 'shared' } });
    await waitFor(() => expect(mocks.projectMembers).toHaveBeenCalledWith('shared'));
    await waitFor(() => expect(mocks.projectMemberCandidates).toHaveBeenCalledWith('shared'));
    expect(await screen.findByText('Bob (@bob)')).toBeTruthy();
  });
});
