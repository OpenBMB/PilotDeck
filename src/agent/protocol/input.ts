import type { CanonicalContentBlock } from "../../model/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";

/** User-visible execution modes accepted at the Agent input boundary. */
export const AGENT_RUN_MODES = ["agent", "plan", "ask"] as const;

export type AgentRunMode = (typeof AGENT_RUN_MODES)[number];

/** Parse a wire/UI value without choosing a caller-specific fallback. */
export function parseAgentRunMode(value: unknown): AgentRunMode | undefined {
  return typeof value === "string" && AGENT_RUN_MODES.some((mode) => mode === value)
    ? value as AgentRunMode
    : undefined;
}

export type AgentModelOverride = {
  provider: string;
  model: string;
  /** @deprecated Provider adapters may ignore temperature. */
  temperature?: number;
  speed?: number;
  thinking?: import("../../model/index.js").CanonicalThinkingConfig;
};

export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
  workspaceId?: string;
  storageConfigVersion?: string;
  invocationLogSink?: import("../../storage/invocationStorage.js").ModelInvocationLogSink;
  /**
   * Host-owned execution identity. Gateway and external transports use this
   * to keep one run/operation identity across an AgentLoop provider boundary.
   */
  execution?: Pick<import("../modules/protocol.js").AgentExecutionContext, "runId" | "operationId" | "idempotencyKey" | "operationDeadline">;
  maxTurns?: number;
  /** Gateway-owned USD ceiling for this submitted turn. */
  maxBudgetUsd?: number;
  /** Gateway-owned USD ceiling shared by every turn in an SDK session. */
  taskBudgetUsd?: number;
  /** Gateway-owned amount already charged to `taskBudgetUsd` before this turn. */
  initialTaskBudgetSpentUsd?: number;
  metadata?: Record<string, unknown>;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  /** Allow the native elicitation channel without enabling permission prompts. */
  canElicit?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  /**
   * Synthetic messages appended after the user input in the turn.
   * Stored in transcript with `metadata.synthetic: true` so they are
   * visible to the model but filtered out of the Web UI display.
   */
  syntheticMessages?: import("../../model/index.js").CanonicalMessage[];
  modelOverride?: AgentModelOverride;
  /** Submitted model snapshot, recorded for replay and legacy session clients. */
  modelSelection?: NonNullable<import("../../session/transcript/TranscriptEntry.js").SessionMetadataValue["modelSelection"]>;
};
