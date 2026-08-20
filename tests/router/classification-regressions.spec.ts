import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelRuntime,
} from "../../src/model/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../../src/router/config/schema.js";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import { parseTier } from "../../src/router/tokenSaver/parseTier.js";

const TWO_TIER_CASES = [
  { instruction: "Explain this error", expected: "SIMPLE" },
  { instruction: "Rename one variable", expected: "SIMPLE" },
  { instruction: "Refactor the authentication module", expected: "COMPLEX" },
  { instruction: "Find and optimize the performance bottleneck", expected: "COMPLEX" },
] as const;

const TWO_TIER_CONFIG: RouterTokenSaverConfig = {
  enabled: true,
  judge: ref("judge"),
  defaultTier: "SIMPLE",
  tiers: {
    SIMPLE: { model: ref("cheap"), description: "Small edits and quick lookups" },
    COMPLEX: { model: ref("expensive"), description: "Multi-step architecture and debugging" },
  },
  rules: ["Use COMPLEX for multi-step work", "Use SIMPLE for one small edit"],
  judgeTimeoutMs: 5_000,
};

const FOUR_TIER_CONFIG: RouterTokenSaverConfig = {
  enabled: true,
  judge: ref("judge"),
  defaultTier: "medium",
  tiers: {
    simple: { model: ref("fast"), description: "Greetings and single-step answers" },
    medium: { model: ref("balanced"), description: "One tool call or a small file change" },
    complex: { model: ref("orchestrator"), description: "Sub-agent orchestration and delegation" },
    reasoning: { model: ref("deep"), description: "Deep single-agent analysis and multi-step workflows" },
  },
  rules: [
    "complex is only for sub-agent orchestration",
    "single-agent multi-step work should be reasoning",
  ],
  judgeTimeoutMs: 5_000,
};

test("classification prompts contain every benchmark instruction and tier", () => {
  for (const entry of TWO_TIER_CASES) {
    const prompt = generateJudgePrompt({ userMessage: entry.instruction, config: TWO_TIER_CONFIG });
    assert.match(prompt, new RegExp(entry.instruction));
    assert.match(prompt, /SIMPLE/);
    assert.match(prompt, /COMPLEX/);
  }
});

test("a mock judge selecting the expected tier routes every benchmark case", async () => {
  for (const entry of TWO_TIER_CASES) {
    const result = await classify(entry.instruction, TWO_TIER_CONFIG, entry.expected);
    assert.equal(result?.tier, entry.expected);
    assert.equal(result?.resolvedFrom, "judge");
  }
});

test("classification preserves a valid judge decision even when it differs from the benchmark", async () => {
  for (const entry of TWO_TIER_CASES) {
    const opposite = entry.expected === "SIMPLE" ? "COMPLEX" : "SIMPLE";
    const result = await classify(entry.instruction, TWO_TIER_CONFIG, opposite);
    assert.equal(result?.tier, opposite);
    assert.notEqual(result?.tier, entry.expected);
    assert.equal(result?.resolvedFrom, "judge");
  }
});

test("classification prompts include tier descriptions and routing rules", () => {
  const prompt = generateJudgePrompt({ userMessage: "Review this change", config: TWO_TIER_CONFIG });
  assert.match(prompt, /Small edits and quick lookups/);
  assert.match(prompt, /Multi-step architecture and debugging/);
  assert.match(prompt, /Routing rules:/);
  assert.match(prompt, /Use COMPLEX for multi-step work/);
});

test("four-tier prompts include the complete routing vocabulary", () => {
  const prompt = generateJudgePrompt({ userMessage: "Analyze this repository", config: FOUR_TIER_CONFIG });
  for (const value of ["simple", "medium", "complex", "reasoning", "sub-agent orchestration", "Routing rules:"]) {
    assert.equal(prompt.includes(value), true, value);
  }
});

test("parseTier accepts canonical lowercase tags", () => {
  const tiers = Object.keys(FOUR_TIER_CONFIG.tiers);
  assert.equal(parseTier("<tier>simple</tier>", tiers), "simple");
  assert.equal(parseTier("<tier>reasoning</tier>", tiers), "reasoning");
});

test("parseTier normalizes uppercase tagged values", () => {
  const tiers = Object.keys(FOUR_TIER_CONFIG.tiers);
  assert.equal(parseTier("<tier>SIMPLE</tier>", tiers), "simple");
  assert.equal(parseTier("<tier>REASONING</tier>", tiers), "reasoning");
});

test("parseTier falls back to an untagged known-tier mention", () => {
  assert.equal(
    parseTier("This task needs the reasoning level", Object.keys(FOUR_TIER_CONFIG.tiers)),
    "reasoning",
  );
});

test("a four-tier mock judge selects the configured model tier", async () => {
  const result = await classify("Schedule a meeting", FOUR_TIER_CONFIG, "medium");
  assert.equal(result?.tier, "medium");
  assert.equal(result?.selection.model, "balanced");
  assert.equal(result?.resolvedFrom, "judge");
});

test("owned classification fixtures cannot silently disappear", async () => {
  const cases = new Map([
    ["Say hello", "simple"],
    ["Write one file", "medium"],
    ["Delegate three independent investigations", "complex"],
    ["Analyze several datasets and produce a report", "reasoning"],
  ]);
  assert.equal(cases.size, 4);
  for (const [instruction, expected] of cases) {
    const result = await classify(instruction, FOUR_TIER_CONFIG, expected);
    assert.equal(result?.tier, expected, instruction);
  }
});

async function classify(instruction: string, config: RouterTokenSaverConfig, tier: string) {
  return classifyAndRoute({
    config,
    messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
    judgeRuntime: mockJudge(tier),
  });
}

function mockJudge(tier: string): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      throw new Error("stream is not used by classifyAndRoute");
    },
    async complete(_request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      return {
        role: "assistant",
        content: [{ type: "text", text: `<tier>${tier}</tier>` }],
        finishReason: "stop",
      };
    },
    getCapabilities(): ModelCapabilities {
      return {
        supportsToolUse: false,
        supportsStreaming: false,
        supportsParallelToolCalls: false,
        supportsThinking: false,
        supportsJsonSchema: false,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 8_192,
        maxOutputTokens: 256,
      };
    },
    getMultimodal: () => ({ input: ["text" as const] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

function ref(model: string): RouterModelRef {
  return { id: `test/${model}`, provider: "test", model };
}
