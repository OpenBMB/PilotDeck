import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../../src/agent/protocol/events.js';
import type { CanonicalModelEvent } from '../../src/model/protocol/canonical.js';
import { FileInputProgress } from '../../src/gateway/stream/FileInputProgress.js';
import { ActiveTimeline } from '../../src/gateway/stream/ActiveTimeline.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import type { SessionRouter } from '../../src/gateway/SessionRouter.js';

const model = (event: CanonicalModelEvent): AgentEvent => ({ type: 'model_event', sessionId: 's', turnId: 't', event });

test('the real Gateway publishes progress and a reconnect snapshot before arguments finish', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let completedArguments = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const router = { beginTurn: () => true, endTurn: () => {}, getOrCreate: async () => ({
    submit: async function* () {
      yield model({ type: 'tool_call_start', id: 'file', name: 'write_file' });
      yield model({ type: 'tool_call_delta', id: 'file', delta: '{"file_path":"src/app.ts","content":"partial' });
      await Promise.race([gate, new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); })]);
      completedArguments = true;
      yield { type: 'tool_calls_detected', sessionId: 's', turnId: 't', calls: [{ id: 'file', name: 'write_file', input: { file_path: 'src/app.ts', content: 'complete' } }] } as AgentEvent;
    },
  }) } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router);
  let sawPreparation = false, sawDispatch = false;
  try {
    for await (const event of gateway.submitTurn({ sessionKey: 'web:file-progress', channelKey: 'web', message: 'Write a file', runId: 'run' })) {
      if (event.type === 'tool_call_started') sawDispatch = true;
      if (event.type !== 'agent_status' || event.event !== 'file_input_progress' || !event.detail?.filePath || event.detail.state !== 'running') continue;
      try {
        assert.equal(completedArguments, false);
        assert.equal(sawDispatch, false);
        const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: 'web:file-progress' });
        assert.ok(snapshot.events.some(frame => frame.type === 'agent_status' && frame.event === 'file_input_progress' && frame.detail?.filePath === 'src/app.ts'));
        sawPreparation = true;
      } finally { release(); }
    }
    assert.equal(sawPreparation, true);
    assert.equal(sawDispatch, true);
  } finally { release(); if (timer) clearTimeout(timer); }
});

test('streams bounded preparation metadata before dispatch, with valid completed paths and coalesced reconnect state', () => {
  let now = 0;
  const tracker = new FileInputProgress('run', () => now);
  const active = new ActiveTimeline();
  const start = tracker.accept(model({ type: 'tool_call_start', id: 'file', name: 'write_file' }));
  assert.equal(start.length, 1); start.forEach(frame => active.record(frame));
  assert.equal(tracker.accept(model({ type: 'tool_call_delta', id: 'file', delta: '{"file_path":"src/hel' })).length, 0);
  const path = tracker.accept(model({ type: 'tool_call_delta', id: 'file', delta: 'lo.ts","content":"' }));
  assert.deepEqual(path[0]?.type === 'agent_status' && path[0].detail?.filePath, 'src/hello.ts');
  const chunk = 'PRIVATE_CONTENT'.repeat(50);
  let frames = 0;
  for (let index = 0; index < 10_000; index++) {
    now++;
    for (const frame of tracker.accept(model({ type: 'tool_call_delta', id: 'file', delta: chunk }))) {
      frames++; active.record(frame);
      assert.ok(JSON.stringify(frame).length < 500);
      assert.ok(!JSON.stringify(frame).includes('PRIVATE_CONTENT'));
    }
  }
  assert.ok(frames > 10 && frames < 100);
  assert.equal(active.values().length, 1);
  const last = active.values()[0];
  assert.ok(last?.type === 'agent_status' && Number(last.detail?.receivedBytes) > 6_000_000);
  tracker.accept({ type: 'tool_calls_detected', sessionId: 's', turnId: 't', calls: [{ id: 'file', name: 'write_file', input: {} }] }).forEach(frame => active.record(frame));
  assert.equal(active.values().length, 0);
  assert.deepEqual(tracker.finish(), []);
});

test('rejects invalid or incomplete paths, ignores nested path fields, and clears aborted drafts', () => {
  for (const prefix of ['{"file_path":"bad\\q"', '{"file_path":"unfinished', '{"metadata":{"file_path":"nested.ts"},"content":"body']) {
    const tracker = new FileInputProgress('run', () => 1000);
    tracker.accept(model({ type: 'tool_call_start', id: 'file', name: 'write_file' }));
    tracker.accept(model({ type: 'tool_call_delta', id: 'file', delta: prefix }));
    const frames = tracker.finish();
    assert.ok(frames[0]?.type === 'agent_status' && !frames[0].detail?.filePath);
    assert.ok(frames[0]?.type === 'agent_status' && frames[0].detail?.state === 'cancelled');
  }
});

test('scopes parallel root and child preparation and gives retry attempts independent identities', () => {
  const tracker = new FileInputProgress('run');
  const root = tracker.accept(model({ type: 'tool_call_start', id: 'file', name: 'edit_file' }))[0];
  const child = tracker.accept({ type: 'subagent_model_event', sessionId: 's', turnId: 't', subagentId: 'child', subagentType: 'worker',
    event: { type: 'tool_call_start', id: 'file', name: 'write_file' } })[0];
  assert.ok(child?.type === 'agent_status' && child.detail?.subagentId === 'child');
  const cancelled = tracker.accept(model({ type: 'request_started', model: 'fixture', provider: 'fixture' }));
  assert.equal(cancelled.length, 1);
  const retried = tracker.accept(model({ type: 'tool_call_start', id: 'file', name: 'edit_file' }))[0];
  assert.ok(root?.type === 'agent_status' && retried?.type === 'agent_status' && root.detail?.activityId !== retried.detail?.activityId);
  assert.equal(tracker.finish().length, 2);
});
