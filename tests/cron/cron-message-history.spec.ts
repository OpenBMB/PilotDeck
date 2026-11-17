import assert from 'node:assert/strict';
import test from 'node:test';
import { readCronMessageHistory } from '../../src/cron/runtime/CronMessageHistory.js';
import type { CronListResult } from '../../src/cron/protocol/types.js';
import type { WebReadSessionMessagesResult } from '../../src/web/client/protocol.js';

const result = (sessionKey: string, ordinal: number): WebReadSessionMessagesResult => ({
  session: { sessionId: sessionKey, sessionKey, summary: 'Task', lastModified: 0 },
  messages: ['user', 'assistant'].map((role, index) => ({ id: `${ordinal}-${role}`, sessionKey, provider: 'pilotdeck',
    source: 'history', kind: 'text', role: role as 'user' | 'assistant', text: `${role} ${ordinal}`, turnId: `turn-${ordinal}`,
    createdAt: `2026-01-0${ordinal}T00:00:0${index}Z` })),
});

test('legacy owned runs join the shared task history with whole-turn pagination and no source-chat reads', async () => {
  const catalog = { tasks: [{ taskId: 'owned', sessionKey: 'cron:owned' }], recentRuns: [
    { taskId: 'owned', sessionKey: 'web:source' },
    { taskId: 'owned', sessionKey: 'cron:owned:second' },
    { taskId: 'owned', sessionKey: 'cron:owned:first' },
    { taskId: 'other', sessionKey: 'cron:owned:wrong-owner' },
  ] } as CronListResult;
  const reads: string[] = [];
  const read = async ({ sessionKey }: { sessionKey: string }) => {
    reads.push(sessionKey);
    return result(sessionKey, sessionKey.endsWith('first') ? 1 : sessionKey.endsWith('second') ? 2 : 3);
  };
  const newest = await readCronMessageHistory({ sessionKey: 'cron:owned', limit: 1, direction: 'backward' }, catalog, read);
  assert.equal(newest.total, 6);
  assert.deepEqual(newest.messages.map(message => message.text), ['user 3', 'assistant 3']);
  assert.equal(newest.nextCursor, 'before:3-user');
  const older = await readCronMessageHistory({ sessionKey: 'cron:owned', limit: 1, direction: 'backward', cursor: newest.nextCursor }, catalog, read);
  assert.deepEqual(older.messages.map(message => message.text), ['user 2', 'assistant 2']);
  assert.equal(reads.some(key => key === 'web:source' || key.endsWith('wrong-owner')), false);
  const restored = await readCronMessageHistory({ sessionKey: 'cron:owned', limit: 1, direction: 'backward', includeFromId: '1-user' }, catalog, read);
  assert.equal(restored.messages.length, 6);
});
