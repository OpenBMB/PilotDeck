import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { createStorageSubagentTranscriptHooks } from "../../../src/session/storage/subagentTranscriptHooks.js";
import type { SubagentTaskMetadataValue } from "../../../src/session/transcript/TranscriptEntry.js";

async function fixture(t: TestContext, overrides: Partial<SubagentTaskMetadataValue> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-continuation-validation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({ projectRoot: dir, pilotHome: dir, sessionId: "parent" });
  const writer = storage.transcript.forSubagent("child-id").writer;
  const sessionId = "child-session", turnId = "child-id-t0";
  await writer.recordAcceptedInput(sessionId, turnId, [{ role: "user", content: [{ type: "text", text: "task" }] }]);
  await writer.recordDurableMessage(sessionId, turnId, { role: "assistant", content: [{ type: "text", text: "done" }] });
  await writer.recordSessionMetadata(sessionId, turnId, {
    subagentTask: { formatVersion: 2, subagentId: "child-id", definitionId: "explore", parentSessionId: "parent", subagentSessionId: sessionId, provider: "test", model: "child", ...overrides },
  });
  await writer.recordTurnResult(sessionId, turnId, { type: "success", sessionId, turnId, stopReason: "completed", usage: {}, turns: 1, permissionDenials: [], startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z" });
  const hooks = createStorageSubagentTranscriptHooks(storage);
  return { storage, load: (id = "child-id") => hooks.loadSubagentContinuation!({ sessionId: "parent", subagentId: id }) };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("a corrupt transcript tail cannot silently replay an older successful round", async (t) => {
  const f = await fixture(t);
  await appendFile(f.storage.subagentTranscriptPath("child-id"), '{"type":"accepted_input"');
  await assert.rejects(f.load(), code("subagent_task_history_unsupported"));
});

test("path aliases cannot reopen the same child under another identity", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.load("child/id"), code("subagent_task_unknown"));
});

test("the recorded child id must match the requested task", async (t) => {
  const f = await fixture(t, { subagentId: "another-child" });
  await assert.rejects(f.load(), code("subagent_task_unknown"));
});

test("the recorded child session must match its transcript entries", async (t) => {
  const f = await fixture(t, { subagentSessionId: "another-session" });
  await assert.rejects(f.load(), code("subagent_task_history_unsupported"));
});

test("an unreadable sidechain returns a continuation error", async (t) => {
  const f = await fixture(t);
  const path = f.storage.subagentTranscriptPath("child-id");
  await rm(path);
  await mkdir(path);
  await assert.rejects(f.load(), code("subagent_task_history_unsupported"));
});
