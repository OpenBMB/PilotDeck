import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createModelRuntime,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalUsage,
  type ModelRuntime,
} from "../../../src/model/index.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import type { RouterTokenSaverConfig } from "../../../src/router/config/schema.js";
import { classifyAndRoute } from "../../../src/router/index.js";
import { parseTier } from "../../../src/router/tokenSaver/parseTier.js";

if (process.env.PILOTDECK_RUN_REAL_ROUTER_CONTEXT_E2E !== "1") {
  throw new Error(
    "Set PILOTDECK_RUN_REAL_ROUTER_CONTEXT_E2E=1 to run the paid real-provider router benchmark.",
  );
}

type BenchmarkCase = {
  id: string;
  expectedTier: string;
  previousTier: string;
  messages: CanonicalMessage[];
};

type CaseResult = {
  id: string;
  expectedTier: string;
  previousTier: string;
  currentUserMessage: string;
  predictedTier: string;
  correct: boolean;
  underRouted: boolean;
  judgeCalls: number;
  latencyMs: number;
  usage: CanonicalUsage;
  resolution: string;
  proposedTier?: string;
  confidence?: number;
  taskRelation?: string;
  continuationKind?: string;
  hasNewTaskSignal?: boolean;
};

type Summary = {
  cases: number;
  correct: number;
  accuracy: number;
  underRouted: number;
  underRouteRate: number;
  judgeCalls: number;
  judgeCallsPerCase: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  nativeCost: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
};

async function main(): Promise<void> {
  const snapshot = loadPilotConfig({ projectRoot: process.cwd() });
  const config = snapshot.config.router?.tokenSaver;
  if (!config?.enabled) {
    throw new Error("router.tokenSaver.enabled must be true in the active PilotDeck configuration.");
  }

  const requiredTiers = ["simple", "medium", "complex", "reasoning"];
  for (const tier of requiredTiers) {
    if (!config.tiers[tier]) {
      throw new Error(`The real router benchmark requires a configured ${tier} tier.`);
    }
  }

  const caseLimit = parseCaseLimit(process.env.PILOTDECK_ROUTER_BENCH_CASE_LIMIT, CASES.length);
  const cases = CASES.slice(0, caseLimit);
  const runtime = createModelRuntime(snapshot.config.model);
  const baseline: CaseResult[] = [];
  const optimized: CaseResult[] = [];

  for (const benchmarkCase of cases) {
    baseline.push(await runLegacyCase(runtime, config, benchmarkCase));
    optimized.push(await runContextAwareCase(runtime, config, benchmarkCase));
  }

  const baselineSummary = summarize(baseline);
  const optimizedSummary = summarize(optimized);
  const report = {
    benchmark: "PilotDeck context-aware TokenSaver routing",
    generatedAt: new Date().toISOString(),
    judge: `${config.judge.provider}/${config.judge.model}`,
    note: "Latency is router decision latency before the execution model starts; it is not end-to-end answer TTFT.",
    baseline: {
      description: "Repository baseline: last user message plus previous tier in a single Judge prompt.",
      summary: baselineSummary,
      cases: baseline,
    },
    optimized: {
      description: "Bounded task context, deterministic continuation gate, confidence and relation guards.",
      summary: optimizedSummary,
      calibration: buildThresholdCalibration(optimized, config.defaultTier),
      cases: optimized,
    },
    delta: buildDelta(baselineSummary, optimizedSummary),
  };

  const outputPath = resolve(
    process.env.PILOTDECK_ROUTER_BENCH_OUTPUT
      ?? `artifacts/router-context-benchmark-${Date.now()}.json`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ outputPath, ...report }, null, 2));
}

async function runLegacyCase(
  modelRuntime: ModelRuntime,
  tokenSaver: RouterTokenSaverConfig,
  benchmarkCase: BenchmarkCase,
): Promise<CaseResult> {
  const currentUserMessage = lastUserText(benchmarkCase.messages);
  const request: CanonicalModelRequest = {
    provider: tokenSaver.judge.provider,
    model: tokenSaver.judge.model,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: generateLegacyPrompt(currentUserMessage, benchmarkCase.previousTier, tokenSaver),
      }],
    }],
    maxOutputTokens: 256,
    thinking: { enabled: false },
    stream: false,
  };
  const startedAt = performance.now();
  let attempts = 0;
  let usage: CanonicalUsage = {};
  let predictedTier: string | undefined;

  while (!predictedTier && attempts < 3) {
    attempts += 1;
    const response = await modelRuntime.complete(request);
    usage = addUsage(usage, response.usage);
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    predictedTier = parseTier(text, Object.keys(tokenSaver.tiers));
  }

  const finalTier = predictedTier ?? tokenSaver.defaultTier;
  return makeResult({
    benchmarkCase,
    currentUserMessage,
    predictedTier: finalTier,
    judgeCalls: attempts,
    latencyMs: performance.now() - startedAt,
    usage,
    resolution: predictedTier ? "judge" : "fallback",
  });
}

