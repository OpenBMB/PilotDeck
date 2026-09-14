import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCachePlan,
  rebuildRoutedCachePlan,
} from "../../src/context/cache/CachePlan.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelCapabilities,
  ModelDefinition,
} from "../../src/model/index.js";
import { buildAnthropicRequest } from "../../src/model/providers/anthropic/request.js";

export const REAL_EXPERIMENT_OUTPUT_DIRECTORY = "docs/experiments/cache-aware-routing-real";
export const REAL_EXPERIMENT_MAX_REQUESTS = 12;
export const REAL_EXPERIMENT_MAX_OUTPUT_TOKENS = 16;
export const REAL_EXPERIMENT_PREFIX_WORDS = 6_000;

const DEFAULT_BASE_URL = "https://lab.cs.tsinghua.edu.cn/ai-platform/api/v1";
const DEFAULT_MODEL = "qwen3.5-mini";
const ANTHROPIC_VERSION = "2023-06-01";

export type RealExperimentArm = "original" | "plan_fix_only";

type CacheUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  hasAnthropicCacheFields: boolean;
};

export type RealRequestRecord = {
  phase: "smoke" | "comparison";
  arm: RealExperimentArm;
  repetition: number;
  model: string;
  httpStatus: number;
  latencyMs: number;
  markerCount: number;
  responseId: string | null;
  usage: CacheUsage;
};

export type RealExperimentResult = {
  metadata: {
    experimentId: string;
    startedAt: string;
    completedAt: string;
    endpoint: string;
    model: string;
    maxRequests: number;
    requestsMade: number;
    maxOutputTokensPerRequest: number;
    approximatePrefixWordsPerRequest: number;
    modelOutputPersisted: false;
    apiKeyPersisted: false;
  };
  status: "completed" | "stopped_cache_usage_not_verifiable";
  stopReason: string | null;
  records: RealRequestRecord[];
  summaries: Array<{
    arm: RealExperimentArm;
    scope: "smoke" | "comparison";
    requests: number;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    cacheReadRatio: number | null;
    medianLatencyMs: number | null;
  }>;
  limitations: string[];
};

/** Builds the exact production Anthropic payload used by the real experiment. */
export function buildRealExperimentPayload(input: {
  arm: RealExperimentArm;
  model: string;
  lineage: string;
}): { body: ReturnType<typeof buildAnthropicRequest>; markerCount: number } {
  const messages = fixtureMessages(input.lineage);
  const systemPrompt = fixtureSystemPrompt(input.lineage);
  const preparedPlan = buildCachePlan({
    provider: "baseline-anthropic",
    model: "pre-route-model",
    systemPrompt,
    tools: [],
    messages,
    enabled: true,
  }, 1);
  const preparedRequest: CanonicalModelRequest = {
    provider: "baseline-anthropic",
    model: "pre-route-model",
    systemPrompt,
    messages,
    maxOutputTokens: REAL_EXPERIMENT_MAX_OUTPUT_TOKENS,
    cachePlan: preparedPlan,
    cacheBreakpoints: preparedPlan?.messages,
  };

  let finalRequest: CanonicalModelRequest;
  if (input.arm === "original") {
    // Frozen cfc4d177 behavior: a post-plan model mismatch drops the plan.
    finalRequest = {
      ...preparedRequest,
      provider: "anthropic-compatible",
      model: input.model,
      cachePlan: undefined,
      cacheBreakpoints: undefined,
    };
  } else {
    const rebuilt = rebuildRoutedCachePlan({
      provider: "anthropic-compatible",
      model: input.model,
      protocol: "anthropic",
      supportsPromptCache: true,
      systemPrompt,
      tools: [],
      messages,
    }, preparedPlan);
    finalRequest = {
      ...preparedRequest,
      provider: "anthropic-compatible",
      model: input.model,
      cachePlan: rebuilt.cachePlan,
      cacheBreakpoints: rebuilt.cacheBreakpoints,
    };
  }

  const body = buildAnthropicRequest(finalRequest, modelDefinition(input.model));
  return { body, markerCount: countCacheControls(body) };
}

