import assert from "node:assert/strict";
import test from "node:test";

import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createPlanTodoSnapshot } from "../../../src/plan-todo/projection/PlanTodoProjection.js";

test("default sidecar factory maps host-neutral execution payloads", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      sessionId: "session-1",
      turnId: "turn-1",
      operationDeadline: "2026-09-02T00:01:00.000Z",
      payload: {
        agent: {
          provider: "provider-a",
          model: "model-a",
          cwd: "/workspace",
          systemPrompt: "Use the host tools.",
          appendSystemPrompt: "Keep the final answer concise.",
          planModeInstructions: "Write a plan before editing.",
          runtimeContextSurface: "system_prompt",
          thinking: { enabled: true, mode: "high", preserve: true },
          toolChoice: { type: "tool", name: "lookup" },
          maxContextMessages: 12,
          stopOnStructuredOutput: true,
          jsonSelfCorrect: true,
          runMode: "ask",
        },
        maxTurns: 2,
        maxBudgetUsd: 1.5,
        taskBudgetUsd: 4,
        initialTaskBudgetSpentUsd: 0.25,
        canElicit: true,
        modelOverride: {
          provider: "provider-b",
          model: "model-b",
          speed: 2,
          thinking: { enabled: true, mode: "medium" },
        },
        task: { prompt: "Inspect the input." },
        messages: [
          { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
          { role: "assistant", content: "Acknowledged" },
        ],
        basePermissionMode: "default",
        allowPlanModeTools: true,
        permissionContext: {
          mode: "plan",
          canPrompt: true,
          bypassAvailable: false,
          rules: { deny: [{ toolName: "shell" }] },
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "session-1");
  assert.equal(execution.input.turnId, "turn-1");
  assert.equal(execution.input.maxTurns, 2);
  assert.equal(execution.input.maxBudgetUsd, 1.5);
  assert.equal(execution.input.taskBudgetUsd, 4);
  assert.equal(execution.input.initialTaskBudgetSpentUsd, 0.25);
  assert.equal(execution.input.runMode, "ask");
  assert.equal(execution.input.permissionMode, "plan");
  assert.equal(execution.input.basePermissionMode, "default");
  assert.equal(execution.input.allowPlanModeTools, true);
  assert.equal(execution.input.canPrompt, true);
  assert.equal(execution.input.canElicit, true);
  assert.deepEqual(execution.input.modelOverride, {
    provider: "provider-b",
    model: "model-b",
    speed: 2,
    thinking: { enabled: true, mode: "medium" },
  });
  const loopConfig = (execution.loop as any).config;
  assert.equal(loopConfig.runtimeContextSurface, "system_prompt");
  assert.equal(loopConfig.appendSystemPrompt, "Keep the final answer concise.");
  assert.equal(loopConfig.planModeInstructions, "Write a plan before editing.");
  assert.deepEqual(loopConfig.thinking, { enabled: true, mode: "high", preserve: true });
  assert.deepEqual(loopConfig.toolChoice, { type: "tool", name: "lookup" });
  assert.equal(loopConfig.maxContextMessages, 12);
  assert.equal(loopConfig.stopOnStructuredOutput, true);
  assert.equal(loopConfig.jsonSelfCorrect, true);
  assert.deepEqual(execution.input.execution, {
    runId: "run-1",
    operationId: "operation-1",
    idempotencyKey: undefined,
    operationDeadline: "2026-09-02T00:01:00.000Z",
  });
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
    { role: "assistant", content: [{ type: "text", text: "Acknowledged" }] },
  ]);
});

test("default sidecar factory preserves an explicit empty prompt and additional working directories", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-empty-prompt",
      method: "execute",
      runId: "run-empty-prompt",
      operationId: "operation-empty-prompt",
      requestId: "request-empty-prompt",
      sessionId: "session-empty-prompt",
      turnId: "turn-empty-prompt",
      payload: {
        agent: { provider: "provider-a", model: "model-a", cwd: "/workspace", systemPrompt: "" },
        permissionContext: {
          mode: "default",
          canPrompt: false,
          additionalWorkingDirectories: ["/workspace/shared", "/workspace/vendor"],
          rules: { allow: [], deny: [], ask: [] },
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "empty-prompt-response", inReplyTo: "call", ok: true }),
  });

  assert.equal((execution.loop as any).config.systemPrompt, "");
  assert.deepEqual((execution.loop as any).config.permissionContext.additionalWorkingDirectories, [
    "/workspace/shared",
    "/workspace/vendor",
  ]);
});

