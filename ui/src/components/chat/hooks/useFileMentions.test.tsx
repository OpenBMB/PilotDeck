// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import { useFileMentions } from './useFileMentions';

vi.mock('../../../utils/api', () => ({
  api: {
    getFiles: vi.fn(),
  },
}));

const getFilesMock = vi.mocked(api.getFiles);

const makeTextareaKeyEvent = (key: string) => ({
  key,
  preventDefault: vi.fn(),
  nativeEvent: {},
}) as unknown as KeyboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFileMentions selection behavior', () => {
  it('highlights the first matching file by default so Enter selection is visible', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory', children: [{ name: 'ComposerV2.tsx', type: 'file' }] },
      ],
    } as Response);

    const setInput = vi.fn();
    const textareaRef = { current: document.createElement('textarea') };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useFileMentions({
        selectedProject,
        input: '@',
        setInput,
        textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      }),
    );

    act(() => {
      result.current.setCursorPosition(1);
    });

    await waitFor(() => {
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual([
        'README.md',
        'src/ComposerV2.tsx',
      ]);
    });

    expect(result.current.showFileDropdown).toBe(true);
    expect(result.current.selectedFileIndex).toBe(0);
  });

  it('updates the highlighted file suggestion from mouse hover', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory', children: [{ name: 'ComposerV2.tsx', type: 'file' }] },
      ],
    } as Response);

    const setInput = vi.fn();
    const textareaRef = { current: document.createElement('textarea') };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useFileMentions({
        selectedProject,
        input: '@',
        setInput,
        textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      }),
    );

    act(() => {
      result.current.setCursorPosition(1);
    });

    await waitFor(() => {
      expect(result.current.filteredFiles).toHaveLength(2);
    });

    act(() => {
      result.current.highlightFileSuggestion(1);
    });

    expect(result.current.selectedFileIndex).toBe(1);
  });

  it('does not let Enter or Tab submit when the open file menu has no matches', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);

    const setInput = vi.fn();
    const textareaRef = { current: document.createElement('textarea') };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useFileMentions({
        selectedProject,
        input: '@missing',
        setInput,
        textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      }),
    );

    act(() => {
      result.current.setCursorPosition(8);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles).toHaveLength(0);
    });

    const enterEvent = makeTextareaKeyEvent('Enter');
    const tabEvent = makeTextareaKeyEvent('Tab');

    let enterHandled = false;
    let tabHandled = false;
    act(() => {
      enterHandled = result.current.handleFileMentionsKeyDown(enterEvent);
      tabHandled = result.current.handleFileMentionsKeyDown(tabEvent);
    });

    expect(enterHandled).toBe(true);
    expect(tabHandled).toBe(true);
    expect(enterEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(tabEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(setInput).not.toHaveBeenCalled();
  });

  it('closes an empty file mention menu with Escape', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);

    const setInput = vi.fn();
    const textareaRef = { current: document.createElement('textarea') };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result } = renderHook(() =>
      useFileMentions({
        selectedProject,
        input: '@missing',
        setInput,
        textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
      }),
    );

    act(() => {
      result.current.setCursorPosition(8);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles).toHaveLength(0);
    });

    const escapeEvent = makeTextareaKeyEvent('Escape');

    let handled = false;
    act(() => {
      handled = result.current.handleFileMentionsKeyDown(escapeEvent);
    });

    expect(handled).toBe(true);
    expect(escapeEvent.preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(false);
    });
  });

  it('keeps a dismissed empty file mention menu closed until the query changes', async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'README.md', type: 'file' }],
    } as Response);

    const setInput = vi.fn();
    const textareaRef = { current: document.createElement('textarea') };
    const selectedProject = {
      name: 'general',
      path: '/tmp/general',
      fullPath: '/tmp/general',
    } as Project;

    const { result, rerender } = renderHook(
      ({ input }) =>
        useFileMentions({
          selectedProject,
          input,
          setInput,
          textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
        }),
      { initialProps: { input: '@missing' } },
    );

    act(() => {
      result.current.setCursorPosition(8);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles).toHaveLength(0);
    });

    act(() => {
      result.current.handleFileMentionsKeyDown(makeTextareaKeyEvent('Escape'));
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(false);
    });

    rerender({ input: '@missing' });

    expect(result.current.showFileDropdown).toBe(false);

    rerender({ input: '@read' });

    act(() => {
      result.current.setCursorPosition(5);
    });

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles.map((file) => file.path)).toEqual(['README.md']);
    });
  });
});
