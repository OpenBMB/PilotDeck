// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposerState } from './useChatComposerState';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  uploadAttachmentBatch: vi.fn(),
  cancelAttachmentUpload: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock('../utils/attachmentUpload', () => ({
  uploadAttachmentBatch: mocks.uploadAttachmentBatch,
  cancelAttachmentUpload: mocks.cancelAttachmentUpload,
}));

describe('useChatComposerState attachment submission', () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ pinned: [], builtIn: [], custom: [] }),
    });
    mocks.cancelAttachmentUpload.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('does not create an optimistic sidebar session when attachment upload fails', async () => {
    mocks.uploadAttachmentBatch.mockRejectedValue(new Error('upload failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const onSessionActivityBump = vi.fn();
    const addMessage = vi.fn();
    const { result } = renderHook(() => useChatComposerState({
      selectedProject: {
        name: 'demo',
        displayName: 'Demo',
        fullPath: '/tmp/demo',
      },
      selectedSession: null,
      currentSessionId: null,
      model: 'provider/model',
      permissionMode: 'fullAccess',
      runMode: 'default',
      cycleRunMode: vi.fn(),
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: vi.fn(),
      onSessionActivityBump,
      pendingViewSessionRef: { current: null },
      scrollToBottom: vi.fn(),
      addMessage,
      clearMessages: vi.fn(),
      rewindMessages: vi.fn(),
      setIsLoading: vi.fn(),
      setCanAbortSession: vi.fn(),
      setIsAborting: vi.fn(),
      setClaudeStatus: vi.fn(),
      setPilotDeckStatus: vi.fn(),
      setIsUserScrolledUp: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
    }));

    act(() => {
      result.current.setInput('send this file');
      result.current.addAttachmentFiles([
        new File(['content'], 'broken.txt', { type: 'text/plain', lastModified: 1 }),
      ]);
    });

    await waitFor(() => {
      expect(result.current.input).toBe('send this file');
      expect(result.current.attachedImages).toHaveLength(1);
    });

    await result.current.handleSubmit({ preventDefault: vi.fn() } as never);

    expect(onSessionActivityBump).not.toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        content: 'Failed to upload attachments: broken.txt',
      }),
      null,
    );
  });

  it('keeps the draft and avoids loading state when a new-session command is disconnected', async () => {
    const onSessionActivityBump = vi.fn();
    const onSessionActive = vi.fn();
    const addMessage = vi.fn();
    const setIsLoading = vi.fn();
    const setCanAbortSession = vi.fn();
    const { result } = renderHook(() => useChatComposerState({
      selectedProject: {
        name: 'demo',
        displayName: 'Demo',
        fullPath: '/tmp/demo',
      },
      selectedSession: null,
      currentSessionId: null,
      model: 'provider/model',
      permissionMode: 'fullAccess',
      runMode: 'default',
      cycleRunMode: vi.fn(),
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: vi.fn(() => false),
      onSessionActivityBump,
      onSessionActive,
      pendingViewSessionRef: { current: null },
      scrollToBottom: vi.fn(),
      addMessage,
      clearMessages: vi.fn(),
      rewindMessages: vi.fn(),
      setIsLoading,
      setCanAbortSession,
      setIsAborting: vi.fn(),
      setClaudeStatus: vi.fn(),
      setPilotDeckStatus: vi.fn(),
      setIsUserScrolledUp: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
    }));

    act(() => result.current.setInput('keep this draft'));
    await result.current.handleSubmit({ preventDefault: vi.fn() } as never);

    expect(result.current.input).toBe('keep this draft');
    expect(onSessionActivityBump).not.toHaveBeenCalled();
    expect(onSessionActive).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalledWith(true);
    expect(setCanAbortSession).not.toHaveBeenCalledWith(true);
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('Connection lost'),
      }),
      null,
    );
  });
});
