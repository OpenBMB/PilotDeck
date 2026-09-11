import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CanonicalModelRequest,
  CanonicalUsage,
  ModelRuntime,
  ModelRuntimeOptions,
} from "../../src/model/index.js";
import { ModelProviderError } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import type { TaskSnapshot } from "../../src/router/tokenSaver/buildTaskCard.js";

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
};

function runtimeWithJudge(
  replies: Array<string | Error>,
  usage: CanonicalUsage = { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
) {
  const judgeRequests: CanonicalModelRequest[] = [];
  let judgeCalls = 0;
  const modelRuntime: ModelRuntime = {
    async *stream(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {},
    async complete() {
      throw new Error("main complete not used");
    },
    getCapabilities: () => capabilities,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: provider => `https://${provider}.invalid`,
  };
  const judgeRuntime = {
    ...modelRuntime,
    async complete(request: CanonicalModelRequest) {
      judgeRequests.push(request);
      const reply = replies[Math.min(judgeCalls, replies.length - 1)];
      judgeCalls += 1;
      if (reply instanceof Error) throw reply;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: reply }],
        finishReason: "stop" as const,
        usage,
      };
    },
  } satisfies ModelRuntime;
  return { modelRuntime, judgeRuntime, judgeRequests, getJudgeCalls: () => judgeCalls };
}

function config(): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: ref("main", "default") },
    tokenSaver: {
      enabled: true,
      judge: ref("judge", "judge-model"),
      defaultTier: "medium",
      judgeTimeoutMs: 5_000,
      tiers: {
        simple: { model: ref("main", "simple-model") },
        medium: { model: ref("main", "medium-model") },
        reasoning: { model: ref("main", "reasoning-model") },
      },
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0, upgradePolicy: "guard" },
    },
    stats: { enabled: false },
  };
}

function ref(provider: string, model: string) {
  return { id: `${provider}/${model}`, provider, model };
}