test("default sidecar factory applies host metadata before the turn and after routed preparation", async () => {
  const calls: Array<{ operation?: string; provider?: string; model?: string }> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-model-metadata",
      method: "execute",
      runId: "run-model-metadata",
      operationId: "operation-model-metadata",
      requestId: "request-model-metadata",
      sessionId: "session-model-metadata",
      turnId: "turn-model-metadata",
      payload: {
        agent: { provider: "provider-a", model: "model-a", cwd: "/workspace" },
        hostModules: { model: { methods: ["prepare", "stream", "get_metadata"] } },
        messages: [{ role: "user", content: "route this request" }],
        maxTurns: 1,
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      const payload = moduleCall.payload as Record<string, unknown>;
      calls.push({
        operation: payload.operation as string | undefined,
        provider: payload.provider as string | undefined,
        model: payload.model as string | undefined,
      });
      if (payload.operation === "get_metadata") {
        return {
          kind: "response" as const,
          messageId: "metadata-response",
          inReplyTo: moduleCall.requestId,
          ok: true,
          payload: {
            metadata: {
              provider: "provider-a",
              model: "model-a",
              maxContextTokens: 8192,
              maxOutputTokens: 2048,
              tokenLimits: { maxContextTokens: 8192, maxOutputTokens: 2048 },
              protocol: "anthropic",
              supportsPromptCache: true,
            },
          },
        };
      }
      if (payload.operation === "prepare") {
        return {
          kind: "response" as const,
          messageId: "prepared-metadata-response",
          inReplyTo: moduleCall.requestId,
          ok: true,
          payload: {
            prepared: {
              request: { ...(payload.request as Record<string, unknown>), provider: "provider-b", model: "model-b" },
              provider: "provider-b",
              model: "model-b",
            },
            metadata: {
              provider: "provider-b",
              model: "model-b",
              maxContextTokens: 4096,
              maxOutputTokens: 1024,
              tokenLimits: { maxContextTokens: 4096, maxOutputTokens: 1024 },
              protocol: "openai",
              supportsPromptCache: false,
            },
          },
        };
      }
      return {
        kind: "response" as const,
        messageId: "stream-metadata-response",
        inReplyTo: moduleCall.requestId,
        ok: true,
        payload: { events: [{ type: "text_delta", text: "done" }, { type: "message_end", finishReason: "stop" }] },
      };
    },
  });

  const metadata = (execution.loop as any).capabilities.model.metadata;
  assert.equal(metadata.getModelMaxContextTokens("provider-a", "model-a"), 8192);
  assert.equal(metadata.getModelProtocol("provider-a"), "anthropic");
  assert.equal(metadata.getModelSupportsPromptCache("provider-a", "model-a"), true);

  for await (const _event of execution.loop.run(execution.input)) {
    // Run through prepare so the host-selected route can replace the snapshot.
  }

  assert.equal(metadata.getModelMaxContextTokens("provider-b", "model-b"), 4096);
  assert.equal(metadata.getModelMaxOutputTokens("provider-b", "model-b"), 1024);
  assert.equal(metadata.getModelProtocol("provider-b"), "openai");
  assert.equal(metadata.getModelSupportsPromptCache("provider-b", "model-b"), false);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.operation), ["get_metadata", "prepare", "stream"]);
});

test("default sidecar factory fails closed for malformed advertised model metadata", async () => {
  await assert.rejects(
    async () => { await createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-malformed-metadata",
        method: "execute",
        runId: "run-malformed-metadata",
        operationId: "operation-malformed-metadata",
        requestId: "request-malformed-metadata",
        sessionId: "session-malformed-metadata",
        turnId: "turn-malformed-metadata",
        payload: {
          agent: { provider: "provider-a", model: "model-a" },
          hostModules: { model: { methods: ["get_metadata"] } },
        },
      },
      abortSignal: new AbortController().signal,
      callModule: async (moduleCall) => ({
        kind: "response",
        messageId: "malformed-metadata-response",
        inReplyTo: moduleCall.requestId,
        ok: true,
        payload: { metadata: { provider: "provider-a", model: "model-a", maxContextTokens: -1 } },
      }),
    }); },
    /invalid maxContextTokens/,
  );
});

