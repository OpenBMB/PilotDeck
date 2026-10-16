import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import { createInitialAgentSessionState } from "../../src/agent/session/AgentSessionState.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { buildPostCompactMessages, truncateHeadPreservingCheckpoint } from "../../src/context/compaction/CompactionEngine.js";
import { readSubagentProjectSessionPersistence } from "../../src/session/storage/ProjectSessionStorage.js";
import { sopNodeSessionId, sopNodeSidechainId } from "../../src/sop/staffdeck/SopNodeSessions.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import type { AgentTranscriptWriter } from "../../src/session/transcript/TranscriptWriter.js";
import { SopAgentLoop } from "../../src/sop/staffdeck/SopAgentLoop.js";
import { StaffDeckSopClientError } from "../../src/sop/staffdeck/StaffDeckSopClient.js";
import { SopStateStore } from "../../src/sop/staffdeck/SopStateStore.js";
import { currentKnowledgeAuthority, type SopCapabilityAuthorityPort } from "../../src/composition/sopCapabilityAuthority.js";
import type { ModelInvokerPort, ToolPort } from "../../src/agent/modules/protocol.js";
import { createRouterModelInvokerPort } from "../../src/agent/modules/llm/routerModelInvokerAdapter.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import { createModelRuntime, parseModelConfig } from "../../src/model/index.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult } from "../../src/tool/index.js";
import { toolError } from "../../src/tool/index.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopOperationContext,
  StaffDeckSopPrepareResponse,
  StaffDeckSopRuntimeClient,
  StaffDeckSopRuntimeConfig,
} from "../../src/sop/staffdeck/types.js";

const BUNDLE: StaffDeckSopBundle = {
  sops: [{
    id: "onboarding",
    name: "Onboarding",
    content: {
      start_node_id: "lookup",
      nodes: [{
        node_id: "lookup",
        instruction: "Look up the account before replying.",
        allowed_actions: ["call_tool:lookup_account"],
      }],
    },
  }],
};

