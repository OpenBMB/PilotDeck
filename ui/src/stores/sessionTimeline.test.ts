import { describe, expect, it } from 'vitest';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { SessionTimeline, mergeTimeline } from './sessionTimeline';
import { computeMerged, type NormalizedMessage } from './useSessionStore';

const frame = (id: string, order: number, revision: number, content: string, offset?: number,
  overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `wire-${revision}`, sessionId: 's', runId: 'turn', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
  kind: 'stream_delta', role: 'assistant', content,
  timeline: { version: 1, turnId: 'turn', id, order, revision, ...(offset !== undefined ? { offset } : {}) },
  ...overrides,
});
const read = (state: SessionTimeline) => state.values().sort((a, b) => a.timeline!.order - b.timeline!.order)
  .map(m => [m.timeline!.id, m.content, m.streamState]);

describe('versioned session timeline', () => {
  it('keeps alternating thought/text/thought in place and only the tail active', () => {
    const state = new SessionTimeline();
    state.apply(frame('thought-0', 0, 1, 'think', 0, { kind: 'thinking' }));
    state.apply(frame('text-0', 1, 2, 'say', 0));
    state.apply(frame('thought-1', 2, 3, 'again', 0, { kind: 'thinking' }));
    expect(read(state)).toEqual([['thought-0', 'think', 'closed'], ['text-0', 'say', 'closed'], ['thought-1', 'again', 'open']]);
    const rows = normalizedToChatMessages(state.values());
    expect(rows.filter(m => m.isStreaming).map(m => m.content)).toEqual(['again']);
  });

  it('uses offsets for duplicates/gaps, including a missing first packet', () => {
    const state = new SessionTimeline();
    expect(state.apply(frame('a', 0, 2, ' world', 5))).toBe(true);
    expect(state.values()).toEqual([]);
    expect(state.apply(frame('a', 0, 1, 'hello', 0))).toBe(false);
    state.apply(frame('a', 0, 1, 'hello', 0));
    expect(read(state)).toEqual([['a', 'hello world', 'open']]);
  });

  it('detects an entirely missing predecessor and recovers from the absolute baseline', () => {
    const state = new SessionTimeline();
    const next = frame('b', 1, 3, 'second', 0);
    next.timeline!.previousId = 'a';
    expect(state.apply(next)).toBe(true);
    expect(state.apply(frame('a', 0, 2, 'first', undefined, { isFinal: true }))).toBe(false);
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['b', 'second', 'open']]);
  });

  it('an old baseline neither rewinds text nor reopens a settled block', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'hello', 0));
    const id = state.values()[0].id;
    state.apply(frame('a', 0, 2, ' world', 5));
    state.apply(frame('a', 0, 1, 'hello'));
    state.apply(frame('a', 0, 3, 'hello world', undefined, { kind: 'text', isFinal: true }));
    state.apply(frame('a', 0, 2, ' world', 5));
    expect(state.values()[0].id).toBe(id);
    expect(read(state)).toEqual([['a', 'hello world', 'closed']]);
  });

  it('late model-end boundaries cannot close a later attempt', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'first', 0));
    state.apply(frame('retry', 1, 3, 'retry', 0));
    state.close('turn', false, undefined, { turnId: 'turn', through: 0 });
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['retry', 'retry', 'open']]);
    state.close('turn', true);
    state.apply(frame('retry', 1, 4, ' stale', 5));
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['retry', 'retry', 'closed']]);
  });

  it('inserting snapshots/duplicates at every reconnect point has the same final result', () => {
    const deltas = [frame('a', 0, 1, 'abc', 0), frame('a', 0, 2, 'def', 3),
      frame('b', 1, 4, 'ghi', 0, { kind: 'thinking' }), frame('b', 1, 5, 'jkl', 3, { kind: 'thinking' })];
    const snapshots = [frame('a', 0, 3, 'abcdef', undefined, { kind: 'text', isFinal: true }),
      frame('b', 1, 6, 'ghijkl', undefined, { kind: 'thinking', isFinal: true })];
    const expected = [['a', 'abcdef', 'closed'], ['b', 'ghijkl', 'closed']];
    for (let reconnect = 0; reconnect <= deltas.length; reconnect++) {
      for (let seed = 1; seed <= 30; seed++) {
        const state = new SessionTimeline();
        let random = seed;
        const shuffle = (items: NormalizedMessage[]) => items.map(m => ({ m, n: (random = (random * 16807) % 2147483647) }))
          .sort((a, b) => a.n - b.n).map(x => x.m);
        const prefix = deltas.slice(0, reconnect);
        for (const m of prefix) state.apply(m);
        for (const m of shuffle([...deltas, ...deltas, ...snapshots, ...snapshots])) state.apply(m);
        expect(state.hasGap).toBe(false);
        expect(read(state)).toEqual(expected);
      }
    }
  });

  it('does not use status rows as anchors or compare repeated text', () => {
    const user: NormalizedMessage = { ...frame('u', 0, 0, 'question'), timeline: undefined, role: 'user', kind: 'text' };
    const status = { ...user, id: 'status', kind: 'status' as const, role: undefined };
    const a = frame('a', 0, 1, 'same', undefined, { isFinal: true, kind: 'text' });
    const b = frame('b', 1, 2, 'same', undefined, { isFinal: true, kind: 'text' });
    const merged = computeMerged([user, a], [status, b]);
    expect(merged.filter(m => m.kind === 'text').map(m => m.content)).toEqual(['question', 'same', 'same']);
    expect(new Set(merged.filter(m => m.timeline).map(m => m.renderKey)).size).toBe(2);
    expect(mergeTimeline([status, user], [b, a]).filter(m => m.kind === 'text').map(m => m.content))
      .toEqual(['question', 'same', 'same']);
  });

  it('keeps child and parent identities and lifecycle separate', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'parent', 0));
    const child = frame('a', 0, 1, 'child', 0, { subagentId: 'child', isSubagentDetail: true });
    child.timeline!.turnId = 'child-turn';
    state.apply(child);
    state.close('turn', false, 'child', { turnId: 'child-turn', through: 0 });
    expect(state.values()[0].streamState).toBe('open');
    expect(state.values('child')[0].streamState).toBe('closed');
    const persisted = { ...child, sessionId: 's::sub::child', subagentId: undefined, runId: 'child-turn',
      timeline: { ...child.timeline!, revision: 2, offset: undefined }, isFinal: true };
    expect(computeMerged([persisted], [state.values('child')[0]])).toHaveLength(1);
  });
});

