import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

const createdAt = "2026-08-02T00:00:00.000Z";

function messageText(entry: { content: Array<{ type: string; text?: string }> }): string {
  return entry.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("legacy compaction without a complete snapshot conservatively retains original history", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "session-compact",
      turnId: "turn-old",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "old accepted input" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "session-compact",
      turnId: "turn-old",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "old assistant reply" }] },
    },
    {
      type: "turn_result",
      sessionId: "session-compact",
      turnId: "turn-old",
      sequence: 3,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-compact",
        turnId: "turn-old",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
    {
      type: "control_boundary",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 4,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preTokens: 120,
          postTokens: 40,
          messagesSummarized: 2,
        },
      },
    },
    {
      type: "assistant_message",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 5,
      createdAt,
      message: {
        role: "assistant",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }],
      },
    },
    {
      type: "durable_message",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 6,
      createdAt,
      message: {
        role: "user",
        metadata: { compactReplacement: true },
        content: [{ type: "text", text: "kept tail input" }],
      },
    },
    {
      type: "turn_result",
      sessionId: "session-compact",
      turnId: "turn-compact",
      sequence: 7,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-compact",
        turnId: "turn-compact",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
  ];

  const replay = replayTranscriptEntries(entries);
  const replayText = replay.messages.map(messageText).join("\n");
  const rawText = JSON.stringify(entries);

  assert.equal(replay.lastCompactBoundaryIndex, undefined);
  assert.match(rawText, /old accepted input/);
  assert.match(rawText, /old assistant reply/);
  assert.match(replayText, /old accepted input/);
  assert.match(replayText, /old assistant reply/);
  assert.doesNotMatch(replayText, /\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.doesNotMatch(replayText, /kept tail input/);
  // Neither a bare legacy boundary nor a partially written replacement can
  // hide the old context, even before turn_result has been recorded.
  for (const end of [4, 5, 6]) {
    const partial = replayTranscriptEntries(entries.slice(0, end));
    assert.deepEqual(partial.messages, replay.messages);
    assert.equal(partial.lastCompactBoundary, undefined);
  }
});
