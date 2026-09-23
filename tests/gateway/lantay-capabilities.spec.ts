import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentEvent, AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { UploadStore } from "../../src/gateway/dialog/UploadStore.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";
import type { GatewayCronController } from "../../src/gateway/protocol/types.js";
import type { AlwaysOnControlPort } from "../../src/always-on/protocol/AlwaysOnControlPort.js";
import type { RunRegistryPort } from "../../src/gateway/run/RunRegistry.js";
import { resolveProjectStorageId } from "../../src/pilot/paths.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { WorkspaceSnapshotInput, WorkspaceSnapshotRecorder } from "../../src/storage/workspaceSnapshot.js";
import type { PilotDeckToolResult } from "../../src/tool/protocol/result.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

function failedTool(index: number): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: `call-${index}`,
    toolName: "mcp__faxin__search",
    error: { code: "tool_execution_failed", message: "failed" },
    content: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

function completed(sessionId: string, turnId: string, aborted = false): AgentEvent {
  return {
    type: "turn_completed",
    sessionId,
    turnId,
    result: {
      type: aborted ? "aborted" : "success",
      sessionId,
      turnId,
      stopReason: aborted ? "aborted_streaming" : "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

async function drain(gateway: InProcessGateway, input: { sessionKey: string; runId: string; timeoutMs?: number }): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: input.sessionKey,
    channelKey: "web",
    projectKey: "/tmp/project",
    message: "run",
    runId: input.runId,
    timeoutMs: input.timeoutMs,
  })) events.push(event);
  return events;
}

test("FailureGuard persists and publishes the stop before abort while preserving turn_completed", async (t) => {
  const order: string[] = [];
  let aborted = false;
  const session = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "run";
      yield { type: "input_accepted", sessionId: "web:guard", turnId, messages: [] } as const;
      for (let index = 1; index <= 5 && !aborted; index += 1) {
        yield { type: "tool_result", sessionId: "web:guard", turnId, result: failedTool(index) } as const;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      yield completed("web:guard", turnId, aborted);
    },
    abort(reason?: string) {
      order.push(`abort:${reason}`);
      aborted = true;
    },
    async recordAgentStatusMessage(_turnId: string, status: { event: string }) {
      order.push(`persist:${status.event}`);
      return true;
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    resolveRunPolicy: () => ({
      failureGuard: {
        enabled: true,
        modelFailureLimit: 0,
        toolFailureLimits: { mcp__faxin__: 2 },
        toolLabels: { mcp__faxin__: "Faxin" },
      },
    }),
  });

  const events = await drain(gateway, { sessionKey: "web:guard", runId: "run-guard" });
  const stoppedIndex = events.findIndex((event) => event.type === "agent_status" && event.event === "run_policy_stopped");
  const lastToolIndex = events.map((event) => event.type).lastIndexOf("tool_call_finished");
  assert.ok(lastToolIndex >= 0 && lastToolIndex < stoppedIndex);
  assert.deepEqual(order, ["persist:run_policy_stopped", "abort:run_policy:tool_failure_limit_reached"]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.finishReason : undefined, "aborted_streaming");
});

test("FailureGuard counts an attributed Router retry and remains inert when disabled", async (t) => {
  let aborted = false;
  const session = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "run";
      yield { type: "input_accepted", sessionId: "web:retry", turnId, messages: [] } as const;
      for (let index = 0; index < 20 && !aborted; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      yield completed("web:retry", turnId, aborted);
    },
    abort() { aborted = true; },
    async recordAgentStatusMessage() { return true; },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  t.after(() => router.shutdown());
  let enabled = true;
  const gateway = new InProcessGateway(router, {
    resolveRunPolicy: () => ({
      failureGuard: { enabled, modelFailureLimit: 1, toolFailureLimits: {}, toolLabels: {} },
    }),
  });

  const first: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:retry",
    channelKey: "web",
    message: "run",
    runId: "retry-enabled",
  })) {
    first.push(event);
    if (event.type === "input_accepted") {
      gateway.broadcastRetryProgress({
        sessionId: "web:retry",
        turnId: "retry-enabled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        reason: "network_error",
        provider: "openai",
        model: "model",
      });
    }
  }
  assert.equal(aborted, true);
  assert.ok(first.some((event) => event.type === "agent_status" && event.event === "run_policy_stopped"));

  enabled = false;
  aborted = false;
  const second = await drain(gateway, { sessionKey: "web:retry", runId: "retry-disabled" });
  assert.equal(aborted, false);
  assert.equal(second.some((event) => event.type === "agent_status" && event.event === "run_policy_stopped"), false);
});

