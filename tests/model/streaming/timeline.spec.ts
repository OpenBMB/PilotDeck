import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnTimeline } from '../../../src/agent/stream/TurnTimeline.js';
import { applyModelEventToAssembler, assembleAssistantMessage, createModelMessageAssemblerState, getModelStreamBlockId } from '../../../src/model/streaming/assembleModelMessage.js';
import { flattenCanonicalMessage } from '../../../src/web/server/readSessionMessages.js';
import { mapAgentEvent } from '../../../src/gateway/client/InProcessGateway.js';
import { ActiveTimeline } from '../../../src/gateway/stream/ActiveTimeline.js';
import type { CanonicalModelEvent, CanonicalMessage } from '../../../src/model/protocol/canonical.js';
import type { AgentEvent } from '../../../src/agent/protocol/events.js';
import type { GatewayEvent } from '../../../src/gateway/protocol/types.js';

const base = { sessionId: 's', turnId: 'turn' };
test('the assembler, wire stream, and transcript share contiguous order and exact block identity', () => {
  const timeline = new TurnTimeline('turn');
  const assembler = createModelMessageAssemblerState('attempt');
  const baseline = new ActiveTimeline();
  const live: GatewayEvent[] = [];
  const events: CanonicalModelEvent[] = [
    { type: 'thinking_delta', text: 'first' }, { type: 'text_delta', text: 'answer' },
    { type: 'thinking_delta', text: 'second' }, { type: 'text_delta', text: 'same' },
    { type: 'text_delta', text: ' again' },
    { type: 'tool_call_end', toolCall: { id: 'call', name: 'bash', input: { command: 'pwd' } } },
    { type: 'message_end', finishReason: 'tool_call' },
  ];
  for (const event of events) {
    const blockId = event.type === 'text_delta' || event.type === 'thinking_delta'
      ? getModelStreamBlockId(assembler, event.type === 'text_delta' ? 'text' : 'thinking') : undefined;
    const decorated = timeline.event({ type: 'model_event', ...base, blockId, event });
    for (const wire of mapAgentEvent(decorated, 'turn')) { live.push(wire); baseline.record(wire); }
    applyModelEventToAssembler(assembler, event);
  }
  const { message, toolCalls } = assembleAssistantMessage(assembler);
  const settled = timeline.event({ type: 'assistant_message', ...base, message });
  for (const event of mapAgentEvent(settled, 'turn')) baseline.record(event);
  const tools = timeline.event({ type: 'tool_calls_detected', ...base, calls: toolCalls });
  for (const event of mapAgentEvent(tools, 'turn')) baseline.record(event);
  const history = flattenCanonicalMessage(message, { index: 0, sessionKey: 's' });
  assert.deepEqual(history.map(m => [m.kind, m.text, m.timeline?.order]), [
    ['thinking', 'first', 0], ['text', 'answer', 1], ['thinking', 'second', 2], ['text', 'same again', 3], ['tool_use', undefined, 4],
  ]);
  assert.deepEqual(history.filter(m => m.blockId).map(m => m.blockId), [...new Set(live.flatMap(m =>
    'blockId' in m && m.blockId ? [m.blockId] : []))]);
  assert.deepEqual(baseline.values().map(e => e.timeline?.order), [0, 1, 2, 3, 4]);
  assert.equal(baseline.values().filter(e => e.streamState === 'open').length, 0);
  const cloned: CanonicalMessage = JSON.parse(JSON.stringify(message));
  assert.deepEqual(flattenCanonicalMessage(cloned, { index: 100, sessionKey: 's' }).map(m => m.timeline), history.map(m => m.timeline));
});

test('active baseline survives far more than the legacy replay log limit', () => {
  const baseline = new ActiveTimeline();
  for (let i = 0; i < 1000; i++) baseline.record({ type: 'assistant_text_delta', runId: 'turn', blockId: 'a', text: 'x',
    timeline: { version: 1, turnId: 'turn', id: 'a', order: 0, revision: i + 1, offset: i } });
  const [snapshot] = baseline.values();
  assert.ok(snapshot.type === 'assistant_text_delta');
  assert.equal(snapshot.text, 'x'.repeat(1000));
  assert.equal(snapshot.timeline?.offset, undefined);
  assert.equal(snapshot.timeline?.revision, 1000);
});

