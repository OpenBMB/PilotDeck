import type { CanonicalContentBlock } from "../../model/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";

export type AgentRunMode = "agent" | "plan" | "ask";

export type AgentModelOverride = {
  provider: string;
  model: string;
  temperature?: number;
  speed?: number;
  thinking?: import("../../model/index.js").CanonicalThinkingConfig;
};

export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
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
};