test("default sidecar factory rejects prepared metadata for a different routed model", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-mismatched-prepared-metadata",
      method: "execute",
      runId: "run-mismatched-prepared-metadata",
      operationId: "operation-mismatched-prepared-metadata",
      requestId: "request-mismatched-prepared-metadata",
      sessionId: "session-mismatched-prepared-metadata",
      turnId: "turn-mismatched-prepared-metadata",
      payload: {
        agent: { provider: "provider-a", model: "model-a" },
        hostModules: { model: { methods: ["prepare", "get_metadata"] } },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      const payload = moduleCall.payload as Record<string, unknown>;
      if (payload.operation === "get_metadata") {
        return {
          kind: "response" as const,
          messageId: "initial-metadata-response",
          inReplyTo: moduleCall.requestId,
          ok: true,
          payload: { metadata: { provider: "provider-a", model: "model-a" } },
        };
      }
      return {
        kind: "response" as const,
        messageId: "prepared-metadata-response",
        inReplyTo: moduleCall.requestId,
        ok: true,
        payload: {
          prepared: {
            request: { ...(payload.request as Record<string, unknown>), provider: "provider-b", model: "model-b" },
            provider: "provider-b",
            model: "model-b",
          },
          metadata: { provider: "provider-a", model: "model-a" },
        },
      };
    },
  });

  await assert.rejects(
    () => (execution.loop as any).capabilities.model.execution.prepare({
      request: { provider: "provider-a", model: "model-a", messages: [] },
      context: { sessionId: "session-mismatched-prepared-metadata", turnId: "turn-mismatched-prepared-metadata" },
    }),
    /does not match the prepared route/,
  );
});

test("default sidecar factory preserves every canonical media and reference block", async () => {
  const timeline = {
    version: 1 as const,
    turnId: "media-turn",
    id: "media-block",
    order: 3,
    revision: 1,
  };
  const content = [
    { type: "image", source: "url", data: "https://example.test/image.png", mimeType: "image/png", bytes: 12, detail: "high", timeline },
    { type: "pdf", source: "base64", data: "cGRm", mimeType: "application/pdf", bytes: 3, pages: 1, timeline },
    { type: "audio", source: "url", data: "https://example.test/audio.mp3", mimeType: "audio/mpeg", bytes: 24, durationSeconds: 2.5, timeline },
    { type: "tool_result_reference", toolCallId: "tool-1", path: "/tmp/tool.txt", readFilePath: "tool.txt", originalBytes: 100, preview: "preview", hasMore: true, mimeType: "text/plain", reason: "large", timeline },
    { type: "media_reference", toolCallId: "tool-2", path: "/tmp/media.png", originalBytes: 200, preview: "[image]", hasMore: false, mimeType: "image/png", mediaType: "image", detail: "low", reason: "persisted", timeline },
  ];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-media",
      method: "execute",
      runId: "run-media",
      operationId: "operation-media",
      requestId: "request-media",
      sessionId: "session-media",
      turnId: "turn-media",
      payload: { messages: [{ role: "user", content }] },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-media", inReplyTo: "call-media", ok: true }),
  });

  assert.deepEqual(execution.input.messages, [{ role: "user", content }]);
});

test("default sidecar factory preserves canonical message lifecycle metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-metadata",
      method: "execute",
      runId: "run-metadata",
      operationId: "operation-metadata",
      requestId: "request-metadata",
      payload: {
        messages: [{
          role: "assistant",
          content: [{
            type: "text",
            text: "Injected runtime context",
            blockId: "response-1:text:0",
            timeline: {
              version: 1,
              turnId: "origin-turn",
              id: "response-1:text:0",
              order: 0,
              revision: 2,
            },
          }],
          metadata: {
            model: "model-a",
            synthetic: true,
            transient: true,
            transientId: "runtime-context-1",
            purpose: "runtime_context",
            queueItemId: "queued-input-1",
            forkCarryover: { sourceSessionId: "parent-session", sourceTurnId: "parent-turn" },
            hostPrivate: "must not cross the protocol boundary",
          },
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-metadata", inReplyTo: "call-metadata", ok: true }),
  });

  assert.deepEqual(execution.input.messages, [{
    role: "assistant",
    content: [{
      type: "text",
      text: "Injected runtime context",
      blockId: "response-1:text:0",
      timeline: {
        version: 1,
        turnId: "origin-turn",
        id: "response-1:text:0",
        order: 0,
        revision: 2,
      },
    }],
    metadata: {
      model: "model-a",
      synthetic: true,
      transient: true,
      transientId: "runtime-context-1",
      purpose: "runtime_context",
      queueItemId: "queued-input-1",
      forkCarryover: { sourceSessionId: "parent-session", sourceTurnId: "parent-turn" },
    },
  }]);
});

