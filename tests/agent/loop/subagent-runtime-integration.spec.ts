import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { SubagentContinuationError, type SubagentContinuationState } from "../../../src/agent/sub/continuation.js";
import { mapAgentEvent } from "../../../src/gateway/client/InProcessGateway.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry, type PilotDeckSubagentForkApi } from "../../../src/tool/index.js";

type TestableLoop = {
  buildSubagentForkApi(input: AgentLoopInput, messages: CanonicalMessage[]): PilotDeckSubagentForkApi;
};

function fixture(options: { ask?: boolean } = {}) {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const cwd = process.cwd();
  const saved: SubagentContinuationState = {
    definitionId: "general-purpose", provider: "saved", model: "original", subagentSessionId: "saved-session", nextTurnIndex: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "Saved prior evidence" }] }],
  };
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } },
    eventEmitter: event => { events.push(event); },
    getModelTokenLimits: (provider, model) => provider === "saved" && model === "original"
      ? { maxContextTokens: 32000, maxOutputTokens: 4000 } : undefined,
    getModelMultimodal: () => ({ input: ["text"] }),
    subagentTranscript: {
      loadSubagentContinuation: async () => saved,
      subagentTranscriptResolver: () => ({ transcriptRelativePath: "child.jsonl", recordAcceptedInput: async () => {},
        recordDurableMessage: async () => {}, recordSessionMetadata: async () => {}, recordTurnResult: async () => {} }),
    },
    router: {
      decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default",
        isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
      execute: async function* (decision, request) {
        requests.push(request);
        yield { type: "request_started", provider: decision.provider, model: decision.model };
        yield { type: "text_delta", text: "Scope: test\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () { throw new Error("Unexpected legacy model call"); },
    },
  };
  const api = (sessionId = "runtime-parent") => {
    const loop = new AgentLoop({ cwd, provider: "parent", model: "parent-model", maxSubagentDepth: 2,
      runMode: options.ask ? "ask" : "agent", permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
    }, dependencies) as unknown as TestableLoop;
    return loop.buildSubagentForkApi({ sessionId, turnId: "runtime-turn", messages: [] }, []);
  };
  return { api, dependencies, requests, saved, events };
}

test("direct continuation calls across loop instances cannot interleave sidechain writers", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let loads = 0;
  f.dependencies.subagentTranscript!.loadSubagentContinuation = async () => {
    loads++;
    await gate;
    return f.saved;
  };
  const args = { directive: "Continue.", taskId: "direct-busy-child", subagentId: "ignored", timeoutMs: 5000 };
  const first = f.api().fork(args);
  try {
    await assert.rejects(f.api().fork(args), error => error instanceof SubagentContinuationError && error.code === "subagent_task_busy");
    assert.ok(loads <= 1, "only one continuation can reach storage");
  } finally {
    release();
    await first;
  }
  assert.equal(loads, 1);
  assert.equal(f.requests.length, 1);
  await f.api().fork(args);
  assert.equal(loads, 2, "terminal cleanup releases the runtime guard");
  assert.equal(f.requests.length, 2);
});

test("direct continuation validation failures release their runtime guard", async () => {
  const f = fixture();
  let attempts = 0;
  f.dependencies.subagentTranscript!.loadSubagentContinuation = async () => {
    if (attempts++ === 0) throw new SubagentContinuationError("subagent_task_unknown", "Not yet recorded.");
    return f.saved;
  };
  const args = { directive: "Continue.", taskId: "retry-child", subagentId: "ignored", timeoutMs: 5000 };
  await assert.rejects(f.api().fork(args), error => error instanceof SubagentContinuationError && error.code === "subagent_task_unknown");
  await f.api().fork(args);
  assert.equal(f.requests.length, 1);
});