function request(text: string): CanonicalModelRequest {
  return {
    provider: "main",
    model: "default",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

function snapshot(goal: string, status: "pending" | "in_progress" | "completed" = "in_progress"): TaskSnapshot {
  return {
    approvedPlan: goal,
    requiresInitialization: false,
    todos: [{ content: goal, status }],
    activeTodoCount: status === "completed" ? 0 : 1,
    allCompleted: status === "completed",
    keyFiles: [`src/${goal.replace(/\s+/g, "-")}.ts`],
  };
}

function promptText(request: CanonicalModelRequest): string {
  return request.messages.flatMap(message => message.content)
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

test("continuation inherits sticky selection and performs zero additional judge calls", async () => {
  const harness = runtimeWithJudge(["<tier>reasoning</tier><new_task>no</new_task>"]);
  const configured = config();
  configured.autoOrchestrate = {
    enabled: true,
    triggerTiers: ["reasoning"],
    slimSystemPrompt: false,
  };
  const router = createRouterRuntime(configured, harness);
  await router.decide({
    request: request("implement the router"),
    sessionId: "continuation",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("implement the router") },
  });

  const decision = await router.decide({
    request: request("继续"),
    sessionId: "continuation",
    isMainAgent: true,
    metadata: {
      continuation: {
        matched: true,
        previousTier: "reasoning",
        previousProvider: "main",
        previousModel: "reasoning-model",
      },
    },
  });

  assert.equal(harness.getJudgeCalls(), 1);
  assert.equal(decision.provider, "main");
  assert.equal(decision.model, "reasoning-model");
  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.resolvedFrom, "tokenSaver");
  assert.equal(decision.orchestrating, true);
  assert.deepEqual(decision.mutations.orchestrationActivated, {
    tier: "reasoning",
    continued: true,
  });
  assert.deepEqual(decision.mutations.taskCardRoute, {
    shortCircuited: true,
    hasCard: true,
    judgeCalled: false,
    reason: "continuation",
    fromPhase: "execute",
    toPhase: "execute",
  });
  await router.shutdown();
});

test("explicit routing cannot be overwritten by continuation metadata", async () => {
  const harness = runtimeWithJudge(["<tier>reasoning</tier>"]);
  const router = createRouterRuntime(config(), harness);
  const decision = await router.decide({
    request: request("继续"),
    sessionId: "explicit-continuation",
    isMainAgent: true,
    metadata: {
      explicitProvider: "chosen",
      explicitModel: "chosen-model",
      continuation: {
        matched: true,
        previousTier: "reasoning",
        previousProvider: "main",
        previousModel: "reasoning-model",
      },
    },
  });

  assert.equal(harness.getJudgeCalls(), 0);
  assert.equal(decision.provider, "chosen");
  assert.equal(decision.model, "chosen-model");
  assert.equal(decision.resolvedFrom, "explicit");
  assert.equal(decision.mutations.taskCardRoute, undefined);
  await router.shutdown();
});

test("peekSticky is read-only and invalidateSticky returns the same prior selection", async () => {
  const harness = runtimeWithJudge(["<tier>reasoning</tier>"]);
  const router = createRouterRuntime(config(), harness);
  await router.decide({ request: request("hard task"), sessionId: "peek", isMainAgent: true });

  const peeked = router.peekSticky("peek");
  const invalidated = router.invalidateSticky("peek");

  assert.deepEqual(peeked, {
    previousTier: "reasoning",
    previousProvider: "main",
    previousModel: "reasoning-model",
    orchestrating: false,
  });
  assert.deepEqual(invalidated, peeked);
  await router.shutdown();
});

test("peekSticky does not refresh LRU order and disabled routing reports no selection", async () => {
  const harness = runtimeWithJudge([
    "<tier>simple</tier>",
    "<tier>medium</tier>",
    "<tier>reasoning</tier>",
  ]);
  const store = new SessionRouterStore({ capacity: 2 });
  const router = createRouterRuntime(config(), { ...harness, sessionStore: store });
  await router.decide({ request: request("first"), sessionId: "oldest", isMainAgent: true });
  await router.decide({ request: request("second"), sessionId: "newest", isMainAgent: true });

  assert.equal(router.peekSticky("oldest").previousTier, "simple");
  await router.decide({ request: request("third"), sessionId: "replacement", isMainAgent: true });
  assert.equal(router.peekSticky("oldest").previousTier, undefined);
  assert.equal(router.peekSticky("newest").previousTier, "medium");
  await router.shutdown();

  const disabled = createRouterRuntime({ ...config(), enabled: false }, harness);
  assert.deepEqual(disabled.peekSticky("missing"), { orchestrating: false });
  await disabled.shutdown();
});

test("snapshot card persists and is supplied to the next ordinary judge request", async () => {
  const harness = runtimeWithJudge([
    "<tier>medium</tier><new_task>no</new_task>",
    "<tier>medium</tier><new_task>no</new_task>",
  ]);
  const router = createRouterRuntime(config(), harness);
  await router.decide({
    request: request("start"),
    sessionId: "card-persist",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("persistent goal") },
  });
  router.invalidateSticky("card-persist");
  await router.decide({ request: request("next step"), sessionId: "card-persist", isMainAgent: true });

  assert.equal(harness.getJudgeCalls(), 2);
  assert.match(promptText(harness.judgeRequests[1]!), /<goal>persistent goal<\/goal>/);
  assert.match(promptText(harness.judgeRequests[1]!), /src\/persistent-goal\.ts/);
  await router.shutdown();
});

test("completed prior task is reset before the judge sees a new ordinary message", async () => {
  const harness = runtimeWithJudge([
    "<tier>medium</tier><new_task>no</new_task>",
    "<tier>simple</tier><new_task>no</new_task>",
  ]);
  const router = createRouterRuntime(config(), harness);
  await router.decide({
    request: request("finish old task"),
    sessionId: "done-reset",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("old completed goal", "completed") },
  });
  router.invalidateSticky("done-reset");
  const decision = await router.decide({
    request: request("unrelated simple question"),
    sessionId: "done-reset",
    isMainAgent: true,
  });

  const secondPrompt = promptText(harness.judgeRequests[1]!);
  assert.doesNotMatch(secondPrompt, /old completed goal/);
  assert.doesNotMatch(secondPrompt, /old-completed-goal\.ts/);
  assert.equal(decision.mutations.taskCardRoute?.reason, "task_done_reset");
  assert.equal(decision.mutations.taskCardRoute?.hasCard, false);
  await router.shutdown();
});