test("default sidecar factory preserves generic subagent runtime identity and token baseline", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-subagent",
      method: "execute",
      runId: "run-subagent",
      operationId: "operation-subagent",
      requestId: "request-subagent",
      payload: {
        agent: {
          provider: "parent-provider",
          model: "parent-model",
          isSubagent: true,
          subagentModel: {
            provider: "child-provider",
            model: "child-model",
            maxContextTokens: 128_000,
            maxOutputTokens: 32_768,
          },
        },
        task: { prompt: "Run as a child." },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-subagent", inReplyTo: "call-subagent", ok: true }),
  });

  const runtimeConfig = (execution.loop as any).config;
  assert.equal(runtimeConfig.isSubagent, true);
  assert.deepEqual(runtimeConfig.subagentModel, {
    provider: "child-provider",
    model: "child-model",
    maxContextTokens: 128_000,
    maxOutputTokens: 32_768,
  });
});

test("default sidecar factory rejects malformed generic subagent model metadata", async () => {
  await assert.rejects(
    async () => createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-subagent-invalid",
        method: "execute",
        runId: "run-subagent-invalid",
        operationId: "operation-subagent-invalid",
        requestId: "request-subagent-invalid",
        payload: {
          agent: {
            isSubagent: true,
            subagentModel: { provider: "child-provider", model: "child-model", maxContextTokens: 0 },
          },
        },
      },
      abortSignal: new AbortController().signal,
      callModule: async () => ({ kind: "response", messageId: "response-subagent-invalid", inReplyTo: "call-subagent-invalid", ok: true }),
    }),
    /agent\.subagentModel\.maxContextTokens/,
  );
});

test("default sidecar factory falls back to the shared runtime-context profile", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-surface",
      method: "execute",
      runId: "run-surface",
      operationId: "operation-surface",
      requestId: "request-surface",
      payload: {
        agent: { runtimeContextSurface: "unsupported" },
        task: { prompt: "Check profile fallback." },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-surface", inReplyTo: "call-surface", ok: true }),
  });

  assert.equal((execution.loop as any).config.runtimeContextSurface, "system_prompt");
});

test("default sidecar factory validates and restores generic seed state", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        task: { prompt: "Resumed task" },
        seedState: { allowedReadFiles: ["/workspace/input.txt"] },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "operation-1");
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Resumed task" }] },
  ]);
  assert.deepEqual(execution.loop.snapshotFileState().allowedReadFiles, ["/workspace/input.txt"]);
});

test("default sidecar factory rejects malformed generic seed state", async () => {
  await assert.rejects(
    async () => createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-1",
        method: "execute",
        runId: "run-1",
        operationId: "operation-1",
        requestId: "request-1",
        payload: { seedState: { allowedReadFiles: [42] } },
      },
      abortSignal: new AbortController().signal,
      callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
    }),
    /allowedReadFiles/,
  );
});

test("default sidecar factory gives contextOverride precedence and merges metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        agent: {
          systemPrompt: "agent prompt",
          metadata: { source: "agent", stable: true, shared: "agent" },
        },
        task: { prompt: "fallback" },
        messages: [{ role: "user", content: "ordinary" }],
        tools: [{ name: "ordinary", inputSchema: { type: "object" } }],
        executionContext: { source: "execution", shared: "old" },
        contextOverride: {
          systemPrompt: "host prompt",
          messages: [{ role: "assistant", content: "host history" }],
          metadata: { shared: "new", iteration: 2 },
          tools: [{ name: "host-tool", inputSchema: { type: "object" } }],
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.deepEqual(execution.input.messages, [
    { role: "assistant", content: [{ type: "text", text: "host history" }] },
  ]);
  const runtimeConfig = (execution.loop as any).config;
  assert.equal(runtimeConfig.systemPrompt, "host prompt");
  assert.deepEqual(runtimeConfig.metadata, {
    source: "execution",
    stable: true,
    shared: "new",
    iteration: 2,
  });
});