test("ask-mode continuation retains the saved built-in identity and model", async () => {
  const f = fixture({ ask: true });
  const report = await f.api().fork({ directive: "Review more evidence.", taskId: "saved-reviewer", subagentId: "ignored", timeoutMs: 5000 });
  assert.equal(report.subagentId, "saved-reviewer");
  assert.equal(report.definitionId, "general-purpose");
  assert.equal(f.requests[0]?.metadata?.subagentType, "general-purpose");
  assert.equal(f.requests[0]?.provider, "saved");
  assert.equal(f.requests[0]?.model, "original");
  assert.match(JSON.stringify(f.requests[0]?.messages), /Saved prior evidence/);
});

test("an unavailable saved definition is rejected before any model call", async () => {
  const f = fixture();
  f.saved.definitionId = "missing-type";
  await assert.rejects(f.api().fork({ directive: "Continue.", taskId: "missing-child", subagentId: "ignored", timeoutMs: 5000 }),
    error => error instanceof SubagentContinuationError && error.code === "subagent_task_history_unsupported");
  assert.equal(f.requests.length, 0);
});

test("resuming a child in the same parent turn preserves distinct round identities through the gateway", async () => {
  const f = fixture();
  f.dependencies.getModelTokenLimits = () => ({ maxContextTokens: 32000, maxOutputTokens: 4000 });
  const api = f.api();
  await api.fork({ definitionId: "general-purpose", directive: "First round.", subagentId: "same-child", timeoutMs: 5000 });
  await api.fork({ directive: "Follow up in this same parent turn.", taskId: "same-child", subagentId: "ignored", timeoutMs: 5000 });

  const lifecycle = f.events.filter(event => event.type === "subagent_started" || event.type === "subagent_completed");
  assert.deepEqual(lifecycle.map(event => [event.type, event.subagentId, event.subagentTurnId]), [
    ["subagent_started", "same-child", "same-child-t0"],
    ["subagent_completed", "same-child", "same-child-t0"],
    ["subagent_started", "same-child", "same-child-t1"],
    ["subagent_completed", "same-child", "same-child-t1"],
  ]);
  assert.ok(lifecycle.every(event => event.sessionId === "runtime-parent" && event.turnId === "runtime-turn"));
  const gateway = lifecycle.flatMap(event => mapAgentEvent(event, "public-parent-run"));
  assert.equal(gateway.length, 4);
  assert.deepEqual(gateway.map(event => event.type === "agent_status"
    ? [event.event, event.detail?.subagentId, event.detail?.subagentTurnId] : event.type), [
    ["subagent_started", "same-child", "same-child-t0"],
    ["subagent_completed", "same-child", "same-child-t0"],
    ["subagent_started", "same-child", "same-child-t1"],
    ["subagent_completed", "same-child", "same-child-t1"],
  ]);
  assert.ok(gateway.every(event => event.runId === "public-parent-run"));
  const snapshots = f.events.filter(event => event.type === "agent_status" && event.event === "subagent_assistant_block");
  assert.deepEqual(snapshots.map(event => event.timeline?.turnId), ["same-child-t0", "same-child-t1"]);
  assert.ok(snapshots.every(event => mapAgentEvent(event, "public-parent-run")[0]?.timeline?.turnId === event.timeline?.turnId));
});

test("aborted continuation completion carries the resumed child round through the gateway", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.api().fork({ directive: "Continue.", taskId: "cancelled-resume", subagentId: "ignored",
    timeoutMs: 5000, abortSignal: controller.signal }), /aborted/);
  const lifecycle = f.events.filter(event => event.type === "subagent_started" || event.type === "subagent_completed");
  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every(event => event.subagentTurnId === "cancelled-resume-t1"));
  const completed = lifecycle.find(event => event.type === "subagent_completed")!;
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, true);
  const gateway = mapAgentEvent(completed, "public-parent-run")[0]!;
  assert.equal(gateway.type, "agent_status");
  if (gateway.type === "agent_status") {
    assert.equal(gateway.detail?.subagentTurnId, "cancelled-resume-t1");
    assert.equal(gateway.detail?.aborted, true);
  }
});
