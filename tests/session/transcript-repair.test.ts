import test from "node:test";
import assert from "node:assert/strict";

import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

test("replayTranscriptEntries seals completed turns with missing tool results", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "run tool" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "s",
      turnId: "t1",
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "call_timeout", name: "read_file", input: { file_path: "a" } }],
      },
    },
    {
      type: "turn_result",
      sessionId: "s",
      turnId: "t1",
      sequence: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
      result: {
        type: "error",
        sessionId: "s",
        turnId: "t1",
        stopReason: "model_error",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
      },
    },
    {
      type: "accepted_input",
      sessionId: "s",
      turnId: "t2",
      sequence: 4,
      createdAt: "2026-01-01T00:00:03.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    },
  ];

  const replay = replayTranscriptEntries(entries);
  const assistantIndex = replay.messages.findIndex((message) => message.role === "assistant");
  const synthetic = replay.messages[assistantIndex + 1];

  assert.equal(synthetic.role, "user");
  assert.equal(synthetic.content[0]?.type, "tool_result");
  if (synthetic.content[0]?.type === "tool_result") {
    assert.equal(synthetic.content[0].toolCallId, "call_timeout");
    assert.equal(synthetic.content[0].isError, true);
  }
  assert.equal(replay.messages[assistantIndex + 2]?.role, "user");
  assert.equal(replay.diagnostics.some((diagnostic) => diagnostic.message.includes("call_timeout")), true);
});
