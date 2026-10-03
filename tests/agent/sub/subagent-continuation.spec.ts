import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop, type AgentLoopRunResult } from "../../../src/agent/loop/AgentLoop.js";
import {
  SubAgentSession,
  subagentTurnId,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { SubagentContinuationError } from "../../../src/agent/sub/continuation.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";
import {
  ToolRegistry,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../../src/model/index.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { createStorageSubagentTranscriptHooks } from "../../../src/session/storage/subagentTranscriptHooks.js";
import { loadSubagentContinuation } from "../../../src/session/transcript/loadSubagentContinuation.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";

const ROUND_A_REPORT = [
  "Scope: round A",
  "Result: round A complete",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const ROUND_B_REPORT = [
  "Scope: round B",
  "Result: round B complete",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const SESSION_KEY = "cli:continuation-session";
const FOREIGN_SESSION_KEY = "cli:foreign-session";

type TempDirs = { projectRoot: string; pilotHome: string };

async function makeTempDirs(prefix: string): Promise<TempDirs> {
  const projectRoot = await mkdtemp(join(tmpdir(), `${prefix}-project-`));
  const pilotHome = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
  return { projectRoot, pilotHome };
}

async function cleanupDirs(dirs: TempDirs): Promise<void> {
  await rm(dirs.projectRoot, { recursive: true, force: true });
  await rm(dirs.pilotHome, { recursive: true, force: true });
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function parentConfig(
  dirs: TempDirs,
  overrides: Partial<AgentRuntimeConfig> = {},
): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: dirs.projectRoot,
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: dirs.projectRoot,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...overrides,
  };
}

function createProbeTool(calls: Array<Record<string, unknown>>): PilotDeckToolDefinition {
  return {
    name: "probe",
    description: "probe test tool",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => {
      calls.push(input as Record<string, unknown>);
      return { content: [{ type: "text", text: "probe-ok" }], data: {} };
    },
  };
}

type ScriptStep = (() => CanonicalModelEvent[]) | "BLOCK";

const BLOCK: "BLOCK" = "BLOCK";

function toolCallEvents(id: string, name: string, input: unknown): CanonicalModelEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_end", toolCall: { id, name, input } },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
}

function textEvents(text: string): CanonicalModelEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
}

function createScriptedRouter(
  script: ScriptStep[],
  captured: CanonicalModelRequest[],
): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* (_decision, request, context) {
      captured.push(request);
      const step = script.shift();
      if (!step) {
        throw new Error(
          `unexpected model request #${captured.length} (${request.messages.length} messages)`,
        );
      }
      if (step === BLOCK) {
        await new Promise<never>((_resolve, reject) => {
          const signal = context?.abortSignal;
          if (!signal) {
            reject(new Error("blocking script step requires an abort signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        });
        return;
      }
      yield* step();
    },
    stream: async function* () {
      throw new Error("scripted router does not support stream()");
    },
  } as AgentRouterRuntime;
}

function buildDependencies(
  router: AgentRouterRuntime,
  registry: ToolRegistry,
  hooks: AgentRuntimeDependencies["subagentTranscript"],
): AgentRuntimeDependencies {
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new ConcurrentToolScheduler(toolRuntime, registry);
  return {
    router,
    tools: { scheduler, registry },
    subagentTranscript: hooks,
  };
}

async function drainLoop(run: AsyncGenerator<unknown, AgentLoopRunResult, unknown>): Promise<AgentLoopRunResult> {
  let last: IteratorResult<unknown, AgentLoopRunResult>;
  do {
    last = await run.next();
  } while (!last.done);
  return last.value;
}

function isChildRequest(request: CanonicalModelRequest): boolean {
  return Boolean(request.systemPrompt?.includes("You are a subagent of PilotDeck"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function successTurnResult(sessionId: string, turnId: string, type: AgentTurnResult["type"] = "success"): AgentTurnResult {
  return {
    type,
    sessionId,
    turnId,
    stopReason: type === "success" ? "completed" : "aborted_streaming",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-13T00:00:00.000Z",
    completedAt: "2026-09-13T00:00:01.000Z",
  };
}

type SidechainFixture = {
  taskId: string;
  definitionId?: string;
  provider?: string;
  model?: string;
  parentSessionId?: string;
  withMetadata?: boolean;
  withTurnResult?: boolean;
  resultType?: AgentTurnResult["type"];
};

async function writeSidechain(
  storage: ReturnType<typeof createAgentProjectSessionStorage>,
  fixture: SidechainFixture,
): Promise<void> {
  const taskId = fixture.taskId;
  const subagentSessionId = `${storage.chatDir}::sub::${taskId}`;
  const turnId = subagentTurnId(taskId, 0);
  const { writer } = storage.transcript.forSubagent(taskId);
  await writer.recordAcceptedInput(subagentSessionId, turnId, [userMessage("ROUND ONE DIRECTIVE")]);
  await writer.recordDurableMessage(subagentSessionId, turnId, {
    role: "assistant",
    content: [{ type: "text", text: "round A interim answer" }],
  });
  if (fixture.withMetadata !== false) {
    await writer.recordSessionMetadata(subagentSessionId, turnId, {
      subagentTask: {
        formatVersion: 2,
        subagentId: taskId,
        definitionId: fixture.definitionId ?? "explore",
        provider: fixture.provider ?? "test",
        model: fixture.model ?? "test-model",
        parentSessionId: fixture.parentSessionId ?? SESSION_KEY,
        subagentSessionId,
      },
    });
  }
  if (fixture.withTurnResult !== false) {
    await writer.recordTurnResult(
      subagentSessionId,
      turnId,
      successTurnResult(subagentSessionId, turnId, fixture.resultType),
    );
  }
}

async function loadVia(storage: ReturnType<typeof createAgentProjectSessionStorage>, taskId: string) {
  return loadSubagentContinuation({
    transcriptPath: storage.subagentTranscriptPath(taskId),
    requestedDefinitionId: undefined,
    expectedParentSessionId: SESSION_KEY,
  });
}

test("subagent continuation restores prior child history after a parent session reload", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-e2e");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const hooks = createStorageSubagentTranscriptHooks(storage);
    const captured: CanonicalModelRequest[] = [];
    const probeCalls: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register(createAgentTool());
    registry.register(createProbeTool(probeCalls));

    const script: ScriptStep[] = [
      () => toolCallEvents("p1", "agent", { description: "round one", prompt: "ROUND ONE DIRECTIVE" }),
      () => toolCallEvents("c1", "probe", { question: "probe round one" }),
      () => textEvents(ROUND_A_REPORT),
      () => textEvents("parent done one"),
      // Placeholder; the real task_id is patched in below once round 1 ran.
      () => toolCallEvents("p2", "agent", {
        description: "round two",
        prompt: "ROUND TWO DIRECTIVE",
        task_id: "PENDING",
      }),
      () => textEvents(ROUND_B_REPORT),
      () => textEvents("parent done two"),
    ];
    // Steps are lazily evaluated by the router, so patching step 5 after
    // round 1 is sufficient.
    const router = createScriptedRouter(script, captured);

    const loop1 = new AgentLoop(
      parentConfig(dirs),
      buildDependencies(router, registry, hooks),
    );
    await drainLoop(loop1.run({
      sessionId: SESSION_KEY,
      turnId: "parent-turn-1",
      messages: [userMessage("parent kick-off")],
    }));

    const parentEntries = await readTranscript(storage.transcriptPath);
    const startedEntries = parentEntries.entries.filter(
      (entry) => entry.type === "subagent_started",
    );
    assert.equal(startedEntries.length, 1, "round 1 must record one subagent_started reference");
    const firstStarted = startedEntries[0]!;
    if (firstStarted.type !== "subagent_started") throw new Error("unreachable");
    const taskId = firstStarted.subagentId;

    // Reload via disk: fresh storage instance + hooks, fresh loop, and a
    // parent whose configured subagent model changed. Continuation must keep
    // the saved provider/model instead.
    const storage2 = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const hooks2 = createStorageSubagentTranscriptHooks(storage2);

    // The router consumes steps with shift(), so patch the next remaining step.
    script[0] = () => toolCallEvents("p2", "agent", {
      description: "round two",
      prompt: "ROUND TWO DIRECTIVE",
      task_id: taskId,
    });

    const loop2 = new AgentLoop(
      parentConfig(dirs, {
        subagentModel: { provider: "other", model: "other-model" },
      }),
      buildDependencies(router, registry, hooks2),
    );
    const run2 = await drainLoop(loop2.run({
      sessionId: SESSION_KEY,
      turnId: "parent-turn-2",
      messages: [userMessage("parent follow-up")],
    }));
    assert.equal(run2.result.type, "success");

    // The child ran exactly one probe call — in round 1 only.
    assert.deepEqual(probeCalls, [{ question: "probe round one" }]);

    const childRequests = captured.filter(isChildRequest);
    assert.equal(childRequests.length, 3, "child must request twice in round 1 and once in round 2");
    const followupRequest = childRequests[2]!;
    const messages = followupRequest.messages;

    // Previous user / assistant / tool history is visible to the follow-up…
    assert.equal(messages[0]?.role, "user");
    assert.equal(
      messages[0]?.content.some((block) => block.type === "text" && block.text === "ROUND ONE DIRECTIVE"),
      true,
    );
    const probeCallMessage = messages.find(
      (message) => message.role === "assistant"
        && message.content.some((block) => block.type === "tool_call" && block.id === "c1"),
    );
    assert.ok(probeCallMessage, "follow-up must see the prior assistant tool_call");
    const probeResultMessage = messages.find(
      (message) => message.role === "user"
        && message.content.some((block) => block.type === "tool_result" && block.toolCallId === "c1"),
    );
    assert.ok(probeResultMessage, "follow-up must see the prior tool result");
    assert.equal(
      messages.some((message) => message.role === "assistant"
        && message.content.some((block) => block.type === "text" && block.text === ROUND_A_REPORT)),
      true,
      "follow-up must see the prior final assistant report",
    );
    // …and only ONE new directive appended at the end.
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, "user");
    assert.equal(
      last.content.some((block) => block.type === "text" && block.text === "ROUND TWO DIRECTIVE"),
      true,
    );
    const directiveCount = messages.filter(
      (message) => message.role === "user"
        && message.content.some((block) => block.type === "text" && block.text === "ROUND TWO DIRECTIVE"),
    ).length;
    assert.equal(directiveCount, 1, "the new directive must be appended exactly once");

    // Saved provider/model wins over the parent's (changed) subagent model.
    assert.equal(followupRequest.provider, "test");
    assert.equal(followupRequest.model, "test-model");

    // Sidechain transcript: two rounds, each with its own turn_result, and
    // the follow-up accepted_input carries ONLY the new directive.
    const sidechain = await readTranscript(storage2.subagentTranscriptPath(taskId));
    const accepted = sidechain.entries.filter((entry) => entry.type === "accepted_input");
    assert.equal(accepted.length, 2);
    const secondAccepted = accepted[1]!;
    if (secondAccepted.type !== "accepted_input") throw new Error("unreachable");
    assert.equal(secondAccepted.messages.length, 1);
    assert.equal(
      secondAccepted.messages[0]?.content.some(
        (block) => block.type === "text" && block.text === "ROUND TWO DIRECTIVE",
      ),
      true,
    );
    const turnResults = sidechain.entries.filter((entry) => entry.type === "turn_result");
    assert.equal(turnResults.length, 2);
    assert.deepEqual(
      turnResults.map((entry) => entry.type === "turn_result" ? entry.result.type : ""),
      ["success", "success"],
    );
    // Unique turn ids for the follow-up rounds.
    assert.notEqual(accepted[0]!.turnId, accepted[1]!.turnId);

    // Round 2 reuses the same subagent identity in the parent transcript.
    const started2 = (await readTranscript(storage2.transcriptPath)).entries.filter(
      (entry) => entry.type === "subagent_started",
    );
    assert.equal(started2.length, 2);
    assert.ok(started2.every((entry) => entry.type === "subagent_started" && entry.subagentId === taskId));
  } finally {
    await cleanupDirs(dirs);
  }
});

test("continuation with an unknown or foreign task id fails clearly without provider calls", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-unknown");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const hooks = createStorageSubagentTranscriptHooks(storage);
    const captured: CanonicalModelRequest[] = [];
    const registry = new ToolRegistry();
    registry.register(createAgentTool());
    const router = createScriptedRouter([
      () => toolCallEvents("p1", "agent", {
        description: "bad continuation",
        prompt: "FOLLOWUP DIRECTIVE",
        task_id: "00000000-0000-4000-8000-00000000dead",
      }),
      () => textEvents("parent survived"),
    ], captured);
    const loop = new AgentLoop(parentConfig(dirs), buildDependencies(router, registry, hooks));
    const run = await drainLoop(loop.run({
      sessionId: SESSION_KEY,
      turnId: "parent-turn-1",
      messages: [userMessage("kick-off")],
    }));

    assert.equal(run.result.type, "success");
    // Only parent requests — the child never launched.
    assert.equal(captured.length, 2);
    assert.ok(captured.every((request) => !isChildRequest(request)));
    const errorText = JSON.stringify(run.messages);
    assert.match(errorText, /subagent_task_unknown/);
  } finally {
    await cleanupDirs(dirs);
  }
});

test("loader rejects unknown, foreign, legacy, incomplete, conflicting, model-missing, and failed sidechains", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-loader");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const foreignStorage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: FOREIGN_SESSION_KEY,
    });

    // Unknown: no sidechain file under the calling session.
    await assert.rejects(
      loadVia(storage, "00000000-0000-4000-8000-00000000unknown"),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_unknown",
    );

    // Foreign parent: the sidechain exists but belongs to another session.
    const foreignTaskId = "22000000-0000-4000-8000-00000000forei";
    await writeSidechain(foreignStorage, { taskId: foreignTaskId });
    await assert.rejects(
      loadVia(storage, foreignTaskId),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_unknown",
    );

    // Legacy: no turn_result / no continuation metadata.
    const legacyTaskId = "33000000-0000-4000-8000-00000000legacy";
    const { writer: legacyWriter } = storage.transcript.forSubagent(legacyTaskId);
    await legacyWriter.recordAcceptedInput("legacy-sub-session", subagentTurnId(legacyTaskId, 0), [
      userMessage("old directive"),
    ]);
    await legacyWriter.recordDurableMessage("legacy-sub-session", subagentTurnId(legacyTaskId, 0), {
      role: "assistant",
      content: [{ type: "text", text: "old report" }],
    });
    await assert.rejects(
      loadVia(storage, legacyTaskId),
      (error: unknown) =>
        error instanceof SubagentContinuationError
        && error.code === "subagent_task_history_unsupported",
    );

    // Incomplete: metadata present but the round never finished.
    const incompleteTaskId = "44000000-0000-4000-8000-00000000incom";
    await writeSidechain(storage, { taskId: incompleteTaskId, withTurnResult: false });
    await assert.rejects(
      loadVia(storage, incompleteTaskId),
      (error: unknown) =>
        error instanceof SubagentContinuationError
        && error.code === "subagent_task_history_unsupported",
    );

    // Conflicting type.
    const conflictTaskId = "55000000-0000-4000-8000-00000000conf";
    await writeSidechain(storage, { taskId: conflictTaskId, definitionId: "explore" });
    await assert.rejects(
      loadSubagentContinuation({
        transcriptPath: storage.subagentTranscriptPath(conflictTaskId),
        requestedDefinitionId: "plan",
        expectedParentSessionId: SESSION_KEY,
      }),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_type_conflict",
    );

    // Missing model metadata — reject instead of silently switching models.
    const noModelTaskId = "66000000-0000-4000-8000-00000000nomdl";
    await writeSidechain(storage, { taskId: noModelTaskId, model: "" });
    await assert.rejects(
      loadVia(storage, noModelTaskId),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_model_missing",
    );

    // Failed last round must not be resumed.
    const failedTaskId = "77000000-0000-4000-8000-00000000failed";
    await writeSidechain(storage, { taskId: failedTaskId, resultType: "aborted" });
    await assert.rejects(
      loadVia(storage, failedTaskId),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_round_failed",
    );
  } finally {
    await cleanupDirs(dirs);
  }
});

