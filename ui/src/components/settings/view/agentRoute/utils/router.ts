import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

export type RouterTierKey = "simple" | "medium" | "complex" | "reasoning";

export const ROUTER_TIER_KEYS: RouterTierKey[] = [
  "simple",
  "medium",
  "complex",
  "reasoning",
];

export const DEFAULT_TIERS: Record<
  RouterTierKey,
  { label: string; alias: string; description: string; summary: string }
> = {
  simple: {
    label: "简单任务",
    alias: "Simple",
    description: "Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules",
    summary: "快速问答、确认、轻量改写和简单文件操作。",
  },
  medium: {
    label: "常规任务",
    alias: "Medium",
    description: "Single tool call, short text generation, 1-2 file read/write, code generation",
    summary: "单次工具调用、短文本生成、少量文件修改和常规代码变更。",
  },
  complex: {
    label: "复杂任务",
    alias: "Complex",
    description: "Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents",
    summary: "需要拆分或交给子智能体处理的任务。",
  },
  reasoning: {
    label: "深度推理",
    alias: "Reasoning",
    description: "Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources",
    summary: "多文件分析、长上下文、报告和深度推理任务。",
  },
};

export const DEFAULT_RULES: string[] = [
  "complex is ONLY for tasks that need sub-agent orchestration or parallel delegation",
  "Multi-file operations and multi-step workflows without orchestration should be reasoning",
  "Simple file creation or single code generation is medium",
  "Trivial confirmations or one-file short Q&A is simple",
];

type Pricing = {
  input?: number;
  output?: number;
  cacheRead?: number;
  unit?: "$/百万 Token" | "¥/百万 Token";
};

const BUILT_IN_PRICING: Array<{ pattern: RegExp; pricing: Pricing }> = [
  { pattern: /deepseek.*flash/i, pricing: { input: 0.2, output: 0.6 } },
  { pattern: /deepseek.*chat/i, pricing: { input: 0.5, output: 1.5 } },
  { pattern: /deepseek.*reasoner/i, pricing: { input: 0.8, output: 2 } },
  { pattern: /deepseek.*v3/i, pricing: { input: 0.27, output: 1.1 } },
  { pattern: /claude.*opus/i, pricing: { input: 15, output: 75, cacheRead: 1.5 } },
  { pattern: /claude.*sonnet/i, pricing: { input: 3, output: 15, cacheRead: 0.3 } },
  { pattern: /claude.*haiku/i, pricing: { input: 0.8, output: 4, cacheRead: 0.08 } },
  { pattern: /gpt-4o-mini/i, pricing: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
  { pattern: /gpt-4o/i, pricing: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { pattern: /gpt-4\.1/i, pricing: { input: 2, output: 8, cacheRead: 0.5 } },
  { pattern: /gpt-5/i, pricing: { input: 2, output: 8, cacheRead: 0.5 } },
  { pattern: /o[134]-mini/i, pricing: { input: 1.1, output: 4.4 } },
  { pattern: /o[134]-pro/i, pricing: { input: 10, output: 40 } },
  { pattern: /o[134]/i, pricing: { input: 2.5, output: 10 } },
  { pattern: /gemini.*flash/i, pricing: { input: 0.1, output: 0.4 } },
  { pattern: /gemini.*pro/i, pricing: { input: 1.25, output: 5 } },
  { pattern: /glm/i, pricing: { input: 0.5, output: 1 } },
  { pattern: /qwen.*turbo/i, pricing: { input: 0.3, output: 0.6 } },
  { pattern: /qwen.*plus/i, pricing: { input: 0.8, output: 2 } },
  { pattern: /qwen.*max/i, pricing: { input: 2, output: 6 } },
  { pattern: /qwen/i, pricing: { input: 0.5, output: 1.5 } },
  { pattern: /llama.*70b/i, pricing: { input: 0.8, output: 0.8 } },
  { pattern: /llama.*405b/i, pricing: { input: 3, output: 3 } },
  { pattern: /llama/i, pricing: { input: 0.2, output: 0.2 } },
  { pattern: /mistral.*large/i, pricing: { input: 2, output: 6 } },
  { pattern: /mistral.*small/i, pricing: { input: 0.1, output: 0.3 } },
  { pattern: /mistral/i, pricing: { input: 0.25, output: 0.25 } },
  { pattern: /yi-/i, pricing: { input: 0.3, output: 0.3 } },
  { pattern: /moonshot|kimi/i, pricing: { input: 1, output: 2 } },
  { pattern: /doubao/i, pricing: { input: 0.4, output: 0.8 } },
];

export function getBuiltInPricing(modelRef: string): Pricing | undefined {
  return BUILT_IN_PRICING.find(({ pattern }) => pattern.test(modelRef))?.pricing;
}

export function replaceFallbackModelRef(
  config: PilotDeckConfig,
  oldRef: string,
  newRef: string,
): PilotDeckConfig {
  const fallback = config.router?.fallback;
  if (!fallback || !oldRef || oldRef === newRef) return config;

  let changed = false;
  const rewritten = Object.fromEntries(
    Object.entries(fallback).map(([key, refs]) => {
      const nextRefs = refs.map((ref) => {
        if (ref !== oldRef) return ref;
        changed = true;
        return newRef;
      });
      return [key, nextRefs];
    }),
  );

  return changed ? patch(config, ["router", "fallback"], rewritten) : config;
}
