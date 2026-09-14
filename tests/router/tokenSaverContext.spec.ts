import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import {
  buildJudgeContext,
  classifyAndRoute,
  detectExplicitRiskTier,
  parseJudgeDecision,
  parseJudgeDecisionFromThinking,
  TokenStatsCollector,
} from "../../src/router/index.js";

test("builds a bounded context packet around the current user turn", () => {
  const context = buildJudgeContext({
    messages: [
      user("Refactor the router across several files and run the full test suite."),
      assistant("I changed the parser but the implementation and tests are still unfinished."),
      user("继续这个项目"),
    ],
    previousTier: "reasoning",
    availableToolCount: 12,
  });

  assert.equal(context?.currentUserMessage, "继续这个项目");
  assert.match(context?.previousTaskMessage ?? "", /Refactor the router/);
  assert.match(context?.previousAssistantTail ?? "", /still unfinished/);
  assert.equal(context?.previousTier, "reasoning");
  assert.equal(context?.continuationKind, "action");
  assert.equal(context?.features.availableToolCount, 12);
});

test("does not treat an explicit new task as a continuation", () => {
  const context = buildJudgeContext({
    messages: [
      user("Refactor ten files and run tests."),
      assistant("The implementation is unfinished."),
      user("换个问题，1+1 等于几？"),
    ],
    previousTier: "reasoning",
  });

  assert.equal(context?.hasNewTaskSignal, true);
  assert.equal(context?.continuationKind, "none");
});

test("distinguishes an actionable approval from a terminal acknowledgement", () => {
  const actionable = buildJudgeContext({
    messages: [
      user("Implement the router change."),
      assistant("是否现在开始执行并运行测试？"),
      user("好的"),
    ],
    previousTier: "reasoning",
  });
  const terminal = buildJudgeContext({
    messages: [
      user("Implement the router change."),
      assistant("修改和测试已经全部完成。"),
      user("好的"),
    ],
    previousTier: "reasoning",
  });

  assert.equal(actionable?.continuationKind, "action_confirmation");
  assert.equal(terminal?.continuationKind, "acknowledgement");
});

test("bounds raw text and never copies tool-result payloads into judge context", () => {
  const secretPayload = "DO_NOT_COPY_TOOL_PAYLOAD_".repeat(100);
  const context = buildJudgeContext({
    messages: [
      user("A".repeat(2_000)),
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId: "tool-1",
          content: [{ type: "text", text: secretPayload }],
        }],
      },
      assistant("B".repeat(1_000)),
      user("Please continue with the second approach."),
    ],
    options: {
      maxCurrentMessageChars: 80,
      maxPreviousTaskChars: 120,
      maxAssistantTailChars: 90,
    },
  });

  assert.ok((context?.previousTaskMessage?.length ?? 0) <= 120);
  assert.ok((context?.previousAssistantTail?.length ?? 0) <= 90);
  assert.doesNotMatch(JSON.stringify(context), /DO_NOT_COPY_TOOL_PAYLOAD/);
  assert.ok((context?.features.textCharacterCount ?? 0) > secretPayload.length);
  assert.equal(context?.features.toolResultCount, 1);
});

test("honors even very small configured context limits", () => {
  const context = buildJudgeContext({
    messages: [user("previous task"), assistant("assistant tail"), user("current request")],
    options: {
      maxCurrentMessageChars: 3,
      maxPreviousTaskChars: 2,
      maxAssistantTailChars: 1,
    },
  });
  assert.equal(context?.currentUserMessage.length, 3);
  assert.equal(context?.previousTaskMessage?.length, 2);
  assert.equal(context?.previousAssistantTail?.length, 1);
});

test("skips the judge and preserves the previous tier for an action continuation", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Modify multiple router files, run tests, and prepare the commit."),
      assistant("The work stopped before tests."),
      user("继续这个项目"),
    ],
    previousTier: "reasoning",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response("<tier>simple</tier>");
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "continuation_gate");
  assert.equal(result?.diagnostics?.judgeInvoked, false);
});