test("loader returns only post-boundary history for a compacted sidechain", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-compact");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const taskId = "88000000-0000-4000-8000-00000000cmpct";
    const subagentSessionId = `${storage.chatDir}::sub::${taskId}`;
    const { writer } = storage.transcript.forSubagent(taskId);
    const turn0 = subagentTurnId(taskId, 0);
    await writer.recordAcceptedInput(subagentSessionId, turn0, [userMessage("ROUND ONE DIRECTIVE")]);
    await writer.recordDurableMessage(subagentSessionId, turn0, {
      role: "assistant",
      content: [{ type: "text", text: "pre-compact child output" }],
    });
    await writer.recordSessionMetadata(subagentSessionId, turn0, {
      subagentTask: {
        formatVersion: 2,
        subagentId: taskId,
        definitionId: "explore",
        provider: "test",
        model: "test-model",
        parentSessionId: SESSION_KEY,
        subagentSessionId,
      },
    });
    await writer.recordTurnResult(subagentSessionId, turn0, successTurnResult(subagentSessionId, turn0));
    const turn1 = subagentTurnId(taskId, 1);
    await writer.recordAcceptedInput(subagentSessionId, turn1, [userMessage("ROUND TWO DIRECTIVE")]);
    await writer.recordControlBoundary(subagentSessionId, turn1, {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 90, postTokens: 20, messagesSummarized: 1 },
    });
    await writer.recordDurableMessage(subagentSessionId, turn1, {
      role: "user",
      metadata: { compactReplacement: true },
      content: [{ type: "text", text: "[compacted child summary]" }],
    });
    await writer.recordDurableMessage(subagentSessionId, turn1, {
      role: "assistant",
      content: [{ type: "text", text: "post-compact child output" }],
    });
    await writer.recordTurnResult(subagentSessionId, turn1, successTurnResult(subagentSessionId, turn1));

    const loaded = await loadVia(storage, taskId);
    const texts = loaded.messages.map((message) =>
      message.content.map((block) => block.type === "text" ? block.text : "").join(""),
    );
    assert.match(texts.join("\n"), /compacted child summary/);
    assert.match(texts.join("\n"), /post-compact child output/);
    assert.doesNotMatch(texts.join("\n"), /ROUND ONE DIRECTIVE/);
    assert.doesNotMatch(texts.join("\n"), /pre-compact child output/);
    assert.equal(loaded.definitionId, "explore");
    assert.equal(loaded.provider, "test");
    assert.equal(loaded.model, "test-model");
    assert.equal(loaded.nextTurnIndex, 2);
    assert.ok(loaded.seed.sequence >= 2, "seed must continue the sidechain sequence");
  } finally {
    await cleanupDirs(dirs);
  }
});

