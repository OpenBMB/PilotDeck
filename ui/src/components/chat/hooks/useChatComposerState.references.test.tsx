import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { createTextContentReference } from '../../../types/contentReference';
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from '../../../utils/workspaceFileMention';
import { useChatComposerState } from './useChatComposerState';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn(async () => ({
  ok: true, json: async () => ({ pinned: [], builtIn: [], custom: [] }),
})) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const project: Project = { name: 'demo', displayName: 'Demo', fullPath: '/fixture/demo' };
const reference = (id: string) => createTextContentReference({ id, selectionMode: 'text',
  source: { projectName: 'demo', fileName: 'report.md', relativePath: 'report.md' },
  renderer: { id: 'text', backend: 'builtin', locatorQuality: 'semantic' },
  locator: { surface: 'editor', quote: { exact: id } }, selectedText: id,
});
const quote = (id: string) => act(() => {
  window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference(id) }));
});
const mention = (projectName: string) => act(() => {
  window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, { detail: { projectName, relativePath: 'report.md' } }));
});

function setup(selectedProject: Project, sessionId: string, initialActive = true) {
  const sendMessage = vi.fn((_message: unknown) => true);
  const enqueuePreparedInput = vi.fn(async (_item: unknown) => ({ ok: true }));
  const view = renderHook(({ active }) => useChatComposerState({
    active, selectedProject, selectedSession: { id: sessionId }, currentSessionId: sessionId,
    model: 'test/model', permissionMode: 'default', cycleRunMode: vi.fn(), isLoading: false,
    canAbortSession: false, tokenBudget: null, sendMessage, enqueuePreparedInput,
    pendingViewSessionRef: { current: null }, scrollToBottom: vi.fn(), addMessage: vi.fn(),
    clearMessages: vi.fn(), rewindMessages: vi.fn(), setIsLoading: vi.fn(), setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(), setClaudeStatus: vi.fn(), setPilotDeckStatus: vi.fn(), setIsUserScrolledUp: vi.fn(),
    pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
  }), { initialProps: { active: initialActive } });
  return { ...view, sendMessage, enqueuePreparedInput };
}

it('quotes only into the active conversation while retaining hidden task drafts', async () => {
  const chat = setup(project, 'web:chat');
  const task = setup({ ...project, workspaceCwd: '/fixture/worktree', fileOperationsKey: 'cron-task:task' }, 'cron:task', false);
  act(() => task.result.current.setInput('Keep my task draft'));
  quote('ordinary quote'); mention('demo');
  expect(chat.result.current.documentReferences.map(ref => ref.id)).toEqual(['ordinary quote']);
  expect(chat.result.current.selectedFileMentions).toHaveLength(1);
  expect(task.result.current.documentReferences).toEqual([]);
  expect(task.result.current.selectedFileMentions).toEqual([]);
  chat.rerender({ active: false }); task.rerender({ active: true });
  quote('task quote'); mention('demo');
  expect(task.result.current.input).toBe('Keep my task draft');
  expect(task.result.current.documentReferences.map(ref => ref.id)).toEqual(['task quote']);
  expect(chat.result.current.documentReferences.map(ref => ref.id)).toEqual(['ordinary quote']);
  await act(async () => task.result.current.handleSubmit({ preventDefault() {} } as never));
  expect(task.enqueuePreparedInput).toHaveBeenCalledOnce();
  const command = task.enqueuePreparedInput.mock.calls[0][0];
  expect(JSON.stringify(command)).toContain('task quote');
  expect(JSON.stringify(command)).not.toContain('ordinary quote');
  expect(command).toMatchObject({ options: { attachments: expect.arrayContaining([expect.objectContaining({ path: '/fixture/worktree/report.md' })]) } });
});

it('does not steal focus when a quote is followed by navigation before the next frame', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const task = setup(project, 'cron:task');
  const textarea = document.createElement('textarea'); document.body.append(textarea);
  const focus = vi.spyOn(textarea, 'focus');
  Object.defineProperty(task.result.current.textareaRef, 'current', { value: textarea, configurable: true });
  quote('task quote');
  task.rerender({ active: false });
  act(() => frames.forEach(callback => callback(0)));
  expect(focus).not.toHaveBeenCalled();
  textarea.remove();
});

it('submits a General task file-card reference while keeping ordinary General file mentions disabled', async () => {
  const general: Project = { name: 'general', displayName: 'General', kind: 'general', fullPath: '/fixture/general',
    capabilities: { files: false, projectFileMentions: false } };
  const chat = setup(general, 'web:general', false);
  const task = setup({ ...general, workspaceCwd: '/fixture/general-workspace', fileOperationsKey: 'cron-task:general-task',
    capabilities: { ...general.capabilities, projectFileMentions: true } }, 'cron:general-task');
  mention('general');
  expect(task.result.current.selectedFileMentions).toEqual([expect.objectContaining({ path: 'report.md' })]);
  act(() => task.result.current.setInput('Review this file'));
  await act(async () => task.result.current.handleSubmit({ preventDefault() {} } as never));
  expect(task.enqueuePreparedInput).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
    attachments: [expect.objectContaining({ path: '/fixture/general-workspace/report.md' })],
  }) }));
  task.rerender({ active: false }); chat.rerender({ active: true });
  mention('general');
  act(() => { chat.result.current.setInput('@'); chat.result.current.handleTextareaClick({ currentTarget: { selectionStart: 1 } } as never); });
  expect(chat.result.current.selectedFileMentions).toEqual([]);
  expect(chat.result.current.showFileDropdown).toBe(false);
});
