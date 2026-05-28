import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";

/**
 * Subset of tool names whose results are eligible for cached
 * microcompaction — tools whose output is large, stale-by-default, and
 * cheap to re-derive. Read-only / search / fetch tools dominate; permission
 * sensitive tools and ask_user_question are intentionally absent so user
 * decisions are never silently dropped.
 *
 * Behaviour M1 in §4.4. Adding a tool here is a runtime contract change;
 * remove from here only if the parent tool's output is small enough that
 * caching does not help.
 */
export const COMPACTABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "Read",
  "bash",
  "Bash",
  "grep",
  "Grep",
  "glob",
  "Glob",
  "web_search",
  "WebSearch",
  "web_fetch",
  "WebFetch",
  "edit_file",
  "Edit",
  "write_file",
  "Write",
]);

export type CachedMicroCompactionInput = {
  messages: CanonicalMessage[];
  /**
   * Max number of tool_results to keep "live" (i.e. unmarked) per turn. Older
   * results above this threshold are eligible for cache breakpoint marking.
   * Defaults to legacy `LIVE_TOOL_RESULTS_THRESHOLD ≈ 4`.
   */
  liveThreshold?: number;
};

export type CachedMicroCompactionResult = {
  /**
   * Indices into `input.messages` to be marked with `cache_control:
   * ephemeral` on the last content block. Empty when feature is disabled,
   * provider is not Anthropic, or no compactable tool_results exist.
   */
  cacheBreakpoints: number[];
  /** Eligible tool_use ids (M4) — informational only; engine does not edit messages. */
  eligibleToolCallIds: string[];
  /** Whether the engine actually ran (vs short-circuited). */
  applied: boolean;
};

export type CachedMicroCompactionOptions = {
  /** Master feature gate — the engine is a no-op when false (M5). */
  enabled?: boolean;
  liveThreshold?: number;
};

/**
 * Anthropic-only cached microcompact (A4). Computes cache breakpoints
 * marking the user message immediately *before* an aged-out tool_result so
 * the prefix above stays cached even as the tool_result content gets
 * rewritten in subsequent turns.
 *
 * Behaviour alignment (M1..M7 in §4.4):
 *   M1 COMPACTABLE_TOOL_NAMES set matches legacy.
 *   M2 Anthropic-only: short-circuits for non-Anthropic providers.
 *   M3 Subagent skip: forked agents share state with main loop, so we never
 *      run the engine inside a subagent (cache_control is a per-turn signal).
 *   M4 Returns eligible tool_call_ids for telemetry / debugging.
 *   M5 Disabled by default; gated on `pilotdeck.context.cachedMicrocompactEnabled`.
 *   M6 Cache breakpoint goes on the message *immediately preceding* the
 *      eligible tool_result message, not on the eligible message itself.
 *   M7 `validateCacheHit(usage)` returns true when `cacheReadTokens > 0`,
 *      surfacing whether the breakpoint actually produced a hit.
 */
export class CachedMicroCompactionEngine {
  private readonly enabled: boolean;
  private readonly liveThreshold: number;

  constructor(options: CachedMicroCompactionOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.liveThreshold = options.liveThreshold ?? 4;
  }

  apply(input: CachedMicroCompactionInput): CachedMicroCompactionResult {
    const empty: CachedMicroCompactionResult = {
      cacheBreakpoints: [],
      eligibleToolCallIds: [],
      applied: false,
    };

    if (!this.enabled) return empty;

    const liveThreshold = input.liveThreshold ?? this.liveThreshold;

    // First pass: collect compactable tool_call ids (assistant blocks
    // emitted by COMPACTABLE_TOOL_NAMES).
    const compactableIds = new Set<string>();
    for (const message of input.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "tool_call" && COMPACTABLE_TOOL_NAMES.has(block.name)) {
          compactableIds.add(block.id);
        }
      }
    }
    if (compactableIds.size === 0) return empty;

    // Second pass: list user messages that hold a tool_result for any
    // compactable id, in encounter order.
    const eligibleMessageIndices: number[] = [];
    const eligibleToolCallIds: string[] = [];
    for (let i = 0; i < input.messages.length; i++) {
      const message = input.messages[i];
      if (!message || message.role !== "user") continue;
      let touched = false;
      for (const block of message.content) {
        if (block.type === "tool_result" && compactableIds.has(block.toolCallId)) {
          touched = true;
          eligibleToolCallIds.push(block.toolCallId);
        }
      }
      if (touched) eligibleMessageIndices.push(i);
    }

    // Skip the `liveThreshold` most recent eligible messages — those are
    // still "live" and should not be marked.
    if (eligibleMessageIndices.length <= liveThreshold) return empty;
    const aged = eligibleMessageIndices.slice(
      0,
      eligibleMessageIndices.length - liveThreshold,
    );

    // M6: mark the message immediately *before* each aged-out one. Dedupe.
    const breakpointSet = new Set<number>();
    for (const idx of aged) {
      const before = idx - 1;
      if (before >= 0) breakpointSet.add(before);
    }
    const cacheBreakpoints = Array.from(breakpointSet).sort((a, b) => a - b);

    return {
      cacheBreakpoints,
      eligibleToolCallIds,
      applied: cacheBreakpoints.length > 0,
    };
  }

  /**
   * M7: confirm a cache hit happened on the previous request. Returns true
   * when the provider reported any cache_read tokens. Caller can log this
   * for telemetry; a `false` return is informational only (the breakpoint
   * is still valid, the cache may simply have been cold).
   */
  validateCacheHit(usage: CanonicalUsage | undefined): boolean {
    if (!usage) return false;
    return (usage.cacheReadTokens ?? 0) > 0;
  }
}
