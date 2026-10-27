// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionIndicatorStore, useSessionIndicators } from './useSessionIndicators';
const completed = (id = 's1', runId = 'r1') => ({type:'session-activity',activity:{sessionId:id,processing:false,completedRunId:runId}});
afterEach(() => {cleanup(); localStorage.clear(); delete window.pilotdeckDesktop; vi.restoreAllMocks();});
it('persists unread completions, deduplicates replays and restores running state from snapshots', () => {
  const store = createSessionIndicatorStore('test', localStorage);
  store.receive({type:'session-activity',activity:{sessionId:'s1',processing:true}});
  expect(store.getSnapshot().processingSessions.has('s1')).toBe(true);
  store.receive(completed());
  expect(store.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  const restored = createSessionIndicatorStore('test', localStorage);
  expect(restored.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  restored.markRead('s1');
  restored.receive(completed());
  expect(restored.getSnapshot().unreadSessionIds.size).toBe(0);
  restored.receive({type:'session-activity-snapshot',activities:[{sessionId:'s1',processing:true,completedRunId:'r1'}]});
  expect(restored.getSnapshot().processingSessions.has('s1')).toBe(true);
  restored.receive({type:'session-activity-snapshot',activities:[]});
  expect(restored.getSnapshot().processingSessions.size).toBe(0);
  restored.receive(completed('s1','r2'));
  expect(restored.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
});
it('always lights on completion and requires a later action, not visibility or refresh', () => {
  let listener: (message:any) => void = () => {};
  const subscribe = (fn: typeof listener) => {listener = fn; return () => {};};
  const sendMessage = vi.fn();
  const props = {scope:'user',viewedSessionId:'s1',subscribe,sendMessage,isConnected:true};
  const {result,unmount} = renderHook(() => useSessionIndicators(props));
  expect(sendMessage).toHaveBeenCalledWith({type:'get-session-activity'});
  act(() => result.current.acknowledge()); // Activity before completion cannot acknowledge it.
  act(() => listener(completed()));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new MouseEvent('mousemove'));
  });
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  unmount();
  const refreshed = renderHook(() => useSessionIndicators(props));
  act(() => listener({type:'session-activity-snapshot',activities:[completed().activity]}));
  expect(refreshed.result.current.unreadSessionIds.has('s1')).toBe(true);
  act(() => refreshed.result.current.acknowledge());
  expect(refreshed.result.current.unreadSessionIds.size).toBe(0);
  act(() => listener(completed()));
  expect(refreshed.result.current.unreadSessionIds.size).toBe(0);
  act(() => listener(completed('s1','r2')));
  expect(refreshed.result.current.unreadSessionIds.has('s1')).toBe(true);
});
it('acknowledges navigation only after loading and never clears a newer completion', () => {
  let listener: (message:any) => void = () => {};
  const subscribe = (fn: typeof listener) => {listener = fn; return () => {};};
  const sendMessage = vi.fn();
  const {result,rerender} = renderHook(({viewedSessionId}: {viewedSessionId:string|null}) => useSessionIndicators({scope:'user',viewedSessionId,subscribe,sendMessage,isConnected:true}),{initialProps:{viewedSessionId:'s1' as string|null}});
  act(() => {listener(completed('s1'));listener(completed('s2'));listener(completed('s3'));});
  act(() => result.current.selectSession('s2'));
  expect(result.current.unreadSessionIds.has('s1')).toBe(false);
  expect(result.current.unreadSessionIds.has('s2')).toBe(true);
  rerender({viewedSessionId:null});
  act(() => result.current.acknowledge()); // Loading/hidden chat is not read.
  expect(result.current.unreadSessionIds.has('s2')).toBe(true);
  rerender({viewedSessionId:'s2'});
  expect(result.current.unreadSessionIds.has('s2')).toBe(false);
  expect(result.current.unreadSessionIds.has('s3')).toBe(true);
  act(() => result.current.selectSession('s3'));
  rerender({viewedSessionId:null});
  act(() => listener(completed('s3','r2')));
  rerender({viewedSessionId:'s3'});
  expect(result.current.unreadSessionIds.has('s3')).toBe(true);
  act(() => result.current.selectSession(null)); // Starting a new conversation acknowledges the old one.
  expect(result.current.unreadSessionIds.size).toBe(0);
  rerender({viewedSessionId:null});
  act(() => {listener(completed('s3','r3'));result.current.acknowledge();});
  expect(result.current.unreadSessionIds.has('s3')).toBe(true);
});
it('reconciles a completion missed during refresh, and isolates accounts', () => {
  const store = createSessionIndicatorStore('user-a', localStorage);
  store.receive({type:'session-activity-snapshot',activities:[completed().activity]});
  expect(store.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  expect(createSessionIndicatorStore('user-b',localStorage).getSnapshot().unreadSessionIds.size).toBe(0);
  expect(() => createSessionIndicatorStore('no-storage',undefined).receive(completed())).not.toThrow();
});

function desktopIndicators(viewedSessionId: string | null = 's1') {
  const setCompletionBadge = vi.fn().mockResolvedValue(undefined);
  window.pilotdeckDesktop = {setCompletionBadge} as any;
  let listener: (message: any) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => { listener = () => {}; }; };
  const sendMessage = vi.fn();
  const hook = renderHook(({scope, viewedSessionId}: {scope: string; viewedSessionId: string | null}) =>
    useSessionIndicators({scope, viewedSessionId, subscribe, sendMessage, isConnected: true}),
  {initialProps: {scope: 'user', viewedSessionId}});
  return {...hook, setCompletionBadge, receive: (message: any) => act(() => listener(message))};
}

