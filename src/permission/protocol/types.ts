export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export type PermissionRuleSource = "user" | "project" | "session" | "policy" | "cli";

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionRuleBehavior;
  toolName: string;
  pattern?: string;
};

export type PermissionRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
};

export type PermissionContext = {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  cwd: string;
  additionalWorkingDirectories: string[];
  canPrompt: boolean;
  bypassAvailable: boolean;
  /** Absolute path of the project-local `.pilotdeck/plans` directory. */
  planDirectoryPath?: string;
};

export type PermissionDecisionReason =
  | { type: "mode"; mode: PermissionMode; message: string }
  | { type: "rule"; behavior: PermissionRuleBehavior; rule: PermissionRule; message: string }
  | { type: "tool"; toolName: string; message: string }
  | { type: "safety"; message: string }
  | { type: "runtime"; message: string };

export type PermissionRequest = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  reason: PermissionDecisionReason;
  options: PermissionRequestOption[];
  metadata?: Record<string, unknown>;
};

export type PermissionRequestOption =
  | { id: "allow_once"; label: string }
  | { id: "allow_session"; label: string; rules?: PermissionRule[] }
  | { id: "deny"; label: string }
  | { id: "cancel"; label: string };

export type PermissionDecision =
  | {
      type: "allow";
      reason: PermissionDecisionReason;
      updatedInput?: unknown;
    }
  | {
      type: "deny";
      reason: PermissionDecisionReason;
      message: string;
    }
  | {
      type: "ask";
      reason: PermissionDecisionReason;
      request: PermissionRequest;
    }
  | {
      type: "cancel";
      reason: PermissionDecisionReason;
      message: string;
    };

export type PermissionResult = PermissionDecision | { type: "passthrough"; reason?: PermissionDecisionReason };

export function emptyPermissionRuleSet(): PermissionRuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
  };
}

export function createDefaultPermissionContext(options: {
  cwd: string;
  mode?: PermissionMode;
  canPrompt?: boolean;
  bypassAvailable?: boolean;
  additionalWorkingDirectories?: string[];
  planDirectoryPath?: string;
  rules?: Partial<PermissionRuleSet>;
}): PermissionContext {
  return {
    mode: options.mode ?? "default",
    canPrompt: options.canPrompt ?? false,
    bypassAvailable: options.bypassAvailable ?? false,
    cwd: options.cwd,
    additionalWorkingDirectories: options.additionalWorkingDirectories ?? [],
    ...(options.planDirectoryPath ? { planDirectoryPath: options.planDirectoryPath } : {}),
    rules: {
      ...emptyPermissionRuleSet(),
      ...options.rules,
    },
  };
}
