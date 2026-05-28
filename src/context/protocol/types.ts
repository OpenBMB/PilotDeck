import type {
  CanonicalMessage,
  CanonicalModelError,
  CanonicalToolSchema,
} from "../../model/index.js";

/** Diagnostic produced by context runtime; non-fatal except for `severity:"fatal"`. */
export type ContextDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error" | "fatal";
  message: string;
  path?: string;
};

/**
 * Boundary metadata exposed to the agent loop after `prepareForModel`.
 * Lets the loop know which compact boundary (if any) the projection sliced
 * messages from.
 */
export type ContextBoundary = {
  type: "compact" | "microcompact" | "snip";
  /** Number of messages retained after the boundary. */
  retainedMessages: number;
  /** Free-form metadata (compact boundary trigger, preTokens, etc). */
  metadata?: Record<string, unknown>;
};

/** Fully-prepared model context produced by `prepareForModel`. */
export type ModelContext = {
  messages: CanonicalMessage[];
  systemPrompt?: string;
  systemPromptParts: string[];
  tools: CanonicalToolSchema[];
  diagnostics: ContextDiagnostic[];
  boundaries: ContextBoundary[];
  metadata?: Record<string, unknown>;
  /** A4: message indices for `cache_control` breakpoints (Anthropic only). */
  cacheBreakpoints?: number[];
};

export type ContextPrepareInput = {
  sessionId: string;
  turnId: string;
  cwd: string;
  abortSignal?: AbortSignal;
  /** Provider/model identifier. */
  provider: string;
  model: string;
  /** Permission mode label for prompt assembly. */
  permissionMode: string;
  /** Additional working directories from PermissionContext. */
  additionalWorkingDirectories: string[];
  messages: CanonicalMessage[];
  tools: CanonicalToolSchema[];
  /** Optional full system-prompt override. */
  customSystemPrompt?: string;
  /** Optional system-prompt addendum appended after the base prompt. */
  appendSystemPrompt?: string;
  /** Maximum messages retained when no compact boundary is in play. */
  maxMessages?: number;
};

export type ContextToolResultInput = {
  sessionId: string;
  turnId: string;
  /** New tool result blocks projected by the agent loop. */
  toolResultMessage: CanonicalMessage;
  messages: CanonicalMessage[];
};

export type ContextToolResultResult = {
  messages: CanonicalMessage[];
  diagnostics: ContextDiagnostic[];
};

export type ContextRecoveryInput = {
  sessionId: string;
  turnId: string;
  error: CanonicalModelError;
  messages: CanonicalMessage[];
  /** Set to true after the loop already ran one truncate-and-retry cycle. */
  hasAttemptedCompact: boolean;
};

export type ContextRecoveryDecision =
  | { type: "truncate_head_and_retry"; keepRatio: number; reason: string }
  | { type: "strip_images_and_retry"; reason: string }
  | { type: "give_up"; reason: string };

/**
 * Hand-off after a turn finishes (success, failure, or aborted). When a
 * memory provider is wired into context, this is where the runtime forwards
 * the conversation snapshot to the provider's capture pipeline. The hook is
 * advisory — context implementations without memory simply no-op.
 */
export type ContextCaptureTurnInput = {
  sessionId: string;
  turnId: string;
  /** Whole turn-end message history (not the in-flight projection). */
  messages: CanonicalMessage[];
  /** True if the turn ended in error/abort; false on completed success. */
  errored: boolean;
};

/**
 * Public ContextRuntime contract consumed by the agent loop. The runtime is
 * **not** model-aware — `recoverFromModelError` only returns a decision; the
 * loop is responsible for any model calls (CompactionEngine.summarize) needed
 * to fulfill the decision.
 */
export interface ContextRuntime {
  prepareForModel(input: ContextPrepareInput): Promise<ModelContext>;
  applyToolResults(input: ContextToolResultInput): Promise<ContextToolResultResult>;
  recoverFromModelError(input: ContextRecoveryInput): Promise<ContextRecoveryDecision>;
  /**
   * Optional turn-end hook (memory capture). Implementations without a
   * memory provider should leave this absent so the agent loop can short-
   * circuit. Throwing must not break the turn — implementations swallow.
   */
  captureTurn?(input: ContextCaptureTurnInput): Promise<void>;
}
