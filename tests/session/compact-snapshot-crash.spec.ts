import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import type { AgentControlBoundaryTranscriptEntry, AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { findLastCompactBoundaryIndex, replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

const base = { sessionId: "session", turnId: "compact-turn", createdAt: "2026-09-17T00:00:00.000Z" };
const oldMessages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "original context" }] }];
const snapshotMessages: CanonicalMessage[] = [
  { role: "assistant", content: [{ type: "text", text: "摘要 🚀" }], metadata: { compactReplacement: true } },
  { role: "user", content: [{ type: "text", text: "kept tail" }], metadata: { compactReplacement: true } },
];
const oldEntry: AgentTranscriptEntry = { ...base, type: "accepted_input", sequence: 1, messages: oldMessages };
const boundary: AgentControlBoundaryTranscriptEntry["boundary"] = {
  kind: "compact", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100 },
  snapshot: { version: 1, messages: snapshotMessages },
};
const compactEntry: AgentControlBoundaryTranscriptEntry = {
  ...base, type: "control_boundary", sequence: 2, boundary,
};

test("a complete compact snapshot replays without turn_result and preserves subsequent input", () => {
  const later: AgentTranscriptEntry = { ...oldEntry, sequence: 3, turnId: "next", messages: oldMessages };
  const result = replayTranscriptEntries([oldEntry, compactEntry, later]);
  assert.deepEqual(result.messages, [...snapshotMessages, ...oldMessages]);
  assert.equal(result.lastCompactBoundaryIndex, 1);
  assert.equal(result.lastCompactBoundary, compactEntry);
  assert.equal(result.diagnostics.length, 0);
  assert.notEqual(result.messages[0], snapshotMessages[0]);
  assert.equal(result.events.length, 3);
});

test("TurnRunner commits the entire snapshot before the active turn completes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compact-turn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  let checked = false;
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      // The loop supplies a boundary plus messages, not a pre-built snapshot.
      await input.onCompactPersisted!({
        boundary: { kind: "compact", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100 } },
        messages: snapshotMessages,
      });
      const { entries } = await readTranscript(path);
      assert.deepEqual(
        entries.filter((entry) => entry.type === "accepted_input" || entry.type === "control_boundary").map((entry) => entry.type),
        ["accepted_input", "control_boundary"],
      );
      assert.deepEqual(replayTranscriptEntries(entries).messages, snapshotMessages);
      checked = true;
      return {
        messages: snapshotMessages,
        result: {
          type: "success", sessionId: input.sessionId, turnId: input.turnId,
          stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
          startedAt: base.createdAt, completedAt: base.createdAt,
        },
      };
    },
  } as unknown as AgentLoop;
  const runner = new TurnRunner(loop, writer, undefined, undefined, undefined,
    { cwd: dir, transcriptPath: path, collectFileArtifacts: false });
  for await (const _event of runner.run({
    sessionId: base.sessionId, turnId: base.turnId, messages: [], input: { type: "text", text: "original input" },
  })) { /* exhaust the turn */ }
  assert.equal(checked, true);
  const { entries } = await readTranscript(path);
  assert.equal(entries.filter((entry) => entry.type === "control_boundary").length, 1);
  assert.deepEqual(replayTranscriptEntries(entries).messages, snapshotMessages);
});

test("snapshot validation preserves tool pairs, thinking, and multimedia content", () => {
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [
      { type: "thinking", text: "thought", signature: "signature" },
      { type: "tool_call", id: "tool", name: "read", input: { path: "file" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", toolCallId: "tool", content: [{ type: "text", text: "output" }] },
      { type: "image", source: "url", data: "https://example.com/image", mimeType: "image/png" },
      { type: "pdf", source: "base64", data: "data", mimeType: "application/pdf", bytes: 4 },
      { type: "audio", source: "base64", data: "data", mimeType: "audio/wav" },
      { type: "tool_result_reference", toolCallId: "tool2", path: "file", originalBytes: 10, preview: "part", hasMore: true },
      { type: "media_reference", path: "media", originalBytes: 10, preview: "image", hasMore: true, mimeType: "image/png", mediaType: "image" },
    ] },
  ];
  const result = replayTranscriptEntries([oldEntry, {
    ...compactEntry, boundary: { ...boundary, snapshot: { version: 1, messages } },
  }]);
  assert.deepEqual(result.messages, messages);
  const call = result.messages[0]!.content[1]!;
  assert.equal(call.type, "tool_call");
  if (call.type === "tool_call") (call.input as { path: string }).path = "mutated";
  assert.deepEqual(messages[0]!.content[1], { type: "tool_call", id: "tool", name: "read", input: { path: "file" } });
});

