export type PermissionMode = "default" | "plan" | "bypassPermissions";

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

export type SudoPolicyAction = "deny" | "ask" | "allow";

export type SudoRemoteHostPolicy = {
  /** Hostname, user@hostname, IP, or a `*` wildcard pattern. */
  host: string;
  action: SudoPolicyAction;
};

export type SudoPermissionPolicy = {
  /** Policy for sudo executed by the local shell. */
  local: SudoPolicyAction;
  /** Default policy for sudo detected inside an ssh remote command/script. */
  remote: SudoPolicyAction;
  /** Host-specific remote overrides. First matching entry wins. */
  remoteHosts: SudoRemoteHostPolicy[];
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
  sudoPolicy: SudoPermissionPolicy;
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

export const DEFAULT_SUDO_PERMISSION_POLICY: SudoPermissionPolicy = {
  local: "deny",
  remote: "deny",
  remoteHosts: [],
};

export function createDefaultPermissionContext(options: {
  cwd: string;
  mode?: PermissionMode;
  canPrompt?: boolean;
  bypassAvailable?: boolean;
  additionalWorkingDirectories?: string[];
  planDirectoryPath?: string;
  rules?: Partial<PermissionRuleSet>;
  sudoPolicy?: Partial<SudoPermissionPolicy>;
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
    sudoPolicy: normalizeSudoPermissionPolicy(options.sudoPolicy),
  };
}

export function normalizeSudoPermissionPolicy(value: unknown): SudoPermissionPolicy {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Partial<SudoPermissionPolicy>
    : {};
  return {
    local: normalizeSudoPolicyAction(record.local, DEFAULT_SUDO_PERMISSION_POLICY.local),
    remote: normalizeSudoPolicyAction(record.remote, DEFAULT_SUDO_PERMISSION_POLICY.remote),
    remoteHosts: normalizeSudoRemoteHosts(record.remoteHosts),
  };
}

function normalizeSudoPolicyAction(value: unknown, fallback: SudoPolicyAction): SudoPolicyAction {
  return value === "deny" || value === "ask" || value === "allow" ? value : fallback;
}

function normalizeSudoRemoteHosts(value: unknown): SudoRemoteHostPolicy[] {
  if (!Array.isArray(value)) return [];
  const out: SudoRemoteHostPolicy[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Partial<SudoRemoteHostPolicy>;
    const host = typeof record.host === "string" ? record.host.trim() : "";
    if (!host) continue;
    const action = normalizeSudoPolicyAction(record.action, "deny");
    const key = `${host.toLowerCase()}:${action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, action });
  }
  return out;
}
