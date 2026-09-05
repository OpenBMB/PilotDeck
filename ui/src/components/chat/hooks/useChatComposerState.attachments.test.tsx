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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
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

  it.each([false, true])('snapshots the selected model before attachment preparation (queued=%s)', async (queued) => {
    let finishUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { finishUpload = resolve; });
    mocks.uploadAttachmentBatch.mockImplementation(async ({ files }: { files: File[] }) => {
      await uploadGate;
      return {
        uploadId: 'upload-model', attachmentIds: ['attachment-model'],
        attachments: files.map((file) => ({ attachmentId: 'attachment-model', name: file.name,
          relativePath: `.tmp/chat-uploads/upload-model/${file.name}`, bytes: file.size, mimeType: file.type })),
      };
    });
    const sendMessage = vi.fn(() => true);
    const enqueuePreparedInput = vi.fn(async () => ({ ok: true }));
    const registerEarlierChoice = vi.fn(() => vi.fn());
    const registerLaterChoice = vi.fn(() => vi.fn());
    const initialChoice = { mode: 'model' as const, provider: 'zeta', model: 'configured', reasoning: 0.8, temperature: 0.3, speed: 1 };
    const selectedProject = { name: 'demo', displayName: 'Demo', fullPath: '/tmp/demo' };
    const selectedSession = queued ? { id: 'web:queue' } : null;
    const { result, rerender } = renderHook(({ modelSelection, registerModelSelectionSubmission }) => useChatComposerState({
      selectedProject, selectedSession, currentSessionId: queued ? 'web:queue' : null,
      model: 'zeta/configured', modelSelection, isModelSelectionReady: true,
      registerModelSelectionSubmission,
      permissionMode: 'default', runMode: 'agent', cycleRunMode: vi.fn(), isLoading: queued,
      canAbortSession: queued, tokenBudget: null, sendMessage, enqueuePreparedInput,
      pendingViewSessionRef: { current: null }, scrollToBottom: vi.fn(), addMessage: vi.fn(),
      clearMessages: vi.fn(), rewindMessages: vi.fn(), setIsLoading: vi.fn(), setCanAbortSession: vi.fn(),
      setIsAborting: vi.fn(), setClaudeStatus: vi.fn(), setPilotDeckStatus: vi.fn(), setIsUserScrolledUp: vi.fn(),
      pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
    }), { initialProps: { modelSelection: initialChoice as import('./useChatProviderState').ChatModelSelection, registerModelSelectionSubmission: registerEarlierChoice } });
    act(() => {
      result.current.setInput('keep my selected model');
      result.current.addAttachmentFiles([new File(['content'], 'test.txt', { type: 'text/plain' })]);
    });
    await waitFor(() => expect(result.current.attachedImages).toHaveLength(1));
    let submitting!: Promise<void>;
    act(() => { submitting = result.current.handleSubmit({ preventDefault: vi.fn() } as never); });
    rerender({ modelSelection: { mode: 'auto' }, registerModelSelectionSubmission: registerLaterChoice });
    await act(async () => { finishUpload(); await submitting; });
    expect(queued ? enqueuePreparedInput : sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ modelSelection: initialChoice }),
    }));
    expect(registerEarlierChoice).toHaveBeenCalledOnce();
    expect(registerLaterChoice).not.toHaveBeenCalled();
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

  it('cancels a shared batch and sends only the attachment that remains selected', async () => {
    let uploadCall = 0;
    mocks.uploadAttachmentBatch.mockImplementation(async ({ files, signal, onCreated }: any) => {
      uploadCall += 1;
      const currentCall = uploadCall;
      onCreated?.(currentCall === 1 ? 'upload-old' : 'upload-new');
      if (currentCall === 1) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          uploadId: 'upload-old',
          attachmentIds: ['attachment-a', 'attachment-b-old'],
          attachments: files.map((file: File, index: number) => ({
            attachmentId: index === 0 ? 'attachment-a' : 'attachment-b-old',
            name: file.name,
            relativePath: `.tmp/chat-uploads/upload-old/${file.name}`,
          })),
        };
      }
      return {
        uploadId: 'upload-new',
        attachmentIds: ['attachment-b'],
        attachments: files.map((file: File) => ({
          attachmentId: 'attachment-b',
          name: file.name,
          relativePath: `.tmp/chat-uploads/upload-new/${file.name}`,
          bytes: file.size,
          mimeType: file.type,
        })),
      };
    });

    const sendMessage = vi.fn(() => true);
    const addMessage = vi.fn();
    const { result } = renderHook(() => useChatComposerState({
      selectedProject: { name: 'demo', displayName: 'Demo', fullPath: '/tmp/demo' },
      selectedSession: null,
      currentSessionId: null,
      model: 'provider/model',
      permissionMode: 'fullAccess',
      runMode: 'default',
      cycleRunMode: vi.fn(),
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage,
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
    const first = new File(['a'], 'a.txt', { type: 'text/plain', lastModified: 1 });
    const second = new File(['b'], 'b.txt', { type: 'text/plain', lastModified: 2 });

    act(() => {
      result.current.setInput('send remaining');
      result.current.addAttachmentFiles([first, second]);
    });
    await waitFor(() => expect(result.current.attachedImages).toHaveLength(2));

    let submitting!: Promise<void>;
    act(() => {
      submitting = result.current.handleSubmit({ preventDefault: vi.fn() } as never);
    });
    act(() => result.current.removeAttachedImage(0));
    await waitFor(() => expect(mocks.uploadAttachmentBatch).toHaveBeenCalledTimes(2));
    await submitting;

    expect(mocks.cancelAttachmentUpload).toHaveBeenCalledWith('upload-old');
    expect(mocks.uploadAttachmentBatch).toHaveBeenCalledTimes(2);
    expect(mocks.uploadAttachmentBatch.mock.calls[1][0].files).toEqual([second]);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        uploadedAttachments: [{ uploadId: 'upload-new', attachmentIds: ['attachment-b'] }],
      }),
    }));
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ name: 'b.txt', uploadId: 'upload-new' })],
    }), null);
  });
});
