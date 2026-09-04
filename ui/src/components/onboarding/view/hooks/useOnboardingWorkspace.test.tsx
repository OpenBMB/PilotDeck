// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useOnboardingWorkspace from './useOnboardingWorkspace';

const mocks = vi.hoisted(() => ({
  createWorkspaceRequest: vi.fn(),
  cloneWorkspaceWithProgress: vi.fn(),
}));

vi.mock('../../../project-creation-wizard/data/workspaceApi', () => ({
  createWorkspaceRequest: mocks.createWorkspaceRequest,
  cloneWorkspaceWithProgress: mocks.cloneWorkspaceWithProgress,
}));

describe('useOnboardingWorkspace retry safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorkspaceRequest.mockResolvedValue({ name: 'demo' });
    mocks.cloneWorkspaceWithProgress.mockResolvedValue({ name: 'demo' });
  });

  it('does not create the same workspace again after creation succeeds', async () => {
    const { result } = renderHook(() => useOnboardingWorkspace());
    act(() => result.current.setWorkspacePath('/workspace/demo'));

    await act(async () => result.current.createWorkspace());
    await act(async () => result.current.createWorkspace());

    expect(mocks.createWorkspaceRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceRequest).toHaveBeenCalledWith({
      workspaceType: 'new',
      path: '/workspace/demo',
    });
  });

  it('creates again when the workspace draft changes', async () => {
    const { result } = renderHook(() => useOnboardingWorkspace());
    act(() => result.current.setWorkspacePath('/workspace/first'));
    await act(async () => result.current.createWorkspace());

    act(() => result.current.setWorkspacePath('/workspace/second'));
    await act(async () => result.current.createWorkspace());

    expect(mocks.createWorkspaceRequest).toHaveBeenCalledTimes(2);
  });
});