test("continuation through the fork API restores history and blocks failed rounds", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-fork");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const hooks = createStorageSubagentTranscriptHooks(storage);
    const captured: CanonicalModelRequest[] = [];
    const registry = new ToolRegistry();
    const router = createScriptedRouter([() => textEvents(ROUND_B_REPORT)], captured);
    const loop = new AgentLoop(parentConfig(dirs), buildDependencies(router, registry, hooks));
    const fork = (loop as unknown as {
      buildSubagentForkApi: (input: { sessionId: string; turnId: string; messages: CanonicalMessage[] }, messages: CanonicalMessage[]) => import("../../../src/tool/index.js").PilotDeckSubagentForkApi;
    }).buildSubagentForkApi(
      { sessionId: SESSION_KEY, turnId: "parent-turn", messages: [] },
      [],
    );

    const taskId = "99000000-0000-4000-8000-00000000fork1";
    await writeSidechain(storage, { taskId, definitionId: "general-purpose" });

    const report = await fork.fork({
      definitionId: undefined,
      directive: "ROUND TWO DIRECTIVE",
      subagentId: "fresh-should-not-be-used",
      taskId,
      timeoutMs: 60_000,
    });
    assert.match(report.markdown, /round B complete/);
    assert.equal(report.definitionId, "general-purpose");
    assert.equal(report.subagentId, taskId, "continuation must reuse the task id, not the fresh id");
    const childRequest = captured.find(isChildRequest);
    assert.ok(childRequest);
    assert.equal(
      childRequest.messages[0]?.content.some(
        (block) => block.type === "text" && block.text === "ROUND ONE DIRECTIVE",
      ),
      true,
    );
    assert.equal(
      childRequest.messages[childRequest.messages.length - 1]?.content.some(
        (block) => block.type === "text" && block.text === "ROUND TWO DIRECTIVE",
      ),
      true,
    );

    // A failed (aborted) last round blocks the next continuation.
    const failedTaskId = "99000000-0000-4000-8000-00000000fork2";
    await writeSidechain(storage, {
      taskId: failedTaskId,
      definitionId: "general-purpose",
      resultType: "aborted",
    });
    await assert.rejects(
      fork.fork({
        definitionId: undefined,
        directive: "should never run",
        subagentId: "fresh-2",
        taskId: failedTaskId,
        timeoutMs: 60_000,
      }),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_round_failed",
    );
    assert.equal(captured.filter(isChildRequest).length, 1, "blocked continuation must not reach the model");
  } finally {
    await cleanupDirs(dirs);
  }
});

