import type {
  TaskCard,
  TaskSnapshot,
  RoutePhase,
  UpgradeEvidence,
  ContinuationRoutingInfo,
} from "../tokenSaver/buildTaskCard.js";

export type RouterScenarioType =
  | "default"
  | "subagent"
  | "explicit";

export type RouterDecisionResolution =
  | "explicit"
  | "scenario"
  | "tokenSaver"
  | "custom"
  | "fallback";

export type RouterMutationsLog = {
  systemPromptSlim?: { from: number; to: number; preservedKeywords: string[] };
  toolsStripped?: { before: number; after: number; mode?: "allowlist" | "blocklist"; patterns: string[] };
  orchestrationPromptInjected?: { tier: string; chars: number };
  orchestrationActivated?: { tier: string; continued: boolean };
  asyncAgentLaunchedRewritten?: boolean;
  subagentTagStripped?: boolean;
  mediaCapabilityRerouted?: {
    required: import("../../model/protocol/multimodal.js").InputModality[];
    from: string;
    to: string;
  };
  cacheAwareSwitch?: {
    action: "kept_sticky" | "switched" | "bypassed_by_evidence";
    from: string;
    to: string;
    cachedCost: number;
    prefillCost: number;
    estimatedInputTokens: number;
    direction?: "upgrade" | "downgrade" | "same" | "unknown";
    policy?: "guard" | "amortized" | "exempt";
    evidence?: UpgradeEvidence;
    amortizedPrefillCost?: number;
    remainingTurns?: number;
  };
  taskCardRoute?: {
    shortCircuited: boolean;
    hasCard: boolean;
    judgeCalled: boolean;
    isNewTask?: boolean;
    reason: "continuation" | "task_done_reset" | "judge" | "fallback";
    fromPhase?: RoutePhase;
    toPhase?: RoutePhase;
    judgeAttempts?: number;
    judgeUsage?: import("../../model/index.js").CanonicalUsage;
  };
};

export type RouterRequestPatch = Pick<
  import("../../model/protocol/canonical.js").CanonicalModelRequest,
  "messages" | "tools" | "systemPrompt"
>;

export type RouterDecision = {
  provider: string;
  model: string;
  scenarioType: RouterScenarioType;
  tokenSaverTier?: string;
  isSubagent: boolean;
  orchestrating: boolean;
  resolvedFrom: RouterDecisionResolution;
  mutations: RouterMutationsLog;
  requestPatch?: Partial<RouterRequestPatch>;
};

export type SessionRoutingState = {
  sessionId: string;
  isSubagent: boolean;
  tokenSaverTier?: string;
  stickyProvider?: string;
  stickyModel?: string;
  orchestrating: boolean;
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  taskCard?: TaskCard;
  updatedAt: number;
};

export type RouterDecisionInputUsageHint = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RouterDecisionInput = {
  request: import("../../model/protocol/canonical.js").CanonicalModelRequest;
  sessionId: string;
  isMainAgent: boolean;
  /** Cancels a pending router judge request when the enclosing turn stops. */
  abortSignal?: AbortSignal;
  metadata?: {
    lastUsage?: RouterDecisionInputUsageHint;
    explicitProvider?: string;
    explicitModel?: string;
    /** Tier from the previous turn; fed to the judge for context-aware classification. */
    previousTier?: string;
    previousProvider?: string;
    previousModel?: string;
    taskSnapshot?: TaskSnapshot;
    continuation?: ContinuationRoutingInfo;
    upgradeEvidence?: UpgradeEvidence;
  };
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  projectPath?: string;
  abortSignal?: AbortSignal;
};