it('restores a terminated child snapshot without reopening it or blocking the parent', () => {
  const state = new SessionTimeline();
  state.close('turn', true, 'child');
  const child = frame('thought', 0, 1, 'Restored thought', undefined, {
    kind: 'thinking', isSubagentDetail: true, subagentId: 'child', streamState: 'open',
  });
  child.timeline!.turnId = 'child-t0';
  state.apply(child);
  expect(state.values('child')[0]).toMatchObject({ content: 'Restored thought', streamState: 'closed' });
  expect(state.apply({ ...child, content: ' late', timeline: { ...child.timeline!, offset: 16, revision: 2 } })).toBe(false);
  expect(state.values('child')[0].content).toBe('Restored thought');
  state.apply(frame('parent', 0, 1, 'Parent continues', 0));
  expect(state.values()[0].streamState).toBe('open');
});

it('terminal recovery clears orphaned predecessors, pending deltas and conflicts only for that turn', () => {
  const state = new SessionTimeline();
  const retry = frame('retry', 2, 3, 'Recovered', 0);
  retry.timeline!.previousId = 'tool:discarded';
  expect(state.apply(retry)).toBe(true);
  state.apply(frame('pending', 3, 4, 'tail', 10));
  state.apply(frame('retry', 2, 3, 'conflict', 0));
  state.apply(frame('retry', 2, 5, 'Recovered', undefined, { isFinal: true }));
  const other = frame('other', 0, 1, 'tail', 4, { runId: 'other-run' });
  other.timeline!.turnId = 'other-run';
  state.apply(other);
  state.close('turn', true);
  expect(state.hasGap).toBe(true); // The other active turn still needs recovery.
  expect(state.apply({ ...other, content: 'head', timeline: { ...other.timeline!, offset: 0 } })).toBe(false);
  expect(state.apply(retry)).toBe(false); // Late packets cannot recreate the discarded dependency.
  const next = frame('next', 0, 1, 'New turn', 0, { runId: 'next-run' });
  next.timeline!.turnId = 'next-run';
  expect(state.apply(next)).toBe(false);
});

