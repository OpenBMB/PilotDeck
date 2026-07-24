import type { CanonicalMessage, CanonicalUsage } from "../model/index.js";
import type {
  ContextBoundary,
  ContextCaptureTurnInput,
  ContextDiagnostic,
  ContextPrepareInput,
  ContextRecoveryDecision,
  ContextRecoveryInput,
  ContextToolResultInput,
  ContextToolResultResult,
  ModelContext,
} from "./protocol/types.js";
import type { AutoCompactResult } from "./DefaultContextRuntime.js";
import type { TokenBudgetSnapshot } from "./budget/TokenBudgetManager.js";

export type AgentContextPrepareInput = ContextPrepareInput;
export type AgentPreparedContext = ModelContext;
export type AgentContextBoundary = ContextBoundary;
export type AgentContextDiagnostic = ContextDiagnostic;

/**
 * Optional reactive-recovery input the loop hands to context. When the
 * underlying context runtime returns a `truncate_head_and_retry` decision the
 * loop slices `messages` and retries the model call once per turn.
 */
export type AgentContextRecoveryInput = ContextRecoveryInput;
export type AgentContextToolResultInput = ContextToolResultInput;
export type AgentContextToolResultResult = ContextToolResultResult;
export type AgentContextCaptureTurnInput = ContextCaptureTurnInput;

export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
  /** Commits one-shot context only after the final request has been built and is about to execute. */
  commitPreparedContext?(input: { sessionId: string; turnId: string }): void;
  /**
   * Optional. Real implementations (e.g. `DefaultContextRuntime`) provide
   * this; minimal runtimes (`NullContextRuntime`) leave it undefined and the
   * loop falls back to `AgentRecoveryPolicy` directly.
   */
  recoverFromModelError?(input: AgentContextRecoveryInput): Promise<ContextRecoveryDecision>;
  /**
   * Optional. Real implementations route through `ToolResultBudget` so large
   * tool results land on disk. Minimal runtimes leave this undefined and the
   * loop appends the raw `toolResultMessage` directly.
   */
  applyToolResults?(input: AgentContextToolResultInput): Promise<AgentContextToolResultResult>;
  /**
   * Optional. Real implementations forward the turn-end snapshot into the
   * configured memory provider's `captureTurn`. Errors must not bubble — the
   * implementation swallows so a failing memory backend never breaks a turn.
   */
  captureTurn?(input: AgentContextCaptureTurnInput): Promise<void>;
  /**
   * Optional. Proactive auto-compaction: evaluates the token budget and
   * triggers summarization when the context approaches `maxContextTokens`.
   * Minimal runtimes (`NullContextRuntime`) leave this undefined.
   *
   * When `maxContextTokens` is provided it overrides the construction-time
   * default for this single evaluation. The agent loop uses this to
   * re-evaluate compaction against the routed model's (potentially smaller)
   * context window after a routing decision.
   */
  tryAutoCompact?(input: {
    messages: CanonicalMessage[];
    abortSignal?: AbortSignal;
    maxContextTokens?: number;
    reservedOutputTokens?: number;
    lastUsage?: CanonicalUsage;
    budgetEvaluator?: (messages: CanonicalMessage[], lastUsage?: CanonicalUsage) => Promise<TokenBudgetSnapshot>;
  }): Promise<AutoCompactResult>;
};
