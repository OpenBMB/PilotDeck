import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent, FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../../types/app';
import { getThinkingModeAvailability } from '../constants/thinkingModeAvailability';
import { useChatComposerState } from './useChatComposerState';

const { authenticatedFetchMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: authenticatedFetchMock,
}));

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: vi.fn(),
  }),
}));

vi.mock('./useSlashCommands', () => ({
  useSlashCommands: () => ({
    slashCommands: [],
    slashCommandsCount: 0,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: '',
    showCommandMenu: false,
    selectedCommandIndex: 0,
    resetCommandMenuState: vi.fn(),
    dismissCommandMenu: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(),
    handleCommandInputChange: vi.fn(),
    handleCommandMenuKeyDown: () => false,
  }),
}));

vi.mock('./useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: vi.fn(),
    setCursorPosition: vi.fn(),
    handleFileMentionsKeyDown: () => false,
  }),
}));

const project = {
  name: 'project-a',
  displayName: 'Project A',
  fullPath: '/workspace/project-a',
} as Project;

const session = {
  id: 'web:s_existing',
  title: 'Existing session',
} as ProjectSession;

describe('useChatComposerState busy send queue', () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        images: [],
        files: [{ name: 'queued.txt', path: '/workspace/project-a/queued.txt' }],
      }),
    });
    localStorage.clear();
    sessionStorage.clear();
  });

  it('queues the first busy submit without sending a command', async () => {
    const harness = renderComposer({ isLoading: true, canAbortSession: true });
    changeInput(harness.result.current, 'queued request');

    await submit(harness.result.current);

    expect(harness.result.current.isBusySendQueued).toBe(true);
    expect(harness.result.current.isBusySendConfirmed).toBe(false);
    expect(harness.mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the latest queued text and attachments when the active turn completes', async () => {
    const harness = renderComposer({ isLoading: true, canAbortSession: true });
    changeInput(harness.result.current, 'initial queued request');
    await submit(harness.result.current);

    const file = new File(['queued'], 'queued.txt', { type: 'text/plain' });
    changeInput(harness.result.current, 'edited queued request');
    act(() => harness.result.current.setAttachedImages([file]));

    await act(async () => {
      harness.rerender({ isLoading: false, canAbortSession: false });
    });

    const command = pilotdeckCommands(harness.mocks.sendMessage)[0];
    expect(command).toMatchObject({
      command: expect.stringContaining('edited queued request'),
      options: {
        sessionId: 'web:s_existing',
        attachments: [expect.objectContaining({ name: 'queued.txt' })],
      },
    });
    expect(command.options.forceStart).toBeUndefined();
    expect(authenticatedFetchMock).toHaveBeenCalledOnce();
  });

  it('aborts on confirmation and force-starts the queued command after completion', async () => {
    const harness = renderComposer({ isLoading: true, canAbortSession: true });
    changeInput(harness.result.current, 'run next');
    await submit(harness.result.current);
    await submit(harness.result.current);

    expect(harness.result.current.isBusySendConfirmed).toBe(true);
    expect(harness.mocks.sendMessage).toHaveBeenCalledWith({
      type: 'abort-session',
      sessionId: 'web:s_existing',
      provider: 'pilotdeck',
    });

    await act(async () => {
      harness.rerender({ isLoading: false, canAbortSession: false });
    });

    expect(pilotdeckCommands(harness.mocks.sendMessage)).toEqual([
      expect.objectContaining({
        command: 'run next',
        options: expect.objectContaining({ forceStart: true }),
      }),
    ]);
  });

  it('manual stop cancels the queued command before aborting the session', async () => {
    const harness = renderComposer({ isLoading: true, canAbortSession: true });
    changeInput(harness.result.current, 'do not send this');
    await submit(harness.result.current);

    act(() => harness.result.current.handleAbortSession());
    expect(harness.result.current.isBusySendQueued).toBe(false);

    await act(async () => {
      harness.rerender({ isLoading: false, canAbortSession: false });
    });

    expect(pilotdeckCommands(harness.mocks.sendMessage)).toEqual([]);
    expect(harness.mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'abort-session',
      sessionId: 'web:s_existing',
    }));
  });
});

function renderComposer(initialProps: { isLoading: boolean; canAbortSession: boolean }) {
  const mocks = {
    sendMessage: vi.fn(),
    setIsLoading: vi.fn(),
    setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(),
    setClaudeStatus: vi.fn(),
    setPilotDeckStatus: vi.fn(),
  };
  const pendingViewSessionRef = { current: null };
  const hook = renderHook(
    (props: typeof initialProps) => useChatComposerState({
      selectedProject: project,
      selectedSession: session,
      currentSessionId: session.id,
      model: 'gpt-test',
      permissionMode: 'default',
      runMode: 'agent',
      cycleRunMode: vi.fn(),
      isLoading: props.isLoading,
      canAbortSession: props.canAbortSession,
      tokenBudget: null,
      thinkingModeAvailability: getThinkingModeAvailability(),
      sendMessage: mocks.sendMessage,
      pendingViewSessionRef,
      scrollToBottom: vi.fn(),
      addMessage: vi.fn(),
      clearMessages: vi.fn(),
      rewindMessages: vi.fn(),
      setIsLoading: mocks.setIsLoading,
      setCanAbortSession: mocks.setCanAbortSession,
      setIsAborting: mocks.setIsAborting,
      setClaudeStatus: mocks.setClaudeStatus,
      setPilotDeckStatus: mocks.setPilotDeckStatus,
      setIsUserScrolledUp: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
    }),
    { initialProps },
  );
  return { ...hook, mocks };
}

function changeInput(
  composer: ReturnType<typeof useChatComposerState>,
  value: string,
): void {
  const target = {
    value,
    selectionStart: value.length,
    style: { height: '' },
  } as unknown as HTMLTextAreaElement;
  act(() => composer.handleInputChange({ target } as ChangeEvent<HTMLTextAreaElement>));
}

async function submit(composer: ReturnType<typeof useChatComposerState>): Promise<void> {
  await act(async () => {
    await composer.handleSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>);
  });
}

function pilotdeckCommands(sendMessage: ReturnType<typeof vi.fn>) {
  return sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.type === 'pilotdeck-command');
}
