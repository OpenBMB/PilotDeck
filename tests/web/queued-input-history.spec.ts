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

test("web history re-projects sent file attachments as assistant messages", () => {
  const messages = flattenCanonicalMessage({
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: "call-send",
      content: [{ type: "text", text: "Sending attachment: report.txt" }],
      raw: {
        toolName: "send_attachment",
        content: [{
          type: "file",
          path: "/workspace/report.txt",
          mimeType: "text/plain",
        }],
      },
    }],
  }, {
    index: 1,
    sessionKey: "web:s_test",
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  });

  const attachmentMessage = messages.find((message) => message.attachments?.length);
  assert.equal(attachmentMessage?.role, "assistant");
  assert.deepEqual(attachmentMessage?.attachments, [{
    name: "report.txt",
    path: "/workspace/report.txt",
    mimeType: "text/plain",
  }]);
});
