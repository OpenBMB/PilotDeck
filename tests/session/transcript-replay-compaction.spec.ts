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

test("transcript replay applies an atomic compact replacement only after its turn completes", () => {
  const replacement = [
    {
      role: "assistant" as const,
      metadata: { compactReplacement: true },
      content: [{ type: "text" as const, text: "atomic summary" }],
    },
    {
      role: "user" as const,
      metadata: { compactReplacement: true },
      content: [{ type: "text" as const, text: "atomic tail" }],
    },
  ];
  const completedEntries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "session-atomic-compact",
      turnId: "turn-old",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "old history" }] }],
    },
    {
      type: "turn_result",
      sessionId: "session-atomic-compact",
      turnId: "turn-old",
      sequence: 2,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-atomic-compact",
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
      sessionId: "session-atomic-compact",
      turnId: "turn-compact",
      sequence: 3,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 20 },
        replacementMessages: replacement,
      },
    },
    {
      type: "turn_result",
      sessionId: "session-atomic-compact",
      turnId: "turn-compact",
      sequence: 4,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-atomic-compact",
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
  const completedReplay = replayTranscriptEntries(completedEntries);
  assert.deepEqual(completedReplay.messages.map(messageText), ["atomic summary", "atomic tail"]);

  const crashReplay = replayTranscriptEntries(completedEntries.slice(0, 3));
  assert.deepEqual(crashReplay.messages, []);
});

test("transcript replay composes conversation, turn summary, metadata, and diagnostics projections", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "session-projections",
      turnId: "turn-complete",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    {
      type: "assistant_message",
      sessionId: "session-projections",
      turnId: "turn-complete",
      sequence: 2,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "world" }] },
    },
    {
      type: "turn_result",
      sessionId: "session-projections",
      turnId: "turn-complete",
      sequence: 3,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-projections",
        turnId: "turn-complete",
        stopReason: "completed",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        permissionDenials: [{ toolName: "write_file", toolCallId: "call-denied", errorCode: "denied" }],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
    {
      type: "session_metadata",
      sessionId: "session-projections",
      turnId: "turn-complete",
      sequence: 4,
      createdAt,
      metadata: { title: "Projected title", firstPrompt: "hello" },
    },
    {
      type: "session_metadata",
      sessionId: "session-projections",
      turnId: "turn-complete",
      sequence: 5,
      createdAt,
      metadata: { tag: "projection" },
    },
    {
      type: "durable_message",
      sessionId: "session-projections",
      turnId: "turn-incomplete",
      sequence: 6,
      createdAt,
      message: { role: "user", content: [{ type: "text", text: "must not replay" }] },
    },
  ];

  const replay = replayTranscriptEntries(entries);

  assert.deepEqual(replay.messages.map(messageText), ["hello", "world"]);
  assert.deepEqual(replay.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    totalTokens: 5,
  });
  assert.deepEqual(replay.permissionDenials, [
    { toolName: "write_file", toolCallId: "call-denied", errorCode: "denied" },
  ]);
  assert.deepEqual(replay.metadata, {
    title: "Projected title",
    firstPrompt: "hello",
    tag: "projection",
    linkedPullRequest: undefined,
  });
  assert.deepEqual(replay.events.map((event) => event.type), [
    "input_accepted",
    "assistant_message",
    "turn_completed",
  ]);
  assert.deepEqual(replay.diagnostics, [
    {
      code: "transcript_entry_invalid",
      severity: "warning",
      message: "Skipping durable message for incomplete turn turn-incomplete.",
    },
  ]);
});

test("transcript replay restores runtime context before its completed turn request and skips crash tails", () => {
  const runtimeContextMessage = {
    role: "user" as const,
    metadata: { synthetic: true, purpose: "runtime_context" },
    content: [{ type: "text" as const, text: "<runtime-context name=\"cwd\">/workspace</runtime-context>" }],
  };
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: "session-runtime-context",
      turnId: "turn-complete",
      sequence: 1,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    {
      type: "context_snapshot",
      sessionId: "session-runtime-context",
      turnId: "turn-complete",
      sequence: 2,
      createdAt,
      step: 1,
      contexts: [{ name: "cwd", text: "/workspace" }],
      runtimeContextMessages: [runtimeContextMessage],
    },
    {
      type: "assistant_message",
      sessionId: "session-runtime-context",
      turnId: "turn-complete",
      sequence: 3,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "world" }] },
    },
    {
      type: "turn_result",
      sessionId: "session-runtime-context",
      turnId: "turn-complete",
      sequence: 4,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-runtime-context",
        turnId: "turn-complete",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
    {
      type: "accepted_input",
      sessionId: "session-runtime-context",
      turnId: "turn-incomplete",
      sequence: 5,
      createdAt,
      messages: [{ role: "user", content: [{ type: "text", text: "crash tail" }] }],
    },
    {
      type: "context_snapshot",
      sessionId: "session-runtime-context",
      turnId: "turn-incomplete",
      sequence: 6,
      createdAt,
      step: 1,
      contexts: [{ name: "cwd", text: "/workspace" }],
      runtimeContextMessages: [runtimeContextMessage],
    },
  ];

  const replay = replayTranscriptEntries(entries);

  assert.deepEqual(replay.messages.map(messageText), [
    "<runtime-context name=\"cwd\">/workspace</runtime-context>",
    "hello",
    "world",
    "crash tail",
  ]);
  assert.equal(replay.diagnostics.length, 0);
});