test("pre_user snapshot blocks generator progress and successful turns do not write post_agent", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-pre-snapshot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const order: string[] = [];
  const recorder: WorkspaceSnapshotRecorder = {
    capturePreUser: async () => {
      order.push("pre");
      return { snapshotId: "pre", phase: "pre_user", state: "committed" };
    },
    capturePostAgent: async () => {
      order.push("post");
      return { snapshotId: "post", phase: "post_agent", state: "committed" };
    },
  };
  const session = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "run";
      yield { type: "input_accepted", sessionId: "web:snapshot", turnId, messages: [] } as const;
      order.push("continued");
      yield completed("web:snapshot", turnId);
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, { snapshotRecorder: recorder, workspaceId: "workspace" });

  await drain(gateway, { sessionKey: "web:snapshot", runId: "run-success" });
  assert.deepEqual(order, ["pre", "continued"]);
});

test("failed, aborted, and non-quiescent timed-out turns write classified post_agent snapshots", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-post-snapshot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const postInputs: WorkspaceSnapshotInput[] = [];
  const recorder: WorkspaceSnapshotRecorder = {
    capturePreUser: async () => ({ snapshotId: "pre", phase: "pre_user", state: "committed" }),
    capturePostAgent: async (input) => {
      postInputs.push(input);
      return { snapshotId: "post", phase: "post_agent", state: input.workspaceStable === false ? "failed" : "committed" };
    },
  };
  const failedSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "failed";
      yield { type: "input_accepted", sessionId: "web:failed", turnId, messages: [] } as const;
      yield {
        type: "turn_failed",
        sessionId: "web:failed",
        turnId,
        error: { code: "agent_model_error", message: "provider failed" },
      } as const;
    },
    abort() {},
    async recordAgentStatusMessage() { return true; },
  } as unknown as AgentSession;
  const timeoutSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "timeout";
      yield { type: "input_accepted", sessionId: "web:timeout", turnId, messages: [] } as const;
      await new Promise<void>(() => {});
    },
    abort() {},
    async recordAgentStatusMessage() { return true; },
  } as unknown as AgentSession;
  const abortedSession = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "aborted";
      yield { type: "input_accepted", sessionId: "web:aborted", turnId, messages: [] } as const;
      yield { type: "session_aborted", sessionId: "web:aborted", reason: "user stopped" } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: (context) => context.sessionKey === "web:failed"
      ? failedSession
      : context.sessionKey === "web:aborted"
        ? abortedSession
        : timeoutSession,
  });
  const gateway = new InProcessGateway(router, {
    snapshotRecorder: recorder,
    workspaceId: "workspace",
    abortTurnTimeoutMs: 5,
  });

  await drain(gateway, { sessionKey: "web:failed", runId: "run-failed" });
  await drain(gateway, { sessionKey: "web:aborted", runId: "run-aborted" });
  await drain(gateway, { sessionKey: "web:timeout", runId: "run-timeout", timeoutMs: 5 });
  assert.equal(postInputs[0]?.failureKind, "agent_error");
  assert.match(postInputs[0]?.failureReason ?? "", /agent_model_error/);
  assert.equal(postInputs[1]?.failureKind, "interrupted");
  assert.equal(postInputs[1]?.failureReason, "user stopped");
  assert.equal(postInputs[2]?.failureKind, "timeout");
  assert.equal(postInputs[2]?.workspaceStable, false);
  assert.match(postInputs[2]?.failureReason ?? "", /workspace_not_quiescent/);
});

