import { describe, expect, it } from 'vitest';
import { createSessionNotificationRegistry, sessionAttention } from './session-notifications.js';
import { createSessionActivityRegistry } from './session-activity.js';
import { buildSystemNotification, notificationText } from '../shared/notifications.js';

const frame = (kind, fields = {}) => ({ id: 'frame', sessionId: 's1', runId: 'r1', kind, ...fields });
describe('session notification events', () => {
  it('correlates approvals, questions and completion with one task, including queued failures', () => {
    const registry = createSessionNotificationRegistry();
    const question = registry.receive(1, frame('permission_request', { requestId: 'q1', toolName: 'AskUserQuestion' }));
    const approval = registry.receive(1, frame('permission_request', { requestId: 'p1', toolName: 'shell' }));
    const complete = registry.receive(1, frame('complete', { finishReason: 'completed' }));
    expect([question.taskId, approval.taskId, complete.taskId]).toEqual(['r1', 'r1', 'r1']);
    expect(buildSystemNotification(question).data.taskId).toBe('r1');
    expect(registry.receive(1, { type: 'input-queue-state', sessionId: 's1', items: [{ id: 'input-2', runId: 'r2', status: 'failed' }] }).taskId).toBe('r2');
    expect(registry.receive(1, { type: 'input-queue-state', sessionId: 's1', items: [{ id: 'input-3', status: 'delivery_uncertain' }] }).taskId).toBe('input-3');
  });
  it('orders distinct reminders with tied, missing or backward source timestamps', () => {
    const registry = createSessionNotificationRegistry();
    const times = ['2026-10-27T03:00:00Z', '2026-10-27T03:00:00Z', '2026-10-27T02:00:00Z', 'invalid'];
    const events = times.map((timestamp, index) => registry.receive(1, frame('permission_request', {
      requestId: `p${index}`, toolName: 'shell', timestamp,
    })));
    for (let i = 1; i < events.length; i++) expect(Date.parse(events[i].createdAt)).toBeGreaterThan(Date.parse(events[i - 1].createdAt));
    const activity = createSessionActivityRegistry();
    expect(activity.receive(1, frame('permission_request', { requestId: 'p1', timestamp: events[1].createdAt })).attentionAt).toBe(events[1].createdAt);
  });
  it('uses the final assistant block, includes titles, and deduplicates per user and run', () => {
    const registry = createSessionNotificationRegistry();
    registry.receive(1, frame('text', { role: 'user', content: 'Prepare the report' }));
    registry.receive(1, frame('thinking', { content: 'private reasoning' }));
    registry.receive(1, frame('text', { role: 'assistant', content: 'Working on it' }));
    registry.receive(1, frame('text', { role: 'assistant', content: '**Report ready**\n[View report](/report)' }));
    const complete = frame('complete', { finishReason: 'completed' });
    expect(registry.receive(1, complete)).toMatchObject({ id: 'r1', kind: 'completed', sessionName: 'Prepare the report', preview: 'Report ready View report' });
    expect(registry.receive(1, complete)).toBeNull();
    expect(registry.receive(2, complete)).toMatchObject({ kind: 'completed', scope: '2' });
    registry.receive(1, frame('status', { text: 'started', runId: 'r2' }));
    expect(registry.receive(1, frame('complete', { runId: 'r2', finishReason: 'completed' }))).toMatchObject({ id: 'r2', preview: '' });
  });
  it('distinguishes approvals and questions, retaining different requests within one run', () => {
    expect(sessionAttention(frame('permission_request', { requestId: 'p1', toolName: 'shell' }))).toEqual({ id: 'approval:p1', kind: 'approval' });
    const registry = createSessionNotificationRegistry();
    const question = frame('permission_request', { requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which format?' }] } });
    expect(registry.receive(1, question)).toMatchObject({ id: 'question:q1', kind: 'question', preview: 'Which format?' });
    expect(registry.receive(1, question)).toBeNull();
    expect(registry.receive(1, { ...question, requestId: 'q2' })).toMatchObject({ id: 'question:q2' });
  });
  it('ignores retries, cancellation, subagents and stale terminal events', () => {
    const registry = createSessionNotificationRegistry();
    expect(registry.receive(1, frame('error', { terminal: false }))).toBeNull();
    expect(registry.receive(1, frame('interrupted'))).toBeNull();
    expect(registry.receive(1, frame('complete', { finishReason: 'aborted' }))).toBeNull();
    expect(registry.receive(1, frame('error', { parentToolUseId: 'parent' }))).toBeNull();
    registry.receive(1, frame('status', { text: 'started', runId: 'r2' }));
    registry.receive(1, frame('text', { role: 'assistant', content: 'stale text' }));
    expect(registry.receive(1, frame('error', { content: 'stale error' }))).toBeNull();
    expect(registry.receive(1, frame('error', { runId: 'r2', userHint: 'Check your connection' }))).toMatchObject({ id: 'error:r2', preview: 'Check your connection' });
  });
  it('adds attention metadata for failures and requests without exposing message content', () => {
    const registry = createSessionActivityRegistry();
    registry.receive(1, frame('status', { text: 'started' }));
    expect(registry.receive(1, frame('permission_request', { requestId: 'p1', toolName: 'shell', input: { command: 'private' } }))).toMatchObject({ processing: true, attentionId: 'approval:p1' });
    expect(registry.receive(1, frame('error', { content: 'private' }))).toMatchObject({ processing: false, attentionId: 'error:r1' });
    expect(JSON.stringify(registry.snapshot(1))).not.toContain('private');
  });
  it('removes previews while preserving the conversation and action, and formats both languages', () => {
    const event = { id: 'p1', sessionId: 's1', scope: '1', kind: 'approval', sessionName: 'Report', preview: 'Sensitive content' };
    const payload = buildSystemNotification(event, { preview: false, sound: false }, 'zh-CN');
    expect(payload).toMatchObject({ title: 'Report', body: '需要审批 · 请审批后继续', silent: true, data: { eventId: 'p1', sessionId: 's1' } });
    expect(JSON.stringify(payload)).not.toContain('Sensitive');
    expect(buildSystemNotification(event).body).toContain('Approve to continue');
  });
});

it.each(['<script', '<b>Visible</b> <img src=x', '<<script>script>alert(1)', '[<script](example)', '&lt;script&gt;', '1 < 2 > 0'])(
  'keeps notification text free of markup delimiters: %s', value => {
    expect(notificationText(value)).not.toMatch(/[<>]/);
    const payload = buildSystemNotification({ id: 'r1', sessionId: 's1', scope: '1', kind: 'completed', sessionName: value, preview: value });
    expect(payload.title + payload.body).not.toMatch(/[<>]/);
  });

it('keeps the action ahead of long previews in both languages', () => {
  const event = { id: 'p1', sessionId: 's1', scope: '1', kind: 'question', sessionName: 'Report', preview: 'Long response '.repeat(100) };
  expect(buildSystemNotification(event, {}, 'zh-CN').body.split('\n')[0]).toBe('需要回答问题 · 请回答后继续');
  expect(buildSystemNotification(event).body.split('\n')[0]).toBe('Answer needed · Answer to continue');
});
it('tracks concurrent requests across views, resumes after the last response and rejects stale runs', () => {
  const registry = createSessionActivityRegistry();
  registry.receive(1, frame('status', { text: 'started' }));
  expect(registry.receive(1, frame('permission_request', { requestId: 'q1', toolCallId: 't1', toolName: 'AskUserQuestion' })).waitingFor).toBe('question');
  registry.receive(1, frame('permission_request', { requestId: 'p1', toolName: 'shell' }));
  expect(registry.receive(1, frame('tool_result', { toolId: 't1' })).waitingFor).toBe('approval');
  expect(registry.receive(1, frame('permission_cancelled', { requestId: 'p1' }))).toMatchObject({ processing: true, waitingFor: null });
  registry.receive(1, frame('permission_request', { requestId: 'q2', toolName: 'AskUserQuestion' }));
  expect(registry.snapshot(1)[0].waitingFor).toBe('question');
  expect(registry.receive(1, frame('complete', { finishReason: 'completed' }))).toMatchObject({ processing: false, waitingFor: null });
  registry.receive(1, frame('status', { text: 'started', runId: 'r2' }));
  expect(registry.receive(1, frame('permission_request', { requestId: 'old', toolName: 'AskUserQuestion' }))).toBeNull();
  expect(registry.snapshot(1)[0].waitingFor).toBeNull();
});
