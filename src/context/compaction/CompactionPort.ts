import type { CanonicalMessage, CanonicalModelRequest } from "../../model/index.js";
import type { ContextPrepareInput } from "../protocol/types.js";
import type { ContextRecoveryDecision, ContextRecoveryInput } from "../protocol/types.js";
import type { TokenBudgetEvaluateOptions, TokenBudgetSnapshot } from "../budget/TokenBudgetManager.js";
import type { TokenCalibrationBaseline } from "../budget/TokenAccountingRuntime.js";
import type { AutoCompactionDecision } from "./AutoCompactionPolicy.js";
import {
  type CompactionInput,
  type CompactionResult,
} from "./CompactionEngine.js";
import type {
  MicroCompactionInput,
  MicroCompactionResult,
} from "./MicroCompactionEngine.js";
import type { SnipResult } from "./SnipEngine.js";

/** Result returned by a context consumer after one proactive compaction pass. */
export type AutoCompactResult =
  | { type: "skipped"; snapshot: TokenBudgetSnapshot }
  | {
      type: "compacted";
      messages: CanonicalMessage[];
      tier: "micro" | "snip" | "full" | "emergency";
      snapshot: TokenBudgetSnapshot;
      result?: CompactionResult;
      /** Set when every emergency tier ran but the request still cannot fit. */
      error?: "context_overflow_after_emergency_compaction";
    };

/**
 * Serializable budget intent sent from a sidecar context consumer to its
 * host. It deliberately contains no callback, abort signal, router decision,
 * or session state. A route-bound calibration snapshot is safe scalar data and
 * preserves native request-budget accounting when one has been observed.
 */
export type CompactionBudgetProjection = {
  stage: "pre_route" | "routed" | "recovery";
  trigger: "auto" | "reactive" | "manual";
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  manualForce?: boolean;
  allowFallbackOnFailure?: boolean;
  request?: CanonicalModelRequest;
  /**
   * Host-safe prompt-preparation intent. The sidecar sends this instead of
   * attempting to splice candidate durable messages into an already projected
   * request. Abort signals and callbacks are intentionally excluded.
   */
  preparation?: Omit<ContextPrepareInput, "abortSignal">;
  calibration?: TokenCalibrationBaseline;
};

export type CompactionAutoCompactInput = {
  sessionId?: string;
  turnId?: string;
  /** Explicit AgentLoop decision point retained across sidecar serialization. */
  budgetStage?: "pre_route" | "routed" | "recovery";
  /** Lifecycle classification used by durable adapters; defaults to auto. */
  trigger?: "auto" | "reactive" | "manual";
  /**
   * Run one explicit manual summary even when the automatic pressure policy
   * would skip. This is intentionally separate from `trigger`: callers must
   * opt into the force semantics, and providers still need a budget and a
   * full-summary capability to make a useful durable replacement.
   */
  manualForce?: boolean;
  messages: CanonicalMessage[];
  abortSignal?: AbortSignal;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  /** Legacy compatibility flag; summary failures never fabricate a checkpoint. */
  allowFallbackOnFailure?: boolean;
  budgetEvaluator?: CompactionBudgetEvaluator;
  /** Serializable request template used to reconstruct request-level budgeting across a sidecar boundary. */
  budgetRequest?: CanonicalModelRequest;
  /** Candidate-message preparation intent for a remote context runtime. */
  budgetPreparation?: Omit<ContextPrepareInput, "abortSignal">;
  budgetCalibration?: TokenCalibrationBaseline;
};

/**
 * Optional read-only detail from an AgentLoop request-budget evaluation.
 * Context consumes only the returned snapshot; the detail is retained solely
 * by native test instrumentation so a saved trace can independently replay
 * the request-level accounting input.
 */
export type CompactionBudgetEvaluationObservation = {
  request: CanonicalModelRequest;
  maxContextTokens: number;
  reservedOutputTokens: number;
  calibration?: TokenCalibrationBaseline;
};

