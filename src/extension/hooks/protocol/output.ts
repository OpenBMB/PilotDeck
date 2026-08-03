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
  /** Restricted PreModelRequest patch; messages and tools cannot be replaced. */
  modelRequestPatch?: {
    provider?: string;
    model?: string;
    maxOutputTokens?: number;
    temperature?: number;
    metadata?: Record<string, unknown>;
  };
  artifactContracts?: Array<{
    id: string;
    path: string;
    required?: boolean;
    validatorIds?: string[];
    expectedExtensions?: string[];
    options?: Record<string, unknown>;
    domainId?: string;
  }>;
  /** Session-scoped context consumed by the next model request. */
  dynamicContext?: Array<{
    id: string;
    content: string;
    priority?: "critical" | "high" | "normal" | "low";
    ttlMs?: number;
  }>;
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
  raw?: unknown;
};

export type PilotDeckHookOutput = PilotDeckHookSyncOutput | PilotDeckHookAsyncOutput;