test("judge new_task replaces the prior card with the current snapshot", async () => {
  const harness = runtimeWithJudge([
    "<tier>medium</tier><new_task>no</new_task>",
    "<tier>medium</tier><new_task>yes</new_task>",
  ]);
  const store = new SessionRouterStore();
  const router = createRouterRuntime(config(), { ...harness, sessionStore: store });
  await router.decide({
    request: request("old work"),
    sessionId: "new-task",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("old goal") },
  });
  router.invalidateSticky("new-task");
  const decision = await router.decide({
    request: request("new work"),
    sessionId: "new-task",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("new goal") },
  });

  assert.equal(decision.mutations.taskCardRoute?.isNewTask, true);
  assert.equal(store.get("new-task", false)?.taskCard?.goal, "new goal");
  assert.notEqual(store.get("new-task", false)?.taskCard?.goal, "old goal");
  await router.shutdown();
});

test("judge fallback preserves an unfinished card and invalidateSticky preserves it too", async () => {
  const failure = new ModelProviderError({
    provider: "judge",
    protocol: "openai",
    code: "auth_error",
    message: "not configured",
    retryable: false,
  });
  const harness = runtimeWithJudge([
    "<tier>medium</tier><new_task>no</new_task>",
    failure,
  ]);
  const store = new SessionRouterStore();
  const router = createRouterRuntime(config(), { ...harness, sessionStore: store });
  await router.decide({
    request: request("ongoing"),
    sessionId: "fallback-card",
    isMainAgent: true,
    metadata: { taskSnapshot: snapshot("unfinished goal") },
  });
  router.invalidateSticky("fallback-card");
  assert.equal(store.get("fallback-card", false)?.taskCard?.goal, "unfinished goal");

  const decision = await router.decide({
    request: request("keep going"),
    sessionId: "fallback-card",
    isMainAgent: true,
  });
  assert.equal(decision.mutations.taskCardRoute?.reason, "fallback");
  assert.equal(store.get("fallback-card", false)?.taskCard?.goal, "unfinished goal");
  await router.shutdown();
});

test("execute persists decision evidence and separately priced judge usage to JSONL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-runtime-stats-"));
  try {
    const judgeUsage = { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 };
    const harness = runtimeWithJudge(["<tier>medium</tier><new_task>no</new_task>"], judgeUsage);
    const configured = config();
    configured.zeroUsageRetry = { enabled: false, maxAttempts: 1 };
    configured.stats = {
      enabled: true,
      filePath: join(dir, "stats.json"),
      modelPricing: {
        "judge/judge-model": { input: 2, output: 4 },
        "main/medium-model": { input: 1, output: 1 },
      },
    };
    const router = createRouterRuntime(configured, harness);
    const modelRequest = request("collect routing evidence");
    const decision = await router.decide({
      request: modelRequest,
      sessionId: "runtime-stats",
      isMainAgent: true,
      metadata: { taskSnapshot: snapshot("collect routing evidence") },
    });
    for await (const _event of router.execute(decision, modelRequest, {
      sessionId: "runtime-stats",
      turnId: "turn-1",
      projectPath: "/workspace/project",
    })) {
      // Drain the production execute path so it writes the stats record.
    }
    await router.shutdown();

    const line = (await readFile(join(dir, "stats.jsonl"), "utf8")).trim();
    const persisted = JSON.parse(line);
    assert.deepEqual(persisted.routing.taskCardRoute, decision.mutations.taskCardRoute);
    assert.deepEqual(persisted.judge, {
      called: true,
      attempts: 1,
      usage: judgeUsage,
      cost: 4,
    });
    assert.equal(persisted.usage.inputTokens > 0, true);
    assert.equal(persisted.usage.inputTokens, persisted.usage.totalTokens);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
