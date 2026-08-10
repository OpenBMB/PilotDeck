import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/protocol/canonical.js";

test("agent loop respects agent maxContextTokens before and after routing", async () => {
  const tokenBudget = new TokenBudgetManager();
  const budgetEvaluations: Array<{ maxContextTokens?: number; reservedOutputTokens?: number }> = [];

  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({
      messages: input.messages,
      diagnostics: [],
    }),
    recoverFromModelError: async () => ({
      type: "give_up",
      reason: "test",
    }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(
          10_000,
          100,
          { reservedOutputTokens: input.reservedOutputTokens },
        ),
      };
    },
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: "model-b",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };

  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "model-a",
    cwd: "/workspace/project",
    maxContextTokens: 8_000,
    maxOutputTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number; reservedOutputTokens?: number }) => {
        budgetEvaluations.push({
          maxContextTokens: options.maxContextTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        });
        return tokenBudget.snapshotFromTokens(10_000, options.maxContextTokens, {
          reservedOutputTokens: options.reservedOutputTokens,
        });
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    getModelTokenLimits(provider, model) {
      if (provider !== "openai") return undefined;
      if (model === "model-a") {
        return { maxContextTokens: 32_768, maxOutputTokens: 32_768 };
      }
      if (model === "model-b") {
        return { maxContextTokens: 16_384, maxOutputTokens: 32_768 };
      }
      return undefined;
    },
  };

  const loop = new AgentLoop(config, dependencies);

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  })) {
    events.push(event);
  }

  assert.equal(budgetEvaluations.length, 1);
  assert.equal(budgetEvaluations[0]!.maxContextTokens, 8_000);
  assert.equal(budgetEvaluations[0]!.reservedOutputTokens, 32_768);
  assert.ok(events.some((event) => event.type === "context_budget"));
});

test("agent loop does not reserve catalog max output for compaction unless requested", async () => {
  const tokenBudget = new TokenBudgetManager();
  const budgetEvaluations: Array<{ maxContextTokens?: number; reservedOutputTokens?: number }> = [];

  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({
      messages: input.messages,
      diagnostics: [],
    }),
    recoverFromModelError: async () => ({
      type: "give_up",
      reason: "test",
    }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(1_000, 20_000, {
          reservedOutputTokens: input.reservedOutputTokens,
        }),
      };
    },
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };

  const config: AgentRuntimeConfig = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    cwd: "/workspace/project",
    maxContextTokens: 20_000,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number; reservedOutputTokens?: number }) => {
        budgetEvaluations.push({
          maxContextTokens: options.maxContextTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        });
        return tokenBudget.snapshotFromTokens(1_000, options.maxContextTokens, {
          reservedOutputTokens: options.reservedOutputTokens,
        });
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    getModelTokenLimits(provider, model) {
      if (provider === "deepseek" && model === "deepseek-v4-pro") {
        return { maxContextTokens: 1_048_576, maxOutputTokens: 393_216 };
      }
      return undefined;
    },
  };

  const loop = new AgentLoop(config, dependencies);

  for await (const _event of loop.run({
    sessionId: "session-no-catalog-reserve",
    turnId: "turn-no-catalog-reserve",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  })) {
    // Drain the turn.
  }

  assert.equal(budgetEvaluations.length, 1);
  assert.equal(budgetEvaluations[0]!.maxContextTokens, 20_000);
  assert.equal(budgetEvaluations[0]!.reservedOutputTokens, 0);
});

