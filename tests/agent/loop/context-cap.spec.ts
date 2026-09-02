import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { requestFingerprint } from "../../../src/model/streaming/requestFingerprint.js";
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

test("main agent loop ignores matching subagent baseline caps", async () => {
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
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(1_000, input.maxContextTokens ?? 1_000_000, {
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
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };

  const loop = new AgentLoop({
    provider: "openai",
    model: "same-model",
    cwd: "/workspace/project",
    maxContextTokens: 8_000,
    maxOutputTokens: 1_000,
    subagentModel: {
      provider: "openai",
      model: "same-model",
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
    },
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
      if (provider === "openai" && model === "same-model") {
        return { maxContextTokens: 128_000, maxOutputTokens: 32_768 };
      }
      return undefined;
    },
  });

  for await (const _event of loop.run({
    sessionId: "main-agent-matching-subagent-baseline",
    turnId: "turn-main-agent-matching-subagent-baseline",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Drain the turn.
  }

  assert.deepEqual(budgetEvaluations, [
    { maxContextTokens: 8_000, reservedOutputTokens: 1_000 },
  ]);
});

test("subagent loop applies baseline caps after router keeps the baseline model", async () => {
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
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(1_000, input.maxContextTokens ?? 1_000_000, {
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
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };

  const loop = new AgentLoop({
    provider: "child",
    model: "baseline",
    cwd: "/workspace/project",
    isSubagent: true,
    subagentModel: {
      provider: "child",
      model: "baseline",
      maxContextTokens: 200_000,
      maxOutputTokens: 12_345,
    },
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
      if (provider === "child" && model === "baseline") {
        return { maxContextTokens: 200_000, maxOutputTokens: 12_345 };
      }
      return undefined;
    },
  });

  for await (const _event of loop.run({
    sessionId: "subagent-baseline-caps",
    turnId: "turn-baseline-caps",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Drain the turn.
  }

  assert.deepEqual(budgetEvaluations, [
    { maxContextTokens: 1_000_000, reservedOutputTokens: 12_345 },
    { maxContextTokens: 200_000, reservedOutputTokens: 12_345 },
  ]);
});

test("subagent loop uses routed model caps when router picks a smaller model than the baseline", async () => {
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
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(1_000, input.maxContextTokens ?? 1_000_000, {
          reservedOutputTokens: input.reservedOutputTokens,
        }),
      };
    },
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async () => ({
      provider: "child",
      model: "small-routed",
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "tokenSaver",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };

  const loop = new AgentLoop({
    provider: "child",
    model: "large-baseline",
    cwd: "/workspace/project",
    isSubagent: true,
    subagentModel: {
      provider: "child",
      model: "large-baseline",
      maxContextTokens: 200_000,
      maxOutputTokens: 32_768,
    },
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
      if (provider !== "child") return undefined;
      if (model === "large-baseline") {
        return { maxContextTokens: 200_000, maxOutputTokens: 32_768 };
      }
      if (model === "small-routed") {
        return { maxContextTokens: 32_000, maxOutputTokens: 4_096 };
      }
      return undefined;
    },
  });

  for await (const _event of loop.run({
    sessionId: "subagent-routed-smaller-caps",
    turnId: "turn-routed-smaller-caps",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Drain the turn.
  }

  assert.deepEqual(budgetEvaluations, [
    { maxContextTokens: 1_000_000, reservedOutputTokens: 32_768 },
    { maxContextTokens: 32_000, reservedOutputTokens: 0 },
  ]);
});

test("subagent loop does not precompress to a smaller baseline when router picks a larger model", async () => {
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
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(1_000, input.maxContextTokens ?? 1_000_000, {
          reservedOutputTokens: input.reservedOutputTokens,
        }),
      };
    },
  };

  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async () => ({
      provider: "child",
      model: "large-routed",
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "tokenSaver",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };

  const loop = new AgentLoop({
    provider: "child",
    model: "small-baseline",
    cwd: "/workspace/project",
    isSubagent: true,
    subagentModel: {
      provider: "child",
      model: "small-baseline",
      maxContextTokens: 32_000,
      maxOutputTokens: 4_096,
    },
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
      if (provider !== "child") return undefined;
      if (model === "small-baseline") {
        return { maxContextTokens: 32_000, maxOutputTokens: 4_096 };
      }
      if (model === "large-routed") {
        return { maxContextTokens: 200_000, maxOutputTokens: 32_768 };
      }
      return undefined;
    },
  });

  for await (const _event of loop.run({
    sessionId: "subagent-routed-larger-caps",
    turnId: "turn-routed-larger-caps",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Drain the turn.
  }

  assert.deepEqual(budgetEvaluations, [
    { maxContextTokens: 1_000_000, reservedOutputTokens: 4_096 },
    { maxContextTokens: 200_000, reservedOutputTokens: 0 },
  ]);
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
      summaryGenerated: true,
      checkpointMerged: false,
      finalRatio: 40,
      extra: {
        tier: "full",
        summarySucceeded: true,
      },
    },
  });
  assert.equal(persistedCompacts[0]!.messages.length, 1);
  assert.equal(persistedCompacts[0]!.messages[0]!.metadata?.compactReplacement, true);
  assert.equal(persistedCompacts[0]!.messages[0]!.metadata?.compactSnapshotId, "compact-auto-1");
});