async function runContextAwareCase(
  modelRuntime: ModelRuntime,
  tokenSaver: RouterTokenSaverConfig,
  benchmarkCase: BenchmarkCase,
): Promise<CaseResult> {
  const startedAt = performance.now();
  const decision = await classifyAndRoute({
    config: tokenSaver,
    messages: benchmarkCase.messages,
    previousTier: benchmarkCase.previousTier,
    judgeRuntime: modelRuntime,
    sessionId: `router-context-benchmark-${benchmarkCase.id}`,
  });
  if (!decision) throw new Error(`TokenSaver returned no decision for ${benchmarkCase.id}.`);

  return makeResult({
    benchmarkCase,
    currentUserMessage: lastUserText(benchmarkCase.messages),
    predictedTier: decision.tier,
    judgeCalls: decision.diagnostics?.judgeAttempts ?? 0,
    latencyMs: performance.now() - startedAt,
    usage: decision.diagnostics?.judgeUsage ?? {},
    resolution: decision.resolvedFrom,
    proposedTier: decision.diagnostics?.judgeProposedTier,
    confidence: decision.diagnostics?.judgeConfidence,
    taskRelation: decision.diagnostics?.taskRelation,
    continuationKind: decision.diagnostics?.continuationKind,
    hasNewTaskSignal: decision.diagnostics?.context.hasNewTaskSignal,
  });
}

function makeResult(input: {
  benchmarkCase: BenchmarkCase;
  currentUserMessage: string;
  predictedTier: string;
  judgeCalls: number;
  latencyMs: number;
  usage: CanonicalUsage;
  resolution: string;
  proposedTier?: string;
  confidence?: number;
  taskRelation?: string;
  continuationKind?: string;
  hasNewTaskSignal?: boolean;
}): CaseResult {
  const expectedRank = tierRank(input.benchmarkCase.expectedTier);
  const predictedRank = tierRank(input.predictedTier);
  return {
    id: input.benchmarkCase.id,
    expectedTier: input.benchmarkCase.expectedTier,
    previousTier: input.benchmarkCase.previousTier,
    currentUserMessage: input.currentUserMessage,
    predictedTier: input.predictedTier,
    correct: input.predictedTier === input.benchmarkCase.expectedTier,
    underRouted: predictedRank < expectedRank,
    judgeCalls: input.judgeCalls,
    latencyMs: round(input.latencyMs),
    usage: input.usage,
    resolution: input.resolution,
    ...(input.proposedTier ? { proposedTier: input.proposedTier } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.taskRelation ? { taskRelation: input.taskRelation } : {}),
    ...(input.continuationKind ? { continuationKind: input.continuationKind } : {}),
    ...(input.hasNewTaskSignal === undefined
      ? {}
      : { hasNewTaskSignal: input.hasNewTaskSignal }),
  };
}

function summarize(results: CaseResult[]): Summary {
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const correct = results.filter((result) => result.correct).length;
  const underRouted = results.filter((result) => result.underRouted).length;
  const judgeCalls = sum(results.map((result) => result.judgeCalls));
  const totalInputTokens = sum(results.map((result) => result.usage.inputTokens ?? 0));
  const totalOutputTokens = sum(results.map((result) => result.usage.outputTokens ?? 0));
  const totalTokens = sum(results.map((result) => result.usage.totalTokens ?? 0));
  const nativeCost = sum(results.map((result) => result.usage.nativeCost ?? 0));
  return {
    cases: results.length,
    correct,
    accuracy: ratio(correct, results.length),
    underRouted,
    underRouteRate: ratio(underRouted, results.length),
    judgeCalls,
    judgeCallsPerCase: ratio(judgeCalls, results.length),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    nativeCost: round(nativeCost, 8),
    averageLatencyMs: round(sum(latencies) / Math.max(1, latencies.length)),
    p95LatencyMs: round(percentile(latencies, 0.95)),
  };
}

function buildDelta(baseline: Summary, optimized: Summary) {
  return {
    accuracyPoints: round((optimized.accuracy - baseline.accuracy) * 100),
    underRouteRatePoints: round((optimized.underRouteRate - baseline.underRouteRate) * 100),
    judgeCallReduction: reduction(baseline.judgeCalls, optimized.judgeCalls),
    inputTokenReduction: reduction(baseline.totalInputTokens, optimized.totalInputTokens),
    outputTokenReduction: reduction(baseline.totalOutputTokens, optimized.totalOutputTokens),
    nativeCostReduction: reduction(baseline.nativeCost, optimized.nativeCost),
    averageRoutingLatencyReduction: reduction(
      baseline.averageLatencyMs,
      optimized.averageLatencyMs,
    ),
    estimatedAveragePreExecutionDelaySavedMs: round(
      baseline.averageLatencyMs - optimized.averageLatencyMs,
    ),
  };
}