test("agent loop records a compact boundary when auto compaction fires", async () => {
  const persistedCompacts: Array<{ boundary: unknown; messages: CanonicalMessage[] }> = [];
  const tokenBudget = new TokenBudgetManager();

  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({
      messages: input.messages,
      diagnostics: [],
    }),
    recoverFromModelError: async () => ({
      type: "give_up",
      reason: "test",
    }),
    captureTurn: async () => undefined,
    tryAutoCompact: async () => ({
      type: "compacted",
      tier: "full",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "kept tail" }],
        },
      ],
      snapshot: tokenBudget.snapshotFromTokens(40, 32_768, { reservedOutputTokens: 32_768 }),
      result: {
        compactionId: "compact-auto-1",
        trigger: "auto",
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 1,
        summaryMessage: {
          role: "assistant",
          content: [{ type: "text", text: "summary" }],
        },
        boundaryMarker: {
          role: "user",
          content: [{ type: "text", text: "boundary" }],
        },
        messagesToKeep: [
          {
            role: "user",
            content: [{ type: "text", text: "kept tail" }],
          },
        ],
        attachments: [],
        hookResults: [],
        diagnostics: [],
      },
    }),
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: "model-a",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };

  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "model-a",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number; reservedOutputTokens?: number }) => {
        return tokenBudget.snapshotFromTokens(40, options.maxContextTokens, {
          reservedOutputTokens: options.reservedOutputTokens,
        });
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    getModelTokenLimits(provider, model) {
      if (provider !== "openai") return undefined;
      if (model === "model-a") {
        return { maxContextTokens: 32_768, maxOutputTokens: 32_768 };
      }
      return undefined;
    },
  };

  const loop = new AgentLoop(config, dependencies);

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "session-2",
    turnId: "turn-2",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old reply" }],
      },
    ],
    onCompactPersisted: ({ boundary, messages }) => {
      persistedCompacts.push({ boundary, messages });
    },
  })) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.equal(persistedCompacts.length, 1);
  assert.deepEqual(persistedCompacts[0]!.boundary, {
    kind: "compact",
    subtype: "compact_boundary",
    compactMetadata: {
      compactionId: "compact-auto-1",
      trigger: "auto",
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 1,
      extra: {
        tier: "full",
        summarySucceeded: true,
      },
    },
  });
  assert.equal(persistedCompacts[0]!.messages.length, 1);
  assert.equal(persistedCompacts[0]!.messages[0]!.metadata?.compactReplacement, true);
});

test("agent loop persists a full compaction after recovering from a context error", async () => {
  const persistedCompacts: Array<{ boundary: unknown; messages: CanonicalMessage[] }> = [];
  const tokenBudget = new TokenBudgetManager();
  let compactCalls = 0;
  let executeCalls = 0;

  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "compact_and_retry", reason: "provider-context-limit" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async () => {
      compactCalls += 1;
      if (compactCalls !== 2) {
        return { type: "skipped", snapshot: tokenBudget.snapshotFromTokens(90, 100) };
      }
      return {
        type: "compacted",
        tier: "full",
        messages: [{ role: "user", content: [{ type: "text", text: "compacted tail" }] }],
        snapshot: tokenBudget.snapshotFromTokens(20, 100),
        result: {
          compactionId: "compact-reactive-1",
          trigger: "reactive",
          preTokens: 90,
          postTokens: 20,
          messagesSummarized: 1,
          summaryMessage: { role: "assistant", content: [{ type: "text", text: "summary" }] },
          boundaryMarker: { role: "user", content: [{ type: "text", text: "boundary" }] },
          messagesToKeep: [{ role: "user", content: [{ type: "text", text: "compacted tail" }] }],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        },
      };
    },
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      executeCalls += 1;
      if (executeCalls === 1) {
        yield {
          type: "error",
          error: {
            provider: "openai",
            protocol: "openai",
            code: "context_overflow",
            message: "context length exceeded",
            retryable: false,
            recoverableViaCompact: true,
          },
        };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "recovered" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "unused" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };

  const loop = new AgentLoop({
    provider: "openai",
    model: "model-a",
    cwd: "/workspace/project",
    maxContextTokens: 100,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  }, {
    router,
    tools: { registry: new ToolRegistry(), scheduler: { async executeAll() { return []; } } },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async () => tokenBudget.snapshotFromTokens(20, 100),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });

  for await (const _event of loop.run({
    sessionId: "session-reactive-compact",
    turnId: "turn-reactive-compact",
    messages: [
      { role: "user", content: [{ type: "text", text: "large earlier request" }] },
      { role: "assistant", content: [{ type: "text", text: "large earlier response" }] },
    ],
    onCompactPersisted: ({ boundary, messages }) => {
      persistedCompacts.push({ boundary, messages });
    },
  })) {
    // Drain the recovered turn.
  }

  assert.equal(executeCalls, 2);
  assert.equal(persistedCompacts.length, 1);
  assert.equal((persistedCompacts[0]!.boundary as { kind?: string }).kind, "compact");
  assert.equal(persistedCompacts[0]!.messages[0]!.metadata?.compactReplacement, true);
});