test('parent and child baselines do not close or overwrite one another', () => {
  const baseline = new ActiveTimeline();
  const parent: GatewayEvent = { type: 'assistant_text_delta', runId: 'turn', text: 'parent',
    timeline: { version: 1, turnId: 'turn', id: 'a', order: 0, revision: 1, offset: 0 } };
  baseline.record(parent);
  for (let i = 0; i < 2; i++) baseline.record({ type: 'agent_status', event: 'subagent_thinking_delta', runId: 'turn',
    detail: { subagentId: 'child', text: 'child' },
    timeline: { version: 1, turnId: 'child-turn', id: 'a', order: 0, revision: i + 1, offset: i * 5 } });
  baseline.record({ type: 'agent_status', event: 'subagent_stream_end', detail: { subagentId: 'child' },
    streamBoundary: { turnId: 'child-turn', through: 0, revision: 3 } });
  const [main, child] = baseline.values();
  assert.equal(main.streamState, 'open');
  assert.equal(child.streamState, 'closed');
  assert.ok(child.type === 'agent_status');
  assert.equal(child.detail?.text, 'childchild');
});

test('tool results, compaction and steers get the same position in live and durable forms', () => {
  const timeline = new TurnTimeline('turn');
  const result = timeline.event({ type: 'tool_result', ...base, result: { toolCallId: 't' } } as AgentEvent);
  const message: CanonicalMessage = { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: [{ type: 'text', text: 'ok' }] }] };
  timeline.message(message);
  assert.equal(message.content[0].timeline?.order, result.timeline?.order);
  const compact = timeline.event({ type: 'compact_started', ...base, compactionId: 'c', trigger: 'auto', preTokens: 10 });
  assert.equal(compact.timeline?.id, 'compact:c');
  const steer: CanonicalMessage = { role: 'user', metadata: { queueItemId: 'q' }, content: [{ type: 'text', text: 'wait' }] };
  timeline.message(steer);
  assert.ok(steer.content[0].timeline!.order > compact.timeline!.order);
});

for (const withStart of [true, false]) test(`tool-separated text keeps wire/history order (start frame: ${withStart})`, () => {
  const assembler = createModelMessageAssemblerState('attempt');
  const timeline = new TurnTimeline('turn');
  const events: CanonicalModelEvent[] = [
    { type: 'text_delta', text: 'Before' },
    ...(withStart ? [{ type: 'tool_call_start' as const, id: 'call', name: 'read_file' }] : []),
    { type: 'tool_call_end', toolCall: { id: 'call', name: 'read_file', input: { path: 'README.md' } } },
    { type: 'text_delta', text: 'After' },
    { type: 'message_end', finishReason: 'tool_call' },
  ];
  for (const event of events) {
    const blockId = event.type === 'text_delta' ? getModelStreamBlockId(assembler, 'text') : undefined;
    timeline.event({ type: 'model_event', ...base, event, blockId });
    applyModelEventToAssembler(assembler, event);
  }
  const { message, toolCalls } = assembleAssistantMessage(assembler);
  timeline.message(message);
  timeline.event({ type: 'tool_calls_detected', ...base, calls: toolCalls });
  const rows = flattenCanonicalMessage(message, { index: 0, sessionKey: 's' });
  assert.deepEqual(rows.map(row => row.timeline?.order), [0, 1, 2]);
  assert.deepEqual(rows.map(row => row.kind), ['text', 'tool_use', 'text']);
  assert.equal(toolCalls[0].timeline?.order, 1);
  assert.equal(rows[2].timeline?.previousId, rows[0].timeline?.id, 'streamed text only depends on already published blocks');
});

test('uncompleted tools reserve order without becoming predecessors of interleaved or retried text', () => {
  const timeline = new TurnTimeline('turn');
  const first = timeline.event({ type: 'model_event', ...base, blockId: 'first', event: { type: 'text_delta', text: 'Before' } });
  timeline.event({ type: 'model_event', ...base, event: { type: 'tool_call_start', id: 'discarded', name: 'write_file' } });
  const during = timeline.event({ type: 'model_event', ...base, blockId: 'during', event: { type: 'text_delta', text: 'During' } });
  assert.equal(during.timeline?.previousId, first.timeline?.id);
  timeline.event({ type: 'model_request_started', ...base, model: 'test', provider: 'test' });
  const retry = timeline.event({ type: 'model_event', ...base, blockId: 'retry', event: { type: 'text_delta', text: 'Recovered' } });
  assert.equal(retry.timeline?.previousId, during.timeline?.id);
  assert.ok(retry.timeline!.order > during.timeline!.order);
});
