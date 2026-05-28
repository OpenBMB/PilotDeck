import type { CanonicalContentBlock } from "../../model/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";

export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  permissionRules?: Partial<PermissionRuleSet>;
};
