import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, CanonicalUsage, ModelRuntime } from "../../src/model/index.js";
import { ModelProviderError } from "../../src/model/index.js";
import { buildTaskCard, classifyAndRoute } from "../../src/router/index.js";
import type { TaskCard } from "../../src/router/tokenSaver/buildTaskCard.js";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import * as judgeParser from "../../src/router/tokenSaver/parseTier.js";

test("records the normalized judge error when token-saver falls back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "API key rejected by the provider.",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result?.failure, {
    reason: "model_error",
    attempts: 1,
    code: "auth_error",
    message: "API key rejected by the provider.",
  });
});

test("retries a retryable judge provider error before falling back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "server_error",
        message: "Provider temporarily unavailable.",
        retryable: true,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 3);
  assert.equal(result?.failure?.attempts, 3);
});

test("redacts credentials from a judge error before returning diagnostics", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "Authorization: Bearer super-secret-token apiKey=also-secret",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(
    result?.failure?.message,
    "Authorization: Bearer <redacted> apiKey=<redacted>",
  );
});

test("records a plain network error message when the judge request fails", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new TypeError("fetch failed");
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.failure?.message, "fetch failed");
});

test("omits temperature for an Anthropic judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "anthropic",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.tier, "medium");
  assert.equal(request?.temperature, undefined);
});

test("omits temperature for an OpenAI-compatible judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "openai",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(request?.temperature, undefined);
});

test("aborts the judge request when its classification timeout expires", async () => {
  let aborted = false;
  const judgeRuntime = {
    complete: async (_request: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal?.reason);
        }, { once: true });
      }),
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: { ...config(), judgeTimeoutMs: 500 },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(aborted, true);
  assert.deepEqual(result?.failure, {
    reason: "timeout",
    attempts: 1,
    code: "judge_timeout",
  });
});

function config() {
  return {
    enabled: true,
    judge: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" },
    defaultTier: "medium",
    judgeTimeoutMs: 5_000,
    tiers: {
      medium: { model: { id: "main/main-model", provider: "main", model: "main-model" } },
    },
  };
}

function judgeReturning(
  text: string,
  options?: { usage?: CanonicalUsage; onRequest?: (request: CanonicalModelRequest) => void },
): ModelRuntime {
  return {
    complete: async (request: CanonicalModelRequest) => {
      options?.onRequest?.(request);
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        ...(options?.usage ? { usage: options.usage } : {}),
      };
    },
  } as unknown as ModelRuntime;
}

// ---- Task 2: judge dual-tag compatibility protocol ----

test("tier-only judge output still succeeds (compat)", async () => {
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime: judgeReturning("<tier>medium</tier>"),
  });

  assert.equal(result?.tier, "medium");
  assert.equal(result?.resolvedFrom, "judge");
  assert.equal(result?.isNewTask, undefined);
  assert.equal(result?.judgeUsage, undefined);
  assert.equal(result?.judgeAttempts, 1);
});

test("tier + <new_task>yes</new_task> returns isNewTask === true", async () => {
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "brand new task" }] }],
    judgeRuntime: judgeReturning("<tier>medium</tier>\n<new_task>yes</new_task>"),
  });

  assert.equal(result?.tier, "medium");
  assert.equal(result?.resolvedFrom, "judge");
  assert.equal(result?.isNewTask, true);
});

test("tier + <new_task>no</new_task> returns isNewTask === false", async () => {
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    judgeRuntime: judgeReturning("<tier>medium</tier>\n<new_task>no</new_task>"),
  });

  assert.equal(result?.tier, "medium");
  assert.equal(result?.isNewTask, false);
});

for (const [label, newTaskTag] of [
  ["missing", ""],
  ["maybe", "<new_task>maybe</new_task>"],
  ["empty", "<new_task></new_task>"],
  ["misspelled", "<new_task>yess</new_task>"],
] as const) {
  test(`malformed/uncertain new_task (${label}) yields isNewTask undefined without breaking the tier`, async () => {
    const result = await classifyAndRoute({
      config: config(),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      judgeRuntime: judgeReturning(`<tier>medium</tier>\n${newTaskTag}`),
    });

    assert.equal(result?.tier, "medium");
    assert.equal(result?.resolvedFrom, "judge");
    assert.equal(result?.isNewTask, undefined);
  });
}

test("fenced code blocks and case differences are tolerated for both tags", async () => {
  const fenced = "```xml\n<TIER>MEDIUM</TIER>\n<NEW_TASK>YES</NEW_TASK>\n```";
  const decision = judgeParser.parseJudgeDecision(fenced, ["medium"]);
  assert.equal(decision.tier, "medium");
  assert.equal(decision.isNewTask, true);

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime: judgeReturning(fenced),
  });
  assert.equal(result?.tier, "medium");
  assert.equal(result?.isNewTask, true);
});

test("parseJudgeDecision keeps fallback semantics when the tier is unknown", () => {
  assert.deepEqual(judgeParser.parseJudgeDecision("<tier>unknown</tier><new_task>yes</new_task>", ["medium"]), {
    isNewTask: true,
  });
  assert.deepEqual(judgeParser.parseJudgeDecision("no tags at all", ["medium"]), {});
});

