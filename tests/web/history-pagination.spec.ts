import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentProjectSessionStorage } from '../../src/session/storage/ProjectSessionStorage.js';
import { readWebSessionMessages } from '../../src/web/server/readSessionMessages.js';

test('backward history pages retain complete turns, stable order and repeated prompts during appends', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-page-project-'));
  const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-page-home-'));
  try {
    const sessionKey = 'web:pagination';
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    const addTurn = async (turnId: string, steps: number) => {
      await storage.transcript.recordAcceptedInput(sessionKey, turnId, [{ role: 'user', content: [{ type: 'text', text: 'Continue with the current information' }] }]);
      for (let step = 0; step < steps; step++) {
        await storage.transcript.recordDurableMessage(sessionKey, turnId, {
          role: 'assistant', content: [{ type: 'text', text: `${turnId} step ${step}` }],
        });
      }
      await storage.transcript.recordTurnResult(sessionKey, turnId, {
        type: 'success', sessionId: sessionKey, turnId, stopReason: 'completed',
        permissionDenials: [], turns: 1, startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:00:01Z',
      });
    };
    const read = (input = {}) => readWebSessionMessages({ sessionKey, ...input }, { projectRoot, pilotHome });
    await addTurn('old', 3);
    await addTurn('long', 110);
    const full = await read();
    const tail = await read({ direction: 'backward', limit: 100 });
    assert.ok(tail.messages.length > 100, 'the page budget is soft at a turn boundary');
    assert.equal(tail.messages[0].role, 'user');
    assert.ok(tail.messages.every(message => message.turnId === 'long'));
    assert.ok(tail.nextCursor?.startsWith('before:'));

    // Live appends do not shift a before-ID anchor, including identical user text.
    await addTurn('latest', 2);
    const older = await read({ direction: 'backward', limit: 100, cursor: tail.nextCursor });
    assert.equal(older.nextCursor, undefined);
    assert.deepEqual([...older.messages, ...tail.messages].map(message => message.id), full.messages.map(message => message.id));
    const prompts = [...older.messages, ...tail.messages].filter(message => message.role === 'user');
    assert.equal(prompts.length, 2);
    assert.notEqual(prompts[0].id, prompts[1].id);
    assert.equal(prompts[0].text, prompts[1].text);

    const replaced = await read({ direction: 'backward', limit: 1, cursor: 'before:removed-message' });
    assert.equal(replaced.historyReset, true);
    assert.ok(replaced.messages.every(message => message.turnId === 'latest'));
    const forward = await read({ limit: 2 });
    assert.deepEqual(forward.messages.map(message => message.id), full.messages.slice(0, 2).map(message => message.id));
    assert.equal(forward.nextCursor, '2');
    const next = await read({ limit: 2, cursor: forward.nextCursor });
    assert.deepEqual(next.messages.map(message => message.id), full.messages.slice(2, 4).map(message => message.id));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
