import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, type AgentLoopRunResult } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  ArtifactContractStore,
  ArtifactValidationRuntime,
  FileExistsValidator,
} from "../../src/artifact/index.js";
import type { AgentContextRuntime } from "../../src/context/ContextRuntime.js";
import { DefaultContextRuntime, DynamicContextStore } from "../../src/context/index.js";
import type { TokenBudgetSnapshot } from "../../src/context/index.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { RouterDecision } from "../../src/router/index.js";
import { ToolRegistry } from "../../src/tool/index.js";

test("PreModelRequest mutations survive a post-routing request rebuild and remain model-only", async () => {
  const requests: CanonicalModelRequest[] = [];
  let compactCalls = 0;
  let preModelCalls = 0;
  let observedBudget: unknown;
  const dynamicContext = new DynamicContextStore();
  dynamicContext.register({
    sessionId: "session-1",
    source: "goal-hook",
    id: "checkpoint",
    content: "goal checkpoint survives request rebuild",
    priority: "high",
  });
  const defaultContext = new DefaultContextRuntime({ dynamicContext });
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      compactCalls += 1;
      if (compactCalls === 1) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      return {
        type: "compacted",
        messages: input.messages,
        tier: "micro",
        snapshot: budgetSnapshot(5_000),
      };
    },
  };
  const dependencies = createDependencies(requests, {
    context,
    getModelTokenLimits: (_provider, model) => ({
      maxContextTokens: model === "routed-review-model" ? 5_000 : 10_000,
      maxOutputTokens: 2_048,
    }),
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        observedBudget = (input as { payload?: Record<string, unknown> }).payload?.contextBudget;
        return {
          ...emptyLifecycleResult(),
          messages: [{
            role: "user" as const,
            content: [{ type: "text" as const, text: "current budget checkpoint" }],
            metadata: { synthetic: true },
          }],
          effects: [
            { type: "system_message" as const, content: "runtime policy addendum" },
            {
              type: "model_request_patch" as const,
              patch: { model: "routed-review-model", maxOutputTokens: 9_999, metadata: { goalId: "goal-1" } },
            },
          ],
        };
      },
    } as never,
  });
  const loop = new AgentLoop(createConfig(process.cwd(), { maxContextTokens: 10_000 }), dependencies);

  const completed = await drainLoop(loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [userMessage("original request")],
  }));

  assert.equal(completed.result.type, "success");
  assert.equal(preModelCalls, 1);
  assert.equal(compactCalls, 2);
  assert.equal((observedBudget as TokenBudgetSnapshot | undefined)?.maxContextTokens, 10_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "routed-review-model");
  assert.equal(requests[0]?.maxOutputTokens, 2_048);
  assert.match(requests[0]?.systemPrompt ?? "", /^base system/u);
  assert.match(requests[0]?.systemPrompt ?? "", /runtime policy addendum$/u);
  assert.deepEqual(requests[0]?.metadata, { goalId: "goal-1" });
  assert.match(messageText(requests[0]?.messages ?? []), /current budget checkpoint/);
  assert.match(messageText(requests[0]?.messages ?? []), /goal checkpoint survives request rebuild/);
  assert.doesNotMatch(messageText(completed.messages), /current budget checkpoint/);
  assert.doesNotMatch(messageText(completed.messages), /goal checkpoint survives request rebuild/);
  assert.equal(dynamicContext.hasPending("session-1"), false);
});

test("AgentLoop exposes explicit subagent identity to lifecycle hooks", async () => {
  const requests: CanonicalModelRequest[] = [];
  const observed = new Map<string, boolean | undefined>();
  const dependencies = createDependencies(requests, {
    lifecycle: {
      async dispatch(input: { event: string; baseInput?: { isSubagent?: boolean } }) {
        observed.set(input.event, input.baseInput?.isSubagent);
        return emptyLifecycleResult();
      },
    } as never,
  });
  const loop = new AgentLoop(createConfig(process.cwd(), { isSubagent: true }), dependencies);

  const completed = await drainLoop(loop.run({
    sessionId: "subagent-session",
    turnId: "subagent-turn",
    messages: [userMessage("complete one bounded worker task")],
  }));

  assert.equal(completed.result.type, "success");
  assert.equal(observed.get("PreModelRequest"), true);
  assert.equal(observed.get("Stop"), true);
});

