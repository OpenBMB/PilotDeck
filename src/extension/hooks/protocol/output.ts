export type PilotDeckPermissionHookDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type PilotDeckHookSpecificOutput = {
  hookEventName: string;
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  permissionDecision?: "allow" | "deny" | "ask" | "passthrough";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  decision?: PilotDeckPermissionHookDecision;
  retry?: boolean;
  worktreePath?: string;
};

export type PilotDeckHookSyncOutput = {
  type: "sync";
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  specific?: PilotDeckHookSpecificOutput;
  raw?: unknown;
};

export type PilotDeckHookAsyncOutput = {
  type: "async";
  /** SDK callback-generated id used by the Gateway deferred-result registry. */
  invocationId?: string;
  /** Caller-selected deferred-result deadline in milliseconds. */
  timeoutMs?: number;
  raw?: unknown;
};

export type PilotDeckHookOutput = PilotDeckHookSyncOutput | PilotDeckHookAsyncOutput;