test("default sidecar factory delegates context preparation to an advertised host module", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        hostModules: {
          context: { methods: ["prepare_for_model"] },
        },
        messages: [{ role: "user", content: "hello" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (request) => {
      calls.push(request as unknown as Record<string, unknown>);
      return {
        kind: "response",
        messageId: "response-1",
        inReplyTo: "call-1",
        ok: true,
        payload: {
          result: {
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            systemPrompt: "host system prompt",
            systemPromptParts: ["host system prompt"],
            tools: [],
            diagnostics: [],
            boundaries: [],
          },
        },
      };
    },
  });

  const context = (execution.loop as any).capabilities.context;
  const prepared = await context.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.module, "context");
  assert.equal((calls[0]?.payload as Record<string, unknown>).operation, "prepare_for_model");
  assert.equal(prepared.systemPrompt, "host system prompt");
});

test("default sidecar factory initializes an advertised host-owned plan/todo mirror", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-plan-todo",
      method: "execute",
      runId: "run-plan-todo",
      operationId: "operation-plan-todo",
      requestId: "request-plan-todo",
      sessionId: "session-plan-todo",
      turnId: "turn-plan-todo",
      payload: {
        hostModules: { capability: { methods: ["plan_todo"] } },
        messages: [{ role: "user", content: "Follow the approved plan." }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      const payload = moduleCall.payload as Record<string, unknown>;
      assert.equal(moduleCall.module, "capability");
      assert.equal(payload.operation, "plan_todo");
      assert.equal(payload.method, "read");
      return {
        kind: "response",
        messageId: "plan-todo-snapshot",
        inReplyTo: "call",
        ok: true,
        payload: {
          snapshot: {
            ...createPlanTodoSnapshot(),
            approvedPlan: "# Approved plan\nInspect then implement.",
            requiresInitialization: true,
          },
        },
      };
    },
  });

  const planTodo = (execution.loop as any).capabilities.planMode.planTodoManager.forSession("session-plan-todo");
  assert.match(planTodo.buildPromptAddendum() ?? "", /Before using any non-read-only tool/);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "plan_todo",
    method: "read",
    sessionId: "session-plan-todo",
    turnId: "turn-plan-todo",
  });
});

test("default sidecar factory injects an advertised host lifecycle runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-lifecycle",
      method: "execute",
      runId: "run-lifecycle",
      operationId: "operation-lifecycle",
      requestId: "request-lifecycle",
      sessionId: "session-lifecycle",
      turnId: "turn-lifecycle",
      payload: {
        hostModules: { lifecycle: { methods: ["dispatch"] } },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      return {
        kind: "response",
        messageId: "lifecycle-response",
        inReplyTo: "call",
        ok: true,
        payload: {
          result: {
            effects: [],
            messages: [],
            events: [],
            blockingErrors: [],
            nonBlockingErrors: [],
          },
        },
      };
    },
  });

  const lifecycle = (execution.loop as any).capabilities.hooks.lifecycle;
  assert.equal(typeof lifecycle?.dispatch, "function");
  await lifecycle.dispatch({
    event: "Stop",
    baseInput: { sessionId: "ignored", transcriptPath: "ignored", cwd: "ignored" },
    payload: { lastAssistantMessage: "complete" },
  });
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "dispatch",
    event: "Stop",
    payload: { lastAssistantMessage: "complete" },
  });
});

test("default sidecar factory forwards advertised volatile AgentLoop events before final", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-event",
      method: "execute",
      runId: "run-event",
      operationId: "operation-event",
      requestId: "request-event",
      sessionId: "session-event",
      turnId: "turn-event",
      payload: {
        hostModules: { event: { methods: ["emit"] } },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      return { kind: "response", messageId: "event-response", inReplyTo: "call", ok: true };
    },
  });

  (execution.loop as any).capabilities.events.emit({
    type: "instructions_loaded",
    sessionId: "session-event",
    turnId: "turn-event",
    hasSystemPrompt: true,
  });
  await execution.flush?.();
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "emit",
    event: {
      type: "instructions_loaded",
      sessionId: "session-event",
      turnId: "turn-event",
      hasSystemPrompt: true,
    },
  });
  assert.equal(calls[0]?.module, "event");
});

