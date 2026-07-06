export type RouterModelPricing = {
  input?: number;
  output?: number;
  cacheRead?: number;
};

export type RouterModelPricingMap = Record<string, RouterModelPricing>;

// $/million tokens – fallback when neither nativeCost nor user modelPricing is available
const DEFAULT_PRICING: Array<{ pattern: RegExp; input: number; output: number; cacheRead?: number }> = [
  // DeepSeek
  { pattern: /deepseek.*flash/i, input: 0.20, output: 0.60 },
  { pattern: /deepseek.*chat/i, input: 0.50, output: 1.50 },
  { pattern: /deepseek.*reasoner/i, input: 0.80, output: 2.00 },
  { pattern: /deepseek.*v3/i, input: 0.27, output: 1.10 },
  // Anthropic Claude
  { pattern: /claude.*opus/i, input: 15.00, output: 75.00, cacheRead: 1.50 },
  { pattern: /claude.*sonnet/i, input: 3.00, output: 15.00, cacheRead: 0.30 },
  { pattern: /claude.*haiku/i, input: 0.80, output: 4.00, cacheRead: 0.08 },
  // OpenAI
  { pattern: /gpt-4o-mini/i, input: 0.15, output: 0.60, cacheRead: 0.075 },
  { pattern: /gpt-4o/i, input: 2.50, output: 10.00, cacheRead: 1.25 },
  { pattern: /gpt-4\.1/i, input: 2.00, output: 8.00, cacheRead: 0.50 },
  { pattern: /gpt-5/i, input: 2.00, output: 8.00, cacheRead: 0.50 },
  { pattern: /o[134]-mini/i, input: 1.10, output: 4.40 },
  { pattern: /o[134]-pro/i, input: 10.00, output: 40.00 },
  { pattern: /o[134]/i, input: 2.50, output: 10.00 },
  // Google Gemini
  { pattern: /gemini.*flash/i, input: 0.10, output: 0.40 },
  { pattern: /gemini.*pro/i, input: 1.25, output: 5.00 },
  // GLM / ChatGLM / Zhipu
  { pattern: /glm/i, input: 0.50, output: 1.00 },
  // Qwen / Tongyi
  { pattern: /qwen.*turbo/i, input: 0.30, output: 0.60 },
  { pattern: /qwen.*plus/i, input: 0.80, output: 2.00 },
  { pattern: /qwen.*max/i, input: 2.00, output: 6.00 },
  { pattern: /qwen/i, input: 0.50, output: 1.50 },
  // Llama / Meta
  { pattern: /llama.*70b/i, input: 0.80, output: 0.80 },
  { pattern: /llama.*405b/i, input: 3.00, output: 3.00 },
  { pattern: /llama/i, input: 0.20, output: 0.20 },
  // Mistral
  { pattern: /mistral.*large/i, input: 2.00, output: 6.00 },
  { pattern: /mistral.*small/i, input: 0.10, output: 0.30 },
  { pattern: /mistral/i, input: 0.25, output: 0.25 },
  // Yi / 01.AI
  { pattern: /yi-/i, input: 0.30, output: 0.30 },
  // Moonshot / Kimi
  { pattern: /moonshot|kimi/i, input: 1.00, output: 2.00 },
  // Doubao / ByteDance
  { pattern: /doubao/i, input: 0.40, output: 0.80 },
];

const FALLBACK_PRICING = { input: 0.50, output: 1.50 };

export function lookupModelPricing(
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): RouterModelPricing {
  const combined = `${provider}/${model}`;
  if (modelPricing) {
    const exact = modelPricing[combined];
    if (exact) return exact;
    for (const [key, val] of Object.entries(modelPricing)) {
      if (model.includes(key) || key.includes(model)) return val;
    }
  }
  for (const entry of DEFAULT_PRICING) {
    if (entry.pattern.test(combined) || entry.pattern.test(model)) {
      return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead };
    }
  }
  return FALLBACK_PRICING;
}

export function calculateInputCost(
  tokens: number,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): number {
  const pricing = lookupModelPricing(provider, model, modelPricing);
  return (tokens / 1_000_000) * (pricing.input ?? 0);
}

export function calculateCacheReadCost(
  tokens: number,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): number {
  const pricing = lookupModelPricing(provider, model, modelPricing);
  return (tokens / 1_000_000) * (pricing.cacheRead ?? pricing.input ?? 0);
}
