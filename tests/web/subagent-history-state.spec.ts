import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

const createdAt = "2026-08-10T00:00:00.000Z";

test("history keeps a completed sibling complete when its parent turn is aborted", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-history-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-history-home-"));

  try {
    const sessionKey = "web:s_subagent_mixed_terminal_state";
    const turnId = "turn-mixed";
    const completedSubagentId = "subagent-completed";
    const abortedSubagentId = "subagent-aborted";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date(createdAt),
    });

    await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
      { role: "user", content: [{ type: "text", text: "run two subagents" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, turnId, {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "agent-call-completed",
          name: "agent",
          input: { description: "short child", prompt: "sleep 2" },
        },
        {
          type: "tool_call",
          id: "agent-call-aborted",
          name: "agent",
          input: { description: "long child", prompt: "sleep 300" },
        },
      ],
    });
    await storage.transcript.recordSubagentStarted(sessionKey, turnId, {
      subagentId: completedSubagentId,
      subagentType: "general-purpose",
      prompt: "sleep 2",
      transcriptRelativePath: storage.transcript.relativeSubagentPath(completedSubagentId),
    });
    await storage.transcript.recordSubagentStarted(sessionKey, turnId, {
      subagentId: abortedSubagentId,
      subagentType: "general-purpose",
      prompt: "sleep 300",
      transcriptRelativePath: storage.transcript.relativeSubagentPath(abortedSubagentId),
    });
    await storage.transcript.recordSubagentCompleted(sessionKey, turnId, {
      subagentId: completedSubagentId,
      subagentType: "general-purpose",
      summary: "MIXED_A_DONE",
      turns: 1,
      durationMs: 2_000,
      errored: false,
    });
    await storage.transcript.recordSubagentCompleted(sessionKey, turnId, {
      subagentId: abortedSubagentId,
      subagentType: "general-purpose",
      summary: "SubAgentSession: subagent turn aborted (aborted_tools)",
      turns: 0,
      durationMs: 0,
      errored: true,
    });
    await storage.transcript.recordTurnResult(sessionKey, turnId, {
      type: "aborted",
      sessionId: sessionKey,
      turnId,
      stopReason: "aborted_tools",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: createdAt,
      completedAt: createdAt,
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const completedTool = replay.messages.find(
      (message) => message.kind === "tool_use" && message.toolCallId === "agent-call-completed",
    );
    const abortedTool = replay.messages.find(
      (message) => message.kind === "tool_use" && message.toolCallId === "agent-call-aborted",
    );
    const completedResult = replay.messages.find(
      (message) => message.kind === "tool_result" && message.toolCallId === "agent-call-completed",
    );
    const abortedResult = replay.messages.find(
      (message) => message.kind === "tool_result" && message.toolCallId === "agent-call-aborted",
    );

    assert.equal(completedTool?.subagentId, completedSubagentId);
    assert.equal(abortedTool?.subagentId, abortedSubagentId);
    assert.ok(completedResult, "completed subagent should recover a history tool result");
    assert.equal(completedResult.ok, true);
    assert.equal(completedResult.text, "MIXED_A_DONE");
    assert.equal(abortedResult, undefined, "aborted subagent must remain unfinished for stopped-state fallback");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("history does not duplicate a persisted subagent tool result", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-result-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-result-home-"));

  try {
    const sessionKey = "web:s_subagent_persisted_result";
    const turnId = "turn-completed";
    const subagentId = "subagent-with-result";
    const toolCallId = "agent-call-with-result";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date(createdAt),
    });

    await storage.transcript.recordDurableMessage(sessionKey, turnId, {
      role: "assistant",
      content: [{
        type: "tool_call",
        id: toolCallId,
        name: "agent",
        input: { description: "completed child", prompt: "finish normally" },
      }],
    });
    await storage.transcript.recordSubagentStarted(sessionKey, turnId, {
      subagentId,
      subagentType: "general-purpose",
      prompt: "finish normally",
      transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
    });
    await storage.transcript.recordSubagentCompleted(sessionKey, turnId, {
      subagentId,
      subagentType: "general-purpose",
      summary: "summary preview",
      turns: 1,
      durationMs: 1_000,
      errored: false,
    });
    await storage.transcript.recordDurableMessage(sessionKey, turnId, {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId,
        content: [{ type: "text", text: "persisted full result" }],
        raw: { toolName: "agent" },
      }],
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const results = replay.messages.filter(
      (message) => message.kind === "tool_result" && message.toolCallId === toolCallId,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.text, "persisted full result");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