test("AgentLoop emits a phase budget decision for a convergence report", async () => {
  const requests: CanonicalModelRequest[] = [];
  const lifecycle = {
    async dispatch(input: { event: string }) {
      if (input.event !== "PreModelRequest") return emptyLifecycleResult();
      return {
        ...emptyLifecycleResult(),
        effects: [{
          type: "model_request_patch" as const,
          patch: {
            metadata: {
              pilotdeckConvergence: {
                schemaVersion: 1,
                scope: "synthetic-budget",
                phase: "matrices",
                stateHash: "state-1",
                blockingCode: "matrix_pending",
                remainingCount: 3,
              },
            },
          },
        }],
      };
    },
  } as never;
  const startedAtMs = Date.parse("2026-07-22T00:00:00.000Z");
  const loop = new AgentLoop(createConfig(process.cwd(), {
    phaseBudget: {
      enabled: true,
      finalizationReserveMs: 200,
      phaseBudgetsMs: { matrices: 5_000 },
    },
  }), createDependencies(requests, { lifecycle }));
  const events: Array<{ type?: string; phase?: string; reason?: string; finishFirst?: boolean }> = [];
  const iterator = loop.run({
    sessionId: "session-budget",
    turnId: "turn-budget",
    messages: [userMessage("complete the bounded matrix work")],
    turnDeadlineAtMs: startedAtMs + 100,
  });
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value && typeof next.value === "object") events.push(next.value as typeof events[number]);
  }

  const decision = events.find((event) => event.type === "phase_budget_evaluated");
  assert.equal(decision?.phase, "matrices");
  assert.equal(decision?.reason, "finalization_reserve");
  assert.equal(decision?.finishFirst, true);
});

test("AgentLoop does not emit phase budget events when the policy is not configured", async () => {
  const requests: CanonicalModelRequest[] = [];
  const lifecycle = {
    async dispatch(input: { event: string }) {
      if (input.event !== "PreModelRequest") return emptyLifecycleResult();
      return {
        ...emptyLifecycleResult(),
        effects: [{
          type: "model_request_patch" as const,
          patch: {
            metadata: {
              pilotdeckConvergence: {
                schemaVersion: 1,
                scope: "synthetic-budget-default",
                phase: "coverage",
                stateHash: "state-1",
                remainingCount: 1,
              },
            },
          },
        }],
      };
    },
  } as never;
  const loop = new AgentLoop(createConfig(process.cwd()), createDependencies(requests, { lifecycle }));
  const events: unknown[] = [];
  const iterator = loop.run({
    sessionId: "session-budget-default",
    turnId: "turn-budget-default",
    messages: [userMessage("complete the bounded coverage work")],
    turnDeadlineAtMs: Date.parse("2026-07-22T00:00:01.000Z"),
  });
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  assert.equal(events.some((event) => (
    event && typeof event === "object" && "type" in event && event.type === "phase_budget_evaluated"
  )), false);
});

test("evaluation progress lease stops before a third unchanged model request when full compaction is rejected", async () => {
  const requests: CanonicalModelRequest[] = [];
  const defaultContext = new DefaultContextRuntime();
  let compactCalls = 0;
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      compactCalls += 1;
      if (!input.forceFull) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      return {
        type: "skipped",
        snapshot: budgetSnapshot(10_000),
        trace: {
          triggered: true,
          attemptedTiers: ["full"],
          rejectionReason: "post_compact_blocking",
          summarySucceeded: true,
          initialSnapshot: budgetSnapshot(10_000),
          finalSnapshot: { ...budgetSnapshot(10_000), state: "blocking", ratio: 1.1 },
        },
      };
    },
  };
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default" as const,
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario" as const,
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      const toolCall = { id: `noop-${requests.length}`, name: "noop", input: {} };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_end", toolCall };
      yield { type: "message_end", finishReason: "tool_call" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  const dependencies = createDependencies(requests, {
    context,
    router,
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        return {
          ...emptyLifecycleResult(),
          effects: [{
            type: "model_request_patch" as const,
            patch: {
              metadata: {
                pilotdeckConvergence: {
                  schemaVersion: 1,
                  scope: "synthetic-validation",
                  phase: "coverage",
                  stateHash: "unchanged",
                  blockingCode: "missing_rows",
                  remainingCount: 4,
                },
              },
            },
          }],
        };
      },
    } as never,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "no state change" }],
            startedAt: "2026-07-22T00:00:00.000Z",
            completedAt: "2026-07-22T00:00:00.000Z",
          }));
        },
      },
    },
  });
  const loop = new AgentLoop(createConfig(process.cwd(), {
    maxContextTokens: 10_000,
    progressLease: {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
      maxInitialStagnantObservations: 2,
    },
  }), dependencies);

  const completed = await drainLoop(loop.run({
    sessionId: "session-lease",
    turnId: "turn-lease",
    messages: [userMessage("repair the synthetic state")],
  }));

  assert.equal(completed.result.type, "error");
  assert.equal(completed.result.errors?.[0]?.code, "agent_convergence_stalled");
  assert.equal(completed.result.errors?.[0]?.details && (completed.result.errors[0].details as { reason?: string }).reason, "boundary_rejected");
  assert.equal(requests.length, 2);
  assert.equal(compactCalls, 3);
});

