import assert from "node:assert/strict";
import test from "node:test";

import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";
import { ToolRegistry } from "../../../src/tool/index.js";

const REPORT = "Scope: inspect\nResult: done\nKey files: none\nFiles changed: none\nIssues: none";

type TestableSession = {
  buildConfig(): AgentRuntimeConfig;
  cloneDependencies(registry: ToolRegistry): AgentRuntimeDependencies;
  forwardActivity(event: AgentEvent): void;
};

function fixture() {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  let routingCalls = 0;
  const cwd = process.cwd();
  const options: SubAgentSessionOptions = {
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Review the evidence.",
    parentConfig: {
      cwd, provider: "parent", model: "parent-model", runMode: "agent", permissionMode: "bypassPermissions",
      maxContextTokens: 64000, maxOutputTokens: 8000,
      modelMultimodal: { input: ["text", "image"] },
      subagentModel: { provider: "default", model: "new-default", maxContextTokens: 24000, maxOutputTokens: 2400 },
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
    },
    parentDependencies: {
      tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } },
      eventEmitter: event => { events.push(event); },
      getModelTokenLimits: (provider, model) => provider === "saved" && model === "original"
        ? { maxContextTokens: 32000, maxOutputTokens: 4000 } : undefined,
      getModelMultimodal: (provider, model) => provider === "saved" && model === "original"
        ? { input: ["text"] } : undefined,
      router: {
        decide: async ({ request }) => {
          routingCalls++;
          return { provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true,
            orchestrating: false, resolvedFrom: "fallback", mutations: {} };
        },
        execute: async function* (decision, request) {
          requests.push(request);
          yield { type: "request_started", provider: decision.provider, model: decision.model };
          yield { type: "text_delta", text: REPORT };
          yield { type: "message_end", finishReason: "stop" };
        },
        stream: async function* () { throw new Error("Unexpected legacy stream"); },
      },
    },
    parentSessionId: "root-session", parentTurnId: "root-turn",
    subagentId: "reviewer-id", subagentSessionId: "reviewer-session",
  };
  return { options, requests, events, routingCalls: () => routingCalls };
}

test("resuming a built-in child keeps its saved model and current saved-model limits", async () => {
  const f = fixture();
  const options: SubAgentSessionOptions = {
    ...f.options,
    continuationModel: { provider: "saved", model: "original" },
    priorMessages: [{ role: "user", content: [{ type: "text", text: "Prior child input" }] }],
    turnIndex: 1,
  };
  const session = new SubAgentSession(options);
  const config = (session as unknown as TestableSession).buildConfig();
  assert.equal(config.provider, "saved");
  assert.equal(config.model, "original");
  assert.equal(config.maxContextTokens, 32000);
  assert.equal(config.maxOutputTokens, 4000);
  assert.deepEqual(config.modelMultimodal, { input: ["text"] });
  await session.run();
  assert.equal(f.routingCalls(), 0, "saved identity must bypass automatic routing");
  assert.equal(f.requests[0]?.provider, "saved");
  assert.equal(f.requests[0]?.model, "original");
  assert.equal(f.requests[0]?.maxOutputTokens, 4000);
  assert.match(JSON.stringify(f.requests[0]?.messages), /Prior child input/);
});

test("saved models with no multimodal capability do not inherit the parent's image support", () => {
  const f = fixture();
  f.options.parentDependencies.getModelMultimodal = () => undefined;
  const session = new SubAgentSession({ ...f.options, continuationModel: { provider: "saved", model: "original" } });
  const config = (session as unknown as TestableSession).buildConfig();
  assert.equal(config.modelMultimodal, undefined);
  assert.equal(config.subagentModel, undefined);
  assert.equal(config.maxContextTokens, 32000);
  assert.equal(config.maxOutputTokens, 4000);
});

test("direct child model activity preserves stream boundaries and durable timeline coordinates", () => {
  const f = fixture();
  const session = new SubAgentSession(f.options) as unknown as TestableSession;
  const timeline = { version: 1 as const, turnId: "reviewer-id-t1", id: "block-1", order: 3, revision: 4 };
  const streamBoundary = { turnId: "reviewer-id-t1", through: 3, revision: 5 };
  session.forwardActivity({ type: "model_event", sessionId: "reviewer-session", turnId: "reviewer-id-t1",
    blockId: "block-1", timeline, streamBoundary, event: { type: "text_delta", text: "Evidence" } });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]?.type, "subagent_model_event");
  assert.deepEqual(f.events[0]?.timeline, timeline);
  assert.deepEqual(f.events[0]?.streamBoundary, streamBoundary);
  if (f.events[0]?.type === "subagent_model_event") assert.equal(f.events[0].blockId, "block-1");
});

test("a child exhausting its turn budget records failure instead of returning a successful report", async () => {
  const f = fixture();
  const results: string[] = [];
  f.options.maxTurns = 1;
  f.options.sidechainTranscript = {
    recordAcceptedInput: async () => {}, recordDurableMessage: async () => {},
    recordTurnResult: async (_session, _turn, result) => { results.push(result.type); },
  };
  f.options.parentDependencies.router.execute = async function* () {
    yield { type: "tool_call_end", toolCall: { id: "unavailable", name: "unavailable", input: {} } };
    yield { type: "message_end", finishReason: "tool_call" };
  };
  await assert.rejects(new SubAgentSession(f.options).run(), /max_turns/);
  assert.deepEqual(results, ["max_turns"]);
});

test("child compaction persists one complete atomic snapshot instead of legacy replacement records", async () => {
  const f = fixture();
  const budget = new TokenBudgetManager();
  const summary: CanonicalMessage = { role: "user", content: [{ type: "text", text: "Compacted child evidence" }] };
  const boundaries: AgentControlBoundaryTranscriptEntry["boundary"][] = [];
  const durable: CanonicalMessage[] = [];
  let compactCalls = 0;
  f.options.sidechainTranscript = {
    recordAcceptedInput: async () => {},
    recordDurableMessage: async (_session, _turn, message) => { durable.push(message); },
    recordControlBoundary: async (_session, _turn, boundary) => { boundaries.push(boundary); },
    recordTurnResult: async () => {},
  };
  f.options.parentDependencies.context = {
    prepareForModel: async input => ({ messages: input.messages, systemPrompt: undefined,
      systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async input => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => {},
    tryAutoCompact: async () => {
      const snapshot = budget.snapshotFromTokens(20, 12000);
      if (compactCalls++ > 0) return { type: "skipped", snapshot };
      return {
        type: "compacted", tier: "full", messages: [summary], snapshot,
        result: { compactionId: "child-compact", trigger: "auto", preTokens: 9000, postTokens: 20,
          messagesSummarized: 1, summaryMessage: summary, boundaryMarker: summary, messagesToKeep: [summary],
          attachments: [], hookResults: [], diagnostics: [] },
      };
    },
  };
  await new SubAgentSession(f.options).run();
  assert.equal(boundaries.length, 1);
  const boundary = boundaries[0]!;
  assert.equal(boundary.kind, "compact");
  assert.ok(boundary.kind === "compact" && boundary.subtype === "compact_boundary");
  assert.equal(boundary.snapshot?.version, 1);
  assert.match(JSON.stringify(boundary.snapshot?.messages), /Compacted child evidence/);
  assert.equal(durable.some(message => message.metadata?.compactReplacement === true), false);
  assert.equal(durable.filter(message => message.role === "assistant").length, 1, "the durable callback must not duplicate assistant events");
  assert.match(JSON.stringify(f.requests[0]?.messages), /Compacted child evidence/);
});
