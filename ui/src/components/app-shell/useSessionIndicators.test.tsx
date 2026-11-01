// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionIndicatorStore, useSessionIndicators } from './useSessionIndicators';
const completed = (id = 's1', runId = 'r1') => ({type:'session-activity',activity:{sessionId:id,processing:false,completedRunId:runId}});
afterEach(() => {cleanup(); localStorage.clear(); vi.restoreAllMocks();});
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
it('counts approval and failure reminders per conversation, ignores older replay, and clears deleted conversations', () => {
  const store = createSessionIndicatorStore('test', localStorage);
  store.receive({ type: 'session-attention', activity: { sessionId: 's1', attentionId: 'approval:p1', attentionAt: '2026-10-27T03:00:00Z' } });
  store.receive({ type: 'session-attention', activity: { sessionId: 's1', attentionId: 'error:r1', attentionAt: '2026-10-27T03:01:00Z' } });
  expect(store.getSnapshot().unreadSessionIds.size).toBe(1);
  store.receive({ type: 'session-attention', activity: { sessionId: 's1', attentionId: 'approval:p1', attentionAt: '2026-10-27T03:00:00Z' } });
  expect(store.unreadRun('s1')).toBe('error:r1');
  store.markRead('s1', 'approval:p1');
  expect(store.getSnapshot().unreadSessionIds.size).toBe(1);
  store.receive({ type: 'session-deleted', sessionId: 's1' });
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
});

it('keeps waiting state after reading the reminder and clears it on resume and snapshots', () => {
  const store = createSessionIndicatorStore('waiting', localStorage);
  store.receive({type:'session-activity',activity:{sessionId:'s1',processing:true,waitingFor:'question',attentionId:'question:q1'}});
  store.markRead('s1');
  expect(store.getSnapshot().waitingSessions.get('s1')).toBe('question');
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
  store.receive({type:'session-activity',activity:{sessionId:'s1',processing:true,waitingFor:null}});
  expect(store.getSnapshot().waitingSessions.size).toBe(0);
  expect(store.getSnapshot().processingSessions.has('s1')).toBe(true);
  store.receive({type:'session-activity-snapshot',activities:[{sessionId:'s1',processing:true,waitingFor:'approval'}]});
  expect(store.getSnapshot().waitingSessions.get('s1')).toBe('approval');
  store.receive({type:'session-activity-snapshot',activities:[]});
  expect(store.getSnapshot().waitingSessions.size).toBe(0);
});
