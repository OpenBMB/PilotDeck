import { act, renderHook } from '@testing-library/react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from '../../../utils/workspaceFileMention';
import { useFileMentions } from './useFileMentions';

const { getFilesMock } = vi.hoisted(() => ({
  getFilesMock: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: {
    getFiles: getFilesMock,
  },
}));

const project = {
  name: 'project-a',
  displayName: 'Project A',
  fullPath: '/workspace/project-a',
} as Project;

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement>;

describe('useFileMentions conversation scope', () => {
  beforeEach(() => {
    getFilesMock.mockReset();
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it('does not reuse the previous conversation cursor for an external mention', () => {
    const setInput = vi.fn() as Dispatch<SetStateAction<string>>;
    const { result, rerender } = renderHook(
      (props: { mentionScopeKey: string; input: string }) => useFileMentions({
        selectedProject: project,
        mentionScopeKey: props.mentionScopeKey,
        input: props.input,
        setInput,
        textareaRef,
      }),
      {
        initialProps: {
          mentionScopeKey: 'draft_input_project-a:session-a',
          input: 'abcdef',
        },
      },
    );

    act(() => result.current.setCursorPosition(2));
    rerender({
      mentionScopeKey: 'draft_input_project-a:session-b',
      input: 'xyz',
    });
    setInput.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: {
          projectName: project.name,
          relativePath: 'docs/report.docx',
        },
      }));
    });

    expect(setInput).toHaveBeenCalledWith('xyz docs/report.docx ');
  });
});
