import type { CanonicalMessage } from "../../../model/index.js";
import type { AgentLoopSeedState } from "../../loop/AgentLoop.js";
import type { AgentTurnResult } from "../../protocol/result.js";
import type { ModuleBinding, ModuleOutcome } from "../protocol.js";

/**
 * Host-owned identity for one sidecar execute attempt. It deliberately does
 * not expose a Session, Gateway, Router, or transport implementation.
 */
export type AgentLoopOperationIdentity = Readonly<{
  runId: string;
  operationId: string;
  requestId: string;
  sessionId: string;
  turnId: string;
  binding: ModuleBinding;
  idempotencyKey?: string;
}>;

export type AgentLoopOperationAccepted = AgentLoopOperationIdentity & Readonly<{
  streamId: string;
}>;

export type AgentLoopOperationKnownTerminal = AgentLoopOperationIdentity & Readonly<{
  streamId?: string;
  lastAppliedSequence: number;
  outcome: Exclude<ModuleOutcome, "result_unknown">;
  result: AgentTurnResult;
  messages: CanonicalMessage[];
  seedState?: AgentLoopSeedState;
  code?: string;
  error?: unknown;
}>;

export type AgentLoopOperationUnknownTerminal = AgentLoopOperationAccepted & Readonly<{
  lastAppliedSequence: number;
  code?: string;
  error?: unknown;
}>;

export type AgentLoopOperationResolution = Readonly<{
  outcome: Exclude<ModuleOutcome, "result_unknown">;
  result: AgentTurnResult;
  messages: CanonicalMessage[];
  seedState?: AgentLoopSeedState;
}>;

export type AgentLoopOperationRecovery =
  | Readonly<{ state: "terminal"; resolution: AgentLoopOperationResolution }>
  | Readonly<{ state: "result_unknown"; unknown: AgentLoopOperationUnknownTerminal }>
  | Readonly<{ state: "incomplete" }>;

/**
 * A host operation-status port. The sidecar only reports immutable protocol
 * facts; this owner decides whether a previously committed result is safe to
 * return after a result_unknown terminal.
 */
export type AgentLoopOperationLedger = {
  /**
   * Resolves an already durable terminal before a replacement sidecar is
   * asked to execute the same host operation again. Request, stream, and
   * connection identities are attempt-local, so implementations must match
   * this lookup on the durable operation identity instead.
   */
  recover?(
    input: AgentLoopOperationIdentity,
  ): AgentLoopOperationRecovery | undefined | Promise<AgentLoopOperationRecovery | undefined>;
  start(input: AgentLoopOperationIdentity): void | Promise<void>;
  accept(input: AgentLoopOperationAccepted): void | Promise<void>;
  terminal(input: AgentLoopOperationKnownTerminal): void | Promise<void>;
  resultUnknown(input: AgentLoopOperationUnknownTerminal): void | Promise<void>;
  reconcile(
    input: AgentLoopOperationUnknownTerminal,
  ): AgentLoopOperationResolution | undefined | Promise<AgentLoopOperationResolution | undefined>;
};

export class AgentLoopResultUnknownError extends Error {
  readonly code = "AGENT_LOOP_RESULT_UNKNOWN";

  constructor(message = "AgentLoop terminal outcome is result_unknown and host reconciliation found no final result.") {
    super(message);
    this.name = "AgentLoopResultUnknownError";
  }
}

export function isAgentLoopResultUnknownError(error: unknown): error is AgentLoopResultUnknownError {
  return error instanceof AgentLoopResultUnknownError
    || (error instanceof Error && (error as Error & { code?: string }).code === "AGENT_LOOP_RESULT_UNKNOWN");
}