test("uses the same continuation gate for an approval of an assistant action question", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Implement and test the multi-file change."),
      assistant("是否现在开始执行并运行测试？"),
      user("好的"),
    ],
    previousTier: "reasoning",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response("<tier>simple</tier>");
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "continuation_gate");
});

test("skips the judge for a pure English continuation phrase", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Read one log file and identify the latest error."),
      assistant("The tool call was interrupted."),
      user("proceed with the task"),
    ],
    previousTier: "medium",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response("<tier>simple</tier>");
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "medium");
  assert.equal(result?.resolvedFrom, "continuation_gate");
});

test("recognizes bounded references to unfinished prior work as continuations", () => {
  const references = [
    "把第二个方案实现掉",
    "修复刚才那个问题",
    "再试一次",
    "按上面的要求做完",
    "Please finish the previous approach.",
  ];

  for (const currentMessage of references) {
    const context = buildJudgeContext({
      messages: [
        user("Analyze the repository and prepare two implementation approaches."),
        assistant("The selected approach is not implemented yet."),
        user(currentMessage),
      ],
      previousTier: "reasoning",
    });
    assert.equal(context?.continuationKind, "action", currentMessage);
  }
});

test("chooses the highest explicit risk tier when risk signals overlap", () => {
  assert.equal(
    detectExplicitRiskTier(
      "Analyze the entire repository and delegate independent modules to three agents in parallel.",
    ),
    "reasoning",
  );
});

test("does not over-route ordinary single-file or single-paper requests", () => {
  assert.equal(detectExplicitRiskTier("Summarize one routing paper."), undefined);
  assert.equal(detectExplicitRiskTier("Run the tests for this one file."), undefined);
});

test("judges a terminal acknowledgement instead of blindly inheriting", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Implement and test the multi-file change."),
      assistant("The implementation and tests are complete."),
      user("好的"),
    ],
    previousTier: "reasoning",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response(
        "<tier>simple</tier>\n<confidence>0.96</confidence>\n<task_relation>new_task</task_relation>",
      );
    }),
  });

  assert.equal(judgeCalls, 1);
  assert.equal(result?.tier, "simple");
  assert.equal(result?.resolvedFrom, "judge");
});

test("sends bounded task context as data and stable instructions as system prompt", async () => {
  let captured: CanonicalModelRequest | undefined;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Diagnose a failure spanning several files and logs."),
      assistant("I found two candidate causes; choose the second approach to continue."),
      user("按照第二个方案处理"),
    ],
    previousTier: "reasoning",
    availableToolCount: 9,
    judgeRuntime: runtime(async (request) => {
      captured = request;
      return response(
        "<tier>simple</tier>\n<confidence>0.92</confidence>\n<task_relation>continuation</task_relation>",
        { inputTokens: 180, outputTokens: 14, totalTokens: 194 },
      );
    }),
  });

  const payload = captured?.messages[0]?.content[0];
  assert.match(captured?.systemPrompt ?? "", /reliably complete the current turn/);
  assert.equal(payload?.type, "text");
  assert.match(payload?.type === "text" ? payload.text : "", /previous_task_anchor/);
  assert.match(payload?.type === "text" ? payload.text : "", /availableToolCount/);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "relation_guard");
  assert.equal(result?.diagnostics?.judgeProposedTier, "simple");
  assert.equal(result?.diagnostics?.judgeUsage?.totalTokens, 194);
});

test("preserves previous complexity for a low-confidence ambiguous follow-up", async () => {
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Analyze the repository architecture and implement the migration."),
      assistant("There are two possible migration paths."),
      user("把它处理一下"),
    ],
    previousTier: "reasoning",
    judgeRuntime: runtime(async () => response(
      "<tier>simple</tier>\n<confidence>0.42</confidence>\n<task_relation>unclear</task_relation>",
    )),
  });

  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "confidence_guard");
});

