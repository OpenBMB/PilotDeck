import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import {
  finalizeLastWebSessionTurnReplacement,
  recoverPendingLastTurnReplacements,
  ReplaceLastTurnError,
  replaceLastWebSessionTurn,
} from "../../src/web/server/replaceLastTurn.js";

test("gateway waits for abort, rewrites, then evicts the cached session", async () => {
  const calls: string[] = [];
  const router = {
    abort: async () => { calls.push("abort"); },
    close: async () => { calls.push("close"); },
    activeTurnRunId: () => "turn-old",
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => {
      calls.push("rewrite");
      return {
        sessionKey: input.sessionKey,
        replacedTurnId: input.expectedTurnId,
        removedEntryCount: 3,
        transactionId: "11111111-1111-4111-8111-111111111111",
      };
    },
    finalizeLastTurnReplacement: async (input) => input,
  });

  const result = await gateway.replaceLastTurn({
    sessionKey: "web:s_order",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-new",
  });

  assert.deepEqual(calls, ["abort", "rewrite", "close"]);
  assert.equal(result.removedEntryCount, 3);
});

test("gateway rejects a stale replacement without aborting a newer active turn", async () => {
  const calls: string[] = [];
  const router = {
    abort: async () => { calls.push("abort"); },
    close: async () => { calls.push("close"); },
    activeTurnRunId: () => "turn-newer",
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async () => {
      calls.push("rewrite");
      throw new Error("must not rewrite");
    },
    finalizeLastTurnReplacement: async (input) => input,
  });

  await assert.rejects(
    gateway.replaceLastTurn({
      sessionKey: "web:s_stale_active",
      expectedTurnId: "turn-old",
      replacementTurnId: "turn-replacement",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "replace_turn_conflict"
    ),
  );
  assert.deepEqual(calls, []);
});

test("gateway commits the replacement transaction before emitting input_accepted", async () => {
  const calls: string[] = [];
  const fakeSession = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-replacement";
      yield { type: "turn_started", sessionId: "web:s_accept", turnId } as const;
      yield {
        type: "input_accepted",
        sessionId: "web:s_accept",
        turnId,
        messages: [{ role: "user", content: [{ type: "text", text: "corrected" }] }],
      } as const;
      yield {
        type: "turn_completed",
        sessionId: "web:s_accept",
        turnId,
        result: {
          type: "success",
          sessionId: "web:s_accept",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-08-25T10:00:00.000Z",
          completedAt: "2026-08-25T10:00:01.000Z",
        },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => ({
      sessionKey: input.sessionKey,
      replacedTurnId: input.expectedTurnId,
      removedEntryCount: 2,
      transactionId: "22222222-2222-4222-8222-222222222222",
    }),
    finalizeLastTurnReplacement: async (input) => {
      calls.push(input.action);
      return input;
    },
  });

  await gateway.replaceLastTurn({
    sessionKey: "web:s_accept",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-replacement",
  });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_accept",
    channelKey: "web",
    message: "corrected",
    runId: "turn-replacement",
  })) {
    events.push(event.type);
    if (event.type === "input_accepted") {
      assert.deepEqual(calls, ["commit"]);
    }
  }

  assert.ok(events.includes("input_accepted"));
  assert.deepEqual(calls, ["commit"]);
});

test("gateway claims a replacement before an asynchronous turn-start refresh", async () => {
  const calls: string[] = [];
  const fakeSession = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-replacement";
      yield { type: "turn_started", sessionId: "web:s_claim", turnId } as const;
      yield {
        type: "input_accepted",
        sessionId: "web:s_claim",
        turnId,
        messages: [{ role: "user", content: [{ type: "text", text: "corrected" }] }],
      } as const;
      yield {
        type: "turn_completed",
        sessionId: "web:s_claim",
        turnId,
        result: {
          type: "success",
          sessionId: "web:s_claim",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-08-25T10:00:00.000Z",
          completedAt: "2026-08-25T10:00:01.000Z",
        },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  const gateway = new InProcessGateway(router, {
    replacementTransactionTimeoutMs: 5,
    refreshConfigBeforeTurn: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    },
    replaceLastTurn: async (input) => ({
      sessionKey: input.sessionKey,
      replacedTurnId: input.expectedTurnId,
      removedEntryCount: 2,
      transactionId: "66666666-6666-4666-8666-666666666666",
    }),
    finalizeLastTurnReplacement: async (input) => {
      calls.push(input.action);
      return input;
    },
  });

  await gateway.replaceLastTurn({
    sessionKey: "web:s_claim",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-replacement",
  });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_claim",
    channelKey: "web",
    message: "corrected",
    runId: "turn-replacement",
  })) {
    events.push(event.type);
  }

  assert.ok(events.includes("input_accepted"));
  assert.deepEqual(calls, ["commit"]);
});

