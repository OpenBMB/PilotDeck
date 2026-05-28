import type { CanonicalUsage } from "../protocol/canonical.js";

export function normalizeAnthropicUsage(raw: unknown): CanonicalUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const inputTokens = readNumber(raw.input_tokens);
  const outputTokens = readNumber(raw.output_tokens);
  const cacheReadTokens = readNumber(raw.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(raw.cache_creation_input_tokens);

  return compactUsage({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: sumDefined(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
  });
}

export function normalizeOpenAIUsage(raw: unknown): CanonicalUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const promptTokens = readNumber(raw.prompt_tokens) ?? readNumber(raw.input_tokens);
  const outputTokens = readNumber(raw.completion_tokens) ?? readNumber(raw.output_tokens);
  const nativeCost =
    readNumber(raw.cost) ??
    readNumber(raw.total_cost) ??
    readNumber(raw.estimated_cost);

  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const cacheReadTokens = readNumber(details?.cached_tokens) ?? readNumber(raw.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(details?.cache_write_tokens) ?? readNumber(raw.cache_creation_input_tokens);

  const inputTokens = promptTokens != null
    ? promptTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)
    : undefined;

  const totalTokens = readNumber(raw.total_tokens) ?? sumDefined(promptTokens, outputTokens);

  return compactUsage({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    nativeCost,
  });
}

function compactUsage(usage: CanonicalUsage): CanonicalUsage | undefined {
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? defined.reduce((total, value) => total + value, 0) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
