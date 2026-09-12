export type RouterModelPricing = {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Cache creation price ($/M tokens); Anthropic charges 1.25x input. */
  cacheWrite?: number;
  /** Display currency/unit metadata; it does not affect cost arithmetic. */
  unit?: RouterPricingUnit;
};

export type RouterModelPricingMap = Record<string, RouterModelPricing>;

export type RouterPricingUnit = "$/百万 Token" | "¥/百万 Token";

/**
 * Date the builtin pricing table was last reviewed. Exposed so consumers can
 * label builtin-sourced quotes (see {@link lookupModelPricingDetailed}).
 */
export const PRICING_SNAPSHOT_DATE = "2026-09-11";

/** Provenance marker for quotes resolved from the builtin fallback table. */
export const PRICING_SOURCE = "pilotdeck-builtin-fallback";

/**
 * Fully-resolved pricing quote with provenance and approximation notes.
 *
 * Every sub-price is a concrete number: missing table entries fall back to
 * the input rate (or 0 for input/output themselves) and the fallback is
 * recorded in `notes` so cost estimates can flag their own uncertainty.
 */
export type PricingQuote = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: "user" | "builtin" | "fallback";
  /** PRICING_SNAPSHOT_DATE for builtin; undefined for user/fallback. */
  snapshotDate?: string;
  notes: string[];
};

export type RouterModelPricingResolution = {
  pricing: RouterModelPricing;
  source: "configured" | "builtin" | "generic_fallback";
};

// $/million tokens – fallback when neither nativeCost nor user modelPricing is available
const DEFAULT_PRICING: Array<{
  pattern: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}> = [
  // DeepSeek
  { pattern: /deepseek.*flash/i, input: 0.20, output: 0.60 },
  { pattern: /deepseek.*chat/i, input: 0.50, output: 1.50 },
  { pattern: /deepseek.*reasoner/i, input: 0.80, output: 2.00 },
  { pattern: /deepseek.*v3/i, input: 0.27, output: 1.10 },
  // Anthropic Claude (cacheWrite = 1.25x input for ephemeral cache creation)
  { pattern: /claude.*opus/i, input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  { pattern: /claude.*sonnet/i, input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  { pattern: /claude.*haiku/i, input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
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
  return resolveModelPricing(provider, model, modelPricing).pricing;
}

/** Resolve pricing together with its provenance so accounting can expose confidence. */
export function resolveModelPricing(
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): RouterModelPricingResolution {
  const combined = `${provider}/${model}`;
  if (modelPricing) {
    const exact = modelPricing[combined];
    if (exact) return { pricing: exact, source: "configured" };
    for (const [key, val] of Object.entries(modelPricing)) {
      if (model.includes(key) || key.includes(model)) {
        return { pricing: val, source: "configured" };
      }
    }
  }
  for (const entry of DEFAULT_PRICING) {
    if (entry.pattern.test(combined) || entry.pattern.test(model)) {
      return {
        pricing: {
          input: entry.input,
          output: entry.output,
          cacheRead: entry.cacheRead,
          cacheWrite: entry.cacheWrite,
        },
        source: "builtin",
      };
    }
  }
  return { pricing: FALLBACK_PRICING, source: "generic_fallback" };
}

/**
 * Resolves a pricing quote with provenance. Resolution order mirrors
 * {@link lookupModelPricing}: user modelPricing exact/substring match →
 * builtin regex table → FALLBACK_PRICING. Missing sub-prices are filled
 * with the documented fallback (cacheRead/cacheWrite → input rate) and each
 * fallback is recorded in `notes`.
 */
export function lookupModelPricingDetailed(
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): PricingQuote {
  const combined = `${provider}/${model}`;
  if (modelPricing) {
    const exact = modelPricing[combined];
    if (exact) {
      return quoteFromPricing(exact, "user");
    }
    for (const [key, val] of Object.entries(modelPricing)) {
      if (model.includes(key) || key.includes(model)) {
        return quoteFromPricing(val, "user");
      }
    }
  }
  for (const entry of DEFAULT_PRICING) {
    if (entry.pattern.test(combined) || entry.pattern.test(model)) {
      return quoteFromPricing(
        { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite },
        "builtin",
      );
    }
  }
  const quote = quoteFromPricing(FALLBACK_PRICING, "fallback");
  quote.notes.unshift("no pricing entry: fallback rates applied");
  return quote;
}

function quoteFromPricing(
  pricing: RouterModelPricing,
  source: PricingQuote["source"],
): PricingQuote {
  const notes: string[] = [];
  const input = pricing.input ?? 0;
  const output = pricing.output ?? 0;
  if (pricing.input === undefined) {
    notes.push("input price missing: priced at 0");
  }
  if (pricing.output === undefined) {
    notes.push("output price missing: priced at 0");
  }
  let cacheRead = pricing.cacheRead;
  if (cacheRead === undefined) {
    cacheRead = input;
    notes.push("cacheRead missing: fallback to input rate");
  }
  let cacheWrite = pricing.cacheWrite;
  if (cacheWrite === undefined) {
    cacheWrite = input;
    notes.push("cacheWrite missing: priced at input rate");
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    source,
    snapshotDate: source === "builtin" ? PRICING_SNAPSHOT_DATE : undefined,
    notes,
  };
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

/** Cache-creation cost; missing cacheWrite pricing falls back to the input rate. */
export function calculateCacheWriteCost(
  tokens: number,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): number {
  const pricing = lookupModelPricing(provider, model, modelPricing);
  return (tokens / 1_000_000) * (pricing.cacheWrite ?? pricing.input ?? 0);
}