test("gateway rolls back an abandoned replacement after its acceptance timeout", async () => {
  let resolveRollback!: () => void;
  const rolledBack = new Promise<void>((resolve) => { resolveRollback = resolve; });
  const router = {
    activeTurnRunId: () => undefined,
    hasActiveTurn: () => false,
    close: async () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replacementTransactionTimeoutMs: 5,
    replaceLastTurn: async (input) => ({
      sessionKey: input.sessionKey,
      replacedTurnId: input.expectedTurnId,
      removedEntryCount: 2,
      transactionId: "33333333-3333-4333-8333-333333333333",
    }),
    finalizeLastTurnReplacement: async (input) => {
      if (input.action === "rollback") resolveRollback();
      return input;
    },
  });

  await gateway.replaceLastTurn({
    sessionKey: "web:s_timeout",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-replacement",
  });
  await Promise.race([
    rolledBack,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("replacement timeout did not roll back")), 1_000);
    }),
  ]);
});

test("gateway blocks model metadata writes while a replacement is pending", async () => {
  let modelWrites = 0;
  const router = {
    activeTurnRunId: () => undefined,
    hasActiveTurn: () => false,
    close: async () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => ({
      sessionKey: input.sessionKey,
      replacedTurnId: input.expectedTurnId,
      removedEntryCount: 2,
      transactionId: "44444444-4444-4444-8444-444444444444",
    }),
    finalizeLastTurnReplacement: async (input) => input,
    sessionModelSet: async (input) => {
      modelWrites += 1;
      return {
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        saved: input.selection,
        effective: { provider: "openai", model: "gpt-test", source: "session" },
      };
    },
    sessionModelClear: async () => { modelWrites += 1; },
  });

  const replacement = await gateway.replaceLastTurn({
    sessionKey: "web:s_model_lock",
    projectKey: "/tmp/project",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-replacement",
  });
  const isBusy = (error: unknown) => (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "SESSION_BUSY"
  );
  await assert.rejects(
    gateway.sessionModelSet({
      sessionKey: "web:s_model_lock",
      projectKey: "/tmp/project",
      selection: { mode: "model", provider: "openai", model: "gpt-test" },
    }),
    isBusy,
  );
  await assert.rejects(
    gateway.sessionModelClear({ sessionKey: "web:s_model_lock", projectKey: "/tmp/project" }),
    isBusy,
  );
  assert.equal(modelWrites, 0);

  await gateway.finalizeLastTurnReplacement({
    sessionKey: "web:s_model_lock",
    projectKey: "/tmp/project",
    transactionId: replacement.transactionId,
    action: "rollback",
  });
});

test("gateway cannot start replacement while a model metadata write holds the transcript lock", async () => {
  let releaseModelWrite!: () => void;
  let markModelWriteStarted!: () => void;
  const modelWriteStarted = new Promise<void>((resolve) => { markModelWriteStarted = resolve; });
  const modelWriteRelease = new Promise<void>((resolve) => { releaseModelWrite = resolve; });
  let replacements = 0;
  const router = {
    activeTurnRunId: () => undefined,
    hasActiveTurn: () => false,
    close: async () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => {
      replacements += 1;
      return {
        sessionKey: input.sessionKey,
        replacedTurnId: input.expectedTurnId,
        removedEntryCount: 2,
        transactionId: "55555555-5555-4555-8555-555555555555",
      };
    },
    finalizeLastTurnReplacement: async (input) => input,
    sessionModelSet: async (input) => {
      markModelWriteStarted();
      await modelWriteRelease;
      return {
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        saved: input.selection,
        effective: { provider: "openai", model: "gpt-test", source: "session" },
      };
    },
  });

  const modelWrite = gateway.sessionModelSet({
    sessionKey: "web:s_model_first",
    projectKey: "/tmp/project",
    selection: { mode: "model", provider: "openai", model: "gpt-test" },
  });
  await modelWriteStarted;
  await assert.rejects(
    gateway.replaceLastTurn({
      sessionKey: "web:s_model_first",
      projectKey: "/tmp/project",
      expectedTurnId: "turn-old",
      replacementTurnId: "turn-replacement",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "replace_turn_pending"
    ),
  );
  assert.equal(replacements, 0);
  releaseModelWrite();
  await modelWrite;
});