test("allows a continuation to upgrade when the current turn adds harder work", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Answer a short question."),
      assistant("The answer is ready."),
      user("继续，但现在请分析整个仓库并修改多个文件"),
    ],
    previousTier: "simple",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response(
        "<tier>reasoning</tier>\n<confidence>0.94</confidence>\n<task_relation>continuation</task_relation>",
      );
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "risk_gate");
});

test("routes explicit parallel subagent delegation through the complex risk gate", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [user("把调研、编码和测试并行委派给三个子智能体。")],
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response("<tier>medium</tier>");
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "complex");
  assert.equal(result?.resolvedFrom, "risk_gate");
});

test("routes an explicit multi-paper cited report through the reasoning risk gate", async () => {
  let judgeCalls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [user("New task: compare five routing papers and produce a cited technical report.")],
    previousTier: "simple",
    judgeRuntime: runtime(async () => {
      judgeCalls += 1;
      return response("<tier>medium</tier>");
    }),
  });

  assert.equal(judgeCalls, 0);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.resolvedFrom, "risk_gate");
});

test("allows a confident independent task to replace prior complexity", async () => {
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Analyze and refactor ten files."),
      assistant("The refactor is still in progress."),
      user("换个问题，1+1 等于几？"),
    ],
    previousTier: "reasoning",
    judgeRuntime: runtime(async () => response(
      "<tier>simple</tier>\n<confidence>0.99</confidence>\n<task_relation>new_task</task_relation>",
    )),
  });

  assert.equal(result?.tier, "simple");
  assert.equal(result?.resolvedFrom, "judge");
});

test("parses decimal and percentage confidence without breaking tier-only judges", () => {
  assert.deepEqual(
    parseJudgeDecision(
      "<tier>medium</tier>\n<confidence>83%</confidence>\n<task_relation>new task</task_relation>",
      ["simple", "medium"],
    ),
    { tier: "medium", confidence: 0.83, taskRelation: "new_task" },
  );
  assert.deepEqual(
    parseJudgeDecision("<tier>simple</tier>", ["simple", "medium"]),
    { tier: "simple", taskRelation: "unclear" },
  );
  assert.deepEqual(
    parseJudgeDecisionFromThinking(
      "The previous tier was simple, but this now needs repository analysis, so reasoning tier.",
      ["simple", "medium", "complex", "reasoning"],
    ),
    { tier: "reasoning", taskRelation: "unclear" },
  );
  assert.equal(
    parseJudgeDecisionFromThinking(
      "The previous tier was simple and more analysis is needed.",
      ["simple", "medium", "complex", "reasoning"],
    ),
    undefined,
  );
});