export async function runRealExperiment(input: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  outputDirectory?: string;
}): Promise<RealExperimentResult> {
  if (!input.apiKey.trim()) throw new Error("PILOTDECK_REAL_API_KEY is required");
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = input.model ?? DEFAULT_MODEL;
  const outputDirectory = resolve(input.outputDirectory ?? REAL_EXPERIMENT_OUTPUT_DIRECTORY);
  const startedAt = new Date().toISOString();
  const runLineage = `real-${startedAt.replace(/[^0-9]/g, "")}`;
  const records: RealRequestRecord[] = [];

  const send = async (
    phase: RealRequestRecord["phase"],
    arm: RealExperimentArm,
    repetition: number,
    lineage: string,
  ): Promise<RealRequestRecord> => {
    if (records.length >= REAL_EXPERIMENT_MAX_REQUESTS) {
      throw new Error(`Real experiment request cap reached: ${REAL_EXPERIMENT_MAX_REQUESTS}`);
    }
    const payload = buildRealExperimentPayload({ arm, model, lineage });
    const before = performance.now();
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload.body),
      signal: AbortSignal.timeout(120_000),
    });
    const latencyMs = Math.round(performance.now() - before);
    const text = await response.text();
    const parsed = parseJsonObject(text);
    if (!response.ok) {
      throw new Error(`Anthropic-compatible request failed (${response.status}): ${safeErrorMessage(parsed, text)}`);
    }
    const record: RealRequestRecord = {
      phase,
      arm,
      repetition,
      model,
      httpStatus: response.status,
      latencyMs,
      markerCount: payload.markerCount,
      responseId: readString(parsed.id),
      usage: extractCacheUsage(parsed.usage),
    };
    records.push(record);
    return record;
  };

  const smokeLineage = `${runLineage}-smoke`;
  const smokeFirst = await send("smoke", "plan_fix_only", 1, smokeLineage);
  const smokeSecond = await send("smoke", "plan_fix_only", 2, smokeLineage);
  const cacheUsageVerifiable = smokeFirst.usage.hasAnthropicCacheFields
    && smokeSecond.usage.hasAnthropicCacheFields
    && (smokeFirst.usage.cacheWriteTokens ?? 0) > 0
    && (smokeSecond.usage.cacheReadTokens ?? 0) > 0;

  let status: RealExperimentResult["status"] = "completed";
  let stopReason: string | null = null;
  if (!cacheUsageVerifiable) {
    status = "stopped_cache_usage_not_verifiable";
    stopReason = "The smoke pair did not report a positive Anthropic cache write followed by a positive cache read.";
  } else {
    for (const arm of ["original", "plan_fix_only"] as const) {
      const lineage = `${runLineage}-${arm}`;
      for (let repetition = 1; repetition <= 3; repetition++) {
        await send("comparison", arm, repetition, lineage);
      }
    }
  }

  const result: RealExperimentResult = {
    metadata: {
      experimentId: "pilotroute-cache-aware-routing-real",
      startedAt,
      completedAt: new Date().toISOString(),
      endpoint: baseUrl,
      model,
      maxRequests: REAL_EXPERIMENT_MAX_REQUESTS,
      requestsMade: records.length,
      maxOutputTokensPerRequest: REAL_EXPERIMENT_MAX_OUTPUT_TOKENS,
      approximatePrefixWordsPerRequest: REAL_EXPERIMENT_PREFIX_WORDS,
      modelOutputPersisted: false,
      apiKeyPersisted: false,
    },
    status,
    stopReason,
    records,
    summaries: (["original", "plan_fix_only"] as const).map((arm) => summarizeArm(arm, records)),
    limitations: [
      "This endpoint exposes Anthropic-compatible request syntax but does not expose Claude models.",
      "cache_control acceptance does not prove that the upstream non-Claude model implements Anthropic prompt caching.",
      "Only provider-reported Anthropic cache usage fields are treated as evidence of a cache write or read.",
      "The endpoint did not provide pricing, so this experiment makes no billed-cost or savings claim.",
      "Model output is intentionally omitted; quality is not measured.",
    ],
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, "raw-results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(resolve(outputDirectory, "report.md"), renderRealExperimentReport(result), "utf8"),
  ]);
  return result;
}

export function renderRealExperimentReport(result: RealExperimentResult): string {
  const lines = [
    "# PilotRoute 缓存计划真实 API 实验",
    "",
    "> 本实验调用了真实第三方 API。报告只使用服务端返回的 usage 和本地生成的 wire 元数据；未保存 API key 或模型输出。",
    "",
    "## 控制条件",
    "",
    `- Endpoint: \`${result.metadata.endpoint}\``,
    `- Model: \`${result.metadata.model}\`（Anthropic-compatible 代理，非 Claude）`,
    `- 请求：${result.metadata.requestsMade}/${result.metadata.maxRequests}；每请求最多 ${result.metadata.maxOutputTokensPerRequest} 输出 tokens。`,
    `- 状态：\`${result.status}\``,
    ...(result.stopReason ? [`- 停止原因：${result.stopReason}`] : []),
    "",
    "## 结果",
    "",
    "| 阶段 | 实验臂 | 重复 | Wire markers | 输入 tokens | Cache write | Cache read | 延迟 ms | HTTP |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...result.records.map((record) =>
      `| ${record.phase} | ${record.arm} | ${record.repetition} | ${record.markerCount} | ${formatNullable(record.usage.inputTokens)} | ${formatNullable(record.usage.cacheWriteTokens)} | ${formatNullable(record.usage.cacheReadTokens)} | ${record.latencyMs} | ${record.httpStatus} |`
    ),
    "",
    "## 结论",
    "",
    result.status === "completed"
      ? "- 服务端返回了可验证的 cache write/read usage，已完成受控对照。"
      : "- 服务端连续接受了带 4 个生产 `cache_control` marker 的请求，但 cache write/read 值为 `null`；wire 接受已验证，缓存效果未验证，不能据此宣称命中率或节省提升。",
    "",
    "## 汇总",
    "",
    "| 实验臂 | 范围 | 请求 | Cache write | Cache read | Cache read ratio | 中位延迟 ms |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...result.summaries.map((summary) =>
      `| ${summary.arm} | ${summary.scope} | ${summary.requests} | ${formatNullable(summary.cacheWriteTokens)} | ${formatNullable(summary.cacheReadTokens)} | ${summary.cacheReadRatio === null ? "n/a" : `${(summary.cacheReadRatio * 100).toFixed(2)}%`} | ${formatNullable(summary.medianLatencyMs)} |`
    ),
    "",
    "## 限制",
    "",
    ...result.limitations.map((limitation) => `- ${limitation}`),
    "",
  ];
  return lines.join("\n");
}

