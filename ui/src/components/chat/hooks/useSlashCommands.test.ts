// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import {
  buildSlashCommandInsertion,
  removeActiveSlashQueryForTest,
  useSlashCommands,
} from './useSlashCommands';
import type { Project } from '../../../types/app';

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const fetchMock = vi.mocked(authenticatedFetch);

const makeTextareaKeyEvent = (key: string) => ({
  key,
  preventDefault: vi.fn(),
  nativeEvent: {},
}) as unknown as KeyboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('useSlashCommands dismiss behavior', () => {
  it('removes a trailing slash query without leaving toolbar spacing behind', () => {
    expect(removeActiveSlashQueryForTest('please review /', 14)).toBe('please review');
    expect(removeActiveSlashQueryForTest('please review /skill', 14)).toBe('please review');
  });

  it('keeps the text after a slash query without adding double spaces', () => {
    expect(removeActiveSlashQueryForTest('please /skill this file', 7)).toBe('please this file');
    expect(removeActiveSlashQueryForTest('/skill this file', 0)).toBe('this file');
  });

  it('keeps multiline text after a slash query when dismissing the menu', () => {
    expect(removeActiveSlashQueryForTest('please /skill\nthis file', 7)).toBe('please\nthis file');
    expect(removeActiveSlashQueryForTest('/skill\nthis file', 0)).toBe('this file');
  });

  it('leaves input unchanged when there is no active slash query', () => {
    expect(removeActiveSlashQueryForTest('please review', -1)).toBe('please review');
    expect(removeActiveSlashQueryForTest('please review', 4)).toBe('please review');
  });
});

describe('useSlashCommands command insertion behavior', () => {
  it('replaces a partial slash query with the selected command', () => {
    expect(buildSlashCommandInsertion('please /skill_inst', 7, '/skill_install')).toEqual({
      value: 'please /skill_install ',
      caret: 22,
    });
  });

  it('keeps trailing text with a single separator after the selected command', () => {
    expect(buildSlashCommandInsertion('please /skill_inst this file', 7, '/skill_install')).toEqual({
      value: 'please /skill_install this file',
      caret: 22,
    });
    expect(buildSlashCommandInsertion('/skill this file', 0, '/skill_install')).toEqual({
      value: '/skill_install this file',
      caret: 15,
    });
  });

  it('preserves multiline tail text when replacing the query', () => {
    expect(buildSlashCommandInsertion('/skill\nthis file', 0, '/skill_install')).toEqual({
      value: '/skill_install\nthis file',
      caret: 14,
    });
    expect(buildSlashCommandInsertion('please /skill\nthis file', 7, '/skill_install')).toEqual({
      value: 'please /skill_install\nthis file',
      caret: 21,
    });
  });

  it('falls back to appending the command with safe spacing when no slash is active', () => {
    expect(buildSlashCommandInsertion('please review', -1, '/skill_install')).toEqual({
      value: 'please review /skill_install ',
      caret: 29,
    });
    expect(buildSlashCommandInsertion('please review ', -1, '/skill_install')).toEqual({
      value: 'please review /skill_install ',
      caret: 29,
    });
  });
});