test("invalid snapshots never replace history or supersede the last valid snapshot", () => {
  const invalidSnapshots = [
    undefined, null, {}, { version: 2, messages: snapshotMessages },
    { version: 1, messages: [] }, { version: 1, messages: "bad" },
    { version: 1, messages: [null] },
    { version: 1, messages: [{ role: "system", content: [] }] },
    { version: 1, messages: [{ role: "user" }] },
    { version: 1, messages: [{ role: "user", content: [null] }] },
    { version: 1, messages: [{ role: "assistant", content: [{ type: "text" }] }] },
    { version: 1, messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "id" }] }] },
  ];
  for (const snapshot of invalidSnapshots) {
    const invalid = { ...compactEntry, sequence: 3, boundary: { ...boundary, snapshot } } as AgentTranscriptEntry;
    const fallback = replayTranscriptEntries([oldEntry, invalid]);
    assert.deepEqual(fallback.messages, oldMessages);
    assert.equal(fallback.lastCompactBoundary, undefined);
    assert.equal(findLastCompactBoundaryIndex([oldEntry, invalid]), -1);
    assert.equal(fallback.diagnostics.length, 1);
    const prior = replayTranscriptEntries([oldEntry, compactEntry, invalid]);
    assert.deepEqual(prior.messages, snapshotMessages);
    assert.equal(prior.lastCompactBoundary, compactEntry);
  }
});

test("latest valid snapshot replaces earlier snapshots and preserves usage and metadata", () => {
  const entries: AgentTranscriptEntry[] = [
    oldEntry, compactEntry,
    { ...base, type: "session_metadata", sequence: 3, metadata: { title: "title" } },
    { ...base, type: "turn_result", sequence: 4, result: {
      type: "success", sessionId: base.sessionId, turnId: base.turnId, stopReason: "completed",
      usage: { inputTokens: 100 }, permissionDenials: [], turns: 1,
      startedAt: base.createdAt, completedAt: base.createdAt,
    } },
    { ...compactEntry, sequence: 5, boundary: {
      ...boundary, snapshot: { version: 1, messages: oldMessages },
    } },
  ];
  const result = replayTranscriptEntries(entries);
  assert.deepEqual(result.messages, oldMessages);
  assert.equal(result.lastCompactBoundaryIndex, 4);
  assert.equal(result.metadata.title, "title");
  assert.equal(result.usage.inputTokens, 100);
});

test("writer stores one immutable snapshot record and fsyncs it before resolving", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compact-writer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript.jsonl");
  // Observe FileHandle.sync, the durability operation used by appendFile's
  // flush option, without replacing the actual filesystem write.
  const handle = await open(path, "a+");
  const prototype = Object.getPrototypeOf(handle);
  const originalSync = prototype.sync;
  let syncs = 0;
  const syncMock = t.mock.method(prototype, "sync", async function (this: typeof handle) {
    await originalSync.call(this);
    syncs += 1;
  });
  await handle.close();
  const writer = new JsonlTranscriptWriter({ path });
  const messages = structuredClone(snapshotMessages);
  const pending = writer.recordControlBoundary(base.sessionId, base.turnId, {
    ...boundary, snapshot: { version: 1, messages },
  });
  messages.length = 0;
  await pending;
  assert.equal(syncs, 1);
  syncMock.mock.restore();
  const raw = await readFile(path, "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  assert.deepEqual(replayTranscriptEntries((await readTranscript(path)).entries).messages, snapshotMessages);
});

test("every truncated snapshot prefix retains context and allows new writes after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compact-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript.jsonl");
  const prefix = Buffer.from(`${JSON.stringify(oldEntry)}\n`);
  const record = Buffer.from(`${JSON.stringify(compactEntry)}\n`);
  // Includes truncation inside multibyte UTF-8 and just before the newline.
  for (let cut = 0; cut <= record.length; cut += 1) {
    await writeFile(path, Buffer.concat([prefix, record.subarray(0, cut)]));
    const before = await readTranscript(path);
    const expected = cut >= record.length - 1 ? snapshotMessages : oldMessages;
    assert.deepEqual(replayTranscriptEntries(before.entries).messages, expected, `cut ${cut}`);
    const writer = new JsonlTranscriptWriter({ path });
    const last = before.entries.at(-1)!;
    writer.restoreState(last.sequence, last.entryId ?? null);
    await writer.recordAcceptedInput(base.sessionId, "next", oldMessages);
    const after = await readTranscript(path);
    assert.deepEqual(replayTranscriptEntries(after.entries).messages, [...expected, ...oldMessages], `append after cut ${cut}`);
    assert.equal(after.entries.at(-1)!.sequence, last.sequence + 1);
    // Starting a second writer must not repeatedly change or corrupt the tail.
    const next = new JsonlTranscriptWriter({ path });
    next.restoreState(last.sequence + 1, after.entries.at(-1)!.entryId ?? null);
    await next.recordAcceptedInput(base.sessionId, "again", oldMessages);
    assert.deepEqual(replayTranscriptEntries((await readTranscript(path)).entries).messages,
      [...expected, ...oldMessages, ...oldMessages]);
  }
});

test("an append failure rejects the snapshot and prevents later writes on that writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compact-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = new JsonlTranscriptWriter({ path: dir });
  await assert.rejects(writer.recordControlBoundary(base.sessionId, base.turnId, boundary));
  await assert.rejects(writer.recordAcceptedInput(base.sessionId, "next", oldMessages));
});
