import { useState, type ReactNode } from 'react';
import { SkillConversationContext, type SkillConversationRequest } from '../../../contexts/SkillConversationContext';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatComposerState } from './useChatComposerState';
import { getDraftInputStorageKey } from '../utils/chatStorage';

const fetchMock = vi.hoisted(() => vi.fn());
const config = { name: '/config', namespace: 'pinned', type: 'builtin', metadata: { type: 'builtin' } };
const help = { name: '/help', namespace: 'builtin' };
const custom = { name: '/summarize', namespace: 'user', type: 'command', path: '/tmp/demo/.pilotdeck/commands/summarize.md' };
vi.mock('../../../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  localStorage.clear(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, options?: any) => ({ ok: true, json: async () => url === '/api/commands/execute'
    ? { type: 'builtin', action: JSON.parse(options.body).commandName.slice(1), data: { content: 'Help content' } }
    : { pinned: [config], custom: [custom], builtIn: [help] },
  }));
});
afterEach(cleanup);

function setup(isModelSelectionReady: boolean, isPermissionModeReady = true, initialSkillRequest: SkillConversationRequest | null = null) {
  const consume = vi.fn();
  function SkillRequestProvider({ children }: { children: ReactNode }) {
    const [request, setRequest] = useState(initialSkillRequest);
    return <SkillConversationContext.Provider value={{ request, consume: (id) => { consume(id); setRequest((current) => current?.id === id ? null : current); } }}>{children}</SkillConversationContext.Provider>;
  }
  const onShowSettings = vi.fn();
  const sendMessage = vi.fn(() => true);
  const addMessage = vi.fn();
  const selectedProject = { name: 'demo', displayName: 'Demo', fullPath: '/tmp/demo' };
  const view = renderHook(({ session }) => useChatComposerState({
    selectedProject,
    selectedSession: session, currentSessionId: null,
    model: 'removed/model', modelSelection: { mode: 'model', provider: 'removed', model: 'model' }, isModelSelectionReady, isPermissionModeReady,
    permissionMode: 'default', runMode: 'agent', cycleRunMode: vi.fn(), isLoading: false,
    canAbortSession: false, tokenBudget: null, sendMessage, onShowSettings,
    pendingViewSessionRef: { current: null }, scrollToBottom: vi.fn(), addMessage,
    clearMessages: vi.fn(), rewindMessages: vi.fn(), setIsLoading: vi.fn(), setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(), setClaudeStatus: vi.fn(), setPilotDeckStatus: vi.fn(), setIsUserScrolledUp: vi.fn(),
    pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
  }), { initialProps: { session: null as { id: string } | null }, wrapper: SkillRequestProvider });
  return { ...view, onShowSettings, sendMessage, addMessage, consume };
}

it.each([true, false])('allows settings and help while model ready=%s', async (ready) => {
  const { result, onShowSettings, sendMessage, addMessage } = setup(ready);
  await waitFor(() => expect(result.current.slashCommandsCount).toBe(3));
  act(() => result.current.setInput('/config'));
  expect(result.current.canSubmitWithoutModel).toBe(true);
  await act(() => result.current.handleSubmit({ preventDefault: vi.fn() } as never));
  expect(onShowSettings).toHaveBeenCalledOnce();
  act(() => result.current.setInput('/help'));
  await act(() => result.current.handleSubmit({ preventDefault: vi.fn() } as never));
  expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'Help content' }));
  expect(sendMessage).not.toHaveBeenCalled();
});

it('allows a selected built-in command chip without a model', async () => {
  const { result, onShowSettings, sendMessage } = setup(false);
  await waitFor(() => expect(result.current.slashCommandsCount).toBe(3));
  act(() => result.current.handleCommandSelect(config, 0, false));
  expect(result.current.selectedCommands).toHaveLength(1);
  expect(result.current.canSubmitWithoutModel).toBe(true);
  await act(() => result.current.handleSubmit({ preventDefault: vi.fn() } as never));
  expect(onShowSettings).toHaveBeenCalledOnce();
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each(['ordinary message', '/unknown', '/config-extra', '/summarize'])('blocks %s without a usable model and preserves the input', async (input) => {
  const { result, sendMessage } = setup(false);
  await waitFor(() => expect(result.current.slashCommandsCount).toBe(3));
  act(() => result.current.setInput(input));
  expect(result.current.canSubmitWithoutModel).toBe(false);
  await act(() => result.current.handleSubmit({ preventDefault: vi.fn() } as never));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/commands/execute')).toBe(false);
  expect(result.current.input).toBe(input);
});


it('blocks submission while the global permission preference is loading or saving', async () => {
  const { result, sendMessage } = setup(true, false);
  await waitFor(() => expect(result.current.slashCommandsCount).toBe(3));
  act(() => result.current.setInput('run my task'));
  await act(() => result.current.handleSubmit({ preventDefault: vi.fn() } as never));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(result.current.input).toBe('run my task');
});


it('coalesces draft writes and flushes before reload without resurrecting a cleared draft', async () => {
  const view = setup(true);
  await waitFor(() => expect(view.result.current.slashCommandsCount).toBe(3));
  const key = getDraftInputStorageKey('demo', null);
  vi.useFakeTimers();
  try {
    act(() => view.result.current.setInput('n'));
    act(() => view.result.current.setInput('ni'));
    expect(localStorage.getItem(key)).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(localStorage.getItem(key)).toBe('ni');
    act(() => view.result.current.setInput('你好'));
    act(() => window.dispatchEvent(new Event('pilotdeck:flush-drafts')));
    expect(localStorage.getItem(key)).toBe('你好');
    act(() => view.result.current.setInput(''));
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem(key)).toBeNull();
    view.unmount();
    expect(localStorage.getItem(key)).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('flushes the old conversation before restoring another draft and saves on unmount', async () => {
  const view = setup(true);
  await waitFor(() => expect(view.result.current.slashCommandsCount).toBe(3));
  const newKey = getDraftInputStorageKey('demo', null);
  const savedKey = getDraftInputStorageKey('demo', 'saved');
  localStorage.setItem(savedKey, 'saved draft');
  act(() => view.result.current.setInput('new unsaved draft'));
  view.rerender({ session: { id: 'saved' } });
  expect(localStorage.getItem(newKey)).toBe('new unsaved draft');
  expect(view.result.current.input).toBe('saved draft');
  act(() => view.result.current.setInput('edited saved draft'));
  view.unmount();
  expect(localStorage.getItem(savedKey)).toBe('edited saved draft');
  expect(localStorage.getItem(newKey)).toBe('new unsaved draft');
});


it('consumes a skill handoff into the new conversation without sending it', async () => {
  const skill = { slug: 'report-writer', name: 'Report writer', command: '/report-writer' };
  const { result, consume, sendMessage } = setup(true, true, { id: 'handoff', projectPath: '/tmp/demo', skill });
  await waitFor(() => expect(result.current.selectedSkills).toEqual([skill]));
  expect(consume).toHaveBeenCalledWith('handoff');
  expect(sendMessage).not.toHaveBeenCalled();
  expect(result.current.input).toBe('');
});

it('does not attach a skill handoff to a different project', async () => {
  const { result, consume } = setup(true, true, { id: 'other', projectPath: '/different-project', skill: { slug: 'private', name: 'Private' } });
  await waitFor(() => expect(result.current.slashCommandsCount).toBe(3));
  expect(result.current.selectedSkills).toEqual([]);
  expect(consume).not.toHaveBeenCalled();
});
