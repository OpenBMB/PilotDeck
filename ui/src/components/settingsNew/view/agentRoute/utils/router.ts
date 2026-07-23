import { patch } from "../../modelPool/utils/patch";
import type { PilotDeckConfig } from "../../modelPool/types";

export type RouterTierKey = "simple" | "medium" | "complex" | "reasoning";

export const ROUTER_TIER_KEYS: RouterTierKey[] = [
  "simple",
  "medium",
  "complex",
  "reasoning",
];

export const DEFAULT_TIERS: Record<RouterTierKey, { description: string }> = {
  simple: { description: "Quick confirmations and concise edits." },
  medium: { description: "Single-step coding and moderate complexity tasks." },
  complex: { description: "Complex implementation and coordination tasks." },
  reasoning: { description: "Deep analysis and planning-heavy tasks." },
};

export const DEFAULT_RULES: string[] = [
  "complex is ONLY for tasks that need sub-agent orchestration or parallel delegation",
  "Multi-file operations and multi-step workflows without orchestration should be reasoning",
  "Simple file creation or single code generation is medium",
  "Trivial confirmations or one-file short Q&A is simple",
];

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