test("AgentLoop delivers newly surfaced repair feedback once after an applied boundary", async () => {
  const requests: CanonicalModelRequest[] = [];
  const defaultContext = new DefaultContextRuntime();
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      if (!input.forceFull) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      return {
        type: "compacted",
        messages: input.messages,
        tier: "full",
        snapshot: budgetSnapshot(5_000),
        trace: {
          triggered: true,
          attemptedTiers: ["full"],
          appliedTier: "full",
          summaryAttempted: true,
          summarySucceeded: true,
          initialSnapshot: budgetSnapshot(10_000),
          finalSnapshot: budgetSnapshot(5_000),
        },
      };
    },
  };
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default" as const,
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario" as const,
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      if (requests.length < 4) {
        const toolCall = { id: `repair-${requests.length}`, name: "noop", input: {} };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "repair feedback received" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  let preModelCalls = 0;
  const dependencies = createDependencies(requests, {
    context,
    router,
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        const feedbackAvailable = preModelCalls >= 4;
        return {
          ...emptyLifecycleResult(),
          messages: feedbackAvailable ? [userMessage("first stable repair diagnostics")] : [],
          effects: [{
            type: "model_request_patch" as const,
            patch: {
              metadata: {
                pilotdeckConvergence: {
                  schemaVersion: 1,
                  scope: "synthetic-validation",
                  phase: "coverage",
                  stateHash: feedbackAvailable ? "repair-feedback" : "unchanged",
                  blockingCode: "missing_rows",
                  remainingCount: 4,
                  progressOrdinal: 1,
                  repairOrdinal: feedbackAvailable ? 1 : 0,
                },
              },
            },
          }],
        };
      },
    } as never,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "no genuine progress" }],
            startedAt: "2026-07-26T00:00:00.000Z",
            completedAt: "2026-07-26T00:00:00.000Z",
          }));
        },
      },
    },
  });
  const loop = new AgentLoop(createConfig(process.cwd(), {
    maxContextTokens: 10_000,
    progressLease: {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
      maxInitialStagnantObservations: 2,
    },
  }), dependencies);

  const events: Array<{ type?: string; decision?: string }> = [];
  const iterator = loop.run({
    sessionId: "session-feedback-grace",
    turnId: "turn-feedback-grace",
    messages: [userMessage("repair the synthetic state")],
  });
  let completed: AgentLoopRunResult | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      completed = next.value;
      break;
    }
    events.push(next.value as { type?: string; decision?: string });
  }

  assert.equal(completed.result.type, "success");
  assert.equal(requests.length, 4);
  assert.match(messageText(requests[3]?.messages ?? []), /first stable repair diagnostics/u);
  assert.equal(
    events.some((event) => event.type === "progress_lease_evaluated" && event.decision === "feedback_grace"),
    true,
  );
});