describe('useSlashCommands query filtering behavior', () => {
  it('updates the slash query synchronously for fast keyboard confirmation', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [
          { name: '/clear', description: 'Clear chat' },
          { name: '/skill_install', description: 'Install a skill' },
        ],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: '/skill' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(2);
    });

    act(() => {
      result.current.handleCommandInputChange('/skill', 6);
    });

    expect(result.current.commandQuery).toBe('skill');

    await waitFor(() => {
      expect(result.current.filteredCommands.map((command) => command.name)).toEqual([
        '/skill_install',
      ]);
    });

    await waitFor(() => {
      expect(result.current.selectedCommandIndex).toBe(0);
    });
  });

  it('keeps the first visible command highlighted after narrowing to a same-size result set', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [
          { name: '/apple', description: 'Open apple workflow' },
          { name: '/apricot', description: 'Open apricot workflow' },
          { name: '/banana', description: 'Open banana workflow' },
          { name: '/bandana', description: 'Open bandana workflow' },
        ],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: '/ap' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(4);
    });

    act(() => {
      result.current.handleCommandInputChange('/ap', 3);
    });

    await waitFor(() => {
      expect(result.current.filteredCommands).toHaveLength(2);
      expect(result.current.selectedCommandIndex).toBe(0);
    });

    act(() => {
      result.current.handleCommandMenuKeyDown(makeTextareaKeyEvent('ArrowDown'));
    });

    expect(result.current.selectedCommandIndex).toBe(1);

    act(() => {
      result.current.handleCommandInputChange('/ban', 4);
    });

    await waitFor(() => {
      expect(result.current.filteredCommands).toHaveLength(2);
      expect(result.current.filteredCommands.map((command) => command.name)).toEqual([
        '/banana',
        '/bandana',
      ]);
      expect(result.current.selectedCommandIndex).toBe(0);
    });
  });

  it('does not let Enter or Tab submit when the open slash menu has no matches', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: '/unknown' };
    const setInput = vi.fn();
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleCommandInputChange('/unknown', 8);
    });

    await waitFor(() => {
      expect(result.current.showCommandMenu).toBe(true);
      expect(result.current.filteredCommands).toHaveLength(0);
    });

    const enterEvent = makeTextareaKeyEvent('Enter');
    const tabEvent = makeTextareaKeyEvent('Tab');

    let enterHandled = false;
    let tabHandled = false;
    act(() => {
      enterHandled = result.current.handleCommandMenuKeyDown(enterEvent);
      tabHandled = result.current.handleCommandMenuKeyDown(tabEvent);
    });

    expect(enterHandled).toBe(true);
    expect(tabHandled).toBe(true);
    expect(enterEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(tabEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(setInput).not.toHaveBeenCalled();
  });

  it('keeps built-in commands in the expected slash menu group order', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [{ name: '/project', namespace: 'project', description: 'Run project command' }],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(2);
    });

    act(() => {
      result.current.handleCommandInputChange('/', 1);
    });

    await waitFor(() => {
      expect(result.current.filteredCommands.map((command) => command.name)).toEqual([
        '/clear',
        '/project',
      ]);
    });
    expect(result.current.filteredCommands[0].type).toBe('builtin');
  });

  it('dismisses an unmatched slash query with Escape instead of leaving it behind', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: 'please /unknown' };
    const setInput = vi.fn((next: string | ((previous: string) => string)) => {
      inputValueRef.current = typeof next === 'function' ? next(inputValueRef.current) : next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleCommandInputChange('please /unknown', 15);
    });

    await waitFor(() => {
      expect(result.current.showCommandMenu).toBe(true);
      expect(result.current.filteredCommands).toHaveLength(0);
    });

    const escapeEvent = makeTextareaKeyEvent('Escape');

    let handled = false;
    act(() => {
      handled = result.current.handleCommandMenuKeyDown(escapeEvent);
    });

    expect(handled).toBe(true);
    expect(escapeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(inputValueRef.current).toBe('please');
  });
});