test("Gateway validates caller run ids and records trusted context as turn-scoped Gateway metadata", async (t) => {
  const submitted: Array<{ input: AgentInput; options: AgentSubmitOptions }> = [];
  const session = {
    async *submit(input: AgentInput, options: AgentSubmitOptions = {}) {
      submitted.push({ input, options });
      const turnId = options.turnId ?? "run";
      yield { type: "input_accepted", sessionId: "web:trusted", turnId, messages: [] } as const;
      yield completed("web:trusted", turnId);
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    trustedContextAuthorizer: {
      authorize: async ({ context }) => ({ principal: "host-app", source: context.source }),
    },
  });

  const events: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:trusted",
    channelKey: "web",
    message: "run",
    runId: "caller-run-42",
    trustedContext: [{
      text: "Release policy",
      source: "release-service",
      purpose: "application_context",
      scope: "turn",
    }],
  })) events.push(event);
  assert.equal(events.at(-1)?.type, "turn_completed");
  const trusted = submitted[0]?.options.syntheticMessages?.find((message) => message.metadata?.purpose === "trusted_context");
  assert.deepEqual(trusted?.metadata?.trustedContext, {
    source: "release-service",
    purpose: "application_context",
    scope: "turn",
    authorizedPrincipal: "host-app",
  });

  const attachmentEvents: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:trusted",
    channelKey: "web",
    message: "inspect",
    runId: "attachment-run",
    attachments: [{ type: "text", content: "attached material" }],
  })) attachmentEvents.push(event);
  assert.equal(attachmentEvents.at(-1)?.type, "turn_completed");
  const attachmentInput = submitted[1]?.input;
  assert.equal(attachmentInput?.type, "blocks");
  assert.equal(attachmentInput?.type === "blocks"
    ? attachmentInput.content.some((block) => block.type === "text" && block.text === "attached material")
    : false, true);

  const invalid: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:invalid",
    channelKey: "web",
    message: "run",
    runId: "bad run id",
  })) invalid.push(event);
  assert.equal(invalid[0]?.type, "error");
  assert.equal(invalid[0]?.type === "error" ? invalid[0].code : undefined, "INVALID_RUN_ID");
  assert.equal(submitted.length, 2);

  const unavailable = new InProcessGateway(router);
  const denied: GatewayEvent[] = [];
  for await (const event of unavailable.submitTurn({
    sessionKey: "web:unavailable",
    channelKey: "web",
    message: "run",
    trustedContext: [{ text: "claimed", source: "caller", purpose: "application_context", scope: "turn" }],
  })) denied.push(event);
  assert.equal(denied[0]?.type, "error");
  assert.equal(denied[0]?.type === "error" ? denied[0].code : undefined, "CAPABILITY_UNAVAILABLE");
});

test("a failed pre_user snapshot aborts before the generator advances", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-pre-failed-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let advanced = false;
  let abortReason: string | undefined;
  const session = {
    snapshotForRuntimeReload: () => ({ cwd: workspace, transcriptPath: "" }),
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "run";
      yield { type: "input_accepted", sessionId: "web:pre-failed", turnId, messages: [] } as const;
      advanced = true;
      yield completed("web:pre-failed", turnId);
    },
    abort(reason?: string) { abortReason = reason; },
    async recordAgentStatusMessage() { return true; },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router, {
    workspaceId: "workspace",
    snapshotRecorder: {
      capturePreUser: async () => ({ snapshotId: "pre", phase: "pre_user", state: "failed", error: "disk full" }),
      capturePostAgent: async () => ({ snapshotId: "post", phase: "post_agent", state: "committed" }),
    },
  });

  const events = await drain(gateway, { sessionKey: "web:pre-failed", runId: "run-pre-failed" });
  assert.equal(advanced, false);
  assert.equal(abortReason, "workspace_snapshot:pre_user_failed");
  assert.ok(events.some((event) => event.type === "error" && event.code === "gateway_submit_failed"));
});

test("Gateway permission resource lists and settles only the pending approval", async (t) => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  t.after(() => router.shutdown());
  const gateway = new InProcessGateway(router);
  let decision: string | undefined;
  gateway.getPermissionBus().register("web:permission", {
    requestId: "permission-1",
    toolCallId: "call-1",
    toolName: "write_file",
    resolve: (value) => { decision = value.decision; },
    reject: () => undefined,
  }, { payload: { path: "report.md" } });

  assert.deepEqual(await gateway.listPermissions({ sessionKey: "web:permission" }), {
    requests: [{ requestId: "permission-1", toolCallId: "call-1", toolName: "write_file", payload: { path: "report.md" } }],
  });
  assert.deepEqual(await gateway.permissionDecide({ sessionKey: "web:permission", requestId: "permission-1", decision: "allow" }), { delivered: true });
  assert.equal(decision, "allow");
  assert.deepEqual(await gateway.listPermissions({ sessionKey: "web:permission" }), { requests: [] });
  assert.deepEqual(await gateway.permissionDecide({ sessionKey: "web:permission", requestId: "permission-1", decision: "allow" }), { delivered: false });
});

test("Gateway management resources fail explicitly without host providers", async () => {
  const gateway = new InProcessGateway(new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) }));
  await assert.rejects(() => gateway.memoryList({ projectKey: "/tmp/project" }), { code: "CAPABILITY_UNAVAILABLE" });
  await assert.rejects(() => gateway.snapshotList({ projectKey: "/tmp/project" }), { code: "CAPABILITY_UNAVAILABLE" });
  await assert.rejects(() => gateway.managerSessions({ projectKey: "/tmp/project" }), { code: "CAPABILITY_UNAVAILABLE" });
  gateway.dispose();
});