export type CompactionBudgetEvaluator = ((messages: CanonicalMessage[]) => Promise<TokenBudgetSnapshot>) & {
  /** Returns the input that produced the most recently returned snapshot. */
  getLastObservation?: () => CompactionBudgetEvaluationObservation | undefined;
};

/** Derive the public budget intent from an in-process auto-compaction call. */
export function projectCompactionBudget(input: CompactionAutoCompactInput): CompactionBudgetProjection {
  return {
    stage: input.budgetStage ?? (input.allowFallbackOnFailure === true
      ? "recovery"
      : input.maxContextTokens === undefined
        ? "pre_route"
        : "routed"),
    trigger: input.trigger ?? "auto",
    ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
    ...(input.reservedOutputTokens !== undefined ? { reservedOutputTokens: input.reservedOutputTokens } : {}),
    ...(input.manualForce !== undefined ? { manualForce: input.manualForce } : {}),
    ...(input.allowFallbackOnFailure !== undefined ? { allowFallbackOnFailure: input.allowFallbackOnFailure } : {}),
    ...(input.budgetRequest ? { request: input.budgetRequest } : {}),
    ...(input.budgetPreparation ? { preparation: input.budgetPreparation } : {}),
    ...(input.budgetCalibration ? { calibration: input.budgetCalibration } : {}),
  };
}

/** Minimal token-budget capability consumed by the compaction orchestrator. */
export type CompactionBudgetPort = {
  evaluate(
    messages: CanonicalMessage[],
    maxContextTokens: number,
    options?: TokenBudgetEvaluateOptions,
  ): TokenBudgetSnapshot;
  estimateMessagesTokens(messages: CanonicalMessage[]): number;
};

/** Policy capability; it decides, but never performs, a model summary call. */
export type CompactionPolicyPort = {
  evaluateSnapshot(snapshot: TokenBudgetSnapshot): AutoCompactionDecision;
};

/** Full-summary capability owned by a summarizer provider. */
export type CompactionSummaryPort = {
  run(input: CompactionInput): Promise<CompactionResult>;
};

/** Deterministic tool-result projection capability. */
export type CompactionMicroPort = {
  apply(input: MicroCompactionInput): MicroCompactionResult;
};

/** Deterministic middle-turn projection capability. */
export type CompactionSnipPort = {
  snip(
    messages: CanonicalMessage[],
    options?: { targetTokens?: number; targetTotalTokens?: number },
  ): SnipResult;
};

/** Provider-owned overflow decision capability. */
export type CompactionRecoveryPort = {
  decide(input: ContextRecoveryInput): ContextRecoveryDecision;
};

/**
 * Context-level compaction Definition.
 *
 * The context runtime consumes this contract and does not know which native,
 * host, or future remote provider implements each stage.  The stages remain
 * separate so a policy or deterministic projection can be replaced without
 * replacing the summarizer provider.
 */
export type CompactionPort = {
  /** Optional generation-level cleanup for provider-owned resources. */
  dispose?: () => void | Promise<void>;
  /**
   * High-level provider composition. When present, the context consumer
   * delegates the complete policy/stage ordering to this function instead of
   * knowing how individual stages are sequenced. Stage fields remain optional
   * compatibility inputs for older providers and tests.
   */
  autoCompact?: (input: CompactionAutoCompactInput) => Promise<AutoCompactResult>;
  budget?: CompactionBudgetPort;
  policy?: CompactionPolicyPort;
  summary?: CompactionSummaryPort;
  micro?: CompactionMicroPort;
  snip?: CompactionSnipPort;
  recovery?: CompactionRecoveryPort;
  buildPostCompactMessages(result: CompactionResult): CanonicalMessage[];
  truncateHeadPreservingCheckpoint(messages: CanonicalMessage[], keepRatio: number): CanonicalMessage[];
};
