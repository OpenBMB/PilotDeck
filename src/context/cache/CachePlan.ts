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

// These attachments are reconstructed at each request tail. Date notices and
// other durable synthetic messages keep their history positions and are anchors.
const REQUEST_ONLY_PURPOSES = new Set(["memory_context", "session_artifact_status", "todo_reminder", "plan_mode_reminder"]);

/** Select recent messages, reserving a cache write before request-only tails. */
export function selectRecentMessageBreakpoints(messages: CanonicalMessage[]): number[] {
  const recent = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (message as { role: string }).role !== "system")
    .slice(-RECENT_MESSAGE_BREAKPOINT_COUNT)
    .map(({ index }) => index);
  let historyEnd = messages.length - 1;
  while (historyEnd >= 0 && messages[historyEnd].metadata?.synthetic === true
    && REQUEST_ONLY_PURPOSES.has(String(messages[historyEnd].metadata?.purpose))) historyEnd--;
  if (historyEnd === messages.length - 1) return recent;
  while (historyEnd >= 0 && ((messages[historyEnd] as { role: string }).role === "system"
    || !messages[historyEnd].content.some(block => block.type !== "thinking"))) historyEnd--;
  if (historyEnd < 0 || recent.includes(historyEnd)) return recent;
  return [historyEnd, ...recent.slice(-(RECENT_MESSAGE_BREAKPOINT_COUNT - 1))];
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
