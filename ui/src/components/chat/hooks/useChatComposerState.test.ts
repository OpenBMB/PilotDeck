// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, authenticatedFetch } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { QueuedChatInput } from '../types/types';
import {
  canQueueInputForTest,
  getNextDispatchableQueuedInputForTest,
  hasActiveSlashQueryForTest,
  insertComposerTokenForTest,
  moveQueuedInputForTest,
  settleQueuedDispatchForTest,
  shouldCycleRunModeOnKeyDown,
  useChatComposerState,
} from './useChatComposerState';

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
  api: {
    getFiles: vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    })),
  },
}));

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: vi.fn(),
  }),
}));

const fetchMock = vi.mocked(authenticatedFetch);
const getFilesMock = vi.mocked(api.getFiles);

beforeEach(() => {
  fetchMock.mockReset();
  getFilesMock.mockReset();
  getFilesMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  } as Response);
});

afterEach(() => {
  localStorage.clear();
});

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey };
}

const renderComposerState = () => {
  const selectedProject = {
    name: 'general',
    path: '/tmp/general',
    fullPath: '/tmp/general',
  } as Project;

  return renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession: null,
      currentSessionId: null,
      model: 'test-model',
      permissionMode: 'default',
      cycleRunMode: vi.fn(),
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: vi.fn(),
      sendByCtrlEnter: false,
      pendingViewSessionRef: { current: null },
      scrollToBottom: vi.fn(),
      addMessage: vi.fn(),
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
    }),
  );
};

describe('useChatComposerState keyboard shortcuts', () => {
  it('uses Shift+Tab to cycle run mode when no completion menu is open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(true);
  });

  it('does not cycle run mode for plain Tab or while menus are open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab'), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: true,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: true,
    })).toBe(false);
  });
});

describe('useChatComposerState composer token insertion', () => {
  it('inserts a separating space before toolbar slash commands after text', () => {
    expect(insertComposerTokenForTest('please review', 13, 13, '/')).toEqual({
      nextValue: 'please review /',
      nextCursor: 15,
    });
  });

  it('inserts a separating space before toolbar file mentions after text', () => {
    expect(insertComposerTokenForTest('please review', 13, 13, '@')).toEqual({
      nextValue: 'please review @',
      nextCursor: 15,
    });
  });

  it('keeps slash commands tight at the start or after existing whitespace', () => {
    expect(insertComposerTokenForTest('', 0, 0, '/')).toEqual({
      nextValue: '/',
      nextCursor: 1,
    });
    expect(insertComposerTokenForTest('please ', 7, 7, '/')).toEqual({
      nextValue: 'please /',
      nextCursor: 8,
    });
    expect(insertComposerTokenForTest('', 0, 0, '@')).toEqual({
      nextValue: '@',
      nextCursor: 1,
    });
    expect(insertComposerTokenForTest('please ', 7, 7, '@')).toEqual({
      nextValue: 'please @',
      nextCursor: 8,
    });
  });

  it('replaces selected text when inserting composer tokens', () => {
    expect(insertComposerTokenForTest('please replace this', 7, 14, '@')).toEqual({
      nextValue: 'please @ this',
      nextCursor: 8,
    });
  });
});

describe('useChatComposerState slash query detection', () => {
  it('detects only the slash query immediately before the caret', () => {
    expect(hasActiveSlashQueryForTest('/', 1)).toBe(true);
    expect(hasActiveSlashQueryForTest('please /skill', 13)).toBe(true);
    expect(hasActiveSlashQueryForTest('please /skill now', 13)).toBe(true);
    expect(hasActiveSlashQueryForTest('please /skill now', 18)).toBe(false);
    expect(hasActiveSlashQueryForTest('https://example.test', 20)).toBe(false);
    expect(hasActiveSlashQueryForTest('please /', 8)).toBe(true);
    expect(hasActiveSlashQueryForTest('please /', 99)).toBe(false);
  });
});

