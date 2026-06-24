import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { createProjectId } from "../../src/pilot/paths.js";

test("forkWebSession copies history before target turn and returns prefill text", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_parent";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await import("node:fs/promises").then((fs) => fs.mkdir(chatDir, { recursive: true }));

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "first question" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-2",
      parentEntryId: "entry-1",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "entry-3",
      parentEntryId: "entry-2",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 4,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-4",
      parentEntryId: "entry-3",
      messages: [{ role: "user", content: [{ type: "text", text: "second question" }] }],
    },
  ];

  await import("node:fs/promises").then((fs) =>
    fs.writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8"),
  );

  const result = await forkWebSession(
    { sessionKey, projectKey: projectRoot, fromEntryId: "entry-4" },
    { projectRoot, pilotHome, now: () => new Date("2026-06-24T01:00:00.000Z") },
  );

  assert.equal(result.prefillText, "second question");
  assert.equal(result.carriedMessageCount, 2);
  assert.match(result.newSessionKey, /^web[:_]s_/);

  const newTranscriptPath = join(chatDir, `${result.newSessionKey}.jsonl`);
  const { entries } = await readTranscript(newTranscriptPath);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].sequence, 1);
  assert.equal(entries[2].type, "turn_result");
  assert.equal(entries[3].type, "session_metadata");
  if (entries[3].type === "session_metadata") {
    assert.equal(entries[3].metadata.parentSessionId, sessionKey);
    assert.equal(entries[3].metadata.forkedFromTurnId, "turn-2");
  }

  await rm(pilotHome, { recursive: true, force: true });
});