test("SOP loop admits a completed step only after a PilotDeck tool result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-loop-"));
  try {
    const profile: StaffDeckSopRuntimeConfig = {
      provider: "staffdeck",
      endpoint: "http://unused.test",
      definitionsPath: join(root, "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: root,
    };
    let submittedSuccessfulTools: readonly string[] | undefined;
    const preparedContexts: StaffDeckSopOperationContext[] = [];
    let submittedContext: StaffDeckSopOperationContext | undefined;
    const client: StaffDeckSopRuntimeClient = {
      async prepare({ state, context }) {
        if (context) preparedContexts.push(context);
        return {
          state: { ...state, status: "active" },
          step: {
            skillId: "onboarding",
            skillName: "Onboarding",
            version: "1",
            nodeId: "lookup",
            node: {},
            instruction: "Look up the account before replying.",
            expectedUserInfo: [],
            knownSlots: {},
            allowedNextStepIds: [],
            requiredToolNames: ["lookup_account"],
            allowedActions: ["call_tool:lookup_account"],
            isTerminal: true,
            declaresHandoff: false,
          },
        };
      },
      async submit({ state, successfulToolNames, context }) {
        submittedSuccessfulTools = successfulToolNames;
        submittedContext = context;
        assert.deepEqual(successfulToolNames, ["lookup_account"]);
        return {
          state: { ...state, status: "completed", successful_tool_names: [] },
          result: {
            status: "completed",
            replyFragment: "Account onboarding is complete.",
            slotUpdates: {},
            events: [{ type: "sop_completed" }],
          },
        };
      },
    };
    const model = scriptedModel();
    const lookup = lookupTool();
    const session = createAgentSession({
      sessionId: "sop-session",
      config: {
        provider: "test",
        model: "test-model",
        cwd: root,
        permissionMode: "default",
        permissionContext: createDefaultPermissionContext({ cwd: root, canPrompt: false }),
        staffDeckSop: profile,
      },
      dependencies: {
        router: {} as never,
        ports: { model, tools: toolPort(lookup) },
        tools: { registry: { list: () => [lookup] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle: BUNDLE,
        client,
        stateStore: new SopStateStore(join(root, "sessions")),
      }),
    });

    const events = [];
    for await (const event of session.submit({ type: "text", text: "Start onboarding" }, { turnId: "sop-turn" })) {
      events.push(event);
    }

    assert.deepEqual(submittedSuccessfulTools, ["lookup_account"]);
    assert.equal(preparedContexts[0]?.sessionId, "sop-session");
    assert.equal(preparedContexts[0]?.turnId, "sop-turn");
    assert.equal(preparedContexts[0]?.expectedRevision, 1);
    assert.ok((preparedContexts.at(-1)?.expectedRevision ?? 0) > 1);
    assert.equal(submittedContext?.requestId, `sop.submit:${submittedContext?.idempotencyKey}`);
    assert.ok((submittedContext?.expectedRevision ?? 0) > 1);
    const firstRequest = model.requests[0];
    assert.ok(firstRequest);
    assert.equal(firstRequest.toolChoice, "required");
    assert.ok(firstRequest.tools?.some((tool) => tool.name === "submit_step_result"));
    const finalTextIndex = events.findIndex((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Account onboarding is complete.");
    const completedIndex = events.findIndex((event) => event.type === "turn_completed");
    assert.ok(finalTextIndex >= 0);
    assert.ok(completedIndex > finalTextIndex);
    const completed = events.find((event): event is Extract<AgentEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.equal(completed?.result.finalMessage?.content[0]?.type, "text");
    assert.equal(completed?.result.finalMessage?.content[0]?.type === "text" && completed.result.finalMessage.content[0].text, "Account onboarding is complete.");
    const persisted = JSON.parse(readFileSync(
      join(root, "sessions", `${Buffer.from("sop-session", "utf8").toString("base64url")}.json`),
      "utf8",
    ));
    assert.equal(persisted.state.status, "completed");
    assert.deepEqual(persisted.state.successful_tool_names, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP nodes use a fresh model context by default and preserve only the current user prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-node-context-"));
  try {
    const observed: Array<{ sessionId: string; messages: import("../../src/model/index.js").CanonicalMessage[] }> = [];
    const context = {
      async prepareForModel(input: import("../../src/context/ContextRuntime.js").AgentContextPrepareInput) {
        observed.push({ sessionId: input.sessionId, messages: input.messages });
        return { messages: input.messages, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] };
      },
    } as import("../../src/context/ContextRuntime.js").AgentContextRuntime;
    let prepareCount = 0;
    const client: StaffDeckSopRuntimeClient = {
      async prepare({ state }) {
        const nodeId = state.active_step_id ?? "first";
        prepareCount += 1;
        return {
          state: { ...state, status: "active", active_step_id: nodeId },
          step: {
            skillId: "onboarding", skillName: "Onboarding", version: "1", nodeId, node: { type: "response" },
            instruction: `Run ${nodeId}.`, expectedUserInfo: [], knownSlots: {},
            allowedNextStepIds: nodeId === "first" ? ["second"] : [], requiredToolNames: [],
            allowedActions: ["answer_user"], isTerminal: nodeId === "second", declaresHandoff: false,
          },
        };
      },
      async submit({ state, proposal }) {
        const next = state.active_step_id === "first" ? "second" : undefined;
        return {
          state: { ...state, status: next ? "active" : "completed", ...(next ? { active_step_id: next } : {}) },
          result: { status: proposal.status, replyFragment: proposal.replyFragment, slotUpdates: {}, events: [] },
        };
      },
    };
    let modelCalls = 0;
    const model = modelFromStream(async function* (prepared) {
      modelCalls += 1;
      const request = (prepared as { request: { messages: import("../../src/model/index.js").CanonicalMessage[] } }).request;
      assert.deepEqual(request.messages.map((message) => message.role), ["user"]);
      yield* yieldToolCall(`submit-${modelCalls}`, "submit_step_result", {
        status: "completed", replyFragment: `done-${modelCalls}`, slotUpdates: {},
      });
    });
    const session = createSopSession({ root, sessionId: "node-context", model, client, context,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "old user history" }] },
        { role: "assistant", content: [{ type: "text", text: "old assistant history" },
          { type: "tool_call", id: "old-tool", name: "lookup_account", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "old-tool", content: [{ type: "text", text: "old tool history" }] }] },
      ],
      bundle: { sops: [{ id: "onboarding", content: { nodes: [
        { node_id: "first" },
        { node_id: "second" },
      ] } }] } });
    await collectSessionTurn(session, "current request", "node-context-turn");
    assert.equal(modelCalls, 2);
    assert.ok(prepareCount >= 2);
    const nodeSessions = observed.filter((entry) => entry.sessionId.includes(":sop-node:"));
    assert.ok(nodeSessions.some((entry) => entry.sessionId.endsWith(":first")));
    assert.ok(nodeSessions.some((entry) => entry.sessionId.endsWith(":second")));
    assert.ok(nodeSessions.every((entry) => entry.messages.length === 1));
    assert.ok(nodeSessions.every(entry => JSON.stringify(entry.messages).includes("current request")));
    assert.ok(nodeSessions.every(entry => !JSON.stringify(entry.messages).includes("old ")));
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const contextMode of ["new_session", "inherit"] as const) {
  test(`a local node model overrides the turn model for ${contextMode} execution`, async () => {
    const root = mkdtempSync(join(tmpdir(), `pilotdeck-sop-node-model-${contextMode}-`));
    try {
      const bundle: StaffDeckSopBundle = {
        sops: [{ id: "onboarding", version: "1", content: {
          nodes: [{ node_id: "lookup", model: "node-provider/node-model", contextMode }],
        } }],
      };
      const overrides: Array<{ provider: string; model: string } | undefined> = [];
      let calls = 0;
      const model = modelFromStream((prepared, context) => {
        assert.equal((prepared as { provider: string }).provider, "node-provider");
        assert.equal((prepared as { model: string }).model, "node-model");
        const request = (prepared as { request: import("../../src/model/index.js").CanonicalModelRequest }).request;
        assert.equal(request.speed, 0.7);
        assert.deepEqual(request.thinking, { enabled: false, mode: "off" });
        overrides.push(context.modelOverride);
        calls += 1;
        return calls === 1
          ? yieldToolCall("node-lookup", "lookup_account", { accountId: "ada" })
          : yieldToolCall("node-submit", "submit_step_result", {
              status: "completed", replyFragment: "Done", slotUpdates: {},
            });
      });
      const client: StaffDeckSopRuntimeClient = {
        async prepare({ state }) {
          return {
            state: { ...state, status: "active" },
            step: {
              skillId: "onboarding", skillName: "Onboarding", version: "1", nodeId: "lookup", node: {},
              instruction: "Look up the account.", expectedUserInfo: [], knownSlots: {}, allowedNextStepIds: [],
              requiredToolNames: ["lookup_account"], allowedActions: ["call_tool:lookup_account"],
              isTerminal: true, declaresHandoff: false,
              // The owner value is deliberately different; local YAML remains authoritative.
              model: "owner-provider/owner-model",
            } as StaffDeckSopPrepareResponse["step"],
          };
        },
        async submit({ state, proposal }) {
          return {
            state: { ...state, status: proposal.status },
            result: { status: proposal.status, replyFragment: proposal.replyFragment, slotUpdates: {}, events: [] },
          };
        },
      };
      const session = createSopSession({ root, sessionId: `node-model-${contextMode}`, model, client, bundle });
      const events: AgentEvent[] = [];
      for await (const event of session.submit({ type: "text", text: "Start" }, {
        turnId: "node-model-turn",
        modelOverride: { provider: "user-provider", model: "user-model", speed: 0.7, thinking: { enabled: false, mode: "off" } },
      })) events.push(event);
      assert.ok(events.some((event) => event.type === "turn_completed"));
      assert.equal(calls, 2);
      assert.deepEqual(overrides, [
        { provider: "node-provider", model: "node-model" },
        { provider: "node-provider", model: "node-model" },
      ]);
      await session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a node without a model keeps the caller model override", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-node-model-default-"));
  try {
    const overrides: Array<{ provider: string; model: string } | undefined> = [];
    const model = modelFromStream((_prepared, context) => {
      overrides.push(context.modelOverride);
      return yieldToolCall("default-submit", "submit_step_result", {
        status: "completed", replyFragment: "Done", slotUpdates: {},
      });
    });
    const session = createSopSession({ root, sessionId: "node-model-default", model, client: acceptingClient() });
    for await (const _event of session.submit({ type: "text", text: "Start" }, {
      turnId: "node-model-default-turn",
      modelOverride: { provider: "user-provider", model: "user-model" },
    })) { /* consume */ }
    assert.deepEqual(overrides, [{ provider: "user-provider", model: "user-model" }]);
    await session.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const contextMode of ["new_session", "inherit"] as const)
for (const rejection of ["invalid", "provider_not_found", "model_not_found", "MODEL_POLICY_DENIED", "SDK_MANAGED_MODEL_DENIED"] as const)
test(`node model admission rejects ${rejection} before persisting ${contextMode} preparation`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-model-admission-"));
  const nodeModel = rejection === "invalid" ? 42 : rejection === "provider_not_found" ? "missing/model"
    : rejection === "model_not_found" ? "test/missing" : "test/node-model";
  const bundle = { sops: [{ id: "onboarding", nodes: [{ node_id: "lookup", model: nodeModel, contextMode }] }] };
  const runtime = createModelRuntime(parseModelConfig({ providers: { test: {
    protocol: "openai", url: "http://unused.test", apiKey: "test-only", models: { "node-model": {} },
  } } }));
  const router = createRouterRuntime({ enabled: false }, {
    modelRuntime: runtime, isModelAllowed: () => rejection !== "MODEL_POLICY_DENIED",
  });
  let invocations = 0;
  const port = createRouterModelInvokerPort(router, {
    managedModelPolicy: rejection === "SDK_MANAGED_MODEL_DENIED" ? { allow: [], deny: ["test/*"] } : undefined,
  });
  const model = { ...port, prepare: async (input: Parameters<typeof port.prepare>[0]) => {
    invocations++;
    return port.prepare(input);
  } };
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("model-admission", bundle, "onboarding");
    const before = await store.status("model-admission");
    const session = createSopSession({ root, sessionId: "model-admission", model, client: acceptingClient(), bundle });
    const events = await collectSessionTurn(session, "Start", "admission-turn");
    assert.ok(events.some(e => e.type === "turn_failed"));
    assert.ok(JSON.stringify(events).includes(rejection === "invalid" ? "provider/model" : rejection));
    assert.equal(invocations, 0);
    assert.deepEqual(await store.status("model-admission"), before, "revision, state, wait and delivery must remain unchanged");
    await session.dispose();
  } finally {
    await router.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const contextMode of ["new_session", "inherit"] as const)
test(`an unconfigured next node restores the caller model for ${contextMode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-model-switch-"));
  try {
    const bundle = { sops: [{ id: "onboarding", nodes: [
      { node_id: "first", model: "node-provider/node-model", contextMode }, { node_id: "lookup", contextMode },
    ] }] };
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const p = await base.prepare(input);
        const nodeId = input.state.active_step_id ?? "first";
        return { ...p, state: { ...p.state, active_step_id: nodeId }, step: { ...p.step, nodeId,
          requiredToolNames: [], allowedActions: ["answer_user"],
          isTerminal: nodeId === "lookup", allowedNextStepIds: nodeId === "first" ? ["lookup"] : [] } };
      },
      async submit(input) {
        const p = await base.submit(input);
        return input.state.active_step_id === "first"
          ? { ...p, state: { ...p.state, status: "active", active_step_id: "lookup" },
            result: { ...p.result, nextStepId: "lookup" } } : p;
      },
    };
    const requests: Array<{ provider: string; model: string }> = [];
    const model = modelFromStream(async function* (prepared) {
      requests.push(prepared as { provider: string; model: string });
      yield* yieldToolCall(`submit-${requests.length}`, "submit_step_result", { status: "completed", replyFragment: "Done",
        slotUpdates: {}, ...(requests.length === 1 ? { nextStepId: "lookup" } : {}) });
    });
    const session = createSopSession({ root, sessionId: "model-switch", client, model, bundle });
    for await (const _ of session.submit({ type: "text", text: "Start" }, { turnId: "switch-turn",
      modelOverride: { provider: "user-provider", model: "user-model" } })) { /* consume */ }
    assert.deepEqual(requests.map(({ provider, model }) => ({ provider, model })), [
      { provider: "node-provider", model: "node-model" }, { provider: "user-provider", model: "user-model" },
    ]);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("model-switch"))?.state.status, "completed");
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const contextMode of ["inherit", "new_session"] as const)
test(`a node-level inherit mode keeps full messages with module default ${contextMode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-node-inherit-"));
  try {
    const observed: Array<{ sessionId: string; messages: import("../../src/model/index.js").CanonicalMessage[] }> = [];
    const context = {
      async prepareForModel(input: import("../../src/context/ContextRuntime.js").AgentContextPrepareInput) {
        observed.push({ sessionId: input.sessionId, messages: input.messages });
        return { messages: input.messages, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] };
      },
    } as import("../../src/context/ContextRuntime.js").AgentContextRuntime;
    let modelCalls = 0;
    const client: StaffDeckSopRuntimeClient = {
      async prepare({ state }) {
        const nodeId = state.active_step_id ?? "first";
        return {
          state: { ...state, status: "active", active_step_id: nodeId },
          step: {
            skillId: "onboarding", skillName: "Onboarding", version: "1", nodeId, node: { type: "response" },
            instruction: `Run ${nodeId}.`, expectedUserInfo: [], knownSlots: {},
            allowedNextStepIds: nodeId === "first" ? ["second"] : [], requiredToolNames: [],
            allowedActions: ["answer_user"], isTerminal: nodeId === "second", declaresHandoff: false,
          },
        };
      },
      async submit({ state, proposal }) {
        const next = state.active_step_id === "first" ? "second" : undefined;
        return { state: { ...state, status: next ? "active" : "completed", ...(next ? { active_step_id: next } : {}) },
          result: { status: proposal.status, replyFragment: proposal.replyFragment, slotUpdates: {}, events: [] } };
      },
    };
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      yield* yieldToolCall(`submit-${modelCalls}`, "submit_step_result", {
        status: "completed", replyFragment: `done-${modelCalls}`, slotUpdates: {},
      });
    });
    const session = createSopSession({ root, sessionId: "node-inherit", model, client, context,
      contextMode,
      bundle: { sops: [{ id: "onboarding", content: { nodes: [
        { node_id: "first", contextMode: "new_session" },
        { node_id: "second", contextMode: "inherit" },
      ] } }] } });
    await collectSessionTurn(session, "current request", "node-inherit-turn");
    assert.equal(modelCalls, 2);
    assert.ok(observed.some((entry) => entry.sessionId.endsWith(":first")));
    assert.ok(observed.some((entry) => entry.sessionId === "node-inherit"));
    const inherited = observed.find(entry => entry.sessionId === "node-inherit")!;
    assert.ok(JSON.stringify(inherited.messages).includes("submit-1"));
    assert.ok(inherited.messages.some(message => message.content.some(block => block.type === "tool_result")));
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Context scopes cache, memory and durable compaction to nodes while model accounting stays on the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-context-effects-"));
  try {
    const plans: string[] = [];
    const resets: string[] = [];
    const captured: { sessionId: string; messages: unknown }[] = [];
    const compacted = new Set<string>();
    const context = new DefaultContextRuntime({
      projectRoot: root,
      promptCacheCoordinator: { createPlan: id => { plans.push(id); return undefined; },
        reset: id => { resets.push(id); }, release: () => {} },
      memoryResolver: { retrieve: async () => ({ diagnostics: [] }),
        captureTurn: async input => { captured.push(input); } },
      compaction: { buildPostCompactMessages, truncateHeadPreservingCheckpoint, async autoCompact(input) {
        const snapshot = { tokens: 10, maxContextTokens: 65536, warningRatio: 0.8,
          blockingRatio: 0.95, state: "ok" as const, ratio: 0.01 };
        if (input.messages.length < 2 || compacted.has(input.sessionId!)) return { type: "skipped", snapshot };
        compacted.add(input.sessionId!);
        const summary = { role: "user" as const, content: [{ type: "text" as const, text: `summary:${input.sessionId}` }] };
        return { type: "compacted", tier: "full", snapshot, messages: [summary], result: {
          compactionId: `compact:${input.sessionId}`, trigger: "auto", preTokens: 100, postTokens: 10,
          messagesSummarized: input.messages.length, summaryMessage: summary, boundaryMarker: summary,
          messagesToKeep: [], attachments: [], hookResults: [], diagnostics: [],
        } };
      } },
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const prepared = await base.prepare(input);
        const nodeId = input.state.active_step_id ?? "A";
        return { ...prepared, state: { ...prepared.state, active_step_id: nodeId },
          step: { ...prepared.step, nodeId, requiredToolNames: ["lookup_account"],
            allowedNextStepIds: nodeId === "A" ? ["B"] : [], isTerminal: nodeId === "B" } };
      },
      async submit(input) {
        return { state: { ...input.state, active_step_id: "B", status: input.state.active_step_id === "A" ? "active" : "completed",
          successful_tool_names: [] }, result: { ...input.proposal, slotUpdates: {}, events: [] } };
      },
    };
    let calls = 0;
    const executions: string[] = [];
    const model = modelFromStream(async function* (prepared, execution) {
      executions.push(execution.sessionId);
      const call = calls++;
      if (call >= 2) assert.ok(!JSON.stringify(prepared).includes("summary:effects:sop-node:onboarding:A"));
      yield* yieldToolCall(`effects-${call}`, call % 2 === 0 ? "lookup_account" : "submit_step_result",
        call % 2 === 0 ? {} : { status: "completed", replyFragment: "Done" });
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const session = createSopSession({ root, sessionId: "effects", client, context, model });
    const events = await collectSessionTurn(session, "Start", "effects-turn");
    assert.equal(calls, 4);
    const expected = ["A", "B"].map(node => sopNodeSessionId("effects", "onboarding", node));
    assert.deepEqual([...new Set(plans)].sort(), expected);
    assert.deepEqual(resets, expected);
    assert.deepEqual(captured.map(input => input.sessionId), expected);
    assert.ok(!JSON.stringify(captured[1]).includes("summary:effects:sop-node:onboarding:A"));
    assert.ok(executions.every(id => id === "effects"));
    const completed = events.find(event => event.type === "turn_completed");
    assert.equal(completed?.result.usage.inputTokens, 40);
    for (const nodeId of ["A", "B"]) {
      const persisted = await readSubagentProjectSessionPersistence({ projectRoot: root, pilotHome: root,
        parentSessionId: "effects", sessionId: sopNodeSessionId("effects", "onboarding", nodeId),
        sidechainId: sopNodeSidechainId("onboarding", nodeId) });
      assert.ok(persisted.entries.some(entry => entry.type === "control_boundary" && entry.boundary.kind === "compact"),
        "compaction must persist in the child");
    }
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an inherited node receives the previous real node's compacted context", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-inherit-compacted-"));
  try {
    let compacted = false;
    const context = new DefaultContextRuntime({ compaction: {
      buildPostCompactMessages, truncateHeadPreservingCheckpoint,
      async autoCompact(input) {
        const snapshot = { tokens: 10, maxContextTokens: 65536, warningRatio: 0.8,
          blockingRatio: 0.95, state: "ok" as const, ratio: 0.01 };
        if (compacted || input.messages.length < 2) return { type: "skipped", snapshot };
        compacted = true;
        const summary = { role: "user" as const, content: [{ type: "text" as const, text: "A checkpoint evidence" }] };
        return { type: "compacted", tier: "full", snapshot, messages: [summary], result: {
          compactionId: "inherit-checkpoint", trigger: "auto", preTokens: 100, postTokens: 10,
          messagesSummarized: input.messages.length, summaryMessage: summary, boundaryMarker: summary,
          messagesToKeep: [], attachments: [], hookResults: [], diagnostics: [],
        } };
      },
    } });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const prepared = await base.prepare(input);
        const nodeId = input.state.active_step_id ?? "A";
        return { ...prepared, state: { ...prepared.state, active_step_id: nodeId }, step: {
          ...prepared.step, nodeId, contextMode: nodeId === "A" ? "new_session" : "inherit",
          requiredToolNames: nodeId === "A" ? ["lookup_account"] : [],
          allowedNextStepIds: nodeId === "A" ? ["B"] : [], isTerminal: nodeId === "B",
        } };
      },
      async submit(input) { return { state: { ...input.state, active_step_id: "B",
        status: input.state.active_step_id === "A" ? "active" : "completed", successful_tool_names: [] },
        result: { ...input.proposal, slotUpdates: {}, events: [] } }; },
    };
    let calls = 0;
    const model = modelFromStream(async function* (prepared) {
      const call = calls++;
      if (call === 2) {
        const messages = (prepared as { request: { messages: unknown } }).request.messages;
        assert.ok(JSON.stringify(messages).includes("A checkpoint evidence"));
        assert.ok(!JSON.stringify(messages).includes("prior parent history"));
      }
      yield* yieldToolCall(`checkpoint-${call}`, call === 0 ? "lookup_account" : "submit_step_result",
        call === 0 ? {} : { status: "completed", replyFragment: "Done" });
    });
    const session = createSopSession({ root, sessionId: "inherit-checkpoint", model, context, client,
      initialMessages: [{ role: "user", content: [{ type: "text", text: "prior parent history" }] }] });
    const events = await collectSessionTurn(session, "Start", "checkpoint-turn");
    assert.equal(calls, 3);
    assert.equal(events.find(event => event.type === "turn_completed")?.result.type, "success");
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const status of ["completed", "handoff", "awaiting_user", "blocked"] as const)
test(`real node session keeps ${status} events and SOP state on the parent`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-ending-session-"));
  try {
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, step: { ...prepared.step, requiredToolNames: [],
        expectedUserInfo: status === "awaiting_user" ? ["name"] : [],
        declaresHandoff: status === "handoff", node: { type: status === "handoff" ? "handoff" : "collect_info" } } };
    } };
    const model = modelFromStream(async function* () {
      yield* yieldToolCall(`ending-${status}`, "submit_step_result", { status, replyFragment: `Final ${status}`, slotUpdates: {} });
    });
    const parent = `ending-${status}`;
    const session = createSopSession({ root, sessionId: parent, client, model });
    const events = await collectSessionTurn(session, "name: Ada", `turn-${status}`);
    assert.equal((await new SopStateStore(join(root, "sessions")).status(parent))?.state.status, status);
    const child = await readRealNode(root, parent, "lookup");
    assert.equal(replayTranscriptEntries(child).metadata.parentSessionId, parent);
    assert.ok(events.every(event => event.sessionId === parent));
    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    assert.equal(events.filter(event => event.type === "assistant_message"
      && event.message.content.some(block => block.type === "text" && block.text === `Final ${status}`)).length, 1);
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a model retry reuses the same real node session and durable turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-model-retry-"));
  try {
    let calls = 0;
    const model = modelFromStream(async function* (prepared, context) {
      assert.deepEqual(context.modelOverride, { provider: "test", model: "retry-model" });
      assert.equal((prepared as { model: string }).model, "retry-model");
      if (calls++ === 0) {
        yield { type: "error", error: { provider: "test", protocol: "openai", code: "timeout", message: "Temporary timeout", retryable: true } };
        return;
      }
      yield* yieldToolCall("retry-submit", "submit_step_result", { status: "completed", replyFragment: "Retry completed" });
    });
    const base = acceptingClient();
    const client = { ...base, async prepare(input: Parameters<typeof base.prepare>[0]) {
      const prepared = await base.prepare(input);
      return { ...prepared, step: { ...prepared.step, requiredToolNames: [] } };
    } };
    const context = new DefaultContextRuntime();
    context.recoverFromModelError = async () => ({ type: "adjust_output_and_retry", maxOutputTokens: 1024, reason: "test retry" });
    const session = createSopSession({ root, sessionId: "model-retry", client, model, context,
      bundle: { sops: [{ id: "onboarding", nodes: [{ node_id: "lookup", model: "test/retry-model" }] }] } });
    const events = await collectSessionTurn(session, "Start", "retry-turn");
    assert.equal(calls, 2);
    assert.ok(events.some(event => event.type === "turn_continued"));
    const child = await readRealNode(root, "model-retry", "lookup");
    assert.equal(child.filter(entry => entry.type === "turn_started").length, 1);
    assert.equal(child.filter(entry => entry.type === "session_metadata").length, 1);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("model-retry"))?.state.status, "completed");
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an invalid owner contextMode is rejected before replacing SOP state or creating a child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-invalid-owner-mode-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const before = await store.loadOrCreate("invalid-owner", BUNDLE, "onboarding");
    const base = acceptingClient();
    const client = { ...base, async prepare(input: Parameters<typeof base.prepare>[0]) {
      const prepared = await base.prepare(input);
      return { ...prepared, step: { ...prepared.step, contextMode: "invalid" as "new_session" } };
    } };
    const session = createSopSession({ root, sessionId: "invalid-owner", client,
      model: modelFromStream(async function* () { throw new Error("model must not run"); }) });
    const events = await collectSessionTurn(session, "Start", "invalid-turn");
    assert.ok(JSON.stringify(events).includes("step.contextMode must be new_session or inherit"));
    assert.deepEqual((await store.status("invalid-owner"))?.state, before.state);
    assert.equal((await store.status("invalid-owner"))?.revision, before.revision);
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const limit of ["maxBudgetUsd", "taskBudgetUsd", "maxTurns"] as const)
test(`node switches preserve the parent ${limit} and aggregate usage`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-shared-budget-"));
  try {
    const base = acceptingClient();
    const submitted: string[] = [];
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const prepared = await base.prepare(input);
        const nodeId = input.state.active_step_id ?? "A";
        return { ...prepared, state: { ...prepared.state, active_step_id: nodeId },
          step: { ...prepared.step, nodeId, requiredToolNames: [], allowedNextStepIds: nodeId === "A" ? ["B"] : [], isTerminal: nodeId === "B" } };
      },
      async submit(input) {
        submitted.push(input.state.active_step_id!);
        return { state: { ...input.state, active_step_id: "B", status: input.state.active_step_id === "A" ? "active" : "completed" },
          result: { ...input.proposal, events: [], slotUpdates: {} } };
      },
    };
    let calls = 0;
    const model = modelFromStream(async function* () {
      yield* yieldToolCall(`budget-${calls++}`, "submit_step_result", { status: "completed", replyFragment: "Done" });
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, nativeCost: 0.1 } };
    });
    const session = createSopSession({ root, sessionId: "shared-budget", client, model });
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Start" },
      { turnId: "budget-turn", [limit]: limit === "maxTurns" ? 1 : 0.15, initialTaskBudgetSpentUsd: 0.03 })) events.push(event);
    assert.equal(calls, limit === "maxTurns" ? 1 : 2);
    assert.deepEqual(submitted, ["A"], "B cannot reset the parent budget and submit another result");
    const result = events.find(event => event.type === "turn_completed")?.result;
    assert.equal(result?.sessionId, "shared-budget");
    assert.equal(result?.stopReason, limit === "maxTurns" ? "max_turns" : limit === "maxBudgetUsd" ? "max_budget" : "task_budget");
    assert.equal(result?.usage.inputTokens, limit === "maxTurns" ? 10 : 20);
    assert.equal(result?.budget?.turnSpentUsd, limit === "maxTurns" ? undefined : 0.2);
    if (limit === "taskBudgetUsd") assert.ok(Math.abs(result!.budget!.taskSpentUsd! - 0.23) < 1e-9);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("shared-budget"))?.state.status, "active");
    await session.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one SOP turn continues completed nodes through required evidence to the declared handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-single-turn-"));
  try {
    const submitted: string[] = [];
    let modelCalls = 0;
    const model = modelFromStream(async function* (prepared) {
      const call = modelCalls++;
      const request = (prepared as { request: { toolChoice: unknown; systemPrompt: string } }).request;
      assert.deepEqual(request.toolChoice, [0, 1, 4, 5].includes(call)
        ? { type: "tool", name: "submit_step_result" } : "required");
      assert.equal(request.systemPrompt.includes("SOP_STEP_RESULT_REQUIRED"), [1, 5].includes(call));
      if (call === 0 || call === 4) { yield* yieldText("Approval will be requested."); return; }
      if (call === 2) { yield* yieldToolCall("evidence", "lookup_account", { accountId: "ada" }); return; }
      yield* yieldToolCall(`step-${call}`, "submit_step_result", {
        status: call === 5 ? "handoff" : "completed", replyFragment: `Step ${call} result`,
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      async prepare(input) {
        const prepared = await base.prepare(input);
        const node = input.state.active_step_id ?? "collect";
        return { ...prepared, state: { ...prepared.state, active_step_id: node },
          step: { ...prepared.step, nodeId: node, node: { type: node === "approval" ? "handoff" : node === "collect" ? "collect" : "response" },
            requiredToolNames: node === "evidence" ? ["lookup_account"] : [],
            allowedNextStepIds: node === "approval" ? [] : [node === "collect" ? "evidence" : "approval"],
            declaresHandoff: node === "approval", isTerminal: false } };
      },
      async submit(input) {
        const node = input.state.active_step_id!;
        submitted.push(node);
        if (node === "evidence") assert.deepEqual(input.successfulToolNames, ["lookup_account"]);
        const next = node === "collect" ? "evidence" : node === "evidence" ? "approval" : undefined;
        return { state: { ...input.state, status: next ? "active" : "handoff",
          active_step_id: next ?? node, successful_tool_names: [] },
          result: { status: input.proposal.status, replyFragment: input.proposal.replyFragment,
            slotUpdates: {}, nextStepId: next, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "single-turn", model, client, context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Plan the project with all fields supplied", "single-turn-request");
    assert.deepEqual(submitted, ["collect", "evidence", "approval"]);
    assert.equal(modelCalls, 6);
    const evidenceReceipt = events.find((event) => event.type === "tool_result"
      && event.result.type === "success" && event.result.toolCallId === "step-3");
    assert.ok(evidenceReceipt && evidenceReceipt.type === "tool_result" && evidenceReceipt.result.type === "success");
    assert.deepEqual(evidenceReceipt.result.content[0], { type: "json", value: {
      submittedStepId: "evidence", status: "completed", resultStatus: "completed", activeStepId: "approval",
      sopStatus: "active", nextStepId: "approval", nextStepRequiresOwnSubmission: true,
    } });
    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    const store = new SopStateStore(join(root, "sessions"));
    assert.equal((await store.status("single-turn"))?.wait?.kind, "handoff");
    assert.equal(await store.replyDelivery("single-turn"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("text-only SOP responses get one protocol correction then fail without advancing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-bounded-correction-"));
  try {
    let calls = 0;
    const model = modelFromStream(async function* () { calls++; yield* yieldText("Please confirm."); });
    const session = createSopSession({ root, sessionId: "text-only", model, client: acceptingClient() });
    const events = await collectSessionTurn(session, "Start", "text-only-turn");
    assert.equal(calls, 2);
    const child = await readRealNode(root, "text-only", "lookup");
    assert.equal(child.filter(entry => entry.type === "turn_started").length, 1,
      "protocol correction must stay within one real node turn");
    assert.equal(child.filter(entry => entry.type === "session_metadata").length, 1);
    assert.ok(events.some(event => event.type === "turn_failed"));
    assert.equal(events.filter(event => event.type === "turn_completed" && event.result.type === "success").length, 0);
    const status = await new SopStateStore(join(root, "sessions")).status("text-only");
    assert.equal(status?.state.status, "active");
    assert.equal(status?.wait, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("final SOP node offers only its submission and corrects a text draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-final-submit-"));
  try {
    let calls = 0;
    const requests: { tools?: { name: string }[]; toolChoice: unknown; systemPrompt: string }[] = [];
    const model = modelFromStream(async function* (prepared, context) {
      assert.deepEqual(context.modelOverride, { provider: "test", model: "correction-model" });
      const request = (prepared as { request: { tools?: { name: string }[]; toolChoice: unknown; systemPrompt: string } }).request;
      requests.push(request);
      if (calls++ === 0) {
        yield* yieldText("Final checklist draft.");
        return;
      }
      yield* yieldToolCall("final-submit", "submit_step_result", {
        status: "completed", replyFragment: "Final checklist.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [], isTerminal: true } };
      },
    };
    const session = createSopSession({ root, sessionId: "final-submit", model, client, context: new DefaultContextRuntime(),
      bundle: { sops: [{ id: "onboarding", nodes: [{ node_id: "lookup", model: "test/correction-model" }] }] } });
    await collectSessionTurn(session, "The owner approved the plan. Produce the final checklist.", "final-turn");
    assert.equal(calls, 2);
    assert.deepEqual(requests.map((request) => request.tools?.map((tool) => tool.name)), [
      ["submit_step_result"], ["submit_step_result"],
    ]);
    assert.deepEqual(requests[0]?.toolChoice, { type: "tool", name: "submit_step_result" });
    assert.match(requests[0]?.systemPrompt ?? "", /This is the active final SOP node/);
    assert.match(requests[1]?.systemPrompt ?? "", /previous assistant text was only a draft/);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("final-submit"))?.state.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejected submission followed by prose still receives bounded protocol correction", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-rejected-correction-"));
  try {
    let calls = 0, submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      if (calls === 2) { yield* yieldText("Approval request created."); return; }
      yield* yieldToolCall(`submit-${calls}`, "submit_step_result", {
        status: calls === 1 ? "completed" : "handoff", replyFragment: "Please approve.", slotUpdates: {},
      });
    });
    const base = acceptingClient(undefined, true);
    const client: StaffDeckSopRuntimeClient = { ...base, async submit(input) {
      if (++submissions === 1) throw new StaffDeckSopClientError("HANDOFF_REQUIRED", "Human approval must be resumed before completing this node");
      return base.submit(input);
    } };
    const session = createSopSession({ root, sessionId: "rejected-correction", model, client, context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Start approval", "correction-turn");
    assert.equal(calls, 3);
    assert.equal(submissions, 2);
    assert.ok(!events.some(event => event.type === "turn_failed"), JSON.stringify(events));
    assert.equal((await new SopStateStore(join(root, "sessions" )).status("rejected-correction"))?.state.status, "handoff");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const waiting of ["handoff", "awaiting_user"] as const) {
  test(`terminal ${waiting} node corrects prose without forcing completion`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-wait-"));
    try {
      let calls = 0;
      const model = modelFromStream(async function* (prepared) {
        const request = (prepared as { request: { systemPrompt: string; toolChoice: unknown } }).request;
        assert.deepEqual(request.toolChoice, { type: "tool", name: "submit_step_result" });
        assert.match(request.systemPrompt, /Being final does not remove/);
        if (waiting === "handoff") assert.match(request.systemPrompt, /do not substitute failed merely because the human rejected/);
        assert.doesNotMatch(request.systemPrompt, /Call submit_step_result now with status completed/);
        if (calls++ === 0) { yield* yieldText("Please reply."); return; }
        assert.match(request.systemPrompt, /Follow the current node contract/);
        yield* yieldToolCall("wait", "submit_step_result", {
          status: waiting, replyFragment: "Please reply.", slotUpdates: waiting === "handoff" ? {} : { goal: "Validate SOP" },
        });
      });
      const base = acceptingClient();
      const client: StaffDeckSopRuntimeClient = {
        ...base,
        async prepare(input) {
          const prepared = await base.prepare(input);
          return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
            node: { type: waiting === "handoff" ? "handoff" : "collect_info" },
            expectedUserInfo: waiting === "handoff" ? [] : ["goal", "stage"], declaresHandoff: waiting === "handoff",
            requiredToolNames: [], allowedNextStepIds: [], allowedActions: ["answer_user"], isTerminal: true } };
        },
        async submit(input) {
          assert.equal(input.proposal.status, waiting);
          return { state: { ...input.state, status: waiting, slots_json: input.proposal.slotUpdates }, result: {
            status: waiting, replyFragment: input.proposal.replyFragment, slotUpdates: input.proposal.slotUpdates ?? {}, events: [],
          } };
        },
      };
      const session = createSopSession({ root, sessionId: "terminal-wait", model, client, context: new DefaultContextRuntime() });
      const events = await collectSessionTurn(session, "Goal: Validate SOP", "terminal-wait-turn");
      assert.ok(!events.some(event => event.type === "turn_failed"), JSON.stringify(events));
      assert.equal(calls, 2);
      assert.equal((await new SopStateStore(join(root, "sessions")).status("terminal-wait"))?.state.status, waiting);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("recovery of a committed intermediate node continues instead of ending the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-active-recovery-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const persisted = await store.loadOrCreate("active-recovery", BUNDLE, "onboarding");
    await store.commitSubmission("active-recovery", BUNDLE, { ...persisted.state, status: "active", active_step_id: "lookup" },
      persisted.revision, "interrupted-turn", { status: "completed", nextStepId: "lookup",
        replyFragment: "Previous node persisted", slotUpdates: {}, events: [] });
    const model = scriptedModel();
    const session = createSopSession({ root, sessionId: "active-recovery", model, client: acceptingClient(), context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Recover the interrupted request", "recovery-turn");
    assert.equal(model.requests.length, 2);
    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    assert.equal((await store.status("active-recovery"))?.state.status, "completed");
    assert.equal(await store.replyDelivery("active-recovery"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP loop tells the model declared approval handoffs are resumable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-handoff-prompt-"));
  try {
    const model = scriptedModel();
    const session = createSopSession({
      root,
      sessionId: "handoff-prompt",
      model,
      client: acceptingClient(undefined, true),
      context: new DefaultContextRuntime(),
    });

    for await (const _event of session.submit({ type: "text", text: "Request approval" })) {
      // Consume the turn so the model request is assembled.
    }

    assert.match(
      JSON.stringify(model.requests),
      /This step declares a human handoff\. When approval is required, use status handoff to create the resumable approval wait; do not use awaiting_user\./,
    );
    assert.match(JSON.stringify(model.requests), /condition=approval_required, priority=10, label=Needs approval; target=Confirm approval; handoff; Ask the owner to confirm\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval node rejects awaiting_user and requires a real handoff submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-approval-boundary-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`approval-${calls}`, "submit_step_result", {
        status: calls === 1 ? "awaiting_user" : "handoff",
        replyFragment: "Please confirm the plan.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "handoff" }, requiredToolNames: [], allowedNextStepIds: ["finalize"],
          declaresHandoff: true, isTerminal: false } };
      },
      async submit(input) {
        submissions++;
        assert.equal(input.proposal.status, "handoff");
        return { state: { ...input.state, status: "handoff" }, result: {
          status: "handoff", replyFragment: input.proposal.replyFragment,
          slotUpdates: {}, events: [],
        } };
      },
    };
    const session = createSopSession({ root, sessionId: "approval-boundary", model, client });
    const events = await collectSessionTurn(session, "Please request owner approval.", "approval-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("HANDOFF_REQUIRED")));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("approval-boundary"))?.wait?.kind, "handoff");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects an undeclared nextStepId locally without calling the SOP owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-invalid-transition-"));
  try {
    let submitCalls = 0;
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async submit(input) {
        submitCalls += 1;
        return base.submit(input);
      },
      async prepare(input) {
        const prepared = await base.prepare(input);
        return {
          ...prepared,
          state: { ...prepared.state, active_step_id: "confirm_scope", status: "active" },
          step: {
            ...prepared.step,
            nodeId: "confirm_scope",
            node: { type: "handoff" },
            allowedNextStepIds: ["finalize_plan"],
            allowedActions: ["handoff_human"],
            declaresHandoff: true,
            isTerminal: false,
          },
        };
      },
    };
    const model = modelFromStream(async function* () {
      yield* yieldToolCall("invalid-transition", "submit_step_result", {
        status: "completed",
        replyFragment: "Placeholder plan",
        slotUpdates: {},
        nextStepId: "execute",
      });
    });
    const session = createSopSession({ root, sessionId: "invalid-transition", model, client });
    const events = await collectSessionTurn(session, "负责人已确认变更，请继续", "invalid-transition-turn");
    const rejection = events.find((event) => event.type === "tool_result"
      && event.result.type === "error"
      && event.result.error.code === "invalid_tool_input");
    assert.ok(rejection && rejection.type === "tool_result" && rejection.result.type === "error");
    assert.match(rejection.result.error.message, /SOP_INVALID_TRANSITION/);
    assert.match(rejection.result.error.message, /finalize_plan/);
    assert.equal(submitCalls, 0);
    const persisted = await new SopStateStore(join(root, "sessions")).status("invalid-transition");
    assert.equal(persisted?.state.active_step_id, "confirm_scope");
    assert.equal(persisted?.state.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evidence step without missing fields routes approval to its declared next node", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-evidence-prompt-"));
  try {
    const model = scriptedModel();
    const client = acceptingClient();
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "evidence-prompt", model,
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, step: { ...prepared.step, allowedNextStepIds: ["confirm"], isTerminal: false } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Assess the change before requesting approval." })) {}
    const request = JSON.stringify(model.requests);
    assert.match(request, /This step has no missing user fields/);
    assert.match(request, /Approval belongs to the declared handoff step/);
    assert.match(request, /Allowed next steps: confirm/);
    assert.match(request, /persist it with awaiting_user and no nextStepId/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "complete collect", type: "collect_info", fields: ["stage"], slots: { stage: "validation" }, actions: ["extract_slots"], reject: true },
  { name: "no-input decision", type: "decision", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "evidence approval", type: "knowledge_query", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "undeclared handoff", type: "knowledge_query", fields: [], slots: {}, actions: ["continue_flow"], reject: true },
  { name: "legal missing field", type: "collect_info", fields: ["stage"], slots: {}, actions: ["extract_slots"], reject: false },
  { name: "explicit question", type: "response", fields: [], slots: {}, actions: ["ask_user"], reject: false },
]) test(`SOP awaiting boundary: ${scenario.name}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-wait-boundary-"));
  try {
    let calls = 0, submissions = 0;
    const model = modelFromStream(async function* () {
      const index = calls++;
      if (scenario.type === "knowledge_query" && index === 1) {
        yield* yieldToolCall("knowledge-evidence", "knowledge_query", { query: "Project planning" }); return;
      }
      const status = index === 0 ? (scenario.name === "undeclared handoff" ? "handoff" : "awaiting_user")
        : scenario.name === "legal missing field" ? "awaiting_user" : "completed";
      yield* yieldToolCall(`boundary-${calls}`, "submit_step_result", { status, replyFragment: "Step result", slotUpdates: scenario.slots });
    });
    const client = acceptingClient(() => { submissions++; });
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "wait-boundary", model,
      tools: { ...toolPort(lookupTool()), list: () => [lookupTool(), { ...lookupTool(), name: "knowledge_query" }] },
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" },
          step: { ...prepared.step, node: { type: scenario.type }, expectedUserInfo: scenario.fields,
            allowedNextStepIds: ["confirm"], allowedActions: scenario.actions } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Plan this project." })) {}
    assert.equal(submissions, 1);
    assert.equal(calls, scenario.type === "knowledge_query" ? 3 : scenario.reject || scenario.name === "legal missing field" ? 2 : 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing fields require a persisted waiting result rather than a text-only question", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-missing-prompt-"));
  try {
    const model = scriptedModel();
    const client = acceptingClient();
    const prepare = client.prepare.bind(client);
    const session = createSopSession({ root, sessionId: "missing-prompt", model,
      client: { ...client, async prepare(input) {
        const prepared = await prepare(input);
        return { ...prepared, step: { ...prepared.step, expectedUserInfo: ["current_stage"] } };
      } }, context: new DefaultContextRuntime() });
    for await (const _event of session.submit({ type: "text", text: "Help plan my project." })) {}
    assert.match(JSON.stringify(model.requests), /your question MUST be the replyFragment of a submit_step_result call with status awaiting_user/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty first collect proposal gets one correction before a legal missing-field wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-collect-correction-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-${calls}`, "submit_step_result", {
        status: "awaiting_user",
        replyFragment: calls === 1 ? "What is the goal?" : "What is the stage?",
        slotUpdates: calls === 1 ? {} : { project_goal: "Complete SOP validation" },
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
          allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        assert.deepEqual(input.proposal.slotUpdates, { project_goal: "Complete SOP validation" });
        return { state: { ...input.state, status: "awaiting_user",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "collect-correction", model, client });
    const events = await collectSessionTurn(session, "Goal: Complete SOP validation", "collect-correction-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some(event => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("COLLECT_FIELDS_CHECK")));
    const status = await new SopStateStore(join(root, "sessions")).status("collect-correction");
    assert.equal(status?.state.status, "awaiting_user");
    assert.equal(status?.state.slots_json?.project_goal, "Complete SOP validation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a collect node with no supplied fields may wait after one bounded correction", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-empty-collect-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-${calls}`, "submit_step_result", {
        status: "awaiting_user", replyFragment: "Please provide the stage.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = {
      ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["current_stage"], allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        return { state: { ...input.state, status: "awaiting_user" },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "empty-collect", model, client });
    await collectSessionTurn(session, "Hello", "empty-collect-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("empty-collect"))?.state.status, "awaiting_user");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("follow-up collect wait reviews partial slot updates before accepting a repeated question", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-partial-fill-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("partial-fill", BUNDLE, "onboarding");
    await store.replace("partial-fill", BUNDLE, { selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "lookup", status: "awaiting_user", slots_json: { project_goal: "SOP delivery" } });
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`partial-fill-${calls}`, "submit_step_result", calls === 1
        ? { status: "awaiting_user", replyFragment: "What are the blockers?",
            slotUpdates: { project_goal: "SOP delivery", current_stage: "validation" } }
        : { status: "completed", replyFragment: "Collected the project status.",
            slotUpdates: { project_goal: "SOP delivery", current_stage: "validation", known_blockers: "none" } });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, status: "awaiting_user", active_step_id: "lookup" },
          step: { ...prepared.step, node: { type: "collect_info" },
            expectedUserInfo: ["project_goal", "current_stage", "known_blockers"],
            allowedNextStepIds: ["next"], requiredToolNames: [] } };
      },
      async submit(input) {
        submissions++;
        assert.equal(input.proposal.status, "completed");
        assert.equal(input.proposal.slotUpdates?.known_blockers, "none");
        return { state: { ...input.state, status: "completed",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "completed", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "partial-fill", model, client });
    const events = await collectSessionTurn(session,
      "Current stage: validation. Known blockers: none.", "partial-fill-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text"
      && event.result.content[0].text.includes("COLLECT_FIELDS_CHECK")));
    assert.equal((await store.status("partial-fill"))?.state.slots_json?.known_blockers, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collect wait uses only missing fields and rejects malformed known arguments without rejecting extras", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-collect-question-"));
  try {
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`collect-question-${calls}`, "submit_step_result", calls === 1
        ? { status: "awaiting_user", replyFragment: "What is the goal?", slotUpdates: "{}" }
        : { status: "awaiting_user", replyFragment: "What is the goal?", slotUpdates: { project_goal: "SOP delivery" }, modelNote: "extra" });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base,
      async prepare(input) {
        const prepared = await base.prepare(input);
        return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
          node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
          requiredToolNames: [], allowedNextStepIds: ["next"] } };
      },
      async submit(input) {
        submissions++;
        assert.deepEqual(input.proposal.slotUpdates, { project_goal: "SOP delivery" });
        assert.equal(input.proposal.replyFragment, "请补充以下信息，以继续当前步骤：\n- current_stage");
        return { state: { ...input.state, status: "awaiting_user",
          slots_json: { ...input.state.slots_json, ...input.proposal.slotUpdates } },
          result: { status: "awaiting_user", replyFragment: input.proposal.replyFragment,
            slotUpdates: input.proposal.slotUpdates ?? {}, events: [] } };
      },
    };
    const session = createSopSession({ root, sessionId: "collect-question", model, client });
    const events = await collectSessionTurn(session, "Goal: SOP delivery", "collect-question-turn");
    assert.equal(calls, 2);
    assert.equal(submissions, 1);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.code === "invalid_tool_input"));
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "请补充以下信息，以继续当前步骤：\n- current_stage"));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("collect-question"))?.state.slots_json?.project_goal, "SOP delivery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collect proposal cannot erase a persisted required slot while waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-slot-erasure-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("slot-erasure", BUNDLE, "onboarding");
    await store.replace("slot-erasure", BUNDLE, { selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "lookup", status: "active", slots_json: { project_goal: "SOP delivery" } });
    let calls = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`slot-erasure-${calls}`, "submit_step_result", {
        status: "awaiting_user", replyFragment: "What is the stage?",
        slotUpdates: { project_goal: calls === 1 ? "" : "SOP delivery" },
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "collect_info" }, expectedUserInfo: ["project_goal", "current_stage"],
        requiredToolNames: [], allowedNextStepIds: ["next"] } };
    } };
    const session = createSopSession({ root, sessionId: "slot-erasure", model, client });
    const events = await collectSessionTurn(session, "Continue this project.", "slot-erasure-turn");
    assert.equal(calls, 2);
    assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.content[0]?.type === "text" && event.result.content[0].text.includes("REQUIRED_SLOT_ERASURE")));
    assert.equal((await store.status("slot-erasure"))?.state.slots_json?.project_goal, "SOP delivery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal response without missing fields cannot create an ordinary user wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-wait-"));
  try {
    let calls = 0;
    const model = modelFromStream(async function* () {
      calls++;
      yield* yieldToolCall(`terminal-${calls}`, "submit_step_result", {
        status: calls === 1 ? "awaiting_user" : "completed", replyFragment: "Final response.", slotUpdates: {},
      });
    });
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [],
        expectedUserInfo: [], allowedActions: ["answer_user"], isTerminal: true } };
    } };
    const session = createSopSession({ root, sessionId: "terminal-wait", model, client });
    await collectSessionTurn(session, "Finish the plan.", "terminal-wait-turn");
    assert.equal(calls, 2);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("terminal-wait"))?.state.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal completion rejects stale waiting replies before they become durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-reply-"));
  try {
    const fragments = [
      "请提供以下信息，我才能生成最终答复。",
      "我目前被卡在 recognize_b 步骤，无法推进。请提供相关资料。",
      "I cannot proceed without more information. Please provide the documents.",
      "F64D：已完成 recognize_b 与 reply_b。先前提示“无法推进、请提供资料”已解除。",
    ];
    let calls = 0;
    let submissions = 0;
    const model = modelFromStream(async function* () {
      const call = calls++;
      if (call === 0) {
        yield* yieldToolCall("final-reply-wait", "submit_step_result", {
          status: "awaiting_user", replyFragment: "请提供更多信息。", slotUpdates: {},
        });
        return;
      }
      const replyFragment = fragments[call - 1];
      assert.ok(replyFragment);
      yield* yieldToolCall(`final-reply-${calls}`, "submit_step_result", {
        status: "completed", replyFragment, slotUpdates: {},
      });
    });
    const base = acceptingClient(() => { submissions++; });
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "reply_b" }, step: { ...prepared.step,
        nodeId: "reply_b", node: { type: "response" }, instruction: "F64D: confirm both steps completed.",
        requiredToolNames: [], allowedNextStepIds: [], expectedUserInfo: [],
        allowedActions: ["answer_user"], isTerminal: true } };
    } };
    const session = createSopSession({ root, sessionId: "terminal-reply", model, client });
    const events = await collectSessionTurn(session, "Complete the SOP.", "terminal-reply-turn");
    const rejected = events.filter((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.message.includes("FINAL_REPLY_CONTRADICTS_COMPLETION"));
    assert.equal(rejected.length, 3);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.result.type === "error"
      && event.result.error.message.includes("STEP_MUST_ADVANCE")).length, 1);
    assert.equal(submissions, 1);
    assert.equal(calls, 5);
    assert.equal((await new SopStateStore(join(root, "sessions")).status("terminal-reply"))?.state.status, "completed");
    const terminal = events.find((event) => event.type === "turn_completed");
    assert.equal(terminal?.result.type === "success"
      && (terminal.result.structuredOutput as { sop?: { replyFragment?: string } } | undefined)?.sop?.replyFragment,
    fragments[3]);
    assert.deepEqual(events.filter((event) => event.type === "assistant_message"
      && event.message.metadata?.purpose === "staffdeck_sop_reply")
      .map((event) => event.type === "assistant_message" && event.message.content[0]?.type === "text"
        ? event.message.content[0].text : ""), [fragments[3]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP session construction rejects definitions whose required PilotDeck tool is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-missing-tool-"));
  try {
    const noTools: ToolPort = {
      list: () => [],
      async executeAll() { return []; },
    };
    assert.throws(
      () => createSopSession({
        root,
        sessionId: "missing-tool",
        model: modelFromStream(async function* () { yield* yieldText("unreachable"); }),
        client: acceptingClient(),
        tools: noTools,
      }),
      (error: unknown) => (error as { code?: string; missingToolNames?: unknown }).code === "SOP_REQUIRED_TOOL_UNAVAILABLE"
        && JSON.stringify((error as { missingToolNames?: unknown }).missingToolNames) === JSON.stringify(["lookup_account"]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP glue decorates an externally supplied AgentLoop runner through sidecar ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-external-loop-"));
  try {
    const profile: StaffDeckSopRuntimeConfig = {
      provider: "staffdeck",
      endpoint: "http://unused.test",
      definitionsPath: join(root, "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: root,
    };
    const base = acceptingClient();
    const client: StaffDeckSopRuntimeClient = { ...base, async prepare(input) {
      const prepared = await base.prepare(input);
      return { ...prepared, state: { ...prepared.state, active_step_id: "lookup" }, step: { ...prepared.step,
        node: { type: "response" }, requiredToolNames: [], allowedNextStepIds: [], isTerminal: true } };
    } };
    const session = createAgentSession({
      sessionId: "external-loop-session",
      config: {
        provider: "test",
        model: "test-model",
        cwd: root,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd: root, mode: "bypassPermissions", canPrompt: false }),
        staffDeckSop: profile,
      },
      dependencies: {
        router: {} as never,
        ports: { model: modelFromStream(async function* (prepared) {
          const request = (prepared as { request: { toolChoice?: unknown; tools?: { name: string }[] } }).request;
          assert.deepEqual(request.toolChoice, { type: "tool", name: "submit_step_result" });
          assert.deepEqual(request.tools?.map((tool) => tool.name), ["submit_step_result"]);
          yield* yieldText("unused");
        }), tools: toolPort(lookupTool()) },
        context: new DefaultContextRuntime(),
        tools: { registry: { list: () => [lookupTool()] } as never, scheduler: { executeAll: async () => [] } as never },
      },
      agentLoopFactory: (input) => new SopAgentLoop(input.config, input.capabilities, input.seedState, {
        profile,
        bundle: BUNDLE,
        client,
        stateStore: new SopStateStore(join(root, "sessions")),
        sidecarModules: input.sidecarModules,
        sidecarTransportContext: input.sidecarTransportContext,
        runnerFactory: (runnerInput) => {
          const modules = runnerInput.sidecarModules;
          assert.ok(modules, "external runner must receive the composed sidecar modules");
          return {
            snapshotFileState: () => ({}),
            async *run(runInput) {
              const tools = modules.capability.execution.list();
              assert.ok(tools.some((tool) => tool.name === "submit_step_result"));
              await modules.context?.execution.prepareForModel({
                sessionId: runInput.sessionId,
                turnId: runInput.turnId,
                cwd: root,
                provider: "test",
                model: "test-model",
                permissionMode: "bypassPermissions",
                additionalWorkingDirectories: [],
                messages: runInput.messages,
                tools: [],
              } as never);
              const modelContext = { sessionId: runInput.sessionId, turnId: runInput.turnId, runId: "external-run" };
              const offered = [
                { name: "lookup_account", description: "lookup", parameters: { type: "object" } },
                { name: "submit_step_result", description: "submit", parameters: { type: "object" } },
              ];
              const prepared = await modules.model.execution.prepare({ request: { provider: "test", model: "test-model", messages: [], tools: offered } as never, context: modelContext });
              assert.deepEqual(prepared.request.toolChoice, { type: "tool", name: "submit_step_result" });
              assert.deepEqual(prepared.request.tools?.map((tool) => tool.name), ["submit_step_result"]);
              // Even a runner's request remapping must preserve the active
              // SOP's protocol boundary at the host model execution port.
              for await (const _event of modules.model.execution.stream({
                prepared: { ...prepared, request: { ...prepared.request, toolChoice: undefined, tools: offered as never } }, context: modelContext,
              })) {}
              const [submitted] = await modules.capability.execution.executeAll(
                [{ id: "external-submit", name: "submit_step_result", input: { status: "completed", replyFragment: "External loop completed." } }],
                { sessionId: runInput.sessionId, turnId: runInput.turnId, cwd: root } as never,
                { sessionId: runInput.sessionId, turnId: runInput.turnId, runId: "external-run", operationId: "external-op" },
              );
              assert.equal(submitted?.type, "success");
              const result = {
                type: "success" as const,
                sessionId: runInput.sessionId,
                turnId: runInput.turnId,
                stopReason: "completed" as const,
                usage: {},
                permissionDenials: [],
                turns: 1,
                startedAt: "2026-09-18T00:00:00.000Z",
                completedAt: "2026-09-18T00:00:01.000Z",
              };
              yield { type: "turn_completed", sessionId: runInput.sessionId, turnId: runInput.turnId, result };
              return { result, messages: [] };
            },
          };
        },
      }),
    });

    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Run external SOP" }, { turnId: "external-turn" })) {
      events.push(event);
    }
    assert.equal(events.find((event) => event.type === "turn_failed")?.type, undefined, JSON.stringify(events));
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "External loop completed."));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("external-loop-session"))?.state.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store rejects a stale submission revision before replacing durable state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-revision-conflict-"));
  try {
    const store = new SopStateStore(root);
    const current = await store.loadOrCreate("revision-conflict", BUNDLE, "onboarding");
    await store.replace("revision-conflict", current.bundle, { ...current.state, status: "active" });
    await assert.rejects(
      () => store.commitSubmission(
        "revision-conflict",
        current.bundle,
        { ...current.state, status: "completed" },
        current.revision,
        "stale-turn",
        { status: "completed", replyFragment: "must not persist", slotUpdates: {}, events: [] },
      ),
      (error: unknown) => (error as { code?: string }).code === "SOP_REVISION_CONFLICT",
    );
    assert.equal((await store.status("revision-conflict"))?.revision, 2);
    assert.equal((await store.status("revision-conflict"))?.state.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP protocol rejection during prepare leaves the durable host state unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-prepare-protocol-rejection-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const before = await store.loadOrCreate("prepare-protocol", BUNDLE, "onboarding");
    const client: StaffDeckSopRuntimeClient = {
      async prepare() {
        throw new StaffDeckSopClientError(
          "SOP_RUNTIME_PROTOCOL",
          "StaffDeck SOP runtime returned an invalid prepare payload.",
          { field: "step.requiredToolNames" },
          "unsafe",
        );
      },
      async submit() {
        throw new Error("submit is unreachable after prepare rejection");
      },
    };
    const session = createSopSession({
      root,
      sessionId: "prepare-protocol",
      model: modelFromStream(async function* () { throw new Error("model must not run"); }),
      client,
    });

    const events = await collectSessionTurn(session, "Start", "prepare-protocol-turn");
    assert.ok(events.some((event) => event.type === "turn_failed"));
    assert.deepEqual(await store.status("prepare-protocol"), {
      sessionId: "prepare-protocol",
      revision: before.revision,
      state: before.state,
    });
    assert.equal(await store.replyDelivery("prepare-protocol"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP submit errors preserve owner diagnostics without advancing host state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-submit-error-projection-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    const before = await store.loadOrCreate("submit-error", BUNDLE, "onboarding");
    const client: StaffDeckSopRuntimeClient = {
      ...acceptingClient(),
      async submit() {
        throw new StaffDeckSopClientError(
          "REQUIRED_CAPABILITY_NOT_INVOKED",
          "Required PilotDeck tool was not successful.",
          { missingToolNames: ["lookup_account"] },
          "unsafe",
        );
      },
    };
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield* yieldToolCall("rejected-submit", "submit_step_result", {
          status: "completed",
          replyFragment: "must not persist",
        });
        return;
      }
      yield* yieldText("The model received the SOP rejection and stopped.");
    });
    const session = createSopSession({ root, sessionId: "submit-error", model, client });
    const events = await collectSessionTurn(session, "Start", "submit-error-turn");
    const rejected = events.find((event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.result.toolCallId === "rejected-submit");
    assert.equal(rejected?.result.type, "error");
    assert.equal(rejected?.result.type === "error" && rejected.result.error.code, "tool_execution_failed");
    assert.match(rejected?.result.content[0]?.type === "text" ? rejected.result.content[0].text : "", /\[REQUIRED_CAPABILITY_NOT_INVOKED\]/u);
    assert.deepEqual(rejected?.result.type === "error" && rejected.result.error.details?.sopRuntime, {
      code: "REQUIRED_CAPABILITY_NOT_INVOKED",
      message: "Required PilotDeck tool was not successful.",
      retryability: "unsafe",
      details: { missingToolNames: ["lookup_account"] },
    });
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "The model received the SOP rejection and stopped."));
    assert.deepEqual(await store.status("submit-error"), {
      sessionId: "submit-error",
      // The ordinary prepare boundary runs once for each model turn. The
      // rejected submit itself must not add a commit or reply delivery.
      revision: before.revision + 2,
      state: { ...before.state, status: "active" },
    });
    assert.equal(await store.replyDelivery("submit-error"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP loop recovers in the same session after an ordinary PilotDeck tool failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-tool-recovery-"));
  try {
    let modelCall = 0;
    let toolCall = 0;
    let submittedSuccessfulTools: readonly string[] | undefined;
    const model = modelFromStream(async function* () {
      modelCall += 1;
      if (modelCall === 1 || modelCall === 3) {
        yield* yieldToolCall(modelCall === 1 ? "lookup-failed" : "lookup-retry", "lookup_account", { accountId: "ada" });
        return;
      }
      if (modelCall === 2) {
        yield* yieldText("The account lookup failed; retry is required.");
        return;
      }
      yield* yieldToolCall("submit-after-tool-retry", "submit_step_result", {
        status: "completed",
        replyFragment: "Account onboarding recovered.",
      });
    });
    const client = acceptingClient((successfulToolNames) => { submittedSuccessfulTools = successfulToolNames; });
    const session = createSopSession({
      root,
      sessionId: "tool-recovery",
      model,
      client,
      tools: toolPortWithResult(() => {
        toolCall += 1;
        if (toolCall === 1) {
          const now = new Date().toISOString();
          return {
            type: "error",
            toolCallId: "lookup-failed",
            toolName: "lookup_account",
            error: toolError("tool_execution_failed", "lookup unavailable"),
            content: [{ type: "text", text: "lookup unavailable" }],
            startedAt: now,
            completedAt: now,
          };
        }
        return successToolResult("lookup-retry", "lookup_account");
      }),
    });

    await collectSessionTurn(session, "Start onboarding", "tool-recovery-1");
    const failedState = await new SopStateStore(join(root, "sessions")).loadOrCreate("tool-recovery", BUNDLE, "onboarding");
    assert.deepEqual(failedState.state.successful_tool_names, []);
    assert.equal(failedState.state.status, "active");

    const recovered = await collectSessionTurn(session, "Retry onboarding", "tool-recovery-2");
    assert.deepEqual(submittedSuccessfulTools, ["lookup_account"]);
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Account onboarding recovered."));
    assert.equal((await new SopStateStore(join(root, "sessions")).status("tool-recovery"))?.state.status, "completed");
    const child = await readRealNode(root, "tool-recovery", "lookup");
    assert.equal(child.filter(entry => entry.type === "turn_started").length, 2);
    assert.equal(child.filter(entry => entry.type === "session_metadata").length, 1);
    assert.ok(JSON.stringify(child).includes("lookup-failed"));
    assert.ok(JSON.stringify(child).includes("lookup-retry"));
    await session.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted model output cannot submit or advance the SOP", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-stream-interruption-"));
  try {
    let submits = 0;
    const client = acceptingClient(() => { submits += 1; });
    const model = modelFromStream(async function* (_input, context) {
      if (context.abortSignal?.aborted) return;
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "partial-submit", name: "submit_step_result" };
      yield { type: "tool_call_delta", id: "partial-submit", delta: '{"status":"completed"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: { phase: "tool_call", activeToolCalls: [{ id: "partial-submit", name: "submit_step_result", argumentChars: 21 }] },
        },
      };
    });
    const session = createSopSession({ root, sessionId: "stream-interruption", model, client });
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Complete the SOP" }, { turnId: "stream-interruption-turn" })) {
      events.push(event);
      if (event.type === "turn_continued") session.abort("test_cancel_recovery");
    }

    assert.equal(submits, 0);
    assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "aborted");
    const state = await new SopStateStore(join(root, "sessions")).status("stream-interruption");
    assert.equal(state?.state.status, "active");
    assert.equal(await new SopStateStore(join(root, "sessions")).replyDelivery("stream-interruption"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling after a complete model tool call prevents SOP submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-cancel-"));
  try {
    let submits = 0;
    const client = acceptingClient(() => { submits += 1; });
    const model = modelFromStream(async function* () {
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "cancelled-submit", name: "submit_step_result" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "cancelled-submit",
          name: "submit_step_result",
          input: { status: "completed", replyFragment: "must not commit" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
    });
    const session = createSopSession({ root, sessionId: "cancel-before-submit", model, client });
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "Complete the SOP" }, { turnId: "cancel-before-submit-turn" })) {
      events.push(event);
      if (event.type === "model_event" && event.event.type === "tool_call_end") session.abort("operator_cancelled");
    }

    assert.equal(submits, 0);
    assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "aborted");
    assert.equal((await new SopStateStore(join(root, "sessions")).status("cancel-before-submit"))?.state.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful tools survive a crash window before SOP submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-pre-submit-crash-"));
  try {
    let firstModelCall = 0;
    const firstModel = modelFromStream(async function* (_input, context) {
      firstModelCall += 1;
      if (firstModelCall === 1) {
        yield* yieldToolCall("lookup-before-crash", "lookup_account", { accountId: "ada" });
        return;
      }
      if (context.abortSignal?.aborted) return;
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "submit-before-crash", name: "submit_step_result" };
      yield { type: "tool_call_delta", id: "submit-before-crash", delta: '{"status":"completed"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "forced crash before SOP submission",
          retryable: true,
          streamInterruption: { phase: "tool_call", activeToolCalls: [{ id: "submit-before-crash", name: "submit_step_result", argumentChars: 21 }] },
        },
      };
    });
    const client = acceptingClient((successfulToolNames) => assert.deepEqual(successfulToolNames, ["lookup_account"]));
    const first = createSopSession({ root, sessionId: "pre-submit-crash", model: firstModel, client });
    for await (const event of first.submit({ type: "text", text: "Start" }, { turnId: "pre-submit-crash-1" })) {
      if (event.type === "turn_continued") first.abort("forced_process_exit");
    }
    assert.deepEqual(
      (await new SopStateStore(join(root, "sessions")).status("pre-submit-crash"))?.state.successful_tool_names,
      ["lookup_account"],
    );

    const retryModel = modelFromStream(async function* () {
      yield* yieldToolCall("submit-after-restart", "submit_step_result", {
        status: "completed",
        replyFragment: "Recovered after pre-submit crash.",
      });
    });
    const retry = createSopSession({ root, sessionId: "pre-submit-crash", model: retryModel, client });
    const events = await collectSessionTurn(retry, "Retry after restart", "pre-submit-crash-2");
    assert.ok(events.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Recovered after pre-submit crash."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending SOP reply is recovered after state commit but before durable delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-pending-reply-"));
  try {
    const transcript = new FailOnceSopReplyTranscript();
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      yield* yieldToolCall("submit-pending-reply", "submit_step_result", {
        status: "completed",
        replyFragment: "Recovered pending SOP reply.",
      });
    });
    const client = acceptingClient();
    const first = createSopSession({ root, sessionId: "pending-reply", model, client, transcript });
    const failed = await collectSessionTurn(first, "Complete", "pending-reply-turn");
    assert.ok(failed.some((event) => event.type === "turn_failed"));
    assert.equal((await new SopStateStore(join(root, "sessions")).replyDelivery("pending-reply"))?.phase, "pending");

    const retry = createSopSession({ root, sessionId: "pending-reply", model, client, transcript });
    const recovered = await collectSessionTurn(retry, "Recover interrupted reply", "pending-reply-recovery-turn");
    assert.equal(modelCalls, 1, "reply recovery must not call the model again");
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.content[0]?.type === "text"
      && event.message.content[0].text === "Recovered pending SOP reply."));
    assert.equal(await new SopStateStore(join(root, "sessions")).replyDelivery("pending-reply"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable SOP reply is re-homed onto one completed recovery turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-terminal-recovery-"));
  try {
    const transcript = new InMemoryTranscriptWriter();
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      yield* yieldToolCall("submit-before-terminal-crash", "submit_step_result", {
        status: "completed",
        replyFragment: "Durable before terminal.",
      });
    });
    const client = acceptingClient();
    const first = createSopSession({ root, sessionId: "terminal-recovery", model, client, transcript });
    const interrupted = first.submit({ type: "text", text: "Complete" }, { turnId: "terminal-recovery-turn" });
    for await (const event of interrupted) {
      if (event.type === "assistant_message"
        && event.message.metadata?.purpose === "staffdeck_sop_reply") break;
    }
    assert.equal((await new SopStateStore(join(root, "sessions")).replyDelivery("terminal-recovery"))?.phase, "durable");
    const durableReplyCount = () => transcript.entries.filter((entry) =>
      (entry.type === "assistant_message" || entry.type === "durable_message")
      && entry.message.metadata?.purpose === "staffdeck_sop_reply").length;
    assert.equal(durableReplyCount(), 1);

    const retry = createSopSession({ root, sessionId: "terminal-recovery", model, client, transcript });
    const recovered = await collectSessionTurn(retry, "Recover interrupted terminal", "terminal-recovery-retry-turn");
    assert.equal(modelCalls, 1, "terminal recovery must not call the model again");
    assert.equal(durableReplyCount(), 2, "the completed recovery turn must own one durable copy of the reply");
    assert.ok(recovered.some((event) => event.type === "assistant_message"
      && event.message.metadata?.purpose === "staffdeck_sop_reply"));
    assert.equal(recovered.filter((event) => event.type === "turn_completed").length, 1);
    const visibleReplies = replayTranscriptEntries(transcript.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply");
    assert.equal(visibleReplies.length, 1);
    assert.equal(visibleReplies[0]?.content[0]?.type === "text" && visibleReplies[0].content[0].text, "Durable before terminal.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL after durable SOP reply persistence replays one visible reply without another model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-sigkill-recovery-"));
  try {
    const sessionId = "sigkill-recovery";
    const originalTurnId = "sigkill-original-turn";
    const transcriptPath = join(root, "transcript.jsonl");
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", killedReplyWriterSource({
      root,
      sessionId,
      turnId: originalTurnId,
      transcriptPath,
    })], { encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const stateStore = new SopStateStore(join(root, "sessions"));
    assert.equal((await stateStore.replyDelivery(sessionId))?.phase, "durable");
    const beforeRecovery = await readTranscript(transcriptPath);
    assert.equal(beforeRecovery.diagnostics.length, 0);
    assert.equal(replayTranscriptEntries(beforeRecovery.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply").length, 0,
    "an uncompleted turn must not become browser-visible before recovery");

    const transcript = new JsonlTranscriptWriter({ path: transcriptPath });
    const lastEntry = beforeRecovery.entries.at(-1);
    transcript.restoreState(lastEntry?.sequence ?? 0, lastEntry?.entryId ?? null);
    let modelCalls = 0;
    const model = modelFromStream(async function* () {
      modelCalls += 1;
      throw new Error("recovery must not invoke the model");
    });
    const session = createSopSession({
      root,
      sessionId,
      model,
      client: acceptingClient(),
      transcript,
    });
    const events = await collectSessionTurn(session, "Recover durable reply", "sigkill-recovery-turn");
    await transcript.close();

    assert.equal(modelCalls, 0);
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
    assert.equal(await stateStore.replyDelivery(sessionId), undefined);
    const restored = await readTranscript(transcriptPath);
    assert.equal(restored.diagnostics.length, 0);
    const visibleReplies = replayTranscriptEntries(restored.entries).messages.filter((message) =>
      message.metadata?.purpose === "staffdeck_sop_reply");
    assert.equal(visibleReplies.length, 1);
    assert.equal(visibleReplies[0]?.content[0]?.type === "text" && visibleReplies[0].content[0].text, "Durable SIGKILL reply.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state snapshots keep distinct session ids that transcript paths coalesce", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("a/b", BUNDLE, "onboarding");
    await store.loadOrCreate("a-b", BUNDLE, "onboarding");
    const names = readdirSync(root).filter((name) => name.endsWith(".json"));
    assert.equal(names.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store migrates v1 and v2 waits and pending replies without losing session state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-migration-"));
  try {
    for (const schemaVersion of [1, 2] as const) {
      const sessionId = `legacy-${schemaVersion}`;
      const file = join(root, `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`);
      writeFileSync(file, JSON.stringify({
        schemaVersion,
        sessionId,
        bundle: BUNDLE,
        state: {
          version: 1,
          selected_skill_id: "onboarding",
          active_skill_id: "onboarding",
          active_step_id: "lookup",
          status: "handoff",
          slots_json: { account: "Ada" },
          skill_stack_json: [],
          successful_tool_names: [],
        },
        revision: 7,
        wait: { id: `wait-${schemaVersion}`, kind: "handoff", createdAt: "2026-01-01T00:00:00.000Z" },
        replyDelivery: {
          turnId: `turn-${schemaVersion}`,
          phase: "pending",
          result: { status: "handoff", replyFragment: "Need approval", slotUpdates: {}, events: [] },
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      }));
      const store = new SopStateStore(root);
      const status = await store.status(sessionId);
      assert.equal(status?.revision, 7);
      assert.equal(status?.wait?.id, `wait-${schemaVersion}`);
      assert.deepEqual(status?.state.slots_json, { account: "Ada" });
      assert.equal((await store.replyDelivery(sessionId))?.turnId, `turn-${schemaVersion}`);

      await store.replace(sessionId, BUNDLE, status!.state);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 3);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state store rejects unreadable state without silently replacing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-invalid-"));
  try {
    const sessionId = "invalid-state";
    const file = join(root, `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`);
    writeFileSync(file, "{ definitely-not-json");
    const store = new SopStateStore(root);
    await assert.rejects(
      () => store.loadOrCreate(sessionId, BUNDLE, "onboarding"),
      /invalid JSON/,
    );
    assert.equal(readFileSync(file, "utf8"), "{ definitely-not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state records simultaneous successful tools without losing either result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-state-race-"));
  try {
    const store = new SopStateStore(root);
    await Promise.all([
      store.recordSuccessfulTools("same-session", BUNDLE, "onboarding", ["lookup_account"]),
      store.recordSuccessfulTools("same-session", BUNDLE, "onboarding", ["verify_account"]),
    ]);
    const persisted = await store.loadOrCreate("same-session", BUNDLE, "onboarding");
    assert.deepEqual(persisted.state.successful_tool_names, ["lookup_account", "verify_account"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP state keeps the session definition snapshot after a deployment definition changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-definition-snapshot-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("snapshot-session", BUNDLE, "onboarding");
    const changedBundle: StaffDeckSopBundle = {
      sops: [{ id: "onboarding", version: "2", name: "Changed deployment definition", content: { nodes: [{ node_id: "new-step" }] } }],
    };
    const restored = await store.loadOrCreate("snapshot-session", changedBundle, "onboarding");
    assert.equal(restored.bundle.sops[0]?.name, "Onboarding");
    const fresh = await store.loadOrCreate("fresh-session", changedBundle, "onboarding");
    assert.equal(fresh.bundle.sops[0]?.name, "Changed deployment definition");
    assert.equal(fresh.bundle.sops[0]?.version, "2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SOP host control resumes handoff once and deduplicates the request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-resume-"));
  try {
    const store = new SopStateStore(root);
    const bundle: StaffDeckSopBundle = { sops: [{ id: 'onboarding', version: '1', content: {
      nodes: [{ node_id: 'lookup', type: 'handoff', assignee_user_id: 'approver' }],
    } }] };
    const authority = { tenantId: 'tenant', sessionId: 'resume-session', subject: {
      tenantId: 'tenant', userId: 'approver', source: 'web' as const, role: 'member' as const, disabled: false,
    } };
    await store.loadOrCreate("resume-session", bundle, "onboarding");
    await store.replace("resume-session", bundle, {
      selected_skill_id: "onboarding",
      active_skill_id: "onboarding",
      active_step_id: "lookup",
      status: "handoff",
      slots_json: { account: "Ada" },
      awaiting_input_json: { kind: "handoff" },
    });
    const waiting = await store.status("resume-session");
    assert.equal(waiting?.wait?.kind, "handoff");

    const resumed = await store.resume({
      sessionId: "resume-session",
      requestId: "human-reply-1",
      waitId: waiting!.wait!.id,
      source: "human", authority,
      message: "Approved by the account owner.",
      expectedRevision: waiting!.revision,
      slotUpdates: { approved: true },
    });
    assert.equal(resumed.duplicate, false);
    const duplicate = await store.resume({
      sessionId: "resume-session",
      requestId: "human-reply-1",
      waitId: waiting!.wait!.id,
      source: "human", authority,
      message: "Approved by the account owner.",
      slotUpdates: { approved: true },
      expectedRevision: waiting!.revision,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, resumed.revision);
    await assert.rejects(() => store.resume({
      sessionId: "resume-session", requestId: "human-reply-1", waitId: "another-wait",
      source: "human", authority, message: "Approved by the account owner.", slotUpdates: { approved: true },
    }), (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_REQUEST_CONFLICT");
    await assert.rejects(() => store.resume({
      sessionId: "resume-session", requestId: "human-reply-1", waitId: waiting!.wait!.id,
      source: "human", authority, message: "Different answer", slotUpdates: { approved: true },
    }), (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_REQUEST_CONFLICT");

    const status = await store.status("resume-session");
    assert.equal(status?.state.status, "active");
    assert.equal(status?.wait, undefined);
    assert.deepEqual(status?.state.slots_json, { account: "Ada", approved: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff wait identity is stable on reload but belongs to one active node", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-wait-owner-"));
  try {
    const store = new SopStateStore(join(root, "sessions"));
    await store.loadOrCreate("wait-owner", BUNDLE, "onboarding");
    const approval = { version: 1, selected_skill_id: "onboarding", active_skill_id: "onboarding",
      active_step_id: "approval", status: "handoff", slots_json: {}, skill_stack_json: [] };
    await store.replace("wait-owner", BUNDLE, approval);
    const first = (await store.status("wait-owner"))?.wait;
    assert.ok(first?.id);
    await store.replace("wait-owner", BUNDLE, approval);
    assert.equal((await store.status("wait-owner"))?.wait?.id, first.id);
    await store.replace("wait-owner", BUNDLE, { ...approval, active_step_id: "second_approval" });
    assert.notEqual((await store.status("wait-owner"))?.wait?.id, first.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SOP host control rejects stale and mismatched external resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-resume-reject-"));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate("external-session", BUNDLE, "onboarding");
    await store.replace("external-session", BUNDLE, {
      selected_skill_id: "onboarding",
      active_skill_id: "onboarding",
      active_step_id: "lookup",
      status: "waiting_external_task",
      slots_json: {},
    });
    const waiting = await store.status("external-session");
    await assert.rejects(
      () => store.resume({
        sessionId: "external-session",
        requestId: "wrong-source",
        waitId: waiting!.wait!.id,
        source: "human",
        message: "wrong",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_RESUME_SOURCE_INVALID",
    );
    await assert.rejects(
      () => store.resume({
        sessionId: "external-session",
        requestId: "stale-wait",
        waitId: "old-wait-id",
        source: "external_task",
        message: "completed",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_WAIT_STALE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function scriptedModel(): ModelInvokerPort & { requests: import("../../src/model/index.js").CanonicalModelRequest[] } {
  let call = 0;
  const requests: import("../../src/model/index.js").CanonicalModelRequest[] = [];
  return {
    requests,
    async prepare({ request }) {
      requests.push(request);
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      call += 1;
      const toolCall = call === 1
        ? { id: "lookup-call", name: "lookup_account", input: { accountId: "ada" } }
        : {
            id: "submit-call",
            name: "submit_step_result",
            input: { status: "completed", replyFragment: "Account onboarding is complete." },
          };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_end", toolCall };
      yield { type: "message_end", finishReason: "tool_call" };
    },
  };
}

function lookupTool(): PilotDeckToolDefinition {
  return {
    name: "lookup_account",
    description: "Look up an account.",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "found" }] }),
  };
}

function toolPort(tool: PilotDeckToolDefinition): ToolPort {
  return {
    list: () => [tool],
    async executeAll(calls): Promise<PilotDeckToolResult[]> {
      const now = new Date().toISOString();
      return calls.map((call) => ({
        type: "success" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: "found" }],
        startedAt: now,
        completedAt: now,
      }));
    },
  };
}

async function readRealNode(root: string, parentSessionId: string, nodeId: string) {
  const persisted = await readSubagentProjectSessionPersistence({ projectRoot: root, pilotHome: root,
    parentSessionId, sessionId: sopNodeSessionId(parentSessionId, "onboarding", nodeId),
    sidechainId: sopNodeSidechainId("onboarding", nodeId) });
  assert.ok(persisted.entries.length > 0);
  assert.ok(persisted.entries.every(entry => entry.sessionId === sopNodeSessionId(parentSessionId, "onboarding", nodeId)));
  return persisted.entries;
}

function createSopSession(input: {
  root: string;
  sessionId: string;
  model: ModelInvokerPort;
  client: StaffDeckSopRuntimeClient;
  tools?: ToolPort;
  context?: import("../../src/context/ContextRuntime.js").AgentContextRuntime;
  transcript?: AgentTranscriptWriter;
  authorityPort?: SopCapabilityAuthorityPort;
  bundle?: StaffDeckSopBundle;
  contextMode?: "new_session" | "inherit";
  initialMessages?: import("../../src/model/index.js").CanonicalMessage[];
}) {
  const profile: StaffDeckSopRuntimeConfig = {
    provider: "staffdeck",
    endpoint: "http://unused.test",
    definitionsPath: join(input.root, "definitions.yaml"),
    defaultSopId: "onboarding",
    stateRoot: input.root,
    ...(input.contextMode ? { contextMode: input.contextMode } : {}),
  };
  const lookup = lookupTool();
  return createAgentSession({
    sessionId: input.sessionId,
    ...(input.initialMessages ? { initialState: { ...createInitialAgentSessionState(input.sessionId), messages: input.initialMessages } } : {}),
    config: {
      provider: "test",
      model: "test-model",
      cwd: input.root,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd: input.root, mode: "bypassPermissions", canPrompt: false }),
      staffDeckSop: profile,
    },
    dependencies: {
      router: {} as never,
      ports: { model: input.model, tools: input.tools ?? toolPort(lookup) },
      ...(input.context ? { context: input.context } : {}),
      tools: { registry: { list: () => [lookup] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    transcript: input.transcript,
    agentLoopFactory: (factoryInput) => new SopAgentLoop(factoryInput.config, factoryInput.capabilities, factoryInput.seedState, {
      profile,
      bundle: input.bundle ?? BUNDLE,
      client: input.client,
      stateStore: new SopStateStore(join(input.root, "sessions")),
      authorityPort: input.authorityPort,
      contextRuntime: factoryInput.contextRuntime,
      internalSessionPorts: factoryInput.internalSessionPorts,
    }),
  });
}

test("overlapping owner prepare cannot overwrite the concurrently saved SOP state", async () => {
  const root = mkdtempSync(join(tmpdir(), "r150-prepare-race-"));
  console.log(`prepare-race-evidence=${root}`);
  const store = new SopStateStore(join(root, "sessions"));
  const base = acceptingClient();
  let models = 0;
  const client = { ...base, prepare: async (input: Parameters<StaffDeckSopRuntimeClient["prepare"]>[0]) => {
    const current = (await store.status("race-session"))!;
    await store.replace("race-session", BUNDLE, { ...current.state, active_step_id: "concurrently-resumed" }, current.revision);
    return base.prepare(input);
  } };
  const session = createSopSession({ root, sessionId: "race-session", client,
    model: modelFromStream(async function* () { models++; yield* yieldText("must not execute"); }),
    context: new DefaultContextRuntime() });
  const events = await collectSessionTurn(session, "Start", "race-turn");
  assert.equal(models, 0);
  assert.equal((await store.status("race-session"))?.state.active_step_id, "concurrently-resumed");
  assert.ok(events.some(event => event.type === "turn_failed"));
  await session.dispose();
});

for (const mode of ["allow", "required", "revoke", "stale", "empty", "invalid", "hidden", "untrusted"] as const) {
  test(`response optional Knowledge uses one authorized view across model/list/preflight: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "r150-optional-response-"));
    console.log(`optional-response-evidence=${root}`);
    const store = new SopStateStore(join(root, "sessions"));
    const optionalBundle = { sops: [{ id: "onboarding", version: "1", content: { nodes: [{ node_id: "response", type: "response" }] } }] };
    let resolves = 0, searches = 0, modelCalls = 0;
    let revoked = false;
    let receipts: readonly string[] | undefined;
    const authorityPort: SopCapabilityAuthorityPort = { resolve: async context => {
      resolves++;
      assert.deepEqual(await store.authority(context.sessionKey, context.expectedRevision), {
        sopId: "onboarding", sopVersion: "1", nodeId: "response", content: optionalBundle.sops[0].content,
      });
      return { context, sopId: "onboarding", sopVersion: "1", nodeId: "response", snapshotId: "snapshot",
        registryGeneration: 1, optionalCapabilities: mode === "empty" || revoked ? [] : [
          { operation: "knowledge.search/v1", resourceType: "knowledge_base", resourceId: "base",
            required: false, providerModuleId: "knowledge.local", providerVersion: "1", selectionMode: "current" }] };
    } };
    const base = acceptingClient(names => { receipts = names; });
    const client: StaffDeckSopRuntimeClient = { ...base, prepare: async input => {
      const p = await base.prepare(input);
      return { ...p, state: { ...p.state, active_step_id: "response" }, step: { ...p.step,
        nodeId: "response", node: { type: "response" }, requiredToolNames: mode === 'required' ? ['knowledge_query'] : [], allowedActions: ["answer_user"],
        ...(mode === "untrusted" ? { optionalKnowledge: { optionalCapabilities: [{ resourceId: "base" }] } as never } : {}) } };
    } };
    const query = { ...lookupTool(), name: "knowledge_query" };
    const tools: ToolPort = { list: () => [lookupTool(), query], executeAll: async calls => {
      searches++;
      const hostContext = currentKnowledgeAuthority(); assert.ok(hostContext);
      assert.equal(hostContext.expectedRevision, (await store.status("optional-session"))?.revision);
      return toolPort(query).executeAll(calls, {} as never, {} as never);
    } };
    const model = modelFromStream(async function* (prepared) {
      const request = (prepared as { request: { tools?: { name: string }[]; toolChoice: unknown } }).request;
      modelCalls++;
      if (mode !== 'required') assert.ok(!request.tools?.some(tool => tool.name === "lookup_account"));
      if (modelCalls === 1) {
        const hidden = mode === "empty" || mode === "untrusted";
        assert.deepEqual(request.tools?.map(tool => tool.name), mode === 'required' ? ['lookup_account', 'knowledge_query', 'submit_step_result']
          : hidden ? ["submit_step_result"] : ["knowledge_query", "submit_step_result"]);
        assert.deepEqual(request.toolChoice, hidden ? { type: "tool", name: "submit_step_result" } : "required");
        if (mode === "stale") {
          const p = (await store.status("optional-session"))!;
          await store.replace("optional-session", optionalBundle, p.state, p.revision);
        }
        if (mode === "revoke") revoked = true;
        yield* yieldToolCall("optional-query", mode === "hidden" ? "lookup_account" : "knowledge_query",
          { query: "fact", ...(mode === "invalid" ? { actorUserId: "forged" } : {}) });
      } else {
        yield* yieldToolCall("optional-submit", "submit_step_result", { status: "completed", replyFragment: "Final answer", slotUpdates: {} });
      }
    });
    const session = createSopSession({ root, sessionId: "optional-session", model, client, tools,
      authorityPort: mode === "untrusted" ? undefined : authorityPort, bundle: optionalBundle, context: new DefaultContextRuntime() });
    const events = await collectSessionTurn(session, "Answer with available evidence", "optional-turn");
    if (receipts === undefined) console.log(JSON.stringify({ mode, events }));
    assert.equal(searches, mode === "allow" || mode === 'required' ? 1 : 0);
    assert.deepEqual(receipts, mode === "allow" || mode === 'required' ? ["knowledge_query"] : []);
    const result = events.find(event => event.type === "tool_result" && event.result.toolCallId === "optional-query");
    assert.ok(result && result.type === "tool_result");
    assert.equal(result.result.type, mode === "allow" || mode === 'required' ? "success" : "error");
    assert.equal((await store.status("optional-session"))?.state.status, "completed");
    assert.equal(currentKnowledgeAuthority(), undefined);
    await session.dispose();
  });
}

function acceptingClient(onSubmit?: (successfulToolNames: readonly string[]) => void, declaresHandoff = false): StaffDeckSopRuntimeClient {
  return {
    async prepare({ state }) {
      return {
        state: { ...state, status: "active" },
        step: {
          skillId: "onboarding",
          skillName: "Onboarding",
          version: "1",
          nodeId: "lookup",
          node: {},
          instruction: "Look up the account before replying.",
          expectedUserInfo: [],
          knownSlots: {},
          allowedNextStepIds: [],
          transitions: [{
            nextStepId: "confirm",
            condition: "approval_required",
            priority: 10,
            label: "Needs approval",
            targetStep: { name: "Confirm approval", type: "handoff", instruction: "Ask the owner to confirm." },
          }],
          requiredToolNames: ["lookup_account"],
          allowedActions: ["call_tool:lookup_account"],
          isTerminal: true,
          declaresHandoff,
        },
      };
    },
    async submit({ state, successfulToolNames, proposal }) {
      onSubmit?.(successfulToolNames);
      return {
        state: { ...state, status: proposal.status, successful_tool_names: [] },
        result: {
          status: proposal.status,
          replyFragment: proposal.replyFragment,
          slotUpdates: proposal.slotUpdates ?? {},
          events: [{ type: "sop_completed" }],
        },
      };
    },
  };
}

function modelFromStream(
  stream: (input: unknown, context: import("../../src/agent/modules/protocol.js").ModelExecutionContext) => AsyncIterable<CanonicalModelEvent>,
): ModelInvokerPort {
  return {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    stream({ prepared, context }) {
      return stream(prepared, context);
    },
  };
}

async function* yieldToolCall(id: string, name: string, input: Record<string, unknown>): AsyncIterable<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "tool_call_start", id, name };
  yield { type: "tool_call_end", toolCall: { id, name, input } };
  yield { type: "message_end", finishReason: "tool_call" };
}

async function* yieldText(text: string): AsyncIterable<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "text_delta", text };
  yield { type: "message_end", finishReason: "stop" };
}

function toolPortWithResult(result: (call: number) => PilotDeckToolResult): ToolPort {
  let call = 0;
  return {
    list: () => [lookupTool()],
    async executeAll() {
      call += 1;
      return [result(call)];
    },
  };
}

function successToolResult(toolCallId: string, toolName: string): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "success",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "found" }],
    startedAt: now,
    completedAt: now,
  };
}

async function collectSessionTurn(
  session: ReturnType<typeof createSopSession>,
  text: string,
  turnId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.submit({ type: "text", text }, { turnId })) events.push(event);
  return events;
}

class FailOnceSopReplyTranscript extends InMemoryTranscriptWriter {
  private failed = false;

  override recordDurableMessage(...args: Parameters<InMemoryTranscriptWriter["recordDurableMessage"]>) {
    const message = args[2];
    if (!this.failed && message.metadata?.purpose === "staffdeck_sop_reply") {
      this.failed = true;
      throw new Error("forced crash before SOP reply durability");
    }
    return super.recordDurableMessage(...args);
  }
}

function killedReplyWriterSource(input: {
  root: string;
  sessionId: string;
  turnId: string;
  transcriptPath: string;
}): string {
  const stateStoreUrl = pathToFileURL(join(process.cwd(), "dist/src/sop/staffdeck/SopStateStore.js")).href;
  const transcriptWriterUrl = pathToFileURL(join(process.cwd(), "dist/src/session/transcript/JsonlTranscriptWriter.js")).href;
  return `
    import { SopStateStore } from ${JSON.stringify(stateStoreUrl)};
    import { JsonlTranscriptWriter } from ${JSON.stringify(transcriptWriterUrl)};
    const bundle = ${JSON.stringify(BUNDLE)};
    const root = ${JSON.stringify(input.root)};
    const sessionId = ${JSON.stringify(input.sessionId)};
    const turnId = ${JSON.stringify(input.turnId)};
    const stateStore = new SopStateStore(root + "/sessions");
    const current = await stateStore.loadOrCreate(sessionId, bundle, "onboarding");
    const result = {
      status: "completed",
      replyFragment: "Durable SIGKILL reply.",
      slotUpdates: {},
      events: [{ type: "sop_completed" }],
    };
    await stateStore.commitSubmission(sessionId, current.bundle, {
      ...current.state,
      status: "completed",
      successful_tool_names: [],
    }, current.revision, turnId, result);
    const transcript = new JsonlTranscriptWriter({ path: ${JSON.stringify(input.transcriptPath)} });
    await transcript.recordDurableMessage(sessionId, turnId, {
      role: "assistant",
      content: [{ type: "text", text: result.replyFragment }],
      metadata: { purpose: "staffdeck_sop_reply", sopStatus: result.status, sopEvents: result.events },
    });
    await stateStore.markReplyDurable(sessionId, turnId);
    process.kill(process.pid, "SIGKILL");
  `;
}
