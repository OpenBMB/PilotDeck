import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FeishuSessionMapper } from "../../src/adapters/channel/feishu/FeishuSessionMapper.js";
import {
  applyGatewayEventToTuiState,
  type TuiEventReducerResult,
} from "../../src/adapters/channel/tui/app/types.js";
import { ALWAYS_ON_EXECUTION_DENY_RULES } from "../../src/always-on/runtime/DiscoveryFire.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../../src/always-on/storage/DiscoveryPlanStore.js";
import {
  createDefaultPermissionContext,
  matchPermissionRule,
  PermissionRuntime,
} from "../../src/permission/index.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import {
  findLastCompactBoundaryIndex,
  replayTranscriptEntries,
} from "../../src/session/transcript/TranscriptReplay.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

test("Always-On deny rules cover direct and chained git push and remote commands", () => {
  for (const pattern of ["git push*", "*git push*", "git remote*", "*git remote*"]) {
    const rule = ALWAYS_ON_EXECUTION_DENY_RULES.find(candidate => candidate.pattern === pattern);
    assert.ok(rule, pattern);
    assert.equal(rule.behavior, "deny");
    assert.equal(rule.toolName, "bash");
  }

  const directPush = ALWAYS_ON_EXECUTION_DENY_RULES.find(rule => rule.pattern === "git push*")!;
  const chainedRemote = ALWAYS_ON_EXECUTION_DENY_RULES.find(rule => rule.pattern === "*git remote*")!;
  assert.equal(matchPermissionRule(directPush, "bash", { command: "git push origin main" }), true);
  assert.equal(matchPermissionRule(chainedRemote, "bash", { command: "cd /tmp && git remote set-url origin x" }), true);
  assert.equal(matchPermissionRule(directPush, "bash", { command: "git status" }), false);
});

test("Always-On deny rules remain effective in bypass mode", async () => {
  const runtime = new PermissionRuntime();
  const context = bypassContext();

  for (const command of [
    "git push origin main",
    "cd /tmp && git push origin main",
    "git remote add origin https://example.test",
  ]) {
    assert.equal((await runtime.decide(bashTool(), { command }, context, command)).type, "deny");
  }
});

test("Always-On deny rules do not block safe local commands", async () => {
  const runtime = new PermissionRuntime();
  const context = bypassContext();

  for (const command of ["git status", "git diff --stat", "git commit -m test", "ls -la"]) {
    assert.equal((await runtime.decide(bashTool(), { command }, context, command)).type, "allow");
  }
});

test("DiscoveryPlanStore mirrors terminal status into existing executionStatus", async (t) => {
  for (const status of ["completed", "failed"] as const) {
    const { store, paths } = await planStore(t, status);
    await store.upsert(planRecord(`plan-${status}`));
    const raw = JSON.parse(await readFile(paths.planIndexFile, "utf8"));
    raw.plans[0].executionStatus = "queued";
    await writeFile(paths.planIndexFile, JSON.stringify(raw), "utf8");

    await store.updateStatus(`plan-${status}`, { status });
    const stored = (await store.readIndex()).plans[0] as Record<string, unknown>;
    assert.equal(stored.status, status);
    assert.equal(stored.executionStatus, status);
  }
});

test("DiscoveryPlanStore does not invent executionStatus or mutate it for non-terminal states", async (t) => {
  const { store, paths } = await planStore(t, "non-terminal");
  await store.upsert(planRecord("plan-1"));
  await store.updateStatus("plan-1", { status: "completed" });
  assert.equal("executionStatus" in ((await store.readIndex()).plans[0] as object), false);

  await store.upsert(planRecord("plan-2"));
  const raw = JSON.parse(await readFile(paths.planIndexFile, "utf8"));
  raw.plans.find((plan: { id: string }) => plan.id === "plan-2").executionStatus = "queued";
  await writeFile(paths.planIndexFile, JSON.stringify(raw), "utf8");
  await store.updateStatus("plan-2", { status: "executing" });
  const plan = (await store.readIndex()).plans.find(item => item.id === "plan-2") as Record<string, unknown>;
  assert.equal(plan.executionStatus, "queued");
});