it('sends distinct background session counts and clears only after navigation is ready', () => {
  const hook = desktopIndicators();
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
  hook.receive(completed('s2'));
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  hook.receive(completed('s2'));
  expect(hook.setCompletionBadge.mock.calls.map(([count]) => count)).toEqual([0, 1]);
  hook.receive(completed('s3'));
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(2);
  hook.receive(completed('s2', 'r2')); // Sessions, not number of turns.
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(2);
  act(() => hook.result.current.selectSession('s2'));
  hook.rerender({scope: 'user', viewedSessionId: null});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(2);
  hook.rerender({scope: 'user', viewedSessionId: 's2'});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  act(() => hook.result.current.selectSession('s3'));
  hook.rerender({scope: 'user', viewedSessionId: 's3'});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
});

it('preserves a newer completion arriving while a selected session is loading', () => {
  const hook = desktopIndicators();
  hook.receive(completed('s2'));
  act(() => hook.result.current.selectSession('s2'));
  hook.rerender({scope: 'user', viewedSessionId: null});
  hook.receive(completed('s2', 'r2'));
  hook.rerender({scope: 'user', viewedSessionId: 's2'});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  act(() => hook.result.current.acknowledge());
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
});

it('exempts a watched live completion without changing sidebar unread or losing it on refresh', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const hook = desktopIndicators();
  hook.receive(completed());
  expect(hook.result.current.unreadSessionIds.has('s1')).toBe(true);
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
  hook.unmount();
  const refreshed = desktopIndicators('s2');
  refreshed.receive({type: 'session-activity-snapshot', activities: [completed().activity]});
  expect(refreshed.result.current.unreadSessionIds.has('s1')).toBe(true);
  expect(refreshed.setCompletionBadge).toHaveBeenLastCalledWith(0);
  refreshed.receive(completed('s1', 'r2'));
  expect(refreshed.setCompletionBadge).toHaveBeenLastCalledWith(1);
});

it.each([
  {focused: false, visibility: 'visible'},
  {focused: true, visibility: 'hidden'},
])('counts the displayed session when the window is not being watched: %j', ({focused, visibility}) => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility as DocumentVisibilityState);
  const hook = desktopIndicators();
  hook.receive(completed());
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  act(() => hook.result.current.acknowledge());
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
});

it('counts reconnect completions even in the foreground and never exempts existing unread on replay', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const hook = desktopIndicators();
  hook.receive({type: 'session-activity-snapshot', activities: [completed().activity]});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  hook.receive(completed());
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
});

it('does not treat a retained older completion on running or failed activity as watched', () => {
  for (const processing of [true, false]) {
    const store = createSessionIndicatorStore(`retained-${processing}`, localStorage);
    store.receive({type: 'session-activity', activity: {
      sessionId: 's1', runId: 'new-run', processing, completedRunId: 'old-run',
    }}, 's1');
    expect(store.getSnapshot().desktopCompletionCount).toBe(1);
  }
});

it('restores legacy unread records, scopes badge counts by account and clears on unmount', () => {
  localStorage.setItem('pilotdeck-session-read-v1:user', JSON.stringify({s2: {runId: 'r1', unread: true}}));
  const hook = desktopIndicators();
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  hook.rerender({scope: 'other', viewedSessionId: 's1'});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
  hook.receive(completed('s3'));
  hook.receive(completed('s4'));
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(2);
  hook.rerender({scope: 'user', viewedSessionId: 's1'});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
  hook.unmount();
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
});

it('updates the badge when the existing account storage is acknowledged in another window', () => {
  const hook = desktopIndicators();
  hook.receive(completed('s2'));
  const key = 'pilotdeck-session-read-v1:user';
  localStorage.setItem(key, JSON.stringify({s2: {runId: 'r1', unread: false}}));
  act(() => window.dispatchEvent(new StorageEvent('storage', {key})));
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(0);
});

it('does not count running, failed or interrupted activity and keeps an older unread completion', () => {
  const hook = desktopIndicators();
  for (const processing of [true, false]) {
    hook.receive({type: 'session-activity', activity: {sessionId: 's2', processing}});
  }
  expect(hook.setCompletionBadge.mock.calls.map(([count]) => count)).toEqual([0]);
  hook.receive(completed('s2'));
  hook.receive({type: 'session-activity', activity: {sessionId: 's2', processing: false, completedRunId: 'r1'}});
  expect(hook.setCompletionBadge).toHaveBeenLastCalledWith(1);
});

it('keeps web-only unread semantics and handles rejected desktop IPC without breaking chat', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const store = createSessionIndicatorStore('web', localStorage);
  store.receive(completed());
  expect(store.getSnapshot().desktopCompletionCount).toBe(1);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hook = desktopIndicators();
  hook.setCompletionBadge.mockRejectedValue(new Error('desktop unavailable'));
  hook.receive(completed('s2'));
  await act(async () => {});
  expect(warning).toHaveBeenCalledWith('Could not sync completion badge', expect.any(Error));
  expect(hook.result.current.unreadSessionIds.has('s2')).toBe(true);
});