test("default sidecar factory preserves host model preparation identity after AgentLoop normalizes the prepared request", async () => {
  const calls: Array<{ operation?: string; preparationId?: string; request?: unknown }> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-model-preparation",
      method: "execute",
      runId: "run-model-preparation",
      operationId: "operation-model-preparation",
      requestId: "request-model-preparation",
      sessionId: "session-model-preparation",
      turnId: "turn-model-preparation",
      payload: {
        agent: { provider: "provider-a", model: "model-a" },
        hostModules: { model: { methods: ["prepare", "stream"] } },
        messages: [{ role: "user", content: "preserve preparation" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      const payload = moduleCall.payload as Record<string, unknown>;
      calls.push({
        operation: payload.operation as string | undefined,
        preparationId: payload.preparationId as string | undefined,
        request: structuredClone(payload.request),
      });
      if (payload.operation === "prepare") {
        return {
          kind: "response",
          messageId: "prepared-model-preparation",
          inReplyTo: moduleCall.requestId,
          ok: true,
          payload: {
            prepared: {
              request: payload.request,
              provider: "provider-a",
              model: "model-a",
            },
          },
        };
      }
      return {
        kind: "response",
        messageId: "streamed-model-preparation",
        inReplyTo: moduleCall.requestId,
        ok: true,
        payload: {
          events: [
            { type: "text_delta", text: "done" },
            { type: "message_end", finishReason: "stop" },
          ],
        },
      };
    },
  });

  for await (const _event of execution.loop.run(execution.input)) {
    // Consume the full sidecar execution so both model module calls occur.
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.operation), ["prepare", "stream"]);
  assert.equal(typeof calls[0]?.preparationId, "string");
  assert.equal(calls[1]?.preparationId, calls[0]?.preparationId);
  assert.deepEqual(calls[1]?.request, calls[0]?.request);
});

test("default sidecar factory injects only an advertised host permission module", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        hostModules: { permission: { methods: ["decide", "unknown"] } },
        messages: [{ role: "user", content: "hello" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(typeof (execution.loop as any).capabilities.permission?.decide, "function");
});

test("default sidecar factory preserves host tool interaction metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "host-interactive-tool",
          inputSchema: { type: "object" },
          requiresUserInteraction: true,
          requiredRuntimeCapabilities: ["plan_workflow"],
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  const [tool] = (execution.loop as any).toolPort.list();
  assert.equal(tool.requiresUserInteraction?.({}), true);
  assert.deepEqual(tool.requiredRuntimeCapabilities, ["plan_workflow", "user_interaction"]);
});

test("default sidecar factory retains agent capability requirements", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-agent-capability",
      method: "execute",
      runId: "run-agent-capability",
      operationId: "operation-agent-capability",
      requestId: "request-agent-capability",
      payload: {
        messages: [{ role: "user", content: "delegate this task" }],
        tools: [{
          name: "host-subagent",
          kind: "agent",
          inputSchema: { type: "object" },
          requiredRuntimeCapabilities: ["plan_workflow"],
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-agent-capability", inReplyTo: "call-agent-capability", ok: true }),
  });

  const [tool] = (execution.loop as any).toolPort.list();
  assert.equal(tool.kind, "agent");
  assert.deepEqual(tool.requiredRuntimeCapabilities, ["plan_workflow", "subagent_fork"]);
});