it('reopens only the new child round within the same parent run and rejects stale lifecycle frames', () => {
  const state = new SessionTimeline();
  const activity = (index: number | undefined, status: string): NormalizedMessage => ({
    ...frame('activity', 0, 1, ''), timeline: undefined, kind: 'agent_activity', phase: 'subagent',
    subagentId: 'child', subagentTurnId: index === undefined ? undefined : `child-t${index}`,
    runId: 'subagent:child', parentRunId: 'turn', state: status,
  });
  const child = (index: number, text: string, offset?: number): NormalizedMessage => ({
    ...frame('text', 0, 1, text, offset), subagentId: 'child', isSubagentDetail: true,
    timeline: { ...frame('text', 0, 1, text, offset).timeline!, turnId: `child-t${index}` },
  });
  state.apply(activity(0, 'running'));
  state.apply(child(0, 'first', 0));
  state.apply(activity(0, 'completed'));
  state.apply(activity(1, 'running'));
  state.apply(child(1, 'next', 0));
  state.apply(activity(0, 'running'));
  state.apply(activity(0, 'completed'));
  state.apply(activity(undefined, 'completed'));
  state.apply(child(0, ' stale', 5));
  state.apply(child(1, ' live', 4));
  expect(state.values('child').map(m => [m.timeline?.turnId, m.content, m.streamState])).toEqual([
    ['child-t0', 'first', 'closed'], ['child-t1', 'next live', 'open'],
  ]);
  // A duplicate start never reopens the already completed coordinates.
  state.apply(activity(1, 'completed'));
  state.apply(activity(1, 'running'));
  state.apply(child(1, ' stale', 9));
  expect(state.values('child')[1]).toMatchObject({ content: 'next live', streamState: 'closed' });
  state.close('turn', true);
  state.apply(activity(2, 'running'));
  state.apply(child(2, 'after parent ended', 0));
  expect(state.values('child')).toHaveLength(2);
});

it('can resume after an unversioned completion without reopening restored old coordinates', () => {
  const state = new SessionTimeline();
  state.close('turn', true, 'child');
  const child = frame('text', 0, 1, 'first', undefined, { isSubagentDetail: true, subagentId: 'child' });
  child.timeline!.turnId = 'child-t0';
  state.apply(child);
  state.apply({ ...child, timeline: undefined, kind: 'agent_activity', phase: 'subagent', state: 'running',
    runId: 'subagent:child', parentRunId: 'turn', subagentTurnId: 'child-t0', isSubagentDetail: false });
  state.apply({ ...child, content: ' stale', timeline: { ...child.timeline!, offset: 5 } });
  expect(state.values('child')[0]).toMatchObject({ content: 'first', streamState: 'closed' });
  state.apply({ ...child, timeline: undefined, kind: 'agent_activity', phase: 'subagent', state: 'running',
    runId: 'subagent:child', parentRunId: 'turn', subagentTurnId: 'child-t1', isSubagentDetail: false });
  state.apply({ ...child, content: 'next', timeline: { ...child.timeline!, turnId: 'child-t1', offset: 0 } });
  state.apply({ ...child, content: ' stale', timeline: { ...child.timeline!, offset: 5 } });
  expect(state.values('child').map(m => [m.content, m.streamState])).toEqual([['first', 'closed'], ['next', 'open']]);
});