test("AgentLoop permits one prepared-target request and then requires genuine progress", async () => {
  const requests: CanonicalModelRequest[] = [];
  const defaultContext = new DefaultContextRuntime();
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      if (!input.forceFull) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      return {
        type: "compacted",
        messages: input.messages,
        tier: "full",
        snapshot: budgetSnapshot(5_000),
        trace: {
          triggered: true,
          attemptedTiers: ["full"],
          appliedTier: "full",
          summaryAttempted: true,
          summarySucceeded: true,
          initialSnapshot: budgetSnapshot(10_000),
          finalSnapshot: budgetSnapshot(5_000),
        },
      };
    },
  };
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default" as const,
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario" as const,
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      if (requests.length < 5) {
        const toolCall = { id: `repair-step-${requests.length}`, name: "noop", input: {} };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "bounded repair completed" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  let preModelCalls = 0;
  const dependencies = createDependencies(requests, {
    context,
    router,
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        const feedbackAvailable = preModelCalls >= 3;
        const targetPrepared = preModelCalls >= 4;
        const acceptedProgress = preModelCalls >= 5;
        return {
          ...emptyLifecycleResult(),
          messages: preModelCalls === 3
            ? [userMessage("repair diagnostics for one stable target")]
            : preModelCalls === 4
              ? [userMessage("the stable repair target was read successfully")]
              : [],
          effects: [{
            type: "model_request_patch" as const,
            patch: {
              metadata: {
                pilotdeckConvergence: {
                  schemaVersion: 1,
                  scope: "synthetic-validation",
                  phase: "coverage",
                  stateHash: acceptedProgress ? "accepted" : targetPrepared ? "prepared" : feedbackAvailable ? "feedback" : "unchanged",
                  blockingCode: "missing_rows",
                  remainingCount: 4,
                  progressOrdinal: acceptedProgress ? 2 : 1,
                  repairOrdinal: feedbackAvailable ? 1 : 0,
                  repairPreparationOrdinal: targetPrepared ? 1 : 0,
                },
              },
            },
          }],
        };
      },
    } as never,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "synthetic step completed" }],
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:00.000Z",
          }));
        },
      },
    },
  });
  const loop = new AgentLoop(createConfig(process.cwd(), {
    maxContextTokens: 10_000,
    progressLease: {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
      maxInitialStagnantObservations: 2,
    },
  }), dependencies);

  const events: Array<{ type?: string; decision?: string }> = [];
  const iterator = loop.run({
    sessionId: "session-repair-preparation",
    turnId: "turn-repair-preparation",
    messages: [userMessage("repair the synthetic state")],
  });
  let completed: AgentLoopRunResult | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      completed = next.value;
      break;
    }
    events.push(next.value as { type?: string; decision?: string });
  }

  assert.equal(completed.result.type, "success");
  assert.equal(requests.length, 5);
  assert.match(messageText(requests[2]?.messages ?? []), /repair diagnostics for one stable target/u);
  assert.match(messageText(requests[3]?.messages ?? []), /stable repair target was read successfully/u);
  assert.deepEqual(
    events.filter((event) => event.type === "progress_lease_evaluated").map((event) => event.decision),
    ["baseline", "stagnant", "boundary_grace", "repair_preparation_grace", "renewed"],
  );
});