test("recovers a truncated Judge decision from the thinking block without retrying", async () => {
  let calls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [
      user("Investigate the issue and propose two approaches."),
      assistant("Two approaches remain, and the implementation is unfinished."),
      user("Use the second approach and finish it."),
    ],
    previousTier: "simple",
    judgeRuntime: runtime(async () => {
      calls += 1;
      return {
        role: "assistant" as const,
        content: [{
          type: "thinking" as const,
          text: "The previous tier was simple. The new work requires multi-file analysis, so reasoning tier.",
        }],
        finishReason: "length" as const,
        usage: { inputTokens: 500, outputTokens: 128, totalTokens: 628 },
      };
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result?.tier, "reasoning");
  assert.equal(result?.diagnostics?.judgeResponseSource, "thinking");
  assert.equal(result?.diagnostics?.judgeFinishReason, "length");
});

test("accumulates judge token usage across parse retries", async () => {
  let calls = 0;
  const result = await classifyAndRoute({
    config: routingConfig(),
    messages: [user("Classify this independent task.")],
    judgeRuntime: runtime(async () => {
      calls += 1;
      if (calls === 1) {
        return response("invalid", { inputTokens: 100, outputTokens: 5, totalTokens: 105 });
      }
      return response(
        "<tier>medium</tier>\n<confidence>0.9</confidence>\n<task_relation>new_task</task_relation>",
        { inputTokens: 110, outputTokens: 10, totalTokens: 120 },
      );
    }),
  });

  assert.equal(result?.diagnostics?.judgeAttempts, 2);
  assert.equal(result?.diagnostics?.judgeUsage?.inputTokens, 210);
  assert.equal(result?.diagnostics?.judgeUsage?.outputTokens, 15);
  assert.equal(result?.diagnostics?.judgeUsage?.totalTokens, 225);
});

test("aggregates judge attempts, skips, latency, tokens, cost, and resolution", () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  const collector = new TokenStatsCollector({
    enabled: true,
    filePath: join(directory, "stats.jsonl"),
  });
  const timestamp = new Date().toISOString();

  try {
    collector.observe({
      sessionId: "judge-session",
      scenarioType: "default",
      resolvedFrom: "tokenSaver",
      provider: "test",
      model: "medium",
      tier: "medium",
      usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
      tokenSaverRouting: {
        resolution: "confidence_guard",
        judgeInvoked: true,
        judgeAttempts: 2,
        judgeLatencyMs: 125,
        judgeUsage: { inputTokens: 210, outputTokens: 15, totalTokens: 225, nativeCost: 0.002 },
        continuationKind: "none",
        previousTierAvailable: false,
        context: {
          messageCount: 1,
          userMessageCount: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          failedToolResultCount: 0,
          mediaCount: 0,
          textCharacterCount: 20,
          availableToolCount: 0,
          currentMessageChars: 20,
          previousTaskChars: 0,
          assistantTailChars: 0,
          hasNewTaskSignal: false,
        },
      },
      startedAt: timestamp,
      endedAt: timestamp,
    });
    collector.observe({
      sessionId: "gate-session",
      scenarioType: "default",
      resolvedFrom: "tokenSaver",
      provider: "test",
      model: "reasoning",
      tier: "reasoning",
      usage: { inputTokens: 400, outputTokens: 40, totalTokens: 440 },
      tokenSaverRouting: {
        resolution: "continuation_gate",
        judgeInvoked: false,
        judgeAttempts: 0,
        judgeLatencyMs: 0,
        continuationKind: "action",
        previousTierAvailable: true,
        context: {
          messageCount: 3,
          userMessageCount: 2,
          toolCallCount: 0,
          toolResultCount: 0,
          failedToolResultCount: 0,
          mediaCount: 0,
          textCharacterCount: 60,
          availableToolCount: 0,
          currentMessageChars: 6,
          previousTaskChars: 30,
          assistantTailChars: 24,
          hasNewTaskSignal: false,
        },
      },
      startedAt: timestamp,
      endedAt: timestamp,
    });

    const stats = collector.snapshot();
    assert.equal(stats.judgeRequests, 2);
    assert.equal(stats.judgeSkipped, 1);
    assert.equal(stats.totalJudgeLatencyMs, 125);
    assert.equal(stats.totalJudgeInputTokens, 210);
    assert.equal(stats.totalJudgeOutputTokens, 15);
    assert.equal(stats.totalJudgeNativeCost, 0.002);
    assert.deepEqual(stats.perTokenSaverResolution, {
      confidence_guard: 1,
      continuation_gate: 1,
    });
  } finally {
    collector.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function response(text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    finishReason: "stop" as const,
    usage,
  };
}

function runtime(
  complete: (request: CanonicalModelRequest) => Promise<CanonicalModelResponse>,
): ModelRuntime {
  return { complete } as unknown as ModelRuntime;
}

function routingConfig() {
  const model = (name: string) => ({ id: `test/${name}`, provider: "test", model: name });
  return {
    enabled: true,
    judge: model("judge"),
    defaultTier: "medium",
    judgeTimeoutMs: 5_000,
    contextAware: {
      enabled: true,
      continuationGate: true,
      confidenceThreshold: 0.7,
      maxCurrentMessageChars: 2_000,
      maxPreviousTaskChars: 800,
      maxAssistantTailChars: 400,
    },
    tiers: {
      simple: { model: model("simple") },
      medium: { model: model("medium") },
      complex: { model: model("complex") },
      reasoning: { model: model("reasoning") },
    },
  };
}