test("judge prompt with a task card contains only the four allowed card fields", () => {
  const card: TaskCard = {
    goal: "Implement the judge dual-tag protocol",
    phase: "execute",
    keyFiles: [
      "src/router/tokenSaver/parseTier.ts",
      "src/router/tokenSaver/generateJudgePrompt.ts",
    ],
    taskDone: false,
    updatedAt: 1_720_000_000_000,
  };

  const prompt = generateJudgePrompt({ userMessage: "continue", config: config(), taskCard: card });

  assert.match(prompt, /<goal>Implement the judge dual-tag protocol<\/goal>/);
  assert.match(prompt, /<phase>execute<\/phase>/);
  assert.match(prompt, /parseTier\.ts/);
  assert.match(prompt, /generateJudgePrompt\.ts/);
  assert.match(prompt, /<task_done>false<\/task_done>/);
  // updatedAt, todo history and any snapshot internals must not leak into the prompt.
  assert.doesNotMatch(prompt, /1_?720_?000_?000_?000/);
  assert.match(prompt, /<tier>reasoning<\/tier>/);
  assert.match(prompt, /<new_task>yes\|no<\/new_task>/);
  // previousTier is background context only, no forced inheritance wording.
  const withPrevious = generateJudgePrompt({
    userMessage: "go",
    config: config(),
    taskCard: card,
    previousTier: "medium",
  });
  assert.doesNotMatch(withPrevious, /MUST return <tier>/i);
  assert.match(withPrevious, /medium/);
});

test("judge prompt derived from a snapshot card excludes todo history and full plan text", () => {
  const card = buildTaskCard(
    {
      approvedPlan: "Implement judge protocol\nexpand parser with second tag\nthen wire classifier",
      requiresInitialization: false,
      todos: [
        { content: "todo-history-item-secret", status: "in_progress" },
        { content: "another todo", status: "pending" },
      ],
      activeTodoCount: 2,
      allCompleted: false,
      keyFiles: ["src/router/tokenSaver/parseTier.ts"],
    },
    1_720_000_000_000,
  );
  assert.ok(card);

  const prompt = generateJudgePrompt({ userMessage: "go on", config: config(), taskCard: card });

  assert.match(prompt, /<goal>Implement judge protocol<\/goal>/);
  assert.doesNotMatch(prompt, /expand parser with second tag/);
  assert.doesNotMatch(prompt, /todo-history-item-secret/);
  assert.doesNotMatch(prompt, /1_?720_?000_?000_?000/);
});

test("judge prompt omits the card section entirely when no card is provided", () => {
  const prompt = generateJudgePrompt({ userMessage: "hi", config: config() });
  assert.doesNotMatch(prompt, /<task_card>/);
  assert.doesNotMatch(prompt, /## Current task card/);

  const withPrevious = generateJudgePrompt({ userMessage: "hi", config: config(), previousTier: "medium" });
  assert.doesNotMatch(withPrevious, /## Current task card/);
});

test("judge prompt card text respects the 1500 char budget, truncating the goal before the file list and never cutting XML tags", () => {
  const longGoal = "g".repeat(600);
  const longFiles = Array.from({ length: 5 }, (_, i) => `file-${i}-`.padEnd(240, "x"));
  const card: TaskCard = {
    goal: longGoal,
    phase: "execute",
    keyFiles: longFiles,
    taskDone: false,
    updatedAt: 1,
  };

  const prompt = generateJudgePrompt({ userMessage: "continue", config: config(), taskCard: card });
  const start = prompt.indexOf("<task_card>");
  const end = prompt.indexOf("</task_card>");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = prompt.slice(start, end + "</task_card>".length);

  assert.ok(block.length <= 1500, `card block is ${block.length} chars, exceeds 1500 budget`);
  assert.match(block, /<goal>g+(\.\.\.)?<\/goal>/);
  const goalMatch = /<goal>(g+)(?:\.\.\.)?<\/goal>/.exec(block);
  assert.ok(goalMatch);
  assert.ok(goalMatch[1].length < 600, "goal should be truncated first");
  // The file list survives intact once the goal absorbs the truncation.
  for (const file of longFiles) {
    assert.ok(block.includes(file), `file entry ${file.slice(0, 12)}… was cut`);
  }
  assert.ok(block.endsWith("</task_card>"));
});

test("judge response usage is returned verbatim as judgeUsage", async () => {
  const usage: CanonicalUsage = {
    inputTokens: 42,
    outputTokens: 7,
    cacheReadTokens: 13,
    cacheWriteTokens: 3,
    totalTokens: 65,
    nativeCost: 0.00123,
  };

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime: judgeReturning("<tier>medium</tier>", { usage }),
  });

  assert.deepEqual(result?.judgeUsage, usage);
});

test("judgeUsage is undefined when the response carries no usage", async () => {
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime: judgeReturning("<tier>medium</tier>"),
  });

  assert.equal(result?.judgeUsage, undefined);
});

test("judgeAttempts equals the attempt number that actually produced the parsed result", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      return {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: attempts === 1 ? "cannot decide" : "<tier>medium</tier>",
          },
        ],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 2);
  assert.equal(result?.tier, "medium");
  assert.equal(result?.judgeAttempts, 2);
});

test("failure path does not fabricate isNewTask or judgeUsage", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "API key rejected by the provider.",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.resolvedFrom, "fallback");
  assert.equal(result?.isNewTask, undefined);
  assert.equal(result?.judgeUsage, undefined);
  assert.equal(result?.judgeAttempts, undefined);
});
