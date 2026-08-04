import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import {
  readSubagentWebMessages,
  readWebSessionMessages,
} from "../../src/web/server/readSessionMessages.js";

const createdAt = "2026-08-02T00:00:00.000Z";

function completedTurn(sessionId: string, turnId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

test("web history restores structured records around a visible compact boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-compact-web-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-compact-web-home-"));
  try {
    const sessionKey = "web:s_compact_replay";
    const subagentId = "subagent-before-compact";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      // Intentionally give every entry the same timestamp. Ordering must come
      // from the transcript sequence, not timestamp insertion heuristics.
      now: () => new Date(createdAt),
    });

    await storage.transcript.recordAcceptedInput(sessionKey, "turn-old", [
      { role: "user", content: [{ type: "text", text: "old user request before compact" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-old", {
      role: "assistant",
      content: [
        { type: "thinking", text: "old thinking before compact" },
        { type: "text", text: "old answer before compact" },
        { type: "tool_call", id: "task-1", name: "Task", input: { prompt: "inspect the project" } },
      ],
    });
    await storage.transcript.recordSubagentStarted(sessionKey, "turn-old", {
      subagentId,
      subagentType: "explore",
      prompt: "inspect the project",
      transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-old", {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "task-1",
        content: [{ type: "text", text: "subagent inspected the project" }],
        raw: { toolName: "Task" },
      }],
    });
    await storage.transcript.recordFileArtifacts(sessionKey, "turn-old", [{
      id: "artifact-before-compact",
      name: "report.xlsx",
      path: "report.xlsx",
      operation: "created",
      source: "workspace_diff",
      status: "complete",
      size: 42,
      sha256: "a".repeat(64),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      createdAt,
    }]);
    await storage.transcript.recordTurnResult(
      sessionKey,
      "turn-old",
      completedTurn(sessionKey, "turn-old"),
    );
    await storage.transcript.recordControlBoundary(sessionKey, "turn-compact", {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        trigger: "auto",
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 2,
      },
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-compact", {
      role: "assistant",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\ncompact summary" }],
    });
    await storage.transcript.recordDurableMessage(sessionKey, "turn-compact", {
      role: "user",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "replacement tail should stay model-visible only" }],
    });
    await storage.transcript.recordTurnResult(
      sessionKey,
      "turn-compact",
      completedTurn(sessionKey, "turn-compact"),
    );
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-new", [
      { role: "user", content: [{ type: "text", text: "new user request after compact" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-new", {
      role: "assistant",
      content: [{ type: "text", text: "new answer after compact" }],
    });
    await storage.transcript.recordTurnResult(
      sessionKey,
      "turn-new",
      completedTurn(sessionKey, "turn-new"),
    );

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const text = replay.messages.map((message) => message.text ?? "").join("\n");
    const compactBoundaries = replay.messages.filter((message) => message.kind === "compact_boundary");
    const compactBoundary = compactBoundaries[0];
    const toolUse = replay.messages.find((message) => message.kind === "tool_use" && message.toolCallId === "task-1");
    const toolResult = replay.messages.find((message) => message.kind === "tool_result" && message.toolCallId === "task-1");
    const artifact = replay.messages.find((message) => message.kind === "file_artifacts");

    assert.equal(compactBoundaries.length, 1);
    assert.ok(compactBoundary);
    assert.equal(compactBoundary.turnId, "turn-compact");
    assert.deepEqual(compactBoundary.payload, {
      trigger: "auto",
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 2,
      level: undefined,
      stage: undefined,
      stageLabel: undefined,
    });
    assert.ok(toolUse);
    assert.equal(toolUse.subagentId, subagentId);
    assert.ok(toolResult);
    assert.ok(artifact);
    assert.equal(artifact.turnId, "turn-old");
    assert.equal(artifact.artifacts?.[0]?.path, "report.xlsx");
    assert.match(text, /old user request before compact/);
    assert.match(text, /old thinking before compact/);
    assert.match(text, /old answer before compact/);
    assert.match(text, /new user request after compact/);
    assert.match(text, /new answer after compact/);
    assert.doesNotMatch(text, /\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
    assert.doesNotMatch(text, /compact summary/);
    assert.doesNotMatch(text, /replacement tail should stay model-visible only/);

    const artifactIndex = replay.messages.indexOf(artifact);
    const boundaryIndex = replay.messages.indexOf(compactBoundary);
    const newUserIndex = replay.messages.findIndex((message) =>
      message.kind === "text" && message.text?.includes("new user request after compact"),
    );
    assert.ok(artifactIndex >= 0 && artifactIndex < boundaryIndex);
    assert.ok(boundaryIndex < newUserIndex);
    const sequences = replay.messages
      .map((message) => message.sequence)
      .filter((sequence): sequence is number => Number.isFinite(sequence));
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("subagent history keeps execution messages around its compact boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-compact-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-compact-home-"));
  try {
    const sessionKey = "web:s_subagent_compact";
    const subagentId = "subagent-compact";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date(createdAt),
    });
    const sidechain = storage.transcript.forSubagent(subagentId, () => new Date(createdAt));
    await storage.transcript.recordSubagentStarted(sessionKey, "turn-parent", {
      subagentId,
      subagentType: "explore",
      prompt: "inspect before and after compact",
      transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
    });
    await sidechain.writer.recordAcceptedInput("subagent-session", "sub-turn-old", [{
      role: "user",
      content: [{ type: "text", text: "sidechain fork prelude" }],
    }]);
    await sidechain.writer.recordDurableMessage("subagent-session", "sub-turn-old", {
      role: "assistant",
      content: [{ type: "text", text: "subagent output before compact" }],
    });
    await sidechain.writer.recordTurnResult(
      "subagent-session",
      "sub-turn-old",
      completedTurn("subagent-session", "sub-turn-old"),
    );
    await sidechain.writer.recordControlBoundary("subagent-session", "sub-turn-compact", {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 80, postTokens: 20, messagesSummarized: 1 },
    });
    await sidechain.writer.recordDurableMessage("subagent-session", "sub-turn-compact", {
      role: "assistant",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "hidden subagent compact summary" }],
    });
    await sidechain.writer.recordTurnResult(
      "subagent-session",
      "sub-turn-compact",
      completedTurn("subagent-session", "sub-turn-compact"),
    );
    await sidechain.writer.recordAcceptedInput("subagent-session", "sub-turn-new", [{
      role: "user",
      content: [{ type: "text", text: "sidechain resumed input" }],
    }]);
    await sidechain.writer.recordDurableMessage("subagent-session", "sub-turn-new", {
      role: "assistant",
      content: [{ type: "text", text: "subagent output after compact" }],
    });
    await sidechain.writer.recordTurnResult(
      "subagent-session",
      "sub-turn-new",
      completedTurn("subagent-session", "sub-turn-new"),
    );

    const replay = await readSubagentWebMessages(
      { sessionKey, subagentId },
      { projectRoot, pilotHome },
    );
    const text = replay.messages.map((message) => message.text ?? "").join("\n");
    const boundaryIndex = replay.messages.findIndex((message) => message.kind === "compact_boundary");
    const beforeIndex = replay.messages.findIndex((message) => message.text === "subagent output before compact");
    const afterIndex = replay.messages.findIndex((message) => message.text === "subagent output after compact");

    assert.equal(replay.messages.filter((message) => message.kind === "compact_boundary").length, 1);
    assert.match(text, /subagent output before compact/);
    assert.match(text, /subagent output after compact/);
    assert.doesNotMatch(text, /sidechain fork prelude/);
    assert.doesNotMatch(text, /sidechain resumed input/);
    assert.doesNotMatch(text, /hidden subagent compact summary/);
    assert.ok(beforeIndex >= 0 && beforeIndex < boundaryIndex);
    assert.ok(boundaryIndex < afterIndex);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