test("default sidecar factory installs only advertised budget, turn, and interaction capabilities", async () => {
  const calls: Array<{ module: string; operation: string }> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-host-capabilities",
      method: "execute",
      runId: "run-host-capabilities",
      operationId: "operation-host-capabilities",
      requestId: "request-host-capabilities",
      sessionId: "session-host-capabilities",
      turnId: "turn-host-capabilities",
      payload: {
        messages: [{ role: "user", content: "hello" }],
        interactionCapabilities: { elicitationAvailable: true },
        hostModules: {
          budget: {
            methods: ["estimate_request_input", "evaluate_request_budget", "estimate_usage_cost"],
          },
          turn: {
            methods: ["drain_steer", "drain_or_close_steer", "persist_compaction"],
          },
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (call) => {
      const operation = String(call.payload.operation);
      calls.push({ module: call.module, operation });
      const base = {
        kind: "response" as const,
        messageId: `response-${calls.length}`,
        inReplyTo: call.requestId,
        ok: true,
      };
      if (operation === "estimate_request_input") return { ...base, payload: { tokens: 12 } };
      if (operation === "evaluate_request_budget") {
        return {
          ...base,
          payload: {
            snapshot: {
              tokens: 12,
              maxContextTokens: 100,
              warningRatio: 0.8,
              blockingRatio: 0.9,
              state: "ok",
              ratio: 0.12,
            },
          },
        };
      }
      if (operation === "estimate_usage_cost") return { ...base, payload: { costUsd: 1 } };
      if (operation === "drain_steer") {
        return {
          ...base,
          payload: {
            messages: [{
              itemId: "steer-1",
              message: { role: "user", content: [{ type: "text", text: "continue" }] },
            }],
          },
        };
      }
      if (operation === "drain_or_close_steer") return { ...base, payload: { messages: [], closed: true } };
      if (operation === "persist_compaction") return { ...base, payload: { persisted: true } };
      throw new Error(`Unexpected operation: ${operation}`);
    },
  });

  const capabilities = (execution.loop as any).capabilities;
  assert.equal(capabilities.interaction.elicitation, undefined);
  assert.equal(capabilities.interaction.elicitationAvailable, true);
  assert.equal(await capabilities.model.budget.estimateRequestInput({ provider: "p", model: "m", messages: [] }), 12);
  assert.equal((await capabilities.model.budget.evaluateRequestBudget(
    { provider: "p", model: "m", messages: [] },
    { maxContextTokens: 100 },
  )).tokens, 12);
  assert.equal(await capabilities.model.budget.estimateUsageCost(undefined, "p", "m"), 1);
  assert.equal((await execution.input.drainSteerMessages?.())?.[0]?.itemId, "steer-1");
  assert.deepEqual(await execution.input.drainOrCloseSteerMailbox?.(), { messages: [], closed: true });
  await execution.input.onCompactPersisted?.({
    boundary: { kind: "compact", subtype: "compact_boundary", compactMetadata: {} as never },
    messages: [],
  });
  assert.deepEqual(calls.map((call) => `${call.module}.${call.operation}`), [
    "budget.estimate_request_input",
    "budget.evaluate_request_budget",
    "budget.estimate_usage_cost",
    "turn.drain_steer",
    "turn.drain_or_close_steer",
    "turn.persist_compaction",
  ]);
});

test("default sidecar factory rejects malformed advertised budget responses", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-invalid-budget",
      method: "execute",
      runId: "run-invalid-budget",
      operationId: "operation-invalid-budget",
      requestId: "request-invalid-budget",
      payload: {
        hostModules: { budget: { methods: ["estimate_usage_cost"] } },
        messages: [{ role: "user", content: "hello" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (call) => ({
      kind: "response",
      messageId: "invalid-budget-response",
      inReplyTo: call.requestId,
      ok: true,
      payload: { costUsd: -1 },
    }),
  });

  await assert.rejects(
    () => (execution.loop as any).capabilities.model.budget.estimateUsageCost(undefined, "p", "m"),
    (error: Error & { code?: string }) => error.code === "INVALID_BUDGET_RESPONSE",
  );
});

test("default sidecar factory leaves unadvertised optional host capabilities absent", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-no-optional-capabilities",
      method: "execute",
      runId: "run-no-optional-capabilities",
      operationId: "operation-no-optional-capabilities",
      requestId: "request-no-optional-capabilities",
      payload: { messages: [{ role: "user", content: "hello" }] },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => assert.fail("unadvertised capability must not issue a module call"),
  });

  assert.equal((execution.loop as any).capabilities.model.budget, undefined);
  assert.equal((execution.loop as any).capabilities.interaction.elicitationAvailable, false);
  assert.equal(execution.input.drainSteerMessages, undefined);
  assert.equal(execution.input.drainOrCloseSteerMailbox, undefined);
  assert.equal(execution.input.onCompactPersisted, undefined);
});
