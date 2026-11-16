import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from '../../../utils/workspaceFileMention';
import { useFileMentions } from './useFileMentions';

const translate = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const { getFilesMock, authenticatedFetchMock } = vi.hoisted(() => ({
  getFilesMock: vi.fn(),
  authenticatedFetchMock: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: {
    getFiles: getFilesMock,
  },
  authenticatedFetch: authenticatedFetchMock,
}));

const project = {
  name: 'project-a',
  displayName: 'Project A',
  fullPath: '/workspace/project-a',
} as Project;

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement>;

describe('useFileMentions conversation scope', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    getFilesMock.mockReset();
    authenticatedFetchMock.mockReset();
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [],
        projectKey: project.fullPath,
      }),
    });
  });

  it('opens on @ and loads project entries from the dialog file API', async () => {
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          id: 'sha256:docs',
          name: 'docs',
          relativePath: 'docs',
          kind: 'directory',
          size: 0,
          mtimeMs: 1,
        }, {
          id: 'sha256:readme',
          name: 'README.md',
          relativePath: 'README.md',
          kind: 'file',
          size: 10,
          mtimeMs: 2,
        }],
        projectKey: project.fullPath,
      }),
    });
    const setInput = vi.fn();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '@',
      setInput,
      textareaRef,
    }));

    act(() => result.current.setCursorPosition(1));

    await waitFor(() => {
      expect(result.current.showFileDropdown).toBe(true);
      expect(result.current.filteredFiles).toHaveLength(2);
    });
    const requestedUrl = String(authenticatedFetchMock.mock.calls[0]?.[0] || '');
    expect(requestedUrl).toContain('/api/projects/files?');
    expect(requestedUrl).toContain('projectKey=%2Fworkspace%2Fproject-a');
    expect(requestedUrl).toContain('includeDirs=true');
    expect(requestedUrl).toContain('limit=100');
  });

  it('does not open or query project files when mentions are disabled', async () => {
    vi.useFakeTimers();
    const setInput = vi.fn();
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      enabled: false,
      mentionScopeKey: 'draft_input_general:session-a',
      input: '@',
      setInput,
      textareaRef,
    }));

    act(() => result.current.setCursorPosition(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(result.current.showFileDropdown).toBe(false);
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
  });

  it('queries and paginates through task identity instead of the source checkout', async () => {
    vi.useFakeTimers();
    authenticatedFetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      items: [{ name: url.includes('cursor=') ? 'second.md' : 'worktree-only.md', kind: 'file', relativePath: url.includes('cursor=') ? 'second.md' : 'worktree-only.md' }],
      nextCursor: url.includes('cursor=') ? undefined : 'next-page',
    }) }));
    const { result } = renderHook(() => useFileMentions({
      selectedProject: { ...project, fileOperationsKey: 'cron-task:task-a', workspaceCwd: '/task/worktree' },
      mentionScopeKey: 'cron:task-a', input: '@', setInput: vi.fn(), textareaRef,
    }));
    act(() => result.current.setCursorPosition(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(result.current.filteredFiles[0]?.name).toBe('worktree-only.md');
    expect(result.current.isLoadingFiles).toBe(false);
    await act(async () => result.current.loadMoreFiles());
    expect(result.current.filteredFiles.map(file => file.name)).toEqual(['worktree-only.md', 'second.md']);
    for (const [url] of authenticatedFetchMock.mock.calls) {
      expect(url).toContain('/api/projects/cron-task%3Atask-a/files/index?');
      expect(url).not.toContain('projectKey=');
      expect(url).not.toContain('project-a');
    }
    expect(authenticatedFetchMock.mock.calls[1][0]).toContain('cursor=next-page');
  });

  it('discards a late file response after the task workspace changes', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    authenticatedFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const { result, rerender } = renderHook(({ workspaceCwd }) => useFileMentions({
      selectedProject: { ...project, fileOperationsKey: 'cron-task:task-a', workspaceCwd },
      mentionScopeKey: 'cron:task-a', input: '@', setInput: vi.fn(), textareaRef,
    }), { initialProps: { workspaceCwd: '/task/old' } });
    act(() => result.current.setCursorPosition(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(authenticatedFetchMock).toHaveBeenCalledOnce();
    rerender({ workspaceCwd: '/task/new' });
    await act(async () => resolveOld({ ok: true, json: async () => ({ items: [{ name: 'old.md', kind: 'file' }], nextCursor: 'old-cursor' }) }));
    expect(result.current.filteredFiles).toEqual([]);
    expect(result.current.hasMoreFiles).toBe(false);
    act(() => result.current.setCursorPosition(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(authenticatedFetchMock).toHaveBeenCalledTimes(2);
  });

  it('suspends file queries while hidden and resumes without clearing selected references', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }) => useFileMentions({
      selectedProject: project, active, mentionScopeKey: 'cron:task-a', input: '@', setInput: vi.fn(), textareaRef,
    }), { initialProps: { active: true } });
    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, { detail: { projectName: project.name, relativePath: 'keep.md' } }));
      result.current.setCursorPosition(1);
    });
    rerender({ active: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(authenticatedFetchMock).not.toHaveBeenCalled();
    expect(result.current.selectedFileMentions.map(file => file.path)).toEqual(['keep.md']);
    rerender({ active: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(authenticatedFetchMock).toHaveBeenCalledOnce();
    expect(result.current.selectedFileMentions.map(file => file.path)).toEqual(['keep.md']);
  });

  it('does not reuse the previous conversation cursor for an external mention', () => {
    const setInput = vi.fn();
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

    expect(setInput).not.toHaveBeenCalled();
    expect(result.current.selectedFileMentions).toEqual([
      expect.objectContaining({
        name: 'report.docx',
        path: 'docs/report.docx',
      }),
    ]);
  });

  it('removes a selected file mention from the context row', () => {
    const setInput = vi.fn() as Dispatch<SetStateAction<string>>;
    const { result } = renderHook(() => useFileMentions({
      selectedProject: project,
      mentionScopeKey: 'draft_input_project-a:session-a',
      input: '',
      setInput,
      textareaRef,
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
        detail: { projectName: project.name, relativePath: 'docs/report.docx' },
      }));
    });

    act(() => {
      result.current.removeFileMention('docs/report.docx');
    });

    expect(result.current.selectedFileMentions).toEqual([]);
  });
});
