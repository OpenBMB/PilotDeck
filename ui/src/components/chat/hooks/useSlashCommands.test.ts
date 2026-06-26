// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
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
    expect(removeActiveSlashQueryForTest('please /skill\nthis file', 7)).toBe('please \nthis file');
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
      value: '/skill_install \nthis file',
      caret: 15,
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
  });
});
