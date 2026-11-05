import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentProjectSessionStorage } from '../../src/session/storage/ProjectSessionStorage.js';
import { readWebSessionMessages } from '../../src/web/server/readSessionMessages.js';
import { applyWebGatewayEvent, createWebMessageReducerState } from '../../src/web/client/webMessage.js';
import type { AgentTurnResult } from '../../src/agent/protocol/result.js';

for (const stopReason of ['completed', 'aborted_streaming', 'aborted_tools', 'model_error'] as const) {
  test(`turn timing survives ${stopReason} and history replay without counting idle time`, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-timing-project-'));
    const pilotHome = await mkdtemp(join(tmpdir(), 'pilotdeck-timing-home-'));
    try {
      const sessionKey = 'web:timing', turnId = 'timed-turn';
      // Transcript arrival times intentionally differ from execution bounds.
      const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey,
        now: () => new Date('2026-09-01T00:03:00Z') });
      await storage.transcript.recordAcceptedInput(sessionKey, turnId, [{ role: 'user', content: [{ type: 'text', text: 'Inspect the result' }] }]);
      await storage.transcript.recordDurableMessage(sessionKey, turnId, { role: 'assistant', content: [{ type: 'text', text: 'Checking the result' }] });
      const result: AgentTurnResult = { type: stopReason === 'completed' ? 'success' : stopReason.startsWith('aborted') ? 'aborted' : 'error',
        sessionId: sessionKey, turnId, stopReason, usage: {}, permissionDenials: [], turns: 1,
        startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:01:20Z' };
      await storage.transcript.recordTurnResult(sessionKey, turnId, result);
      const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
      assert.deepEqual(replay.messages.find(message => message.turnTiming)?.turnTiming, {
        startedAt: result.startedAt, completedAt: result.completedAt, finishReason: stopReason,
      });
      assert.equal(replay.messages.filter(message => message.turnTiming).length, 1);
      const live = applyWebGatewayEvent(createWebMessageReducerState(), { type: 'turn_completed', usage: {}, finishReason: stopReason,
        startedAt: result.startedAt, completedAt: result.completedAt }, { sessionKey });
      assert.deepEqual(live.messages[0].turnTiming, replay.messages.find(message => message.turnTiming)?.turnTiming);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(pilotHome, { recursive: true, force: true });
    }
  });
}
