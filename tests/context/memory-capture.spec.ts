import assert from 'node:assert/strict';
import test from 'node:test';
import { EdgeClawMemoryProvider } from '../../src/context/memory/EdgeClawMemoryProvider.js';
import { canonicalMessagesToMemoryMessages } from '../../src/context/memory/MemoryResolver.js';
import { normalizeMessages } from '../../src/context/memory/edgeclaw-memory-core/src/message-utils.js';
import type { CanonicalMessage } from '../../src/model/index.js';

test('task memory capture keeps real lasting guidance instead of runtime reference instructions', async () => {
  const messages: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'Always cite primary sources. Mark unknown evidence as unverified.' }] },
    ...['scheduled_task_context', 'memory_context', 'date_update', 'session_artifact_status'].map(purpose => ({
      role: 'user' as const, metadata: { synthetic: true, purpose }, content: [{ type: 'text' as const, text: 'Internal reference, not user feedback' }],
    })),
    { role: 'assistant', content: [{ type: 'text', text: 'Task requirements saved' }] },
  ];
  let captured: unknown[] = [];
  const provider = new EdgeClawMemoryProvider({ service: {
    async retrieveContext() { return {}; },
    captureTurn(raw, input) {
      captured = normalizeMessages([...raw], { includeAssistant: true, maxMessageChars: 6000, captureStrategy: 'last_turn' });
      return { captured: true, normalizedMessages: [], sessionKey: input.sessionKey };
    },
  } });
  await provider.captureTurn({ sessionId: 'cron:task', projectRoot: '/tmp/synthetic-project', messages, errored: false });
  assert.deepEqual(captured, [
    { role: 'user', content: 'Always cite primary sources. Mark unknown evidence as unverified.' },
    { role: 'assistant', content: 'Task requirements saved' },
  ]);
});

test('memory projection retains real mid-turn corrections and excludes fork carryover when capturing', () => {
  const messages: CanonicalMessage[] = [
    { role: 'user', metadata: { forkCarryover: { sourceSessionId: 'web:source' } }, content: [{ type: 'text', text: 'Copied source conversation' }] },
    { role: 'user', metadata: { purpose: 'mid_turn_steer', queueItemId: 'correction' }, content: [{ type: 'text', text: 'Future reports must verify citations' }] },
  ];
  assert.deepEqual(canonicalMessagesToMemoryMessages(messages, { includeForkCarryover: false }), [
    { msgId: 'message-1', role: 'user', content: 'Future reports must verify citations' },
  ]);
});