function fixtureSystemPrompt(lineage: string): string {
  return `PilotDeck real cache experiment ${lineage}. Do not reproduce this fixture.\n${"cache ".repeat(REAL_EXPERIMENT_PREFIX_WORDS)}`;
}

function fixtureMessages(lineage: string): CanonicalMessage[] {
  return [
    textMessage("user", `Read stable fixture ${lineage}.`),
    textMessage("assistant", "Acknowledged."),
    textMessage("user", "Keep the stable prefix unchanged."),
    textMessage("assistant", "The prefix remains unchanged."),
    textMessage("user", "Reply with exactly OK."),
  ];
}

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function modelDefinition(model: string): ModelDefinition {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: false,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxContextTokens: 128_000,
    maxOutputTokens: REAL_EXPERIMENT_MAX_OUTPUT_TOKENS,
  };
  return { id: model, capabilities, multimodal: { input: ["text"] } };
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countCacheControls(entry), 0);
  if (typeof value !== "object" || value === null) return 0;
  const record = value as Record<string, unknown>;
  const own = typeof record.cache_control === "object" && record.cache_control !== null ? 1 : 0;
  return own + Object.entries(record)
    .filter(([key]) => key !== "cache_control")
    .reduce((total, [, entry]) => total + countCacheControls(entry), 0);
}

function extractCacheUsage(value: unknown): CacheUsage {
  const usage = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    cacheReadTokens: readNumber(usage.cache_read_input_tokens),
    cacheWriteTokens: readNumber(usage.cache_creation_input_tokens),
    hasAnthropicCacheFields: Object.hasOwn(usage, "cache_read_input_tokens")
      && Object.hasOwn(usage, "cache_creation_input_tokens"),
  };
}

function summarizeArm(arm: RealExperimentArm, records: RealRequestRecord[]) {
  const armRecords = records.filter((record) => record.arm === arm);
  const comparisonRecords = armRecords.filter((record) => record.phase === "comparison");
  const scope: "comparison" | "smoke" = comparisonRecords.length > 0 ? "comparison" : "smoke";
  const selected = comparisonRecords.length > 0 ? comparisonRecords : armRecords;
  const cacheReadTokens = sumKnown(selected.map((record) => record.usage.cacheReadTokens));
  const cacheWriteTokens = sumKnown(selected.map((record) => record.usage.cacheWriteTokens));
  const inputTokens = sumKnown(selected.map((record) => record.usage.inputTokens));
  const denominator = inputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null
    ? inputTokens + cacheReadTokens + cacheWriteTokens
    : null;
  return {
    arm,
    scope,
    requests: selected.length,
    cacheReadTokens,
    cacheWriteTokens,
    cacheReadRatio: denominator !== null && denominator > 0 && cacheReadTokens !== null
      ? cacheReadTokens / denominator
      : null,
    medianLatencyMs: median(selected.map((record) => record.latencyMs)),
  };
}

function sumKnown(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + value!, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeErrorMessage(parsed: Record<string, unknown>, raw: string): string {
  const error = typeof parsed.error === "object" && parsed.error !== null
    ? parsed.error as Record<string, unknown>
    : {};
  return readString(error.message) ?? (raw.slice(0, 500) || "unknown response");
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const apiKey = process.env.PILOTDECK_REAL_API_KEY;
  if (!apiKey) throw new Error("Set PILOTDECK_REAL_API_KEY for the real API experiment");
  const result = await runRealExperiment({
    apiKey,
    baseUrl: process.env.PILOTDECK_REAL_API_BASE_URL,
    model: process.env.PILOTDECK_REAL_MODEL,
  });
  console.log(`Real experiment ${result.status}: ${result.metadata.requestsMade} request(s)`);
}
