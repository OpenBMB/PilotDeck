import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSessionWithStorageAsync } from "../../src/agent/session/createAgentSession.js";
import { createAgentLoopSidecarRuntimeFactory } from "../../src/agent/modules/transport/agentLoopSidecarClient.js";
import { SessionAgentLoopOperationLedger } from "../../src/agent/modules/transport/sessionOperationLedger.js";
import { resumeAgentSession } from "../../src/session/resume/resumeAgentSession.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";

test("async agent construction waits for storage and projection rollback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-construction-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "construction-failure",
  });

  await assert.rejects(
    createAgentSessionWithStorageAsync({
      ...baseOptions(root, "construction-failure"),
      storage,
      __agentLoopFactory: () => { throw new Error("loop construction failed"); },
    }),
    /loop construction failed/,
  );

  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
  assert.throws(() => storage.projections.snapshot(), /projection driver is disposed/);
});

test("resume restore failure disposes unpublished storage exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-resume-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "restore-failure",
  });
  const originalDispose = storage.dispose;
  let disposeCalls = 0;
  storage.restore = async () => { throw new Error("restore failed"); };
  storage.dispose = () => {
    disposeCalls += 1;
    return originalDispose();
  };

  await assert.rejects(
    resumeAgentSession({
      ...baseOptions(root, "restore-failure"),
      projectStorage: { projectRoot: root, pilotHome: root },
      __storageFactory: () => storage,
    }),
    /restore failed/,
  );

  assert.equal(disposeCalls, 1);
  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
});

test("resume extension preserves elicitation ownership for handle disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-resume-elicitation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let disposeCalls = 0;
  const elicitation = {
    async askUser() {
      return { type: "cancelled" as const };
    },
    async dispose() {
      disposeCalls += 1;
    },
  };

  const resumed = await resumeAgentSession({
    ...baseOptions(root, "resume-elicitation-owner"),
    projectStorage: { projectRoot: root, pilotHome: root },
    extendDependencies: () => ({ elicitation, ownedElicitation: true }),
  });

  assert.equal(disposeCalls, 0);
  await resumed.handle.dispose("test_resume_elicitation_dispose");
  assert.equal(disposeCalls, 1);
  await resumed.handle.dispose("duplicate_dispose");
  assert.equal(disposeCalls, 1);
});

test("resume restores a settled sidecar operation without re-executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-sidecar-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "resume-sidecar-session";
  const turnId = "resume-sidecar-turn";
  const identity = {
    sessionId,
    turnId,
    runId: "resume-sidecar-run",
    operationId: "resume-sidecar-operation",
    requestId: "resume-sidecar-request-before-restart",
    binding: {
      moduleInstanceId: "sidecar-before-restart",
      connectionGeneration: "connection-before-restart",
    },
  };
  const initialStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const initialLedger = new SessionAgentLoopOperationLedger({
    sessionId,
    transcript: initialStorage.transcript,
  });
  await initialLedger.start(identity);
  await initialLedger.accept({ ...identity, streamId: "stream-before-restart" });
  await initialLedger.terminal({
    ...identity,
    streamId: "stream-before-restart",
    lastAppliedSequence: 1,
    outcome: "completed",
    result: successfulResult(sessionId, turnId),
    messages: [{ role: "assistant", content: [{ type: "text", text: "settled before restart" }] }],
  });
  await initialStorage.dispose();

  let executeCalls = 0;
  const resumed = await resumeAgentSession({
    ...baseOptions(root, sessionId),
    projectStorage: { projectRoot: root, pilotHome: root },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => recoveryHandshakeConnection(() => { executeCalls += 1; }),
    }),
  });
  const events = [];
  for await (const event of resumed.session.submit({ type: "text", text: "recover operation" }, {
    turnId,
    execution: { runId: identity.runId, operationId: identity.operationId },
  })) events.push(event);

  assert.equal(executeCalls, 0);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
  await resumed.handle.dispose("test_resume_sidecar_dispose");

  const verificationStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const restored = await verificationStorage.restore();
  assert.equal(restored.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_")).length, 3);
  await verificationStorage.dispose();
});

test("resume reconciles a result_unknown sidecar operation without re-executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-sidecar-unknown-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "resume-sidecar-unknown-session";
  const turnId = "resume-sidecar-unknown-turn";
  const identity = {
    sessionId,
    turnId,
    runId: "resume-sidecar-unknown-run",
    operationId: "resume-sidecar-unknown-operation",
    requestId: "resume-sidecar-unknown-request-before-restart",
    binding: {
      moduleInstanceId: "sidecar-before-restart",
      connectionGeneration: "connection-before-restart",
    },
  };
  const initialStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const initialLedger = new SessionAgentLoopOperationLedger({
    sessionId,
    transcript: initialStorage.transcript,
  });
  await initialLedger.start(identity);
  await initialLedger.accept({ ...identity, streamId: "stream-before-restart" });
  await initialLedger.resultUnknown({
    ...identity,
    streamId: "stream-before-restart",
    lastAppliedSequence: 1,
    code: "TRANSPORT_INTERRUPTED",
  });
  await initialStorage.dispose();

  let executeCalls = 0;
  let reconciliations = 0;
  const resumed = await resumeAgentSession({
    ...baseOptions(root, sessionId),
    projectStorage: { projectRoot: root, pilotHome: root },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => recoveryHandshakeConnection(() => { executeCalls += 1; }),
      reconcileResultUnknown: async (unknown) => {
        reconciliations += 1;
        assert.equal(unknown.requestId, identity.requestId);
        assert.equal(unknown.streamId, "stream-before-restart");
        return {
          outcome: "completed",
          result: successfulResult(sessionId, turnId),
          messages: [{ role: "assistant", content: [{ type: "text", text: "settled after reconciliation" }] }],
        };
      },
    }),
  });
  const events = [];
  for await (const event of resumed.session.submit({ type: "text", text: "recover unknown operation" }, {
    turnId,
    execution: { runId: identity.runId, operationId: identity.operationId },
  })) events.push(event);

  assert.equal(executeCalls, 0);
  assert.equal(reconciliations, 1);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "success");
  await resumed.handle.dispose("test_resume_unknown_sidecar_dispose");

  const verificationStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const restored = await verificationStorage.restore();
  const operationEntries = restored.entries.filter((entry) => entry.type.startsWith("agent_loop_operation_"));
  assert.equal(operationEntries.length, 4);
  const finalOperationEntry = operationEntries.at(-1);
  assert.equal(finalOperationEntry?.type, "agent_loop_operation_terminal");
  if (finalOperationEntry?.type === "agent_loop_operation_terminal") {
    assert.equal(finalOperationEntry.outcome, "completed");
  }
  await verificationStorage.dispose();
});