describe('useChatComposerState autocomplete coordination', () => {
  it('closes file mention suggestions when typing a slash query manually', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);
    localStorage.setItem('draft_input_general', '@read');

    const { result } = renderComposerState();

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleInputChange({
        target: { value: '@read', selectionStart: 5 },
      } as ChangeEvent<HTMLTextAreaElement>);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['README.md']);
    });

    act(() => {
      result.current.handleInputChange({
        target: { value: '@read /', selectionStart: 7 },
      } as ChangeEvent<HTMLTextAreaElement>);
    });

    expect(result.current.showFileDropdown).toBe(false);
    expect(result.current.filteredFiles).toEqual([]);
    expect(result.current.selectedFileIndex).toBe(-1);
    expect(result.current.showCommandMenu).toBe(true);
  });

  it('closes file mention suggestions when the composer is cleared', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);
    localStorage.setItem('draft_input_general', '@read');

    const { result } = renderComposerState();

    act(() => {
      result.current.handleInputChange({
        target: { value: '@read', selectionStart: 5 },
      } as ChangeEvent<HTMLTextAreaElement>);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['README.md']);
    });

    act(() => {
      result.current.handleClearInput();
    });

    expect(result.current.input).toBe('');
    expect(result.current.showFileDropdown).toBe(false);
    expect(result.current.filteredFiles).toEqual([]);
    expect(result.current.selectedFileIndex).toBe(-1);
  });

  it('closes an open file mention menu before inserting a slash command token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);
    localStorage.setItem('draft_input_general', '@read');

    const { result } = renderComposerState();

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleInputChange({
        target: { value: '@read', selectionStart: 5 },
      } as ChangeEvent<HTMLTextAreaElement>);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['README.md']);
    });

    const textarea = document.createElement('textarea');
    textarea.value = result.current.input;
    result.current.textareaRef.current = textarea;
    textarea.setSelectionRange(5, 5);

    act(() => {
      result.current.insertAtCursor('/');
    });

    expect(result.current.input).toBe('@read /');
    expect(result.current.showFileDropdown).toBe(false);
    expect(result.current.filteredFiles).toEqual([]);
    expect(result.current.selectedFileIndex).toBe(-1);
    expect(result.current.showCommandMenu).toBe(true);
  });

  it('closes an open slash command menu before inserting a file mention token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);
    localStorage.setItem('draft_input_general', '/');

    const { result } = renderComposerState();

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleInputChange({
        target: { value: '/', selectionStart: 1 },
      } as ChangeEvent<HTMLTextAreaElement>);
    });

    await waitFor(() => {
      expect(result.current.showCommandMenu).toBe(true);
    });

    const textarea = document.createElement('textarea');
    textarea.value = result.current.input;
    result.current.textareaRef.current = textarea;
    textarea.setSelectionRange(1, 1);

    act(() => {
      result.current.insertAtCursor('@');
    });

    expect(result.current.input).toBe('/ @');
    expect(result.current.showCommandMenu).toBe(false);
    expect(result.current.commandQuery).toBe('');
    expect(result.current.filteredCommands).toEqual([]);
  });
});

describe('useChatComposerState queued input ordering', () => {
  const makeQueue = (): QueuedChatInput[] => [
    { id: 'a', content: 'first', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    { id: 'b', content: 'second', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
    { id: 'c', content: 'third', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 3 },
  ];

  it('moves queued inputs up and down', () => {
    expect(moveQueuedInputForTest(makeQueue(), 'b', -1).map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'b', 1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('keeps order when moving past queue boundaries or missing ids', () => {
    expect(moveQueuedInputForTest(makeQueue(), 'a', -1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'c', 1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'x', 1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useChatComposerState queued input eligibility', () => {
  const makeQueue = (): QueuedChatInput[] => [
    { id: 'a', content: 'first', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    { id: 'b', content: 'second', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
  ];

  it('allows text-only queued input', () => {
    expect(canQueueInputForTest('next step', 0)).toBe(true);
  });

  it('rejects blank queued input', () => {
    expect(canQueueInputForTest('   \n\t', 0)).toBe(false);
  });

  it('rejects queued input with attachments', () => {
    expect(canQueueInputForTest('next step', 1)).toBe(false);
  });

  it('pauses on an invalid first queued item instead of skipping it', () => {
    const queue: QueuedChatInput[] = [
      { id: 'a', content: '   ', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
      { id: 'b', content: 'send me later', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
    ];

    expect(getNextDispatchableQueuedInputForTest(queue)).toBeNull();
  });

  it('returns the first valid queued item for dispatch', () => {
    const queue: QueuedChatInput[] = [
      { id: 'a', content: 'send me next', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    ];

    expect(getNextDispatchableQueuedInputForTest(queue)?.id).toBe('a');
  });

  it('keeps a queued input visible when dispatch fails', () => {
    const queue = makeQueue();

    expect(settleQueuedDispatchForTest(queue, 'a', false)).toEqual(queue);
  });

  it('removes only the dispatched queued input after successful dispatch', () => {
    expect(settleQueuedDispatchForTest(makeQueue(), 'a', true).map((item) => item.id)).toEqual(['b']);
    expect(settleQueuedDispatchForTest(makeQueue(), 'b', true).map((item) => item.id)).toEqual(['a']);
  });
});