describe('useSlashCommands command history identity', () => {
  it('uses command identity instead of name alone when sorting duplicate slash commands', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/run::custom::/tmp/general/.pilotdeck/commands/run.md': 7,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/run', description: 'Run built-in workflow' }],
        custom: [
          {
            name: '/run',
            description: 'Run project workflow',
            path: '/tmp/general/.pilotdeck/commands/run.md',
          },
        ],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(2);
    });

    expect(result.current.slashCommands[0].path).toBe('/tmp/general/.pilotdeck/commands/run.md');
    expect(result.current.frequentCommands).toHaveLength(1);
    expect(result.current.frequentCommands[0].path).toBe('/tmp/general/.pilotdeck/commands/run.md');
  });

  it('matches pinned commands by identity instead of pinning every duplicate name', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/favorite::custom::/tmp/general/.pilotdeck/commands/favorite.md': 12,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [
          { name: '/clear', description: 'Clear chat' },
          { name: '/run', description: 'Run built-in workflow' },
        ],
        custom: [
          {
            name: '/run',
            description: 'Run project workflow',
            path: '/tmp/general/.pilotdeck/commands/run.md',
          },
          {
            name: '/favorite',
            description: 'Run favorite project workflow',
            path: '/tmp/general/.pilotdeck/commands/favorite.md',
          },
        ],
        pinned: [
          { name: '/clear', namespace: 'pinned', description: 'Clear chat' },
          { name: '/run', namespace: 'pinned', description: 'Run built-in workflow' },
        ],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(4);
    });

    expect(result.current.slashCommands.map((command) => command.path || command.name)).toEqual([
      '/clear',
      '/run',
      '/tmp/general/.pilotdeck/commands/favorite.md',
      '/tmp/general/.pilotdeck/commands/run.md',
    ]);
  });

  it('keeps used pinned commands in the pinned group instead of moving them to frequent', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/clear::builtin::': 9,
        '/favorite::custom::/tmp/general/.pilotdeck/commands/favorite.md': 3,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', namespace: 'pinned', description: 'Clear chat' }],
        custom: [
          {
            name: '/favorite',
            description: 'Run favorite project workflow',
            path: '/tmp/general/.pilotdeck/commands/favorite.md',
          },
        ],
        pinned: [{ name: '/clear', namespace: 'pinned', description: 'Clear chat' }],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(2);
    });

    expect(result.current.frequentCommands.map((command) => command.name)).toEqual([
      '/favorite',
    ]);

    act(() => {
      result.current.handleCommandInputChange('/', 1);
    });

    await waitFor(() => {
      expect(result.current.filteredCommands.map((command) => ({
        name: command.name,
        group: command.displayNamespace || command.namespace || command.type,
      }))).toEqual([
        { name: '/clear', group: 'pinned' },
        { name: '/favorite', group: 'frequent' },
      ]);
    });
  });

  it('records selected command history under the stable command identity', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/run': 4,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [],
        custom: [
          {
            name: '/run',
            description: 'Run project workflow',
            path: '/tmp/general/.pilotdeck/commands/run.md',
          },
        ],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 0, false);
    });

    const savedHistory = JSON.parse(localStorage.getItem('command_history_general') || '{}');
    expect(savedHistory).toEqual({
      '/run::custom::/tmp/general/.pilotdeck/commands/run.md': 5,
    });
    expect(savedHistory['/run']).toBeUndefined();
  });

  it('records frequent command selections under the original command identity', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/run::custom::/tmp/general/.pilotdeck/commands/run.md': 4,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [],
        custom: [
          {
            name: '/run',
            description: 'Run project workflow',
            path: '/tmp/general/.pilotdeck/commands/run.md',
          },
        ],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
      expect(result.current.frequentCommands).toHaveLength(1);
    });

    act(() => {
      result.current.handleCommandInputChange('/', 1);
    });

    await waitFor(() => {
      expect(result.current.filteredCommands[0].displayNamespace).toBe('frequent');
    });

    act(() => {
      result.current.handleCommandSelect(result.current.filteredCommands[0], 0, false);
    });

    const savedHistory = JSON.parse(localStorage.getItem('command_history_general') || '{}');
    expect(savedHistory).toEqual({
      '/run::custom::/tmp/general/.pilotdeck/commands/run.md': 5,
    });
    expect(savedHistory['/run::frequent::/tmp/general/.pilotdeck/commands/run.md']).toBeUndefined();
  });

  it('records pinned built-in selections under the builtin command identity', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', namespace: 'pinned', description: 'Clear chat' }],
        custom: [],
        pinned: [{ name: '/clear', namespace: 'pinned', description: 'Clear chat' }],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 0, false);
    });

    const savedHistory = JSON.parse(localStorage.getItem('command_history_general') || '{}');
    expect(savedHistory).toEqual({
      '/clear::builtin::': 1,
    });
    expect(savedHistory['/clear::pinned::']).toBeUndefined();
  });

  it('keeps legacy name-only command history as a migration fallback', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/clear': 3,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [
          { name: '/help', description: 'Show help' },
          { name: '/clear', description: 'Clear chat' },
        ],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(2);
    });

    expect(result.current.slashCommands[0].name).toBe('/clear');
    expect(result.current.frequentCommands[0].name).toBe('/clear');
  });

  it('migrates legacy built-in command history keys to the normalized builtin identity', async () => {
    localStorage.setItem(
      'command_history_general',
      JSON.stringify({
        '/clear::built-in::': 2,
      }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [{ name: '/clear', description: 'Clear chat' }],
        custom: [],
      }),
    } as Response);

    const inputValueRef = { current: '/' };
    const setInput = vi.fn((next: string) => {
      inputValueRef.current = next;
    });
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useSlashCommands({
        selectedProject,
        input: inputValueRef.current,
        setInput,
        textareaRef,
        inputValueRef,
      }),
    );

    await waitFor(() => {
      expect(result.current.slashCommandsCount).toBe(1);
    });

    expect(result.current.frequentCommands[0].name).toBe('/clear');

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 0, false);
    });

    const savedHistory = JSON.parse(localStorage.getItem('command_history_general') || '{}');
    expect(savedHistory).toEqual({
      '/clear::builtin::': 3,
    });
    expect(savedHistory['/clear::built-in::']).toBeUndefined();
  });
});