test("resume fails closed for an unresolved sidecar operation without re-executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-sidecar-unresolved-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "resume-sidecar-unresolved-session";
  const turnId = "resume-sidecar-unresolved-turn";
  const identity = {
    sessionId,
    turnId,
    runId: "resume-sidecar-unresolved-run",
    operationId: "resume-sidecar-unresolved-operation",
    requestId: "resume-sidecar-unresolved-request-before-restart",
    binding: {
      moduleInstanceId: "sidecar-before-restart",
      connectionGeneration: "connection-before-restart",
    },
  };
  const initialStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const initialLedger = new SessionAgentLoopOperationLedger({
    sessionId,
    transcript: initialStorage.transcript,
  });
  await initialLedger.start(identity);
  await initialLedger.accept({ ...identity, streamId: "stream-before-restart" });
  await initialLedger.resultUnknown({
    ...identity,
    streamId: "stream-before-restart",
    lastAppliedSequence: 1,
    code: "TRANSPORT_INTERRUPTED",
  });
  await initialStorage.dispose();

  let executeCalls = 0;
  const resumed = await resumeAgentSession({
    ...baseOptions(root, sessionId),
    projectStorage: { projectRoot: root, pilotHome: root },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => recoveryHandshakeConnection(() => { executeCalls += 1; }),
    }),
  });
  const events = [];
  for await (const event of resumed.session.submit({ type: "text", text: "recover unresolved operation" }, {
    turnId,
    execution: { runId: identity.runId, operationId: identity.operationId },
  })) events.push(event);

  assert.equal(executeCalls, 0);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "error");
  await resumed.handle.dispose("test_resume_unresolved_sidecar_dispose");
});

test("resume fails closed for an incomplete sidecar operation without re-executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-sidecar-incomplete-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "resume-sidecar-incomplete-session";
  const turnId = "resume-sidecar-incomplete-turn";
  const identity = {
    sessionId,
    turnId,
    runId: "resume-sidecar-incomplete-run",
    operationId: "resume-sidecar-incomplete-operation",
    requestId: "resume-sidecar-incomplete-request-before-restart",
    binding: {
      moduleInstanceId: "sidecar-before-restart",
      connectionGeneration: "connection-before-restart",
    },
  };
  const initialStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
  });
  const initialLedger = new SessionAgentLoopOperationLedger({
    sessionId,
    transcript: initialStorage.transcript,
  });
  await initialLedger.start(identity);
  await initialLedger.accept({ ...identity, streamId: "stream-before-restart" });
  await initialStorage.dispose();

  let executeCalls = 0;
  const resumed = await resumeAgentSession({
    ...baseOptions(root, sessionId),
    projectStorage: { projectRoot: root, pilotHome: root },
    agentLoopFactory: createAgentLoopSidecarRuntimeFactory({
      connect: () => recoveryHandshakeConnection(() => { executeCalls += 1; }),
    }),
  });
  const events = [];
  for await (const event of resumed.session.submit({ type: "text", text: "recover incomplete operation" }, {
    turnId,
    execution: { runId: identity.runId, operationId: identity.operationId },
  })) events.push(event);

  assert.equal(executeCalls, 0);
  const terminal = events.find((event) => event.type === "turn_completed") as { result?: { type?: string } } | undefined;
  assert.equal(terminal?.result?.type, "error");
  await resumed.handle.dispose("test_resume_incomplete_sidecar_dispose");
});

function baseOptions(root: string, sessionId: string) {
  return {
    sessionId,
    config: {
      provider: "test",
      model: "test",
      cwd: root,
      permissionMode: "default" as const,
      permissionContext: {
        mode: "default" as const,
        cwd: root,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
  };
}

function successfulResult(sessionId: string, turnId: string) {
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}

function recoveryHandshakeConnection(onExecute: () => void) {
  const responses: Array<Record<string, unknown>> = [];
  return {
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      if (request.method === "execute") {
        onExecute();
        return;
      }
      if (request.method !== "hello" && request.method !== "capabilities") return;
      responses.push({
        kind: "response",
        messageId: `response-${request.method}`,
        inReplyTo: request.messageId,
        ok: true,
        protocolVersion: "2.0",
        moduleId: "recovered-sidecar",
        moduleInstanceId: "sidecar-after-restart",
        connectionGeneration: "connection-after-restart",
        capabilitiesVersion: "1",
        payload: request.method === "capabilities"
          ? { capabilitiesVersion: "1", methods: [{ name: "execute", enabled: true, profiles: ["streaming"] }] }
          : {},
      });
    },
    async *receive() {
      while (responses.length > 0) yield responses.shift()!;
    },
  };
}
