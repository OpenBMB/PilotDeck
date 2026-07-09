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