test("agent loop persists a full compaction after recovering from a context error", async () => {
  const persistedCompacts: Array<{ boundary: unknown; messages: CanonicalMessage[] }> = [];
  const tokenBudget = new TokenBudgetManager();
  let compactCalls = 0;
  let executeCalls = 0;
  const recoveryBudgetRequests: Array<{ provider?: string; model?: string }> = [];

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
    tryAutoCompact: async (compactInput) => {
      compactCalls += 1;
      if (compactCalls !== 2) {
        return { type: "skipped", snapshot: tokenBudget.snapshotFromTokens(90, 100) };
      }
      assert.ok(compactInput.budgetEvaluator);
      await compactInput.budgetEvaluator(compactInput.messages);
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
      evaluateRequestBudget: async (candidate: unknown) => {
        const request = candidate as { provider?: string; model?: string };
        recoveryBudgetRequests.push({ provider: request.provider, model: request.model });
        return tokenBudget.snapshotFromTokens(20, 100);
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });
  const calibrations = (loop as unknown as { tokenCalibrationByRoute: Map<string, unknown> }).tokenCalibrationByRoute;
  calibrations.set("openai/model-a", {
    provider: "openai",
    model: "model-a",
    actualInputTokens: 90,
    estimatedInputTokens: 60,
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
  assert.deepEqual(recoveryBudgetRequests, [{ provider: "openai", model: "model-a" }]);
  assert.equal(calibrations.size, 0);
});

test("agent loop does not calibrate a primary route from fallback usage", async () => {
  const router: AgentRouterRuntime = {
    decide: async () => ({
      provider: "primary",
      model: "model-a",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "request_started", provider: "fallback", model: "model-b" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "completed by fallback" };
      yield { type: "message_end", finishReason: "stop" };
      yield { type: "usage", usage: { inputTokens: 50_000, outputTokens: 20 } };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
  };
  const loop = new AgentLoop({
    provider: "primary",
    model: "model-a",
    cwd: "/workspace/project",
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
    tokenAccounting: {
      estimateRequestInput: () => 40_000,
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });

  for await (const _event of loop.run({
    sessionId: "fallback-calibration",
    turnId: "fallback-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  })) {
    // Drain the completed turn.
  }

  const calibrations = (loop as unknown as { tokenCalibrationByRoute: Map<string, unknown> }).tokenCalibrationByRoute;
  assert.equal(calibrations.size, 0);
});

test("agent loop skips calibration when a same-route request was transformed", async () => {
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
      const transformed = {
        ...request,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "media removed" }] }],
      };
      yield {
        type: "request_started",
        provider: request.provider,
        model: request.model,
        requestFingerprint: requestFingerprint(transformed),
      };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "completed" };
      yield { type: "message_end", finishReason: "stop" };
      yield { type: "usage", usage: { inputTokens: 50_000, outputTokens: 20 } };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {},
    materializeRequest: (_decision, request) => request,
    observeUsage: () => undefined,
  };
  const loop = new AgentLoop({
    provider: "openai",
    model: "model-a",
    cwd: "/workspace/project",
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
    tokenAccounting: {
      estimateRequestInput: () => 40_000,
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });

  for await (const _event of loop.run({
    sessionId: "transformed-calibration",
    turnId: "transformed-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  })) {
    // Drain the completed turn.
  }

  const calibrations = (loop as unknown as { tokenCalibrationByRoute: Map<string, unknown> }).tokenCalibrationByRoute;
  assert.equal(calibrations.size, 0);
});