function buildThresholdCalibration(results: CaseResult[], defaultTier: string) {
  const rows = [0.5, 0.6, 0.7, 0.8, 0.9].map((threshold) => {
    const predictions = results.map((result) => routeAtThreshold(result, defaultTier, threshold));
    const correct = predictions.filter((tier, index) => tier === results[index]!.expectedTier).length;
    const underRouted = predictions.filter(
      (tier, index) => tierRank(tier) < tierRank(results[index]!.expectedTier),
    ).length;
    return {
      threshold,
      accuracy: ratio(correct, results.length),
      underRouteRate: ratio(underRouted, results.length),
    };
  });
  const recommended = [...rows].sort((left, right) =>
    left.underRouteRate - right.underRouteRate
      || right.accuracy - left.accuracy
      || left.threshold - right.threshold)[0]!;
  return {
    selectionRule: "minimize under-route rate, then maximize exact-tier accuracy",
    recommendedThreshold: recommended.threshold,
    rows,
  };
}

function routeAtThreshold(result: CaseResult, defaultTier: string, threshold: number): string {
  const proposedTier = result.proposedTier;
  if (!proposedTier) return result.predictedTier;
  if (
    result.taskRelation === "continuation"
    && !result.hasNewTaskSignal
    && tierRank(proposedTier) < tierRank(result.previousTier)
  ) return result.previousTier;
  if (result.confidence === undefined || result.confidence >= threshold) return proposedTier;

  const candidates = [proposedTier, defaultTier];
  if (
    !result.hasNewTaskSignal
    && (result.taskRelation === "continuation"
      || result.taskRelation === "unclear"
      || result.continuationKind === "acknowledgement")
  ) candidates.push(result.previousTier);
  return candidates.reduce((highest, tier) =>
    tierRank(tier) > tierRank(highest) ? tier : highest);
}

function generateLegacyPrompt(
  userMessage: string,
  previousTier: string,
  config: RouterTokenSaverConfig,
): string {
  const tierLines = Object.entries(config.tiers)
    .map(([name, tier]) => `- ${name}${tier.description ? `: ${tier.description}` : ""}`)
    .join("\n");
  const ruleLines = (config.rules ?? []).map((rule) => `- ${rule}`).join("\n");
  const rulesSection = ruleLines ? `\nRouting rules:\n${ruleLines}\n` : "";
  const previousTierSection = `\n## CRITICAL RULE — Continuation messages\nThe previous turn was classified as: **${previousTier}**.\nShort messages like \"go\", \"continue\", \"ok\", \"yes\", \"好的\", \"继续\", \"开始\", \"冲\" etc. are continuations of the previous task. They are NOT new simple requests.\nFor ANY message that is clearly a continuation or acknowledgment of the previous task, you MUST return <tier>${previousTier}</tier>.\nOnly reclassify if the user message introduces a genuinely NEW task with different complexity.\n`;
  return `You are a model-tier classifier for the PilotDeck router. Given the following user message, return exactly one tier wrapped in <tier>...</tier>.\n\nAvailable tiers:\n${tierLines}\n${rulesSection}${previousTierSection}\nUser message:\n\"\"\"\n${userMessage}\n\"\"\"\n\nDefault tier when uncertain: ${config.defaultTier}.\nRespond with only <tier>NAME</tier>.`;
}

function lastUserText(messages: CanonicalMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) throw new Error("Benchmark case has no user message.");
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function addUsage(left: CanonicalUsage, right: CanonicalUsage | undefined): CanonicalUsage {
  if (!right) return left;
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
    nativeCost: (left.nativeCost ?? 0) + (right.nativeCost ?? 0),
  };
}

function tierRank(tier: string): number {
  const ranks: Record<string, number> = { simple: 0, medium: 1, complex: 2, reasoning: 3 };
  return ranks[tier] ?? 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 6);
}