test("AgentLoop carries a bounded handoff through the required boundary to genuine progress", async () => {
  const requests: CanonicalModelRequest[] = [];
  const defaultContext = new DefaultContextRuntime();
  let forcedFullCompactions = 0;
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      if (!input.forceFull) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      forcedFullCompactions += 1;
      return {
        type: "compacted",
        messages: input.messages,
        tier: "full",
        snapshot: budgetSnapshot(5_000),
        trace: {
          triggered: true,
          attemptedTiers: ["full"],
          appliedTier: "full",
          summaryAttempted: true,
          summarySucceeded: true,
          initialSnapshot: budgetSnapshot(10_000),
          finalSnapshot: budgetSnapshot(5_000),
        },
      };
    },
  };
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default" as const,
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario" as const,
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      if (requests.length < 5) {
        const toolCall = { id: `handoff-step-${requests.length}`, name: "noop", input: {} };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "matrix checkpoint completed" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  let preModelCalls = 0;
  let toolBatches = 0;
  const dependencies = createDependencies(requests, {
    context,
    router,
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        const report = [
          { progressOrdinal: 7, handoffOrdinal: 0, stateHash: "prior" },
          { progressOrdinal: 8, handoffOrdinal: 0, stateHash: "first-matrix" },
          { progressOrdinal: 8, handoffOrdinal: 1, stateHash: "apply-ready" },
          { progressOrdinal: 8, handoffOrdinal: 2, stateHash: "next-page" },
          { progressOrdinal: 9, handoffOrdinal: 2, stateHash: "finalized" },
        ][preModelCalls - 1]!;
        return {
          ...emptyLifecycleResult(),
          messages: preModelCalls === 3
            ? [userMessage("execute the state-bound apply command now")]
            : preModelCalls === 4
              ? [userMessage("select from the next bounded evidence page")]
              : [],
          effects: [{
            type: "model_request_patch" as const,
            patch: {
              metadata: {
                pilotdeckConvergence: {
                  schemaVersion: 1,
                  scope: "synthetic-validation",
                  phase: "coverage",
                  blockingCode: "missing_rows",
                  remainingCount: 4,
                  ...report,
                },
              },
            },
          }],
        };
      },
    } as never,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          toolBatches += 1;
          const nextReport = [
            { progressOrdinal: 8, handoffOrdinal: 0, stateHash: "first-matrix" },
            { progressOrdinal: 8, handoffOrdinal: 1, stateHash: "apply-ready" },
            { progressOrdinal: 8, handoffOrdinal: 2, stateHash: "next-page" },
            { progressOrdinal: 9, handoffOrdinal: 2, stateHash: "finalized" },
          ][toolBatches - 1];
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "synthetic handoff completed" }],
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:00.000Z",
            ...(nextReport ? {
              metadata: {
                lifecycle: {
                  convergencePreviews: [{
                    schemaVersion: 1,
                    scope: "synthetic-validation",
                    phase: "coverage",
                    blockingCode: "missing_rows",
                    remainingCount: 4,
                    ...nextReport,
                  }],
                },
              },
            } : {}),
          }));
        },
      },
    },
  });
  const loop = new AgentLoop(createConfig(process.cwd(), {
    maxContextTokens: 10_000,
    progressLease: {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
      maxInitialStagnantObservations: 8,
    },
  }), dependencies);

  const events: Array<{
    type?: string;
    decision?: string;
    handoffOrdinal?: number;
    scopes?: string[];
    scope?: string;
    reason?: string;
  }> = [];
  const iterator = loop.run({
    sessionId: "session-bounded-handoff",
    turnId: "turn-bounded-handoff",
    messages: [userMessage("complete the synthetic matrix")],
  });
  let completed: AgentLoopRunResult | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      completed = next.value;
      break;
    }
    events.push(next.value as {
      type?: string;
      decision?: string;
      handoffOrdinal?: number;
      scopes?: string[];
      scope?: string;
      reason?: string;
    });
  }

  assert.equal(completed.result.type, "success");
  assert.equal(requests.length, 5);
  assert.equal(forcedFullCompactions, 0);
  assert.match(messageText(requests[2]?.messages ?? []), /state-bound apply command/u);
  assert.match(messageText(requests[3]?.messages ?? []), /next bounded evidence page/u);
  assert.deepEqual(
    events.filter((event) => event.type === "progress_lease_evaluated")
      .map((event) => [event.decision, event.handoffOrdinal]),
    [
      ["baseline", 0],
      ["renewed", 0],
      ["handoff_grace", 1],
      ["handoff_grace", 2],
      ["renewed", 2],
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "progress_boundary_deferred").map((event) => event.scopes),
    [["synthetic-validation"], ["synthetic-validation"]],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "progress_boundary_preview_evaluated")
      .map((event) => [event.scope, event.decision, event.reason]),
      [
      ["synthetic-validation", "deferred", "preview_handoff"],
      ["synthetic-validation", "deferred", "preview_progressed"],
    ],
  );
});

