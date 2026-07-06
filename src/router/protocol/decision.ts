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
  subagentModelOverride?: boolean;
  mediaCapabilityRerouted?: {
    required: import("../../model/protocol/multimodal.js").InputModality[];
    from: string;
    to: string;
  };
  cacheAwareSwitch?: {
    action: "kept_sticky" | "switched";
    from: string;
    to: string;
    cachedCost: number;
    prefillCost: number;
    estimatedInputTokens: number;
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
  metadata?: {
    lastUsage?: RouterDecisionInputUsageHint;
    explicitProvider?: string;
    explicitModel?: string;
    /** Tier from the previous turn; fed to the judge for context-aware classification. */
    previousTier?: string;
    previousProvider?: string;
    previousModel?: string;
  };
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  projectPath?: string;
  abortSignal?: AbortSignal;
};