test("cancelled and timed-out continuations record their turn result and refuse further continuation", async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-cancel");
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: dirs.projectRoot,
      pilotHome: dirs.pilotHome,
      sessionId: SESSION_KEY,
    });
    const hooks = createStorageSubagentTranscriptHooks(storage);
    const captured: CanonicalModelRequest[] = [];
    const registry = new ToolRegistry();
    const router = createScriptedRouter([BLOCK, BLOCK], captured);
    const loop = new AgentLoop(parentConfig(dirs), buildDependencies(router, registry, hooks));
    const fork = (loop as unknown as {
      buildSubagentForkApi: (input: { sessionId: string; turnId: string; messages: CanonicalMessage[] }, messages: CanonicalMessage[]) => import("../../../src/tool/index.js").PilotDeckSubagentForkApi;
    }).buildSubagentForkApi(
      { sessionId: SESSION_KEY, turnId: "parent-turn", messages: [] },
      [],
    );

    const cancelTaskId = "aa000000-0000-4000-8000-00000000cancel";
    await writeSidechain(storage, { taskId: cancelTaskId, definitionId: "general-purpose" });
    const controller = new AbortController();
    const running = fork.fork({
      definitionId: undefined,
      directive: "ROUND TWO DIRECTIVE",
      subagentId: "fresh-cancel",
      taskId: cancelTaskId,
      abortSignal: controller.signal,
      timeoutMs: 60_000,
    });
    await waitFor(() => captured.filter(isChildRequest).length === 1);
    controller.abort(new Error("parent stopped"));
    await assert.rejects(running, /aborted/);

    const sidechain = await readTranscript(storage.subagentTranscriptPath(cancelTaskId));
    const results = sidechain.entries.filter((entry) => entry.type === "turn_result");
    assert.equal(results.length, 2, "cancelled round must record its own turn_result");
    assert.equal(
      results[1]!.type === "turn_result" ? results[1]!.result.type : "",
      "aborted",
    );

    await assert.rejects(
      fork.fork({
        definitionId: undefined,
        directive: "should never run",
        subagentId: "fresh-cancel-2",
        taskId: cancelTaskId,
        timeoutMs: 60_000,
      }),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_round_failed",
    );

    // Timeout: the timed-out round is recorded and also blocks continuation.
    const timeoutTaskId = "aa000000-0000-4000-8000-00000000times";
    await writeSidechain(storage, { taskId: timeoutTaskId, definitionId: "general-purpose" });
    await assert.rejects(
      fork.fork({
        definitionId: undefined,
        directive: "ROUND TWO DIRECTIVE",
        subagentId: "fresh-timeout",
        taskId: timeoutTaskId,
        timeoutMs: 5,
      }),
      /Subagent timed out after 5ms/,
    );
    const timeoutSidechain = await readTranscript(storage.subagentTranscriptPath(timeoutTaskId));
    const timeoutResults = timeoutSidechain.entries.filter((entry) => entry.type === "turn_result");
    assert.equal(timeoutResults.length, 2);
    await assert.rejects(
      fork.fork({
        definitionId: undefined,
        directive: "should never run",
        subagentId: "fresh-timeout-2",
        taskId: timeoutTaskId,
        timeoutMs: 60_000,
      }),
      (error: unknown) =>
        error instanceof SubagentContinuationError && error.code === "subagent_task_round_failed",
    );
  } finally {
    await cleanupDirs(dirs);
  }
});