test("AgentLoop fails closed before the model when a deferred preview is not confirmed", async () => {
  const requests: CanonicalModelRequest[] = [];
  const defaultContext = new DefaultContextRuntime();
  let forcedFullCompactions = 0;
  const context: AgentContextRuntime = {
    prepareForModel: (input) => defaultContext.prepareForModel(input),
    commitPreparedContext: (input) => defaultContext.commitPreparedContext(input),
    async tryAutoCompact(input) {
      if (!input.forceFull) return { type: "skipped", snapshot: budgetSnapshot(10_000) };
      forcedFullCompactions += 1;
      return {
        type: "compacted",
        messages: input.messages,
        tier: "full",
        snapshot: budgetSnapshot(5_000),
      };
    },
  };
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default" as const,
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario" as const,
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      const toolCall = { id: `stale-preview-${requests.length}`, name: "noop", input: {} };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_end", toolCall };
      yield { type: "message_end", finishReason: "tool_call" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  let preModelCalls = 0;
  let toolBatches = 0;
  const dependencies = createDependencies(requests, {
    context,
    router,
    lifecycle: {
      async dispatch(input: { event: string }) {
        if (input.event !== "PreModelRequest") return emptyLifecycleResult();
        preModelCalls += 1;
        return {
          ...emptyLifecycleResult(),
          effects: [{
            type: "model_request_patch" as const,
            patch: {
              metadata: {
                pilotdeckConvergence: {
                  schemaVersion: 1,
                  scope: "synthetic-validation",
                  phase: "coverage",
                  stateHash: "unchanged",
                  blockingCode: "missing_rows",
                  remainingCount: 4,
                  progressOrdinal: 8,
                  handoffOrdinal: 0,
                },
              },
            },
          }],
        };
      },
    } as never,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          toolBatches += 1;
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "synthetic state unchanged" }],
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:00.000Z",
            ...(toolBatches === 2 ? {
              metadata: {
                lifecycle: {
                  convergencePreviews: [{
                    schemaVersion: 1,
                    scope: "synthetic-validation",
                    phase: "coverage",
                    stateHash: "claimed-handoff",
                    blockingCode: "missing_rows",
                    remainingCount: 4,
                    progressOrdinal: 8,
                    handoffOrdinal: 1,
                  }],
                },
              },
            } : {}),
          }));
        },
      },
    },
  });
  const loop = new AgentLoop(createConfig(process.cwd(), {
    maxContextTokens: 10_000,
    progressLease: {
      enabled: true,
      mode: "evaluation",
      maxStagnantObservations: 2,
      maxInitialStagnantObservations: 2,
    },
  }), dependencies);

  const events: Array<{ type?: string; decision?: string; reason?: string }> = [];
  const iterator = loop.run({
    sessionId: "session-stale-preview",
    turnId: "turn-stale-preview",
    messages: [userMessage("complete the synthetic matrix")],
  });
  let completed: AgentLoopRunResult | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      completed = next.value;
      break;
    }
    events.push(next.value as { type?: string; decision?: string; reason?: string });
  }

  assert.equal(completed.result.type, "error");
  assert.equal(completed.result.errors?.[0]?.code, "agent_convergence_stalled");
  assert.equal(
    completed.result.errors?.[0]?.details
      && (completed.result.errors[0].details as { reason?: string }).reason,
    "boundary_preview_unconfirmed",
  );
  assert.equal(requests.length, 2);
  assert.equal(preModelCalls, 3);
  assert.equal(forcedFullCompactions, 0);
  assert.equal(events.filter((event) => event.type === "progress_boundary_deferred").length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "progress_boundary_preview_evaluated")
      .map((event) => [event.decision, event.reason]),
    [["deferred", "preview_handoff"]],
  );
});

