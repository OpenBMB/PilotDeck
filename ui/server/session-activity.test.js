import { describe, expect, it } from 'vitest';
import { createSessionActivityRegistry } from './session-activity.js';
const started = (runId = 'r1') => ({sessionId:'s1',runId,kind:'status',text:'started'});
const complete = (runId = 'r1', finishReason = 'completed') => ({sessionId:'s1',runId,kind:'complete',finishReason,success:true});
describe('sidebar activity notifications', () => {
  it('tracks sends and completion once, omits content, and scopes snapshots by user', () => {
    const store = createSessionActivityRegistry();
    expect(store.receive('alice', {type:'input-queue-state',sessionId:'s1',items:[{id:'r1',status:'submitting'}]})).toMatchObject({processing:true});
    expect(store.receive('alice', started())).toBeNull();
    expect(store.receive('alice', {sessionId:'s1',runId:'r1',kind:'stream_delta',content:'private'})).toBeNull();
    expect(store.receive('alice', complete())).toMatchObject({processing:false,completedRunId:'r1'});
    expect(store.receive('alice', complete())).toBeNull();
    expect(store.receive('alice', started())).toBeNull();
    expect(store.snapshot('bob')).toEqual([]);
    expect(JSON.stringify(store.snapshot('alice'))).not.toContain('private');
    expect(store.receive('alice', started('r2'))).toMatchObject({processing:true});
    expect(store.receive('alice', complete('r1'))).toBeNull();
  });
  it('stop/error clears the spinner without creating a completed reply', () => {
    for (const terminal of [complete('r1','aborted'), {...complete(), success:false}, {...started(),kind:'error'}, {...started(),kind:'interrupted'}]) {
      const store = createSessionActivityRegistry();
      store.receive(null, started());
      expect(store.receive(null, terminal)).toMatchObject({processing:false});
      expect(store.snapshot(null)[0].completedRunId).toBeUndefined();
    }
  });
  it('keeps queued-only messages from looking like executing work and clears failed sends', () => {
    const store = createSessionActivityRegistry();
    expect(store.receive(null,{type:'input-queue-state',sessionId:'s1',items:[{id:'r1',status:'queued'}]})).toBeNull();
    store.receive(null,started());
    expect(store.receive(null,{...started(),kind:'error',terminal:false})).toBeNull();
    expect(store.receive(null,{type:'input-queue-state',sessionId:'s1',items:[{id:'r1',status:'failed'}]})).toMatchObject({processing:false});
  });
});
