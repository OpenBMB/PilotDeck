import type { CanonicalContentBlock } from "../../model/index.js";
import type { PermissionMode, PermissionRuleSet, SudoPermissionPolicy } from "../../permission/index.js";

export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  sudoPolicy?: Partial<SudoPermissionPolicy>;
};