test("JsonlTranscriptWriter persists compact boundaries with metadata", async (t) => {
  const directory = await tempDir(t, "pilotdeck-transcript-boundary-");
  const path = join(directory, "session.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  await writer.recordAcceptedInput("session-1", "turn-1", [userMessage("before")]);
  await writer.recordControlBoundary("session-1", "turn-1", {
    kind: "compact",
    subtype: "compact_boundary",
    compactMetadata: {
      trigger: "auto",
      preTokens: 12_345,
      messagesSummarized: 3,
      preCompactDiscoveredTools: ["read_file"],
    },
  });

  const transcript = await readTranscript(path);
  const index = findLastCompactBoundaryIndex(transcript.entries);
  assert.ok(index >= 0);
  const entry = transcript.entries[index];
  assert.equal(entry?.type, "control_boundary");
  if (entry?.type === "control_boundary" && entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary") {
    assert.equal(entry.boundary.compactMetadata.preTokens, 12_345);
    assert.deepEqual(entry.boundary.compactMetadata.preCompactDiscoveredTools, ["read_file"]);
  }
});

test("transcript replay discards messages before the latest compact boundary", async (t) => {
  const directory = await tempDir(t, "pilotdeck-transcript-replay-");
  const path = join(directory, "session.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  await writer.recordAcceptedInput("session-1", "turn-1", [userMessage("before")]);
  await writer.recordControlBoundary("session-1", "turn-1", {
    kind: "compact",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "manual", preTokens: 100 },
  });
  await writer.recordAcceptedInput("session-1", "turn-2", [userMessage("after")]);

  const replay = replayTranscriptEntries((await readTranscript(path)).entries);
  assert.deepEqual(replay.messages.map(message => message.content[0]), [{ type: "text", text: "after" }]);
  assert.equal(replay.lastCompactBoundary?.type, "control_boundary");
});

test("Feishu session mapping keeps chats isolated and /new rotates one chat", () => {
  let sequence = 0;
  const mapper = new FeishuSessionMapper(undefined, () => `uuid-${++sequence}`);

  assert.equal(mapper.resolve({ chatId: "chat-1", text: "hello" }).sessionKey, "feishu:chat=chat-1:general");
  assert.equal(mapper.resolve({ chatId: "chat-2", text: "hello" }).sessionKey, "feishu:chat=chat-2:general");
  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "/new next task" }), {
    sessionKey: "feishu:chat=chat-1:s_uuid-1",
    projectKey: undefined,
    command: "new",
    message: "next task",
  });
  assert.equal(mapper.resolve({ chatId: "chat-1", text: "continue" }).sessionKey, "feishu:chat=chat-1:s_uuid-1");
  assert.equal(mapper.resolve({ chatId: "chat-2", text: "continue" }).sessionKey, "feishu:chat=chat-2:general");
});

test("TUI reducer pairs tool start and finish without leaving stale activity", () => {
  const started = applyGatewayEventToTuiState(tuiState(), { type: "turn_started", runId: "run-1" });
  const assistant = applyGatewayEventToTuiState(started, { type: "assistant_text_delta", text: "hello" });
  const toolStarted = applyGatewayEventToTuiState(assistant, {
    type: "tool_call_started",
    toolCallId: "tool-1",
    name: "read_file",
  });
  const toolFinished = applyGatewayEventToTuiState(toolStarted, {
    type: "tool_call_finished",
    toolCallId: "tool-1",
    ok: true,
    resultPreview: "ok",
  });

  assert.deepEqual(toolFinished.activity, []);
  assert.equal(toolFinished.messages.at(-1)?.role, "tool");
  assert.equal(toolFinished.messages.at(-1)?.text, "ok");
});

test("TUI reducer queues concurrent permission requests in arrival order", () => {
  const first = applyGatewayEventToTuiState(tuiState(), {
    type: "permission_request",
    requestId: "request-1",
    toolName: "web_search",
    payload: { query: "one" },
  });
  const second = applyGatewayEventToTuiState(first, {
    type: "permission_request",
    requestId: "request-2",
    toolName: "web_fetch",
    payload: { url: "https://example.test" },
  });

  assert.deepEqual(second.pendingPermissions.map(item => item.requestId), ["request-1", "request-2"]);
  const completed = applyGatewayEventToTuiState(second, {
    type: "turn_completed",
    usage: {},
    finishReason: "completed",
  });
  assert.deepEqual(completed.pendingPermissions, []);
});

function bypassContext(): PilotDeckToolRuntimeContext {
  const cwd = "/tmp/project";
  return {
    sessionId: "always-on-session",
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
      rules: { deny: [...ALWAYS_ON_EXECUTION_DENY_RULES] },
    }),
  };
}

function bashTool(): PilotDeckToolDefinition {
  return {
    name: "bash",
    description: "test bash",
    kind: "shell",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], data: {} }),
  };
}

async function planStore(t: test.TestContext, suffix: string) {
  const pilotHome = await tempDir(t, `pilotdeck-plan-${suffix}-`);
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: "/tmp/project" });
  return { store: new DiscoveryPlanStore(paths), paths };
}

function planRecord(id: string) {
  return {
    id,
    title: "Test plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "executing" as const,
    summary: "",
    rationale: "",
    dedupeKey: id,
    sourceRunId: "run-1",
    planFilePath: `plans/${id}.md`,
  };
}

function userMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

function tuiState(): TuiEventReducerResult {
  return { messages: [], activity: [], mode: "default", isRunning: false, pendingPermissions: [] };
}

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
