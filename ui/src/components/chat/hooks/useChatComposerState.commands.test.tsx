import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatComposerState } from './useChatComposerState';

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

function setup(isModelSelectionReady: boolean) {
  const onShowSettings = vi.fn();
  const sendMessage = vi.fn(() => true);
  const addMessage = vi.fn();
  const selectedProject = { name: 'demo', displayName: 'Demo', fullPath: '/tmp/demo' };
  const { result } = renderHook(() => useChatComposerState({
    selectedProject,
    selectedSession: null, currentSessionId: null,
    model: 'removed/model', modelSelection: { mode: 'model', provider: 'removed', model: 'model' }, isModelSelectionReady,
    permissionMode: 'default', runMode: 'agent', cycleRunMode: vi.fn(), isLoading: false,
    canAbortSession: false, tokenBudget: null, sendMessage, onShowSettings,
    pendingViewSessionRef: { current: null }, scrollToBottom: vi.fn(), addMessage,
    clearMessages: vi.fn(), rewindMessages: vi.fn(), setIsLoading: vi.fn(), setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(), setClaudeStatus: vi.fn(), setPilotDeckStatus: vi.fn(), setIsUserScrolledUp: vi.fn(),
    pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
  }));
  return { result, onShowSettings, sendMessage, addMessage };
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
