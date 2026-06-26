// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
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
});
