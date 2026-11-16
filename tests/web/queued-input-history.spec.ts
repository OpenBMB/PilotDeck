import test from "node:test";
import assert from "node:assert/strict";

import { flattenCanonicalMessage } from "../../src/web/server/readSessionMessages.js";

test("web history preserves queued guidance identity for restart reconciliation", () => {
  const messages = flattenCanonicalMessage({
    role: "user",
    content: [{ type: "text", text: "Use HTML instead" }],
    metadata: {
      purpose: "mid_turn_steer",
      queueItemId: "queue-1",
    },
  }, {
    index: 0,
    sessionKey: "web:s_test",
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.queueItemId, "queue-1");
});

test('history retains the same timeline identity and queue item for mid-turn guidance', () => {
  const timeline = { version: 1 as const, turnId: 'run', id: 'steer:guidance', order: 4, revision: 12 };
  const rows = flattenCanonicalMessage({ role: 'user', content: [{ type: 'text', text: 'Use primary sources', timeline }],
    metadata: { purpose: 'mid_turn_steer', queueItemId: 'guidance' } }, { index: 2, sessionKey: 'cron:task' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].timeline, timeline);
  assert.equal(rows[0].queueItemId, 'guidance');
  assert.equal(rows[0].isSteer, true);
});