test("Gateway management resources reject an empty project before calling providers", async () => {
  let calls = 0;
  const gateway = new InProcessGateway(new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) }), {
    memoryList: async () => { calls += 1; return { items: [] }; },
    memoryWipe: async () => { calls += 1; return { wiped: true, scope: "project" }; },
    snapshotList: async () => { calls += 1; return { items: [] }; },
    snapshotGet: async () => { calls += 1; return { snapshot: undefined }; },
    snapshotRestore: async () => { calls += 1; return { restored: true }; },
  });

  await assert.rejects(() => gateway.memoryList({ projectKey: "   " }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(() => gateway.memoryWipe({ projectKey: "", scope: "project" }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(() => gateway.memoryWipe({ projectKey: "/tmp/project", scope: "session" }), { code: "INVALID_MEMORY_SCOPE" });
  await assert.rejects(() => gateway.memoryList({ projectKey: "/tmp/project", sessionKey: "" }), { code: "INVALID_SESSION_KEY" });
  await assert.rejects(() => gateway.snapshotList({ projectKey: "" }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(() => gateway.snapshotList({ projectKey: "/tmp/project", sessionKey: "" }), { code: "INVALID_SESSION_KEY" });
  await assert.rejects(() => gateway.snapshotGet({ projectKey: "", snapshotId: "snapshot-1" }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(() => gateway.snapshotGet({ projectKey: "/tmp/project", snapshotId: "" }), { code: "INVALID_MANAGEMENT_IDENTIFIER" });
  await assert.rejects(() => gateway.snapshotRestore({ projectKey: "/tmp/project", snapshotId: "snapshot-1", targetProjectKey: "" }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(() => gateway.snapshotRestore({ projectKey: "/tmp/project", snapshotId: "" }), { code: "INVALID_MANAGEMENT_IDENTIFIER" });
  assert.equal(calls, 0);
  gateway.dispose();
});

test("Gateway memory resources delegate to the configured host provider", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const calls: string[] = [];
  const gateway = new InProcessGateway(router, {
    memoryList: async (input) => {
      calls.push(`list:${input.projectKey}`);
      return { items: [{ id: "memory-1" }] };
    },
    memoryWipe: async (input) => {
      calls.push(`wipe:${input.projectKey}:${input.scope}`);
      return { wiped: true, scope: input.scope };
    },
  });

  assert.deepEqual(await gateway.memoryList({ projectKey: "/tmp/project" }), { items: [{ id: "memory-1" }] });
  assert.deepEqual(await gateway.memoryWipe({ projectKey: "/tmp/project", scope: "project" }), { wiped: true, scope: "project" });
  assert.deepEqual(calls, ["list:/tmp/project", "wipe:/tmp/project:project"]);
  assert.ok((await gateway.describeServer()).capabilities?.includes("memory_list"));
  router.shutdown();
  gateway.dispose();
});

test("Gateway manager sessions delegate to the configured session provider", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const gateway = new InProcessGateway(router, {
    managerSessions: async (input) => ({
      items: [{ sessionId: input.sessionKey ?? "session-1", summary: "managed" }],
    }),
  });
  assert.deepEqual(await gateway.managerSessions({ projectKey: "/tmp/project", sessionKey: "session-1" }), {
    items: [{ sessionId: "session-1", summary: "managed" }],
  });
  assert.ok((await gateway.describeServer()).capabilities?.includes("manager_sessions"));
  router.shutdown();
  gateway.dispose();
});

test("Gateway manager browsers delegate to the configured host provider", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const gateway = new InProcessGateway(router, {
    managerBrowsers: async (input) => ({
      items: [{ browserId: "browser-1", projectKey: input.projectKey, sessionKey: input.sessionKey, state: "running" }],
    }),
  });
  assert.deepEqual(await gateway.managerBrowsers({ projectKey: "/tmp/project", sessionKey: "session-1" }), {
    items: [{ browserId: "browser-1", projectKey: "/tmp/project", sessionKey: "session-1", state: "running" }],
  });
  assert.ok((await gateway.describeServer()).capabilities?.includes("manager_browsers"));
  router.shutdown();
  gateway.dispose();
});

test("Gateway native archive artifact reads delegate to the configured archive provider", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const gateway = new InProcessGateway(router, {
    nativeArchiveArtifact: async (input) => ({
      artifactName: input.artifactName,
      content: "ZGF0YQ==",
      encoding: "base64",
      bytes: 4,
      truncated: false,
    }),
  });
  assert.deepEqual(await gateway.nativeArchiveArtifact({ sessionKey: "session-1", artifactName: "tool-1.txt" }), {
    artifactName: "tool-1.txt",
    content: "ZGF0YQ==",
    encoding: "base64",
    bytes: 4,
    truncated: false,
  });
  assert.ok((await gateway.describeServer()).capabilities?.includes("native_transcript_archive_artifact"));
  router.shutdown();
  gateway.dispose();
});

test("Gateway validates native archive cursors, limits, and artifact names before providers", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  let calls = 0;
  const gateway = new InProcessGateway(router, {
    nativeArchiveEntries: async () => {
      calls += 1;
      return { entries: [], complete: true };
    },
    nativeArchiveArtifact: async () => {
      calls += 1;
      return { artifactName: "safe.txt", content: "", encoding: "base64", bytes: 0, truncated: false };
    },
  });
  await assert.rejects(() => gateway.nativeArchiveEntries({ sessionKey: "session-1", afterSequence: -1 }), { code: "INVALID_ARCHIVE_CURSOR" });
  await assert.rejects(() => gateway.nativeArchiveEntries({ sessionKey: "session-1", limit: 501 }), { code: "INVALID_ARCHIVE_LIMIT" });
  await assert.rejects(() => gateway.nativeArchiveArtifact({ sessionKey: "session-1", artifactName: "../secret" }), { code: "INVALID_ARCHIVE_ARTIFACT" });
  await assert.rejects(() => gateway.nativeArchiveArtifact({ sessionKey: "session-1", artifactName: "safe.txt", maxBytes: 0 }), { code: "INVALID_ARCHIVE_ARTIFACT_LIMIT" });
  assert.equal(calls, 0);
  router.shutdown();
  gateway.dispose();
});

test("Gateway upload resource stores remote bytes and returns path-free upload references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-upload-"));
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const lifecycle = new UploadStore({
    resolveProject: async (projectKey) => projectKey === root ? root : Promise.reject(new Error("unknown project")),
    listProjects: async () => [root],
  });
  const gateway = new InProcessGateway(router, { uploadLifecycle: lifecycle });
  t.after(async () => {
    gateway.dispose();
    router.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const created = await gateway.uploadCreate({
    projectKey: root,
    files: [{ clientFileId: "material", name: "material.txt", relativePath: "material", size: 5, mimeType: "text/plain" }],
  });
  assert.equal(created.status, "created");
  const attachment = await gateway.uploadPart({ uploadId: created.uploadId, clientFileId: "material", contentBase64: "aGVsbG8=" });
  assert.equal(attachment.bytes, 5);
  const completed = await gateway.uploadComplete({ uploadId: created.uploadId });
  assert.equal(completed.status, "completed");
  assert.equal(completed.attachments?.[0]?.attachmentId, "material");
  assert.equal("path" in (completed.attachments?.[0] ?? {}), false);
  assert.ok((await gateway.describeServer()).capabilities?.includes("upload_create"));
  await assert.rejects(
    () => gateway.uploadPart({ uploadId: created.uploadId, clientFileId: "material", contentBase64: "not base64" }),
    { code: "UPLOAD_PART_INVALID" },
  );
});

test("Gateway native archive authorization runs before the archive provider", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => ({} as AgentSession) });
  const calls: string[] = [];
  let providerCalls = 0;
  const gateway = new InProcessGateway(router, {
    nativeArchiveAuthorizer: {
      authorize: async (input) => {
        calls.push(`${input.operation}:${input.sessionKey}:${input.artifactName ?? ""}`);
        if (input.operation === "artifact") throw new Error("archive policy denied");
      },
    },
    nativeArchiveManifest: async (input) => ({
      schemaVersion: 1,
      format: "native_transcript_entries",
      sessionKey: input.sessionKey,
      entryCount: 0,
      subagentCount: 0,
      toolResultReferenceCount: 0,
    }),
    nativeArchiveArtifact: async (input) => {
      providerCalls += 1;
      return { artifactName: input.artifactName, content: "", encoding: "base64", bytes: 0, truncated: false };
    },
  });
  try {
    await gateway.nativeArchiveManifest({ sessionKey: "session-1", projectKey: "/project" });
    await assert.rejects(
      () => gateway.nativeArchiveArtifact({ sessionKey: "session-1", projectKey: "/project", artifactName: "tool.txt" }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "ARCHIVE_UNAUTHORIZED",
    );
    assert.deepEqual(calls, ["manifest:session-1:", "artifact:session-1:tool.txt"]);
    assert.equal(providerCalls, 0);
  } finally {
    router.shutdown();
    gateway.dispose();
  }
});