function reduction(baseline: number, optimized: number): number | null {
  return baseline === 0 ? null : round((baseline - optimized) / baseline, 6);
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)]!;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseCaseLimit(raw: string | undefined, maximum: number): number {
  if (!raw) return maximum;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`PILOTDECK_ROUTER_BENCH_CASE_LIMIT must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

const CASES: BenchmarkCase[] = [
  {
    id: "continue-reasoning-project",
    expectedTier: "reasoning",
    previousTier: "reasoning",
    messages: [
      user("分析整个仓库的路由架构，修改多个文件并运行完整测试。"),
      assistant("解析器已修改，但主链路集成和测试还没有完成。"),
      user("继续这个项目"),
    ],
  },
  {
    id: "continue-complex-delegation",
    expectedTier: "complex",
    previousTier: "complex",
    messages: [
      user("把调研、实现和实验拆给三个子智能体并最终汇总。"),
      assistant("两个子智能体已完成，实验子任务仍在运行。"),
      user("继续"),
    ],
  },
  {
    id: "approve-medium-edit",
    expectedTier: "medium",
    previousTier: "medium",
    messages: [
      user("修改一个配置文件并做一次针对性测试。"),
      assistant("是否现在开始修改并运行测试？"),
      user("好的"),
    ],
  },
  {
    id: "approve-reasoning-research",
    expectedTier: "reasoning",
    previousTier: "reasoning",
    messages: [
      user("联网调研五篇论文，比较方法并输出有引用的报告。"),
      assistant("需要我继续检索并完成综合报告吗？"),
      user("可以"),
    ],
  },
  {
    id: "continue-medium-tool",
    expectedTier: "medium",
    previousTier: "medium",
    messages: [
      user("读取一个日志文件并找出最后一次错误。"),
      assistant("读取被临时中断，尚未返回结果。"),
      user("proceed with the task"),
    ],
  },
  {
    id: "continue-simple-answer",
    expectedTier: "simple",
    previousTier: "simple",
    messages: [
      user("用一句话解释什么是缓存。"),
      assistant("我可以现在给出一句话解释。"),
      user("开始吧"),
    ],
  },
  {
    id: "resolve-second-plan",
    expectedTier: "reasoning",
    previousTier: "reasoning",
    messages: [
      user("诊断跨多个模块的并发故障，提出两个修复方案。"),
      assistant("方案一改锁粒度；方案二引入有界队列。目前尚未实现。"),
      user("把第二个方案实现掉"),
    ],
  },
  {
    id: "resolve-prior-failure",
    expectedTier: "reasoning",
    previousTier: "reasoning",
    messages: [
      user("修改路由器并运行全量测试，定位所有回归。"),
      assistant("全量测试发现四个失败，我还没有完成归因。"),
      user("修复刚才那个问题"),
    ],
  },
  {
    id: "retry-tool-workflow",
    expectedTier: "medium",
    previousTier: "medium",
    messages: [
      user("调用工具读取当前 Git 分支和状态。"),
      assistant("第一次工具调用因临时超时失败。"),
      user("再试一次"),
    ],
  },
  {
    id: "complete-above-requirements",
    expectedTier: "reasoning",
    previousTier: "reasoning",
    messages: [
      user("按验收标准完成多文件实现、测试、文档和提交。"),
      assistant("实现已完成，但测试和文档还没做。"),
      user("按上面的要求做完"),
    ],
  },
  {
    id: "new-simple-task",
    expectedTier: "simple",
    previousTier: "reasoning",
    messages: [
      user("分析十个文件并重构路由系统。"),
      assistant("重构仍在进行。"),
      user("换个问题，1+1 等于几？"),
    ],
  },
  {
    id: "new-medium-task",
    expectedTier: "medium",
    previousTier: "reasoning",
    messages: [
      user("完成跨模块性能分析。"),
      assistant("分析尚未完成。"),
      user("另外，帮我写一个单文件 Python 排序脚本。"),
    ],
  },
  {
    id: "new-reasoning-task",
    expectedTier: "reasoning",
    previousTier: "simple",
    messages: [
      user("你好。"),
      assistant("你好！"),
      user("New task: compare five routing papers and produce a cited technical report."),
    ],
  },
  {
    id: "replace-with-simple-task",
    expectedTier: "simple",
    previousTier: "complex",
    messages: [
      user("并行委派三个智能体完成项目。"),
      assistant("子任务正在运行。"),
      user("忽略之前的任务，只回答：北京是中国首都吗？"),
    ],
  },
  {
    id: "continuation-upgrade-to-reasoning",
    expectedTier: "reasoning",
    previousTier: "simple",
    messages: [
      user("回答一个简短问题。"),
      assistant("答案已给出。"),
      user("继续，但现在请分析整个仓库并修改多个文件。"),
    ],
  },
  {
    id: "continuation-upgrade-to-complex",
    expectedTier: "complex",
    previousTier: "medium",
    messages: [
      user("读取一个配置文件。"),
      assistant("配置已读取。"),
      user("继续下一阶段：把调研、编码和测试并行委派给三个子智能体。"),
    ],
  },
];

await main();
