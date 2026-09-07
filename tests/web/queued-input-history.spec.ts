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
