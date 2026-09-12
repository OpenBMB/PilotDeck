import { createHash } from "node:crypto";
import type { CachePlan, CanonicalMessage, CanonicalToolSchema } from "../../model/index.js";
export type { CachePlan } from "../../model/index.js";

export type CachePlanInput = {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
  enabled: boolean;
};

export const RECENT_MESSAGE_BREAKPOINT_COUNT = 3;

/** Select the final non-system messages for the Anthropic recent-message layout. */
export function selectRecentMessageBreakpoints(messages: CanonicalMessage[]): number[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (message as { role: string }).role !== "system")
    .slice(-RECENT_MESSAGE_BREAKPOINT_COUNT)
    .map(({ index }) => index);
}

/** Stable, non-cryptographic serialization for cache-plan identity. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

/**
 * Keep the cache plan compact even when recent messages contain base64 media.
 * The serialized value is used only as hash input and is never retained.
 */
function fingerprintFor(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

export function buildCachePlan(input: CachePlanInput, generation: number): CachePlan | undefined {
  if (!input.enabled) return undefined;
  const messages = selectRecentMessageBreakpoints(input.messages);
  const stableTools = [...input.tools].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : stableSerialize(left).localeCompare(stableSerialize(right));
  });
  return {
    provider: input.provider,
    model: input.model,
    system: Boolean(input.systemPrompt),
    tools: false,
    messages,
    fingerprint: fingerprintFor({
      provider: input.provider ?? "",
      model: input.model ?? "",
      system: input.systemPrompt ?? "",
      tools: stableTools,
      messages: messages.map((index) => input.messages[index]),
    }),
    generation,
  };
}

export type RoutedCachePlanInput = {
  provider: string;
  model: string;
  /** ModelProtocol value from modelRuntime.getProviderProtocol. */
  protocol: string;
  /** From modelRuntime.getCapabilities(provider, model). */
  supportsPromptCache: boolean;
  systemPrompt?: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
};

export type RoutedCachePlanResult = {
  cachePlan?: CachePlan;
  cacheBreakpoints?: number[];
};

/**
 * Rebuild the cache plan for the model a routing decision actually selected.
 * Non-Anthropic protocols and models without prompt-cache support get an
 * explicit clear (no plan, no breakpoints) — the same gate the context
 * runtime applies before routing. The previous plan's generation is carried
 * over, never bumped; bumping stays the context runtime's job.
 */
export function rebuildRoutedCachePlan(
  input: RoutedCachePlanInput,
  previousPlan: CachePlan | undefined,
): RoutedCachePlanResult {
  if (input.protocol !== "anthropic" || input.supportsPromptCache !== true) {
    return { cachePlan: undefined, cacheBreakpoints: undefined };
  }
  const cachePlan = buildCachePlan(
    { ...input, enabled: true },
    previousPlan?.generation ?? 0,
  );
  return { cachePlan, cacheBreakpoints: cachePlan?.messages };
}
