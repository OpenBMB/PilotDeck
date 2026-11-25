import type { CanonicalUsage } from "../../model/index.js";
import type { RouterModelRef } from "../config/schema.js";

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
  lastUsage?: RouterDecisionInputUsageHint;
  /** Latest successful execution for this session and role, including provider-reported usage. */
  lastSuccessful?: { target: RouterModelRef; usage?: CanonicalUsage };
  updatedAt: number;
};

export type RouterDecisionInputUsageHint = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** One AgentLoop run owns this state, including its tool continuations. */
export type RouterTurnRouting = {
  /** Model to continue with in this turn, including after an output limit. */
  continuationTarget?: RouterDecision;
  failedModels: Set<string>;
  failedProviders: Set<string>;
};

export type RouterDecisionInput = {
  request: import("../../model/protocol/canonical.js").CanonicalModelRequest;
  sessionId: string;
  isMainAgent: boolean;
  turnRouting?: RouterTurnRouting;
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
  };
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  projectPath?: string;
  /** Ownership of the execution. Auxiliary calls must not update the main turn's observations. */
  isMainAgent?: boolean;
  turnRouting?: RouterTurnRouting;
  abortSignal?: AbortSignal;
  /** Reproject already resolved context for a selected or fallback provider. */
  requestForTarget?: (target: { provider: string; model: string }) => Promise<import("../../model/protocol/canonical.js").CanonicalModelRequest>;
  /** Final wire-bound request after routing patches and media projection. */
  onRequestPrepared?: (
    request: import("../../model/protocol/canonical.js").CanonicalModelRequest,
    omittedImages?: number,
  ) => void | Promise<void>;
};
