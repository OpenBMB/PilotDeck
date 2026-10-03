/**
 * Shared contracts for `task_id` continuation of a completed child agent
 * (agent tool). Keeps the error vocabulary in one place so the loader
 * (`session/transcript/loadSubagentContinuation.ts`), the AgentLoop fork
 * path, and tests agree on failure codes without the tool layer importing
 * agent internals.
 */

import type { CanonicalMessage } from "../../model/index.js";

export type SubagentContinuationErrorCode =
  /** Runtime lacks the persistence hooks required for continuation. */
  | "subagent_task_unsupported"
  /** Unknown id, or the task belongs to a different parent session. */
  | "subagent_task_unknown"
  /** Another continuation of the same task is already in flight. */
  | "subagent_task_busy"
  /** Requested subagent_type conflicts with the saved task definition. */
  | "subagent_task_type_conflict"
  /** Legacy or structurally incomplete sidechain transcript. */
  | "subagent_task_history_unsupported"
  /** Saved task metadata carries no model — refuse instead of silently switching. */
  | "subagent_task_model_missing"
  /** Last recorded round failed (error / aborted / max_turns) — not safe to resume. */
  | "subagent_task_round_failed";

export class SubagentContinuationError extends Error {
  readonly code: SubagentContinuationErrorCode;

  constructor(code: SubagentContinuationErrorCode, message: string) {
    super(message);
    this.name = "SubagentContinuationError";
    this.code = code;
  }
}

/**
 * Validated continuation state produced by the persistence loader. Everything
 * the fork path needs to re-open the same child identity with its prior
 * durable history. Permissions/tools are deliberately NOT part of this
 * state — they always come from the current parent runtime.
 */
export type SubagentContinuationState = {
  /** Prior durable child messages, already replay-validated and pairing-scrubbed. */
  messages: CanonicalMessage[];
  /** Saved subagent definition id (identity is preserved across rounds). */
  definitionId: string;
  /** Saved provider the child actually used. */
  provider: string;
  /** Saved model the child actually used. */
  model: string;
  /** Saved child session id (keeps sidechain appends in the same file). */
  subagentSessionId: string;
  /** Number of completed rounds — used for unique follow-up turn ids. */
  nextTurnIndex: number;
};