test("replaceLastWebSessionTurn removes only the latest turn and leaves workspace files untouched", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-turn-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-turn-home-"));
  try {
    const sessionKey = "web:s_replace_tail";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "first request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [{
      role: "user",
      content: [{ type: "text", text: "mistyped request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-2", {
      role: "assistant",
      content: [{ type: "text", text: "obsolete answer" }],
    });

    const workspaceFile = join(projectRoot, "already-changed.txt");
    await writeFile(workspaceFile, "keep current workspace state", "utf8");
    const result = await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-2",
        replacementTurnId: "turn-3",
      },
      { projectRoot, pilotHome },
    );

    const transcript = await readTranscript(storage.transcriptPath);
    assert.equal(result.replacedTurnId, "turn-2");
    assert.equal(result.removedEntryCount, 2);
    assert.deepEqual(new Set(transcript.entries.map((entry) => entry.turnId)), new Set(["turn-1"]));
    if (process.platform !== "win32") {
      assert.equal((await stat(storage.transcriptPath)).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(workspaceFile, "utf8"), "keep current workspace state");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("replaceLastWebSessionTurn preserves session metadata written after the edited turn", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-metadata-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-metadata-home-"));
  try {
    const sessionKey = "web:s_replace_metadata";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordSessionMetadata(sessionKey, "early-title", {
      aiTitle: "Obsolete generated title from before input",
      updatedAt: "2026-08-25T09:59:00.000Z",
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "mistyped request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "obsolete answer" }],
    });
    await storage.transcript.recordSessionMetadata(sessionKey, "model-selection", {
      title: "Keep this title",
      aiTitle: "Obsolete generated title",
      firstPrompt: "mistyped request",
      lastPrompt: "mistyped request",
      modelSelection: { mode: "model", provider: "openai", model: "gpt-test" },
      updatedAt: "2026-08-25T10:00:00.000Z",
    });

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome, now: () => new Date("2026-08-25T11:00:00.000Z") },
    );

    const transcript = await readTranscript(storage.transcriptPath);
    const metadataEntry = transcript.entries.filter((entry) => entry.type === "session_metadata").at(-1);
    assert.ok(metadataEntry && metadataEntry.type === "session_metadata");
    assert.equal(metadataEntry.metadata.title, "Keep this title");
    assert.equal(metadataEntry.metadata.aiTitle, undefined);
    assert.deepEqual(metadataEntry.metadata.modelSelection, {
      mode: "model",
      provider: "openai",
      model: "gpt-test",
    });
    assert.equal(metadataEntry.metadata.firstPrompt, undefined);
    assert.equal(metadataEntry.metadata.lastPrompt, undefined);
    assert.equal(metadataEntry.metadata.isSnapshot, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("failed replacement submission can restore the original transcript exactly", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-rollback-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-rollback-home-"));
  try {
    const sessionKey = "web:s_replace_rollback";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "original request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
    });
    const original = await readFile(storage.transcriptPath, "utf8");

    const replacement = await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome },
    );
    await finalizeLastWebSessionTurnReplacement(
      {
        sessionKey,
        projectKey: projectRoot,
        transactionId: replacement.transactionId,
        action: "rollback",
      },
      { projectRoot, pilotHome },
    );

    assert.equal(await readFile(storage.transcriptPath, "utf8"), original);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("startup recovery restores a prepared replacement that was never accepted", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-recovery-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-recovery-home-"));
  try {
    const sessionKey = "web:s_replace_recovery";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "original request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
    });
    const original = await readFile(storage.transcriptPath, "utf8");

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome },
    );

    const recovery = recoverPendingLastTurnReplacements(pilotHome);
    assert.equal(recovery.rolledBack, 1);
    assert.equal(recovery.committed, 0);
    assert.deepEqual(recovery.failures, []);
    assert.equal(await readFile(storage.transcriptPath, "utf8"), original);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("startup recovery recognizes a durable legacy replacement without its journal", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-commit-recovery-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-commit-recovery-home-"));
  try {
    const sessionKey = "web:s_replace_commit_recovery";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "original request" }],
    }]);

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome },
    );
    const prepared = await readTranscript(storage.transcriptPath);
    const latest = prepared.entries.at(-1);
    storage.transcript.restoreState(
      prepared.entries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0),
      latest?.entryId ?? null,
    );
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [{
      role: "user",
      content: [{ type: "text", text: "corrected request" }],
    }]);
    const legacyJournal = (await readdir(storage.chatDir))
      .find((name) => name.endsWith(".replace.json"));
    assert.ok(legacyJournal);
    await rm(join(storage.chatDir, legacyJournal));

    const recovery = recoverPendingLastTurnReplacements(pilotHome);
    assert.equal(recovery.committed, 1);
    assert.equal(recovery.rolledBack, 0);
    assert.deepEqual(recovery.failures, []);
    const recovered = await readTranscript(storage.transcriptPath);
    assert.equal(
      recovered.entries.some((entry) => entry.type === "accepted_input" && entry.turnId === "turn-2"),
      true,
    );
    assert.equal(
      recovered.entries.some((entry) => entry.type === "accepted_input" && entry.turnId === "turn-1"),
      false,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("startup recovery decides from the newest replacement transaction only", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-newest-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-newest-home-"));
  try {
    const sessionKey = "web:s_replace_newest";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "first request" }],
    }]);

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      {
        projectRoot,
        pilotHome,
        now: () => new Date("2026-08-25T10:00:00.000Z"),
      },
    );
    let prepared = await readTranscript(storage.transcriptPath);
    storage.transcript.restoreState(
      prepared.entries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0),
      prepared.entries.at(-1)?.entryId ?? null,
    );
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [{
      role: "user",
      content: [{ type: "text", text: "committed corrected request" }],
    }]);
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-3", [{
      role: "user",
      content: [{ type: "text", text: "newest original request" }],
    }]);

    // Leave transaction 1's artifacts behind as if commit cleanup failed,
    // then prepare a second edit that has not yet been accepted.
    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-3",
        replacementTurnId: "turn-4",
      },
      {
        projectRoot,
        pilotHome,
        now: () => new Date("2026-08-25T10:01:00.000Z"),
      },
    );

    const recovery = recoverPendingLastTurnReplacements(pilotHome);
    assert.equal(recovery.rolledBack, 1);
    assert.equal(recovery.committed, 0);
    assert.deepEqual(recovery.failures, []);
    prepared = await readTranscript(storage.transcriptPath);
    const accepted = prepared.entries
      .filter((entry) => entry.type === "accepted_input")
      .map((entry) => entry.turnId);
    assert.deepEqual(accepted, ["turn-2", "turn-3"]);
    assert.equal(accepted.includes("turn-4"), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("startup recovery skips a replacement owned by a live Gateway process", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-owner-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-owner-home-"));
  try {
    const sessionKey = "web:s_replace_owner";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "original request" }],
    }]);

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      {
        projectRoot,
        pilotHome,
        transactionOwner: { instanceId: "gateway-owner", pid: process.pid },
      },
    );

    const whileOwned = recoverPendingLastTurnReplacements(pilotHome);
    assert.equal(whileOwned.skipped, 1);
    assert.equal(whileOwned.rolledBack, 0);
    let transcript = await readTranscript(storage.transcriptPath);
    assert.equal(transcript.entries.some((entry) => entry.turnId === "turn-1"), false);

    const afterOwnerExit = recoverPendingLastTurnReplacements(pilotHome, {
      isProcessAlive: () => false,
    });
    assert.equal(afterOwnerExit.skipped, 0);
    assert.equal(afterOwnerExit.rolledBack, 1);
    assert.deepEqual(afterOwnerExit.failures, []);
    transcript = await readTranscript(storage.transcriptPath);
    assert.equal(transcript.entries.some((entry) => entry.turnId === "turn-1"), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("replaceLastWebSessionTurn rejects a stale target without changing the transcript", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-conflict-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-conflict-home-"));
  try {
    const sessionKey = "web:s_replace_conflict";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "current-turn", [{
      role: "user",
      content: [{ type: "text", text: "current request" }],
    }]);
    const before = await readFile(storage.transcriptPath, "utf8");

    await assert.rejects(
      replaceLastWebSessionTurn(
        {
          sessionKey,
          projectKey: projectRoot,
          expectedTurnId: "stale-turn",
          replacementTurnId: "replacement-turn",
        },
        { projectRoot, pilotHome },
      ),
      (error: unknown) => (
        error instanceof ReplaceLastTurnError && error.code === "replace_turn_conflict"
      ),
    );
    assert.equal(await readFile(storage.transcriptPath, "utf8"), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
