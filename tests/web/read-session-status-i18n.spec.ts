import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("history replay preserves agent status i18n metadata and user hint", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-status-i18n-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-status-i18n-home-"));
  try {
    const sessionKey = "web:s_status_i18n";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    await storage.transcript.recordAgentStatusMessage(sessionKey, "turn-1", {
      event: "model_request_failed",
      kind: "error",
      text: "Provider raw error\n\nAction: Check Settings.",
      detail: {
        message: "Provider raw error\n\nAction: Check Settings.",
        messageI18n: {
          key: "chat:agentStatus.modelRequestFailed.message",
          params: { providerMessage: "Provider raw error" },
        },
        userHint: "Check Settings.",
        userHintI18n: { key: "chat:agentStatus.modelRequestFailed.actions.settingsDefault" },
        severity: "error",
        visible: true,
      },
    });

    const replay = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const message = replay.messages.find((item) => item.kind === "error");

    assert.ok(message, "expected replayed error status message");
    assert.equal(message.text, "Provider raw error\n\nAction: Check Settings.");
    assert.deepEqual(message.contentI18n, {
      key: "chat:agentStatus.modelRequestFailed.message",
      params: { providerMessage: "Provider raw error" },
    });
    assert.deepEqual(message.userHintI18n, { key: "chat:agentStatus.modelRequestFailed.actions.settingsDefault" });
    assert.equal((message.payload as { detail?: { userHint?: string } }).detail?.userHint, "Check Settings.");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("history token usage restores latest non-empty turn past latest empty turn result", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-token-usage-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-token-usage-home-"));
  try {
    const sessionKey = "web:s_token_usage_restore";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-1", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-1",
      stopReason: "completed",
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 40, totalTokens: 145 },
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-09T00:00:00.000Z",
      completedAt: "2026-07-09T00:00:01.000Z",
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-2", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-2",
      stopReason: "completed",
      usage: { inputTokens: 25, outputTokens: 2, cacheReadTokens: 10, totalTokens: 37 },
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-09T00:00:02.000Z",
      completedAt: "2026-07-09T00:00:03.000Z",
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-3", {
      type: "error",
      sessionId: sessionKey,
      turnId: "turn-3",
      stopReason: "model_error",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: "2026-07-09T00:00:04.000Z",
      completedAt: "2026-07-09T00:00:04.000Z",
    });

    const replay = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, maxContextTokens: 1000 },
    );

    assert.equal(replay.tokenUsage?.used, 35);
    assert.equal((replay.tokenUsage?.breakdown as { output?: number } | undefined)?.output, 2);
    assert.equal(replay.tokenUsage?.total, 1000);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("history token usage prefers persisted context budget snapshot", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-token-budget-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-token-budget-home-"));
  try {
    const sessionKey = "web:s_token_budget_restore";
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-1", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-1",
      stopReason: "completed",
      usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-09T00:00:00.000Z",
      completedAt: "2026-07-09T00:00:01.000Z",
    });
    await storage.transcript.recordAgentStatusMessage(sessionKey, "turn-1", {
      event: "context_budget",
      kind: "status",
      text: "context_budget",
      detail: {
        type: "context_budget",
        used: 80,
        displayUsed: 60,
        budgetUsed: 90,
        total: 500,
        effectiveTotal: 450,
        reservedOutputTokens: 50,
        ratio: 0.2,
        state: "ok",
      },
    });

    const replay = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, maxContextTokens: 1000 },
    );

    assert.equal(replay.tokenUsage?.used, 60);
    assert.equal(replay.tokenUsage?.displayUsed, 60);
    assert.equal(replay.tokenUsage?.budgetUsed, 90);
    assert.equal(replay.tokenUsage?.total, 500);
    assert.equal(replay.tokenUsage?.effectiveTotal, 450);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