for (const mode of ["ask", "plan"] as const) {
test(`a continued write-capable child obeys the current parent's ${mode} mode`, async () => {
  const dirs = await makeTempDirs("pilotdeck-subcont-permissions");
  try {
    const probeCalls: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register({ ...createProbeTool(probeCalls), isReadOnly: () => false });
    const captured: CanonicalModelRequest[] = [];
    const router = createScriptedRouter([
      () => toolCallEvents("write-attempt", "probe", { change: "forbidden" }),
      () => textEvents(ROUND_B_REPORT),
    ], captured);
    const report = await new SubAgentSession({
      definition: SUBAGENT_DEFINITIONS["general-purpose"],
      directive: "Continue the earlier task.",
      priorMessages: [userMessage("Earlier task allowed changes.")],
      turnIndex: 1,
      continuationModel: { provider: "test", model: "test-model" },
      parentConfig: parentConfig(dirs, {
        runMode: "ask", permissionMode: mode === "plan" ? "plan" : "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd: dirs.projectRoot, mode: mode === "plan" ? "plan" : "bypassPermissions", canPrompt: false, bypassAvailable: true }),
      }),
      parentDependencies: buildDependencies(router, registry, undefined),
      parentSessionId: SESSION_KEY, parentTurnId: "parent-turn",
      subagentSessionId: "child-session", subagentId: "child-1",
    }).run();
    assert.equal(report.markdown, ROUND_B_REPORT);
    assert.deepEqual(probeCalls, [], "write tool implementation must not execute");
    assert.match(JSON.stringify(captured[1]?.messages), new RegExp(`${mode}_mode_violation`));
  } finally {
    await cleanupDirs(dirs);
  }
});
}