test("artifact failure injects one bounded correction turn and succeeds after validation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-agent-loop-artifact-"));
  try {
    const contracts = new ArtifactContractStore();
    contracts.register("session-1", "domain-plugin", [{
      id: "final-workbook",
      path: "deliverable.xlsx",
      required: true,
      expectedExtensions: [".xlsx"],
      validatorIds: ["core:file-exists"],
    }]);
    const requests: CanonicalModelRequest[] = [];
    const dependencies = createDependencies(requests, {
      artifactValidation: new ArtifactValidationRuntime(contracts, [new FileExistsValidator()]),
      beforeResponse: async (requestIndex) => {
        if (requestIndex === 2) await writeFile(join(workspace, "deliverable.xlsx"), "verified workbook fixture");
      },
    });
    const loop = new AgentLoop(createConfig(workspace), dependencies);

    const completed = await drainLoop(loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [userMessage("create the required deliverable")],
    }));

    assert.equal(completed.result.type, "success");
    assert.equal(requests.length, 2);
    assert.match(messageText(requests[0]?.messages ?? []), /Required deliverables are still missing/);
    assert.match(messageText(requests[0]?.messages ?? []), /deliverable\.xlsx/);
    assert.doesNotMatch(messageText(completed.messages), /Required deliverables are still missing/);
    assert.match(messageText(requests[1]?.messages ?? []), /Artifact validation failed/);
    assert.match(messageText(requests[1]?.messages ?? []), /deliverable\.xlsx/);
    assert.match(messageText(requests[1]?.messages ?? []), /Required deliverables are still missing/);
    assert.equal(completed.result.turns, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("required artifact failure wins over max-turn completion after a final tool call", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-agent-loop-artifact-max-turns-"));
  try {
    const contracts = new ArtifactContractStore();
    contracts.register("session-1", "domain-plugin", [{
      id: "final-workbook",
      path: "deliverable.xlsx",
      required: true,
      expectedExtensions: [".xlsx"],
      validatorIds: ["core:file-exists"],
    }]);
    const requests: CanonicalModelRequest[] = [];
    const dependencies = createDependencies(requests, {
      artifactValidation: new ArtifactValidationRuntime(contracts, [new FileExistsValidator()]),
      router: {
        async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
          return {
            provider: input.request.provider,
            model: input.request.model,
            scenarioType: "default",
            isSubagent: false,
            orchestrating: false,
            resolvedFrom: "scenario",
            mutations: {},
          };
        },
        async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
          requests.push(request);
          const toolCall = { id: "tool-1", name: "noop", input: {} };
          yield { type: "message_start", role: "assistant" };
          yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
          yield { type: "tool_call_end", toolCall };
          yield { type: "message_end", finishReason: "tool_call" };
        },
        async *stream(): AsyncIterable<CanonicalModelEvent> {
          throw new Error("stream fallback should not be used");
        },
      },
      tools: {
        registry: new ToolRegistry(),
        scheduler: {
          async executeAll(calls) {
            return calls.map((call) => ({
              type: "success" as const,
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text" as const, text: "ok" }],
              startedAt: "2026-07-22T00:00:00.000Z",
              completedAt: "2026-07-22T00:00:00.000Z",
            }));
          },
        },
      },
    });
    const loop = new AgentLoop(createConfig(workspace), dependencies);

    const completed = await drainLoop(loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [userMessage("create the required deliverable")],
      maxTurns: 1,
    }));

    assert.equal(completed.result.type, "error");
    assert.equal(completed.result.stopReason, "tool_error");
    assert.match(completed.result.errors?.[0]?.message ?? "", /Artifact validation failed/u);
    assert.match(completed.result.errors?.[0]?.message ?? "", /deliverable\.xlsx/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function createDependencies(
  requests: CanonicalModelRequest[],
  options: Partial<AgentRuntimeDependencies> & { beforeResponse?: (requestIndex: number) => Promise<void> } = {},
): AgentRuntimeDependencies {
  const registry = new ToolRegistry();
  const router = {
    async decide(input: { request: CanonicalModelRequest }): Promise<RouterDecision> {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      };
    },
    async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      await options.beforeResponse?.(requests.length);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: `response ${requests.length}` };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream fallback should not be used");
    },
  };
  const { beforeResponse: _beforeResponse, ...dependencyOverrides } = options;
  return {
    router,
    tools: {
      registry,
      scheduler: { async executeAll() { return []; } },
    },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    uuid: (() => {
      let sequence = 0;
      return () => `id-${++sequence}`;
    })(),
    ...dependencyOverrides,
  } as AgentRuntimeDependencies;
}

function createConfig(cwd: string, overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    provider: "test-provider",
    model: "test-model",
    cwd,
    systemPrompt: "base system",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
    ...overrides,
  };
}

function emptyLifecycleResult() {
  return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function budgetSnapshot(maxContextTokens: number): TokenBudgetSnapshot {
  return {
    tokens: 10,
    maxContextTokens,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state: "ok",
    ratio: 0.001,
  };
}

async function drainLoop(iterator: AsyncGenerator<unknown, AgentLoopRunResult, unknown>): Promise<AgentLoopRunResult> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
  }
}