test("local Gateway native archive preserves long-result references across rolling compaction and subagent entries", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-native-archive-e2e-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
router:
  enabled: false
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`, "utf8");
  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot });
  t.after(() => local.dispose());

  const sessionKey = "archive-e2e";
  const turnId = "turn-archive";
  const storage = local.registry.createPersistentSessionStorage(projectRoot, sessionKey, () => new Date("2026-09-23T00:00:00.000Z"));
  const toolCallId = "call-long-result";
  const artifactName = "result-long.txt";
  await mkdir(storage.toolResultsDir, { recursive: true });
  await writeFile(join(storage.toolResultsDir, artifactName), "full long result body with citation source", "utf8");

  await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
    { role: "user", content: [{ type: "text", text: "preserve archive evidence" }] },
  ]);
  await storage.transcript.recordEntry?.({
    type: "turn_started",
    sessionId: sessionKey,
    turnId,
    sequence: 2,
    createdAt: "2026-09-23T00:00:00.000Z",
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordDurableMessage(sessionKey, turnId, {
    role: "assistant",
    content: [{ type: "tool_call", id: toolCallId, name: "lookup", input: { query: "citation" } }],
  });
  await storage.transcript.recordEntry?.({
    type: "step_started",
    sessionId: sessionKey,
    turnId,
    sequence: 4,
    createdAt: "2026-09-23T00:00:00.000Z",
    step: 1,
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordEntry?.({
    type: "model_request",
    sessionId: sessionKey,
    turnId,
    sequence: 5,
    createdAt: "2026-09-23T00:00:00.000Z",
    step: 1,
    request: { provider: "test", model: "test", messages: [] },
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordEntry?.({
    type: "tool_call",
    sessionId: sessionKey,
    turnId,
    sequence: 6,
    createdAt: "2026-09-23T00:00:00.000Z",
    step: 1,
    call: { id: toolCallId, name: "lookup", input: { query: "citation" } },
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordEntry?.({
    type: "tool_result",
    sessionId: sessionKey,
    turnId,
    sequence: 7,
    createdAt: "2026-09-23T00:00:00.000Z",
    step: 1,
    result: {
      type: "success",
      toolCallId,
      toolName: "lookup",
      content: [{ type: "text", text: "reference persisted" }],
      startedAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.000Z",
    },
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordEntry?.({
    type: "step_completed",
    sessionId: sessionKey,
    turnId,
    sequence: 8,
    createdAt: "2026-09-23T00:00:01.000Z",
    step: 1,
    outcome: "completed",
  } satisfies AgentTranscriptEntry);
  await storage.transcript.recordDurableMessage(sessionKey, turnId, {
    role: "user",
    content: [{
      type: "tool_result_reference",
      toolCallId,
      path: join(storage.toolResultsDir, artifactName),
      readFilePath: `.pilotdeck/tool-results/${artifactName}`,
      originalBytes: 10_000,
      preview: "citation preview",
      hasMore: true,
      mimeType: "text/plain",
      reason: "large-result",
    }],
  });
  await storage.transcript.recordSubagentStarted(sessionKey, turnId, {
    subagentId: "subagent-archive",
    subagentType: "research",
    prompt: "find citation",
    transcriptRelativePath: "subagents/subagent-archive.jsonl",
    subagentSessionId: "archive-child",
  });
  await storage.transcript.recordSubagentCompleted(sessionKey, turnId, {
    subagentId: "subagent-archive",
    subagentType: "research",
    summary: "citation found",
    turns: 2,
    durationMs: 10,
  });
  for (const [index, compactionId] of ["compact-1", "compact-2"].entries()) {
    await storage.transcript.recordCompactionReplacement?.(sessionKey, `${turnId}-${index}`, {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        compactionId,
        trigger: "auto",
        preTokens: 2_000 + index * 100,
        postTokens: 900,
        messagesSummarized: 3,
        summaryGenerated: true,
      },
    }, [
      { role: "assistant", metadata: { compactReplacement: true, compactSnapshotId: compactionId }, content: [{ type: "text", text: `summary ${compactionId}` }] },
      { role: "user", metadata: { compactReplacement: true }, content: [{ type: "tool_result_reference", toolCallId, path: join(storage.toolResultsDir, artifactName), originalBytes: 10_000, preview: "citation preview", hasMore: true }] },
    ]);
  }
  await storage.transcript.recordTurnResult(sessionKey, turnId, {
    type: "success",
    sessionId: sessionKey,
    turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-23T00:00:00.000Z",
    completedAt: "2026-09-23T00:00:01.000Z",
  });

  assert.ok(local.gateway.nativeArchiveManifest);
  assert.ok(local.gateway.nativeArchiveEntries);
  assert.ok(local.gateway.nativeArchiveArtifact);
  const manifest = await local.gateway.nativeArchiveManifest({ sessionKey, projectKey: projectRoot });
  assert.equal(manifest.subagentCount, 1);
  assert.ok(manifest.toolResultReferenceCount >= 1);
  assert.ok(manifest.entryCount >= 8);

  const pages: unknown[] = [];
  let afterSequence: number | undefined;
  for (;;) {
    const page = await local.gateway.nativeArchiveEntries({ sessionKey, projectKey: projectRoot, afterSequence, limit: 3 });
    pages.push(...page.entries);
    if (page.complete) break;
    assert.notEqual(page.nextSequence, undefined);
    afterSequence = page.nextSequence;
  }
  assert.equal(pages.length, manifest.entryCount);
  const serialized = JSON.stringify(pages);
  assert.match(serialized, /tool_result_reference/);
  assert.match(serialized, /compact-1/);
  assert.match(serialized, /compact-2/);
  assert.match(serialized, /subagent-archive/);
  assert.match(serialized, /citation/);

  const artifact = await local.gateway.nativeArchiveArtifact({ sessionKey, projectKey: projectRoot, artifactName, maxBytes: 12 });
  assert.equal(Buffer.from(artifact.content, "base64").toString("utf8"), "full long re");
  assert.equal(artifact.truncated, true);
});

test("local Gateway scopes snapshot list, get, and restore to the owning project", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-gateway-"));
  const legalRoot = join(projectRoot, "legal");
  const snapshotRoot = join(legalRoot, "snapshots");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `schemaVersion: 1
agent:
  model: test/test
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test: {}
`, "utf8");
  const workspaceId = resolveProjectStorageId(projectRoot, projectRoot);
  const writeManifest = async (snapshotId: string, owner: string, createdAt: string) => {
    const path = join(snapshotRoot, "workspaces", owner, "sessions", "session-1", "snapshots", snapshotId, "manifest.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({
      snapshotId,
      workspaceId: owner,
      sessionId: "session-1",
      turnId: `${snapshotId}-turn`,
      runId: `${snapshotId}-run`,
      phase: "pre_user",
      entries: [],
      createdAt,
    }), "utf8");
  };
  await writeManifest("snapshot-old", workspaceId, "2026-09-22T00:00:00.000Z");
  await writeManifest("snapshot-new", workspaceId, "2026-09-23T00:00:00.000Z");
  await writeManifest("snapshot-other", "other-workspace", "2026-09-24T00:00:00.000Z");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    env: {
      PILOTDECK_LEGAL_STORAGE_ROOT: legalRoot,
      PILOTDECK_LEGAL_SNAPSHOT_ROOT: snapshotRoot,
    },
  });
  t.after(() => local.dispose());
  if (!local.gateway.snapshotList || !local.gateway.snapshotGet || !local.gateway.snapshotRestore) {
    throw new Error("snapshot management was not composed");
  }

  const first = await local.gateway.snapshotList({ projectKey: projectRoot, limit: 1 });
  assert.deepEqual(first.items.map((item) => (item as { snapshotId?: string }).snapshotId), ["snapshot-new"]);
  assert.equal(first.nextCursor, "snapshot-new");
  const second = await local.gateway.snapshotList({ projectKey: projectRoot, cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.items.map((item) => (item as { snapshotId?: string }).snapshotId), ["snapshot-old"]);
  assert.equal(second.nextCursor, undefined);
  const ownedSnapshot = await local.gateway.snapshotGet({ projectKey: projectRoot, snapshotId: "snapshot-old" });
  assert.equal((ownedSnapshot.snapshot as { snapshotId?: unknown }).snapshotId, "snapshot-old");
  await assert.rejects(
    () => local.gateway.snapshotGet!({ projectKey: projectRoot, snapshotId: "snapshot-other" }),
    { code: "SNAPSHOT_NOT_FOUND" },
  );
  await assert.rejects(
    () => local.gateway.snapshotRestore!({ projectKey: projectRoot, snapshotId: "snapshot-other" }),
    { code: "SNAPSHOT_NOT_FOUND" },
  );
});

test("Gateway admits only one active turn per resolved workspace", async (t) => {
  let firstStarted = false;
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstSession = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "first";
      firstStarted = true;
      yield { type: "input_accepted", sessionId: "session:first", turnId, messages: [] } as const;
      await firstReleased;
      yield completed("session:first", turnId);
    },
    abort() {},
  } as unknown as AgentSession;
  const secondSession = {
    async *submit() {
      throw new Error("workspace admission must stop before submit");
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: (context) => context.sessionKey === "session:first" ? firstSession : secondSession,
  });
  const gateway = new InProcessGateway(router, { workspaceId: "shared-workspace" });
  t.after(() => {
    releaseFirst();
    gateway.dispose();
    router.shutdown();
  });
  const firstEventsPromise = (async () => {
    const events: GatewayEvent[] = [];
    for await (const event of gateway.submitTurn({
      sessionKey: "session:first", channelKey: "test", projectKey: "/project", message: "first", runId: "run-first",
    })) events.push(event);
    return events;
  })();
  for (let attempt = 0; attempt < 100 && !firstStarted; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstStarted, true);
  const secondEvents: GatewayEvent[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session:second", channelKey: "test", projectKey: "/project", message: "second", runId: "run-second",
  })) secondEvents.push(event);
  const secondTerminal = secondEvents.at(-1);
  assert.equal(secondTerminal?.type, "error");
  if (secondTerminal?.type === "error") assert.equal(secondTerminal.code, "workspace_busy");
  releaseFirst();
  assert.equal((await firstEventsPromise).at(-1)?.type, "turn_completed");
});

test("Gateway advertises Cron and Always-On only when their host ports are configured", async (t) => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => {
    throw new Error("no session should be created");
  } });
  const gateway = new InProcessGateway(router);
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const unavailable = await gateway.describeServer();
  assert.equal(unavailable.capabilities?.includes("run_get"), false);
  assert.equal(unavailable.capabilities?.includes("cron_list"), false);
  assert.equal(unavailable.capabilities?.includes("always_on_apply"), false);
  assert.equal(unavailable.capabilities?.includes("permission_decide"), true);
  await assert.rejects(
    () => gateway.cronList({ projectKey: "/tmp/project" }),
    (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNAVAILABLE",
  );

  gateway.setCronController({} as GatewayCronController);
  gateway.setAlwaysOnControl({} as AlwaysOnControlPort);
  const configured = await gateway.describeServer();
  for (const capability of [
    "cron_create", "cron_list", "cron_update", "cron_delete", "cron_stop", "cron_run_now",
    "always_on_apply", "always_on_abort", "always_on_rerun_plan",
  ] as const) {
    assert.equal(configured.capabilities?.includes(capability), true, capability);
  }
});

test("Gateway advertises persistent run controls only with a RunRegistry", async (t) => {
  const registry = {
    async accept() { throw new Error("not used"); },
    async append() {},
    async get() { return undefined; },
    async events() { return []; },
    async markOrphansInterrupted() {},
  } as unknown as RunRegistryPort;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => {
    throw new Error("no session should be created");
  } });
  const gateway = new InProcessGateway(router, { runRegistry: registry });
  t.after(() => {
    gateway.dispose();
    router.shutdown();
  });

  const info = await gateway.describeServer();
  for (const capability of ["run_get", "run_events", "run_reattach"] as const) {
    assert.equal(info.capabilities?.includes(capability), true, capability);
  }
});

test("Gateway Cron RPCs delegate every operation to the configured host controller", async (t) => {
  const calls: string[] = [];
  const gateway = new InProcessGateway({} as SessionRouter, {
    cron: {
      async createTask(input) {
        calls.push(`create:${input.message}`);
        return { task: {} as never };
      },
      async listTasks(input) {
        calls.push(`list:${input?.projectKey ?? ""}`);
        return { tasks: [] };
      },
      async updateTask(input) {
        calls.push(`update:${input.taskId}`);
        return { updated: false, reason: "not_found" };
      },
      async deleteTask(input) {
        calls.push(`delete:${input.taskId}`);
        return { deleted: true };
      },
      async stopTask(input) {
        calls.push(`stop:${input.runId ?? input.taskId ?? ""}`);
        return { stopped: true };
      },
      async runTaskNow(input) {
        calls.push(`run:${input.taskId}`);
        return { started: true, taskId: input.taskId };
      },
    },
  });
  t.after(() => gateway.dispose());

  await gateway.cronCreate({
    message: "check",
    schedule: { type: "once", runAt: "2026-09-23T00:00:00.000Z" },
  });
  await gateway.cronList({ projectKey: "/project" });
  await gateway.cronUpdate({
    taskId: "task-1",
    projectKey: "/project",
    expectedRevision: 1,
    message: "updated",
    schedule: { type: "cron", expression: "0 * * * *" },
  });
  await gateway.cronDelete({ taskId: "task-1" });
  await gateway.cronStop({ runId: "run-1" });
  await gateway.cronRunNow({ taskId: "task-1" });

  assert.deepEqual(calls, [
    "create:check",
    "list:/project",
    "update:task-1",
    "delete:task-1",
    "stop:run-1",
    "run:task-1",
  ]);
});
