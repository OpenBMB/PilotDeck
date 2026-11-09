import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../../src/agent/session/AgentSession.js';
import type { TurnRunner } from '../../src/agent/turn/TurnRunner.js';

test('runtime leases release when a turn stream is closed before running', async () => {
  let users = 0;
  const session = new AgentSession({ sessionId: 'early-close', turnRunner: {} as TurnRunner,
    acquireTurnResources: () => { users++; return () => { users--; }; },
  });
  const stream = session.submit({ type: 'text', text: 'test' });
  await stream.next();
  assert.equal(users, 1);
  await stream.return();
  assert.equal(users, 0);
});

test('runtime leases release when turn execution throws', async () => {
  let users = 0;
  const session = new AgentSession({ sessionId: 'failed',
    turnRunner: { async *run() { throw new Error('turn failed'); } } as unknown as TurnRunner,
    acquireTurnResources: () => { users++; return () => { users--; }; },
  });
  await assert.rejects(async () => {
    for await (const _event of session.submit({ type: 'text', text: 'test' })) { /* drain */ }
  }, /turn failed/);
  assert.equal(users, 0);
});
