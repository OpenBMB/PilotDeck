import assert from "node:assert/strict";
import test from "node:test";
import { SubAgentSession, type SubAgentSessionOptions } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { SubagentTaskMetadataValue } from "../../../src/session/transcript/TranscriptEntry.js";

function fixture() {
  const actualModels: string[] = [];
  const requests: CanonicalModelRequest[] = [];
  let saved: SubagentTaskMetadataValue | undefined;
  let decisions = 0;
  const router: AgentRouterRuntime = {
    async decide() {
      decisions++;
      return { provider: "test", model: "routed-child", scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} };
    },
    async *execute(decision, request) {
      actualModels.push(decision.model);
      requests.push(request);
      yield { type: "request_started", provider: decision.provider, model: decision.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "Scope: probe\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream() { throw new Error("unexpected stream shortcut"); },
  };
  const options: SubAgentSessionOptions = {
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Report completion.",
    parentConfig: {
      provider: "test", model: "default-child", cwd: "/tmp", permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd: "/tmp", mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
    },
    parentDependencies: {
      router, tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } },
      getModelTokenLimits: () => ({ maxContextTokens: 32000, maxOutputTokens: 4000 }),
    },
    parentSessionId: "parent", parentTurnId: "parent-turn", subagentSessionId: "child-session", subagentId: "child-id",
    sidechainTranscript: {
      recordAcceptedInput: async () => {}, recordDurableMessage: async () => {}, recordTurnResult: async () => {},
      recordSessionMetadata: async (_session, _turn, metadata) => { saved = metadata.subagentTask; },
    },
  };
  return { options, actualModels, requests, saved: () => saved, decisions: () => decisions };
}

test("fresh child records the model actually chosen by automatic routing", async () => {
  const f = fixture();
  await new SubAgentSession(f.options).run();
  assert.deepEqual(f.actualModels, ["routed-child"]);
  assert.equal(f.saved()?.model, "routed-child");
  assert.equal(f.decisions(), 1);
});

test("continuation bypasses automatic routing and resolves the saved model's current token limits", async () => {
  const f = fixture();
  await new SubAgentSession({
    ...f.options,
    priorMessages: [{ role: "user", content: [{ type: "text", text: "earlier input" }] }],
    turnIndex: 1,
    continuationModel: { provider: "test", model: "saved-child" },
    parentConfig: { ...f.options.parentConfig, subagentModel: { provider: "test", model: "new-default", maxOutputTokens: 1000 } },
  }).run();
  assert.deepEqual(f.actualModels, ["saved-child"]);
  assert.equal(f.decisions(), 0);
  assert.equal(f.requests[0]?.maxOutputTokens, 4000);
});

test("a removed saved model fails before any provider request", async () => {
  const f = fixture();
  f.options.parentDependencies.getModelTokenLimits = () => undefined;
  await assert.rejects(new SubAgentSession({
    ...f.options, continuationModel: { provider: "missing", model: "removed" },
  }).run(), (error: unknown) => (error as { code?: string }).code === "subagent_task_model_missing");
  assert.equal(f.decisions(), 0);
  assert.equal(f.requests.length, 0);
});
