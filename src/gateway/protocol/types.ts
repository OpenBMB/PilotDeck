import type { AgentTurnResult } from "../../agent/index.js";
import type { AgentStatusMessageInput } from "../../session/transcript/TranscriptWriter.js";
import type { AgentRunMode } from "../../agent/protocol/input.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../../cron/protocol/types.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import type { SessionInfo as ProjectSessionInfo } from "../../session/index.js";
import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationQuestion,
} from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type { FormDialogSchema } from "../../tool/dialog/FormDialogSchema.js";
import type {
  WebListProjectsResult as WebUiListProjectsResult,
  WebProjectSummary as WebUiProjectSummary,
  WebReadSessionMessagesInput as WebUiReadSessionMessagesInput,
  WebReadSessionMessagesResult as WebUiReadSessionMessagesResult,
  WebReadSubagentMessagesInput as WebUiReadSubagentMessagesInput,
  WebReadSubagentMessagesResult as WebUiReadSubagentMessagesResult,
  WebForkSessionInput as WebUiForkSessionInput,
  WebForkSessionResult as WebUiForkSessionResult,
  WebReplaceLastTurnInput as WebUiReplaceLastTurnInput,
  WebReplaceLastTurnResult as WebUiReplaceLastTurnResult,
  WebFinalizeLastTurnReplacementInput as WebUiFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult as WebUiFinalizeLastTurnReplacementResult,
} from "../../web/client/protocol.js";
import type {
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillAddressInput,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../../extension/skills/types.js";

export type GatewayChannelKey =
  | "cli" | "tui" | "feishu" | "weixin" | "qq" | "web" | "test"
  | "telegram" | "discord" | "slack" | "matrix" | "mattermost"
  | "signal" | "whatsapp" | "bluebubbles"
  | "dingtalk" | "wecom" | "wecom_callback"
  | "email" | "sms" | "homeassistant"
  | "api_server" | "webhook"
  | (string & {});

export type GatewayMode = "default" | "plan" | "bypassPermissions";

export type ChannelAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type GatewayOutboundAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  source: "tool_result" | "media_reference" | "local_path";
  metadata?: Record<string, unknown>;
};

export type TurnUsage = CanonicalUsage;

export type GatewaySubmitTurnInput = {
  sessionKey: string;
  channelKey: GatewayChannelKey;
  message: string;
  projectKey?: string;
  /** Override the agent session's working directory for this session. */
  workspaceCwd?: string;
  attachments?: ChannelAttachment[];
  uploadedAttachments?: UploadedAttachmentRef[];
  /** A one-turn model override. Persisted session preferences are managed separately. */
  modelOverride?: ExplicitModelSelection;
  runMode?: AgentRunMode;
  mode?: GatewayMode;
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: GatewayMode;
  /** Allow model-visible plan mode tools for this turn. Defaults to true only for explicit plan-mode turns. */
  allowPlanModeTools?: boolean;
  /**
   * Whether the submitting host can answer mid-turn user prompts such as
   * permission requests or ask_user_question elicitation. Headless CLI runs
   * set this false so the agent avoids tools that would otherwise hang.
   */
  canPrompt?: boolean;
  /**
   * Whether the submitting SDK can answer native `ask_user_question`
   * elicitation independently of permission prompts. Omitted by every
   * non-SDK caller and therefore defaults to the historical behaviour.
   */
  canElicit?: boolean;
  runId?: string;
  maxTurns?: number;
  /** Gateway-owned USD ceiling for this submitted turn. */
  maxBudgetUsd?: number;
  /** Hard wall-clock limit for this turn. The gateway aborts and closes the session when exceeded. */
  timeoutMs?: number;
  /** SDK tool surface filters applied when creating the session runtime. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Optional Claude-like permission adapter; native modes remain unchanged. */
  sdkPermissionMode?: "acceptEdits" | "dontAsk";
  /**
   * SDK-only session inputs. Gateway owns their lifetime and applies them
   * before it creates an AgentSession; AgentLoop never reads this envelope.
   */
  sdkSessionConfig?: GatewaySessionSdkConfig;
  telemetry?: {
    ownerModule?: TelemetryModule;
    executionKind?: TelemetryExecutionKind;
    phase?: string;
  };
  /**
   * Channel-specific synthetic messages appended to the turn input.
   * These are stored in the transcript with `metadata.synthetic: true`
   * so they are visible to the model but hidden from the Web UI.
   */
  syntheticMessages?: Array<{ text: string; purpose?: string }>;
};

/** Restrictive, session-local tool visibility policy owned by the Gateway. */
export type GatewayToolSandboxPolicy = {
  type?: "tool_policy";
  filesystem?: "read_only" | "deny";
  network?: "deny";
  process?: "deny";
};

/**
 * A named, Gateway-host-owned command sandbox. The profile name has meaning
 * only on the Gateway host; clients cannot provide a runner or sandbox
 * executable over the wire.
 */
export type GatewayHostSandboxPolicy = {
  type: "host";
  profile: string;
  /** Only expose tools whose host execution is owned by the selected profile. */
  toolIsolation?: "strict";
  filesystem?: "read_only" | "deny";
  network?: "deny";
  process?: "deny";
};

export type GatewaySessionSandboxPolicy = GatewayToolSandboxPolicy | GatewayHostSandboxPolicy;

/** Gateway-only metadata for native, plugin, or MCP tools withheld from the initial model schema. */
export type GatewayDeferredTool = { name: string; searchHint?: string };

export type GatewaySessionSdkConfig = {
  /**
   * Creates a Gateway-owned ephemeral session. Its transcript and runtime
   * artifacts never use project session storage and it cannot be resumed.
   */
  persistSession?: false;
  /** Replaces the assembled PilotDeck system prompt for this SDK session. */
  systemPrompt?: string;
  /** Addendum appended after PilotDeck's normal assembled system prompt. */
  appendSystemPrompt?: string;
  /** Applied only while this SDK session is in native plan mode. */
  planModeInstructions?: string;
  /** Claude-like session adapter mode; native permission mode stays unchanged. */
  permissionMode?: "acceptEdits" | "dontAsk";
  /** Single-hop aliases resolved by the existing AgentLoop tool lookup. */
  toolAliases?: Record<string, string>;
  /**
   * Canonical session tool names withheld until the Gateway-owned
   * `search_tools` catalog matches them. This only controls model visibility.
   */
  deferredTools?: GatewayDeferredTool[];
  /** Additional absolute roots accepted by the existing PermissionContext. */
  additionalWorkingDirectories?: string[];
  /**
   * SDK-only structured-output contract. The gateway scopes the schema to
   * the existing `structured_output` tool and asks the existing AgentLoop to
   * stop after that tool returns. It is not a provider-specific JSON mode.
   */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** SDK-defined subagent presets applied only to this session's existing agent tool. */
  agents?: Record<string, GatewaySdkAgentDefinition>;
  /**
   * Gateway-resolved skill visibility for this session. An explicit list only
   * filters the prompt projection and read_skill access; it never mutates the
   * project PluginRuntime.
   */
  skills?: string[] | "all";
  /**
   * Gateway-local plugin directories applied only to this SDK session. The
   * Gateway loads and owns their lifecycle; they do not alter project plugin
   * discovery or another session's extension surface.
   */
  plugins?: Array<{ type: "local"; path: string }>;
  /**
   * Serializable bridge configuration for SDK-owned hook callbacks. Callback
   * functions stay in the SDK process; the Gateway turns these entries into
   * ordinary native HTTP hooks before constructing the AgentSession.
   */
  hooks?: {
    url: string;
    headers?: Record<string, string>;
    events: Partial<Record<string, Array<{ matcher?: string; timeout?: number }>>>;
  };
  /** Include hook execution lifecycle events in the SDK stream. */
  includeHookEvents?: boolean;
  /** Include transient native tool progress in the SDK stream for this session. */
  agentProgressSummaries?: boolean;
  /** Surface child-agent text as typed SDK stream events, without transcript mutation. */
  forwardSubagentText?: boolean;
  /** Request one Gateway-owned post-turn prompt suggestion for successful turns. */
  promptSuggestions?: boolean;
  /** Restrictive model-visible tool policy; never an OS/container sandbox. */
  sandbox?: GatewaySessionSandboxPolicy;
  /** Dialog kinds enabled by the SDK callback for this session. */
  userDialogKinds?: Array<"input" | "select" | "confirm" | "form">;
  /** Selected Gateway-owned output style name for this SDK session. */
  outputStyle?: string;
  /**
   * Gateway-model-catalog reference used after a pre-content retryable model
   * failure. Gateway resolves and owns this session-scoped fallback; the SDK
   * never selects a provider itself.
   */
  fallbackModel?: string;
  /**
   * Gateway-owned USD budget. `session` scopes the ceiling to one SDK
   * session; `project` shares it across SDK sessions for this project. A
   * project budget may define an inactivity retention period. The Gateway is
   * responsible for persistence and enforcement; the SDK only serializes the
   * requested ceiling.
   */
  taskBudget?: {
    total: number;
    scope?: "session" | "project";
    projectRetentionMs?: number;
  };
  /**
   * Gateway-owned restrictive policy tier supplied by an embedding SDK.
   * It cannot grant access or persist configuration; deny/ask entries are
   * compiled to native PermissionRule values only for this session.
   */
  managedPermissions?: {
    deny: string[];
    ask: string[];
    defaultMode?: "plan";
    /** Restrictive policy may disable prompts but cannot enable them. */
    canPrompt?: false;
  };
  /**
   * Restrictive model-visible tool policy supplied by the SDK session. It is
   * applied after native, extension, and MCP discovery; it can only remove
   * tool definitions and never grants permission or starts a handler.
   */
  managedTools?: {
    allow: string[];
    deny: string[];
  };
  /**
   * Restrictive provider/model selector policy for this SDK session. It can
   * only reject the Gateway's resolved primary, fallback, or subagent model;
   * provider configuration and credentials remain host-owned.
   */
  managedModels?: {
    allow: string[];
    deny: string[];
  };
  /**
   * Gateway-owned, non-secret session overlay. The SDK never resolves paths
   * or writes a settings file: the Gateway validates these values and may
   * additionally resolve the selected host-local source layers.
   */
  settings?: {
    agent?: {
      model?: string | null;
      fallbackModel?: string | null;
      maxContextTokens?: number;
      maxOutputTokens?: number;
      thinking?: { enabled: boolean; budgetTokens?: number };
      subagents?: { default?: string | null; timeoutMs?: number; maxDepth?: number };
    };
  };
  /** Selects Gateway-owned sources; order is fixed by the Gateway policy. */
  settingSources?: Array<"managed" | "user" | "project" | "local">;
};

export type GatewayOutputStyle = {
  name: string;
  description?: string;
  plugin?: string;
  source?: "builtin" | "global" | "project";
};
export type GatewayOutputStylesListInput = { projectKey?: string; sessionKey?: string };
export type GatewayOutputStylesListResult = { styles: GatewayOutputStyle[]; selected?: string };
export type GatewaySetOutputStyleInput = { sessionKey: string; projectKey?: string; name: string | null };
export type GatewaySetOutputStyleResult = { applied: boolean; selected?: string };
export type GatewayReloadOutputStylesInput = { projectKey?: string };
export type GatewayReloadOutputStylesResult = { reloaded: boolean; changed: string[]; reason?: "unsupported" };
export type GatewayUsageSnapshotInput = { sessionKey?: string; projectKey?: string };
export type GatewayUsageSnapshotResult = {
  scope: "session" | "project";
  sessionId?: string;
  aggregate: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    totalBaselineCost: number;
    totalSavedCost: number;
    perScenario: Record<string, number>;
    perModel: Record<string, number>;
    perProvider: Record<string, number>;
    perTier: Record<string, number>;
    perRole: Record<string, number>;
    /** Number of requests grouped by the provenance of their cost amount. */
    costSources: Partial<Record<"provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown", number>>;
  };
  requests?: Array<{
    turnId?: string;
    provider: string;
    model: string;
    role?: "main" | "subagent";
    usage: Record<string, unknown>;
    cost?: { input: number; output: number; cacheRead: number; total: number };
    costSource?: "provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown";
    startedAt: string;
    endedAt: string;
  }>;
};

export type GatewayModelUsageRole = {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  /** Number of requests grouped by the provenance of their cost amount. */
  costSources: Partial<Record<"provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown", number>>;
};

/** Gateway-owned per-model accounting. Costs use the same native/provider pricing path as Router stats. */
export type GatewayModelUsage = GatewayModelUsageRole & {
  provider: string;
  model: string;
  roles: Partial<Record<"main" | "subagent", GatewayModelUsageRole>>;
};

export type GatewayModelUsageSnapshotInput = GatewayUsageSnapshotInput;
export type GatewayModelUsageSnapshotResult = {
  scope: "session" | "project";
  sessionId?: string;
  models: GatewayModelUsage[];
};

export type GatewaySdkAgentDefinition = {
  description: string;
  prompt: string;
  /** Start the existing agent-tool fork as a Gateway-owned detached task. */
  background?: boolean;
  /** Gateway-local model catalog reference; resolved before AgentSession construction. */
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  effort?: "low" | "medium" | "high";
  permissionMode?: "default" | "plan" | "bypassPermissions";
  /**
   * MCP servers are started for an individual fork and disposed when it ends.
   * A string references an SDK-session MCP endpoint; the Gateway resolves it
   * into an immutable fork-local endpoint before AgentSession construction.
   */
  mcpServers?: Record<string, GatewayMcpServerConfig> | Array<string | Record<string, GatewayMcpServerConfig>>;
  /** Gateway-resolved, fork-local skill visibility. */
  skills?: string[] | "all";
  /** `disabled` suppresses the project's native memory resolver for this fork. */
  memory?: "inherit" | "disabled";
  /** Static user context prepended to this child fork before its parent directive. */
  initialPrompt?: string;
  /** Named session-scoped AgentDefinition that observes this child run. */
  observer?: string;
  /** Optional postamble appended to the observer's read-only activity digest. */
  observerMessage?: string;
  /** SDK-provided child-only system reminder; never applied to the parent session. */
  criticalSystemReminder_EXPERIMENTAL?: string;
};

export type GatewaySteerTurnInput = {
  sessionKey: string;
  runId: string;
  itemId: string;
  message: string;
  projectKey?: string;
  attachments?: ChannelAttachment[];
};

export type GatewaySteerTurnResult = {
  accepted: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "turn_closing" | "cancelled";
};

/**
 * The only deferred-hook effect with a safe native ownership boundary:
 * context is injected through the existing mid-turn steer mailbox. Earlier
 * lifecycle decisions cannot be retroactively changed after a hook defers.
 */
export type GatewayAsyncHookResultOutput = {
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
  };
};

export type GatewayAsyncHookResultInput = {
  sessionKey: string;
  invocationId: string;
  output: GatewayAsyncHookResultOutput;
};

export type GatewayAsyncHookResult = {
  invocationId: string;
  status: "delivered" | "duplicate" | "expired" | "unknown";
};

export type GatewayCancelSteerInput = {
  sessionKey: string;
  runId: string;
  itemId: string;
};

export type GatewayCancelSteerResult = {
  cancelled: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "too_late";
};

export type GatewayRecordAgentStatusMessageInput = {
  sessionKey: string;
  turnId: string;
  projectKey?: string;
  status: AgentStatusMessageInput;
};

type GatewayTurnScopedEventMetadata = {
  /**
   * Stable id of the active turn that produced this event. Turn-scoped events
   * carry it so streaming clients can match deltas with lifecycle boundaries.
   */
  runId?: string;
};

export type GatewayEvent = GatewayTurnScopedEventMetadata & (
  | { type: "turn_started"; runId: string }
  | { type: "input_accepted"; runId: string }
  | { type: "steer_applied"; itemId: string; message: CanonicalMessage }
  | { type: "steer_unapplied"; itemId: string; reason: "turn_ended" }
  | { type: "model_request_started"; model?: string; provider?: string }
  | {
      type: "model_selection_changed";
      provider: string;
      model: string;
      source: "turn" | "session" | "router" | "default";
      reasoning?: number;
      temperature?: number;
      speed?: number;
    }
  | { type: "assistant_text_delta"; text: string }
  /** Opt-in post-turn UI guidance; it is not a transcript message. */
  | { type: "prompt_suggestion"; suggestion: string }
  | { type: "assistant_attachment"; attachment: GatewayOutboundAttachment }
  | { type: "file_artifacts"; artifacts: import("../../session/artifacts/FileArtifact.js").FileArtifact[] }
  | { type: "assistant_thinking_delta"; text: string }
  /** Opt-in child text projection; it is not part of the parent assistant output. */
  | { type: "subagent_text_delta"; subagentId: string; subagentType: string; text: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
  /** Transient progress from a running tool; never persisted as a tool result. */
  | {
      type: "tool_progress";
      toolCallId: string;
      toolName: string;
      message: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
    }
  | {
      type: "tool_call_finished";
      toolCallId: string;
      ok: boolean;
      resultPreview?: string;
      resultLineCount?: number;
      resultBytes?: number;
      toolName?: string;
      resultPath?: string;
      /**
       * Inline image results — emitted when the tool returns one or more
       * `PilotDeckToolResultContent { type: "image" }` blocks (e.g. `read_file`
       * on a PNG/JPG, or PDF-page rendering). Hosts render these alongside
       * the tool's row so the user sees the picture next to the call site
       * instead of in a stray user-side bubble. Empty when no images were
       * returned. Base64 payloads should already be size-budgeted by the tool.
       */
      images?: Array<{
        mimeType: string;
        data: string;
        bytes?: number;
        detail?: "auto" | "low" | "high";
      }>;
      /**
       * `PilotDeckToolErrorCode` of the underlying failure when `ok === false`.
       * Hosts use this to render type-specific affordances — e.g. the Web UI
       * only surfaces the "Add to Allowed Tools" suggestion for
       * `permission_denied` / `permission_required`, not for execution
       * failures like a non-zero shell exit code.
       */
      errorCode?: string;
      /** Structured data from the tool result (e.g. planFilePath for exit_plan_mode). */
      data?: Record<string, unknown>;
    }
  | { type: "tool_result_detail_available"; toolCallId: string; resultPath?: string; fullText?: string }
  | { type: "permission_request"; requestId: string; toolName: string; payload: unknown }
  /**
   * Native permission resolution after a tool is denied. Unlike
   * `permission_request`, this has no Gateway request id because the
   * permission decision lifecycle has already completed.
   */
  | { type: "permission_denied"; toolName: string; reason: string }
  | { type: "hook_started"; hookName: string; hookEvent: string }
  | {
      type: "hook_response";
      hookName: string;
      hookEvent: string;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
      asyncInvocationId?: string;
      asyncTimeoutMs?: number;
    }
  | {
      type: "hook_async_result";
      invocationId: string;
      hookName: string;
      hookEvent: string;
      status: "delivered" | "expired";
    }
  /**
   * B1 elicitation request: a tool (`ask_user_question`) wants the host
   * channel to render a multiple-choice dialog. The host MUST eventually
   * call `Gateway.respondElicitation({ requestId, answer })` so the
   * waiting tool can resume.
   */
  | {
      type: "elicitation_request";
      requestId: string;
      toolCallId: string;
      toolName: string;
      previewFormat?: "html" | "markdown";
      questions: PilotDeckElicitationQuestion[];
      metadata?: Record<string, unknown>;
    }
  /**
   * Surfaced when the agent loop is aborted while a question is still
   * pending. The host should dismiss the dialog without expecting an
   * answer — `respondElicitation` is no longer required for this id.
   */
  | { type: "elicitation_cancelled"; requestId: string; reason?: string }
  | {
      type: "user_dialog_request";
      requestId: string;
      dialogKind: "input";
      toolCallId: string;
      toolName: string;
      prompt: string;
      placeholder?: string;
      allowEmpty?: boolean;
    }
  | {
      type: "user_dialog_request";
      requestId: string;
      dialogKind: "select";
      toolCallId: string;
      toolName: string;
      prompt: string;
      choices: Array<{ value: string; label?: string; description?: string }>;
      defaultValue?: string;
    }
  | {
      type: "user_dialog_request";
      requestId: string;
      dialogKind: "confirm";
      toolCallId: string;
      toolName: string;
      prompt: string;
      confirmLabel?: string;
      cancelLabel?: string;
      defaultValue?: boolean;
    }
  | {
      type: "user_dialog_request";
      requestId: string;
      dialogKind: "form";
      toolCallId: string;
      toolName: string;
      prompt: string;
      schema: FormDialogSchema;
    }
  | {
      type: "user_dialog_cancelled";
      requestId: string;
      dialogKind: "input" | "select" | "confirm" | "form";
      reason?: string;
    }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: GatewayMode | (string & {}) }
  | { type: "config_changed"; changedPaths: string[]; changeClasses: string[] }
  | { type: "worktree_created"; runId: string; cwd: string }
  | { type: "worktree_removed"; cwd: string }
  | {
      type: "context_budget";
      used: number;
      displayUsed?: number;
      budgetUsed?: number;
      /** Local tokenizer estimate retained for diagnostics. */
      localEstimateTokens?: number;
      displayTokens?: number;
      estimateSource?: "estimator" | "usage";
      usageTokens?: number;
      calibrationActualInputTokens?: number;
      calibrationEstimatedInputTokens?: number;
      total: number;
      totalContextTokens?: number;
      maxContextTokens?: number;
      effectiveTotal?: number;
      effectiveContextTokens?: number;
      maxOutputTokens?: number;
      reservedOutputTokens?: number;
      warningRatio?: number;
      blockingRatio?: number;
      ratio: number;
      state: "ok" | "warning" | "blocking";
      source?: "provider" | "calibrated" | "local";
      exact?: boolean;
      estimatorError?: string;
      /** Local-tokenizer request composition; older Gateways omit this. */
      breakdown?: {
        source: "local_estimate";
        total: number;
        system: number;
        tools: number;
        messages: number;
        mcp: number;
        memory: number;
      };
    }
  | { type: "turn_completed"; usage: TurnUsage; finishReason: AgentTurnResult["stopReason"] | string }
  | { type: "agent_status"; event: string; detail?: Record<string, unknown> }
  | {
      type: "error";
      message: string;
      code?: string;
      recoverable: boolean;
      userHint?: string;
      providerError?: {
        provider?: string;
        protocol?: string;
        status?: number;
        code?: string;
        message?: string;
        raw?: string;
      };
    }
);

/** Serializable public projection of a still-pending Gateway user dialog. */
export type GatewayUserDialogRequestEvent = Extract<GatewayEvent, { type: "user_dialog_request" }>;
/**
 * A dialog preserved long enough to report that the owning Gateway process
 * restarted. The original AgentLoop promise cannot resume. A renderer may
 * submit an answer once; Gateway validates it and stores it as durable user
 * context for a later, newly submitted turn.
 */
export type GatewayRecoveredUserDialog = {
  type: "user_dialog_terminated";
  request: GatewayUserDialogRequestEvent;
  reason: "gateway_restarted";
  terminatedAt: string;
  /** A valid response becomes durable context for a separately submitted turn. */
  recovery?: "next_turn_context";
};

export type GatewayActiveTurnSnapshotInput = {
  sessionKey: string;
  /** Defaults to true. Set false for status-only polling. */
  includeEvents?: boolean;
};

export type GatewayActiveTurnSnapshot = {
  active: boolean;
  sessionKey: string;
  runId?: string;
  /**
   * Volatile replay events for the currently active turn. Durable transcript
   * history remains the source of truth after the turn completes.
   */
  events: GatewayEvent[];
  truncated?: boolean;
};

export type GatewayMcpServerStatusInput = { projectKey?: string; sessionKey?: string };
export type GatewayMcpServerStatusResult = { servers: Array<{ name: string; status: string; error?: string }> };
/** Gateway-only metadata for MCP tools withheld from the first model schema. */
export type GatewayMcpDeferredTool = GatewayDeferredTool;
export type GatewayMcpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; timeout?: number; deferredTools?: GatewayMcpDeferredTool[] }
  | { type: "streamable_http"; url: string; headers?: Record<string, string>; timeout?: number; deferredTools?: GatewayMcpDeferredTool[] }
  /** Legacy MCP SSE endpoint. New integrations should prefer streamable_http. */
  | { type: "sse"; url: string; headers?: Record<string, string>; timeout?: number; deferredTools?: GatewayMcpDeferredTool[] };
export type GatewaySetMcpServersInput = {
  sessionKey: string;
  projectKey?: string;
  servers: Record<string, GatewayMcpServerConfig>;
};
export type GatewayMcpSetServersResult = {
  added: string[];
  removed: string[];
  errors: Array<{ name: string; error: string }>;
};
export type GatewayMcpServerControlInput = { sessionKey: string; projectKey?: string; serverName: string };
export type GatewayMcpServerToggleInput = GatewayMcpServerControlInput & { enabled: boolean };
/** Session-scoped, tighten-only permission override for one MCP server. */
export type GatewayMcpPermissionModeOverrideInput = GatewayMcpServerControlInput & {
  mode: "default" | "auto" | null;
};
export type GatewayMcpPermissionModeOverrideResult = { warning?: string };
export type GatewayProjectFileReadInput = { projectKey: string; path: string; maxBytes?: number; encoding?: "utf-8" | "base64" };
export type GatewayProjectFileReadResult = { path: string; content: string; encoding: "utf-8" | "base64" };
export type GatewaySetPermissionModeInput = { sessionKey: string; mode: GatewayMode };
/** Session-scoped subset of Claude's flag-layer settings. Values are
 * intentionally opaque at the wire boundary and validated by the Gateway. */
export type GatewayApplyFlagSettingsInput = {
  sessionKey: string;
  projectKey?: string;
  settings: Record<string, unknown>;
};
export type GatewayApplyFlagSettingsResult = {
  applied: string[];
  cleared: string[];
};
/** Persisted, Gateway-hosted local settings.  This is intentionally distinct
 * from session-scoped flag settings: the server owns the local config path. */
export type GatewayUpdateSettingsInput = {
  source: "localSettings";
  settings: Record<string, unknown>;
};
export type GatewayUpdateSettingsResult = {
  applied: string[];
  cleared: string[];
  changedPaths: string[];
};
/** Redacted host-owned configuration snapshot for SDK settings inspection. */
export type GatewayResolvedSettingsSource = {
  kind: "default" | "project" | "env";
  priority: number;
  loadedAt: string;
  path?: string;
  contentHash?: string;
  phase?: "bootstrap" | "merge";
};
export type GatewayResolvedSettingsDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error" | "fatal";
  message: string;
  path?: string;
  source?: Pick<GatewayResolvedSettingsSource, "kind" | "path" | "phase">;
  hint?: string;
  redactedValue?: string;
  recoverable?: boolean;
};
export type GatewayResolvedSettingsResult = {
  schemaVersion: number;
  version: number;
  loadedAt: string;
  contentHash: string;
  /** `config` is redacted by the host before it reaches the Gateway wire. */
  config: Record<string, unknown>;
  sources: GatewayResolvedSettingsSource[];
  diagnostics: GatewayResolvedSettingsDiagnostic[];
};
export type GatewayThinkingConfig = {
  enabled: boolean;
  mode?: "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  budgetTokens?: number;
};
export type GatewaySetSessionThinkingInput = { sessionKey: string; thinking: GatewayThinkingConfig | null };
export type GatewayRewindFilesInput = {
  sessionKey: string;
  projectKey?: string;
  userMessageId: string;
  dryRun?: boolean;
};
export type GatewayRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  /** Files changed outside the checkpoint-producing PilotDeck turn. */
  conflicts?: string[];
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  missing?: string[];
};
/** Stops a PilotDeck background task owned by the requesting SDK session. */
export type GatewayStopBackgroundTaskInput = {
  sessionKey: string;
  taskId: string;
  projectKey?: string;
};
export type GatewayStopBackgroundTaskResult = {
  stopped: boolean;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
};
/** Query-level background control. PilotDeck tasks are born detached, so this
 * operation reports whether an eligible foreground task was found. */
export type GatewayBackgroundTasksInput = {
  sessionKey: string;
  taskId?: string;
  projectKey?: string;
};
export type GatewayBackgroundTasksResult = {
  backgrounded: boolean;
  taskIds?: string[];
  reason?: "no_foreground_tasks" | "task_not_found" | "unsupported_task_kind";
};
/** SDK control for restoring an observed native text-file read state. */
export type GatewaySeedReadStateInput = {
  sessionKey: string;
  path: string;
  /** Floored mtime (milliseconds) at the time the client observed the Read. */
  mtime: number;
  projectKey?: string;
  channelKey?: GatewayChannelKey;
  workspaceCwd?: string;
  /** Applied before a lazy session is created, when supplied by the SDK. */
  sdkSessionConfig?: GatewaySessionSdkConfig;
};
export type GatewaySeedReadStateResult = { applied: boolean };
export type GatewaySupportedAgentsResult = {
  agents: Array<{
    name: string;
    description: string;
    tools: string[];
    readOnly: boolean;
    effort?: "low" | "medium" | "high";
  }>;
};

export type GatewayElicitationResponseInput = {
  sessionKey: string;
  requestId: string;
  answer: PilotDeckElicitationAnswer;
};

export type GatewayUserDialogResponseInput = {
  sessionKey: string;
  projectKey?: string;
  requestId: string;
  /** Opaque live-dialog lease obtained from user_dialog_claim. */
  leaseId?: string;
  result:
    | { behavior: "answered"; value: unknown }
    | { behavior: "cancelled"; reason?: string };
};

/** Lists live dialogs plus terminal records recovered from a prior Gateway process. */
export type GatewayListUserDialogsInput = { sessionKey: string; projectKey?: string };
/** Expiry metadata is observable, but the bearer lease id never appears in list output. */
export type GatewayLiveUserDialog = GatewayUserDialogRequestEvent & {
  lease?: { expiresAt: string };
};
export type GatewayListUserDialogsResult = { dialogs: Array<GatewayLiveUserDialog | GatewayRecoveredUserDialog> };

/** Atomically reserves one live user dialog for a renderer. */
export type GatewayUserDialogClaimInput = {
  sessionKey: string;
  projectKey?: string;
  requestId: string;
  /** Requested duration, constrained by the Gateway to 1 second through 5 minutes. */
  ttlMs?: number;
  /** Matching lease id renews a claim without exposing it through list(). */
  leaseId?: string;
};
export type GatewayUserDialogClaimResult =
  | { claimed: true; leaseId: string; expiresAt: string }
  | { claimed: false; reason: "claimed" | "not_pending"; expiresAt?: string };

/** Releases a renderer lease without answering or cancelling the dialog. */
export type GatewayUserDialogReleaseInput = {
  sessionKey: string;
  projectKey?: string;
  requestId: string;
  leaseId: string;
};
export type GatewayUserDialogReleaseResult = { released: boolean };

/**
 * Web-facing permission decision input. Mirrors the elicitation
 * round-trip pattern: the agent (via `GatewayPermissionBus`) emits a
 * `permission_request` event during a turn; the host UI eventually calls
 * `Gateway.permissionDecide({ requestId, decision })` to unblock the
 * waiting tool.
 *
 * `delivered: false` is returned when the requestId is unknown (already
 * cancelled, decided, or session ended).
 */
export type GatewayPermissionDecisionInput = {
  sessionKey: string;
  requestId: string;
  decision: "allow" | "deny";
  /** Persist the decision as an `allow_session` rule when true. */
  remember?: boolean;
  /** Optional free-form reason; surfaced in audit/transcript. */
  reason?: string;
};

export type GatewaySessionPermissionGrantInput = {
  sessionKey: string;
  entry: string;
};

export type WebReadSessionMessagesInput = WebUiReadSessionMessagesInput;
export type WebReadSessionMessagesResult = WebUiReadSessionMessagesResult;
export type WebReadSubagentMessagesInput = WebUiReadSubagentMessagesInput;
export type WebReadSubagentMessagesResult = WebUiReadSubagentMessagesResult;
export type WebForkSessionInput = WebUiForkSessionInput;
export type WebForkSessionResult = WebUiForkSessionResult;
export type WebReplaceLastTurnInput = WebUiReplaceLastTurnInput;
export type WebReplaceLastTurnResult = WebUiReplaceLastTurnResult;
export type WebFinalizeLastTurnReplacementInput = WebUiFinalizeLastTurnReplacementInput;
export type WebFinalizeLastTurnReplacementResult = WebUiFinalizeLastTurnReplacementResult;
export type WebProjectSummary = WebUiProjectSummary;
export type WebListProjectsResult = WebUiListProjectsResult;
export type WebDescribeProjectInput = { projectKey: string };

export type GatewayError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type ListSessionsInput = {
  projectKey?: string;
  limit?: number;
  cursor?: string;
};

export type GatewaySessionInfo = ProjectSessionInfo & {
  sessionKey?: string;
};

export type ListSessionsResult = {
  sessions: GatewaySessionInfo[];
  nextCursor?: string;
};

export type NewSessionInput = {
  projectKey?: string;
  channelKey: GatewayChannelKey;
  hint?: string;
};
export type GatewaySessionMetadataInput = { sessionKey: string; projectKey?: string; value: string | null };

/**
 * A portable conversation projection, deliberately narrower than a native
 * JSONL transcript. File checkpoints, tool-result artifacts, sidechains and
 * in-flight state stay on the source Gateway and are never client-restored.
 */
export type GatewaySessionTranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

export type GatewaySessionTranscriptArchive = {
  schemaVersion: 1;
  format: "portable_text_messages";
  messages: GatewaySessionTranscriptMessage[];
  title?: string;
};

export type GatewayExportSessionTranscriptInput = {
  sessionKey: string;
  projectKey?: string;
};

export type GatewayRestoreSessionTranscriptInput = {
  /** Must identify a fresh, inactive, persistent Gateway session. */
  sessionKey: string;
  projectKey?: string;
  archive: GatewaySessionTranscriptArchive;
};

export type GatewayRestoreSessionTranscriptResult = {
  sessionKey: string;
  importedMessages: number;
};

export type GatewayServerInfo = {
  mode: "in_process" | "remote";
  protocolVersion?: string;
  projectKey?: string;
  sessionCount?: number;
  capabilities?: GatewayCapability[];
};

export type GatewayCapability =
  | "project_files_list"
  | "commands_list"
  | "model_catalog_list"
  | "session_model_get"
  | "session_model_set"
  | "session_model_clear"
  | "delete_session"
  | "mcp_server_status"
  | "set_mcp_servers"
  | "mcp_server_reconnect"
  | "mcp_server_toggle"
  | "set_mcp_permission_mode_override"
  | "project_file_read"
  | "set_permission_mode"
  | "apply_flag_settings"
  | "update_settings"
  | "resolve_settings"
  | "set_session_thinking"
  | "rewind_files"
  | "background_task_stop"
  | "background_tasks"
  | "seed_read_state"
  | "sdk_session_config"
  /** Gateway host has SDK-only organization session defaults configured. */
  | "sdk_session_defaults"
  | "supported_agents"
  | "output_styles_list"
  | "set_output_style"
  | "reload_output_styles"
  | "usage_snapshot"
  | "model_usage_snapshot"
  | "async_hook_result"
  | "user_dialog_list"
  | "session_transcript_archive";

export type MatchRange = {
  field: string;
  start: number;
  end: number;
};

export type ProjectFileEntry = {
  id: string;
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  matches?: MatchRange[];
};

export type ProjectFilesListInput = {
  projectKey: string;
  query?: string;
  cursor?: string;
  limit?: number;
  includeDirs?: boolean;
};

export type ProjectFilesListResult = {
  items: ProjectFileEntry[];
  nextCursor?: string;
  projectKey: string;
};

export type CommandListItem = {
  name: string;
  description?: string;
  namespace: string;
  type: string;
  argumentHint?: string;
  path?: string;
  relativePath?: string;
  metadata?: Record<string, unknown>;
  matches?: MatchRange[];
};

export type CommandsListInput = {
  projectKey: string;
  query?: string;
  cursor?: string;
  limit?: number;
};

export type CommandsListResult = {
  pinned: CommandListItem[];
  builtIn: CommandListItem[];
  custom: CommandListItem[];
  nextCursor?: string;
};

export type ModelNumericCapability = {
  type: "range" | "enum";
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  default?: number;
};

export type ModelCatalogItem = {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  available: boolean;
  capabilities: {
    reasoning?: ModelNumericCapability;
    temperature?: ModelNumericCapability;
    speed?: ModelNumericCapability;
  };
};

export type ModelCatalogListInput = {
  projectKey: string;
  query?: string;
  provider?: string;
  includeAuto?: boolean;
};

export type ModelCatalogListResult = {
  items: ModelCatalogItem[];
  router: { enabled: boolean; autoAvailable: boolean };
};

export type ExplicitModelSelection = {
  mode: "model";
  provider: string;
  model: string;
  reasoning?: number;
  temperature?: number;
  speed?: number;
};

export type SessionModelSelection = { mode: "auto" } | ExplicitModelSelection;

export type SessionModelInput = { sessionKey: string; projectKey: string };
export type SessionModelSetInput = SessionModelInput & { selection: SessionModelSelection };
export type SessionModelResult = SessionModelInput & {
  saved?: SessionModelSelection;
  effective: {
    provider: string;
    model: string;
    source: "session" | "router" | "default";
    reasoning?: number;
    temperature?: number;
    speed?: number;
  };
};

export type UploadedAttachmentRef = {
  uploadId: string;
  attachmentIds?: string[];
};

export type GatewayCronController = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
  updateTask(input: CronUpdateInput): Promise<CronUpdateResult>;
  deleteTask(input: CronDeleteInput): Promise<CronDeleteResult>;
  stopTask(input: CronStopInput): Promise<CronStopResult>;
  runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult>;
};

export type ReloadConfigResult = {
  reloaded: boolean;
  changedPaths?: string[];
  reason?: "unsupported" | "unchanged";
};

export type PrepareWeixinLoginResult = {
  requested: boolean;
  requestedAt: string;
  reason?: "unsupported";
};

export type ReloadExtensionsInput = {
  projectKey?: string;
  changedPaths?: string[];
};

export type ReloadExtensionsResult = {
  reloaded: boolean;
  changedPaths?: string[];
  reason?: "unsupported" | "unchanged";
};

export type AlwaysOnApplyInput = {
  projectKey: string;
  workCycleId: string;
  projectName: string;
};

export type AlwaysOnApplyResult = {
  sessionKey: string;
  error?: { code: string; message: string };
};

export type AlwaysOnRerunPlanInput = {
  projectKey: string;
  planId: string;
  projectName: string;
};

export type AlwaysOnRerunPlanResult = {
  runId: string;
  error?: { code: string; message: string };
};

export interface Gateway {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult>;
  cancelSteer(input: GatewayCancelSteerInput): Promise<GatewayCancelSteerResult>;
  abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }>;
  newSession(input: NewSessionInput): Promise<{ sessionKey: string }>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
  deleteSession?(input: { sessionKey: string; projectKey?: string }): Promise<void>;
  exportSessionTranscript?(input: GatewayExportSessionTranscriptInput): Promise<GatewaySessionTranscriptArchive>;
  restoreSessionTranscript?(input: GatewayRestoreSessionTranscriptInput): Promise<GatewayRestoreSessionTranscriptResult>;
  renameSession?(input: GatewaySessionMetadataInput): Promise<{ updated: boolean }>;
  tagSession?(input: GatewaySessionMetadataInput): Promise<{ updated: boolean }>;
  recordAgentStatusMessage?(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }>;
  describeServer(): Promise<GatewayServerInfo>;
  projectFilesList?(input: ProjectFilesListInput): Promise<ProjectFilesListResult>;
  commandsList?(input: CommandsListInput): Promise<CommandsListResult>;
  modelCatalogList?(input: ModelCatalogListInput): Promise<ModelCatalogListResult>;
  sessionModelGet?(input: SessionModelInput): Promise<SessionModelResult>;
  sessionModelSet?(input: SessionModelSetInput): Promise<SessionModelResult>;
  sessionModelClear?(input: SessionModelInput): Promise<void>;
  getActiveTurnSnapshot?(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot>;
  mcpServerStatus?(input: GatewayMcpServerStatusInput): Promise<GatewayMcpServerStatusResult>;
  setMcpServers?(input: GatewaySetMcpServersInput): Promise<GatewayMcpSetServersResult>;
  reconnectMcpServer?(input: GatewayMcpServerControlInput): Promise<void>;
  toggleMcpServer?(input: GatewayMcpServerToggleInput): Promise<void>;
  setMcpPermissionModeOverride?(input: GatewayMcpPermissionModeOverrideInput): Promise<GatewayMcpPermissionModeOverrideResult>;
  projectFileRead?(input: GatewayProjectFileReadInput): Promise<GatewayProjectFileReadResult | null>;
  setPermissionMode?(input: GatewaySetPermissionModeInput): Promise<{ applied: boolean }>;
  applyFlagSettings?(input: GatewayApplyFlagSettingsInput): Promise<GatewayApplyFlagSettingsResult>;
  updateSettings?(input: GatewayUpdateSettingsInput): Promise<GatewayUpdateSettingsResult>;
  resolveSettings?(): Promise<GatewayResolvedSettingsResult>;
  setSessionThinking?(input: GatewaySetSessionThinkingInput): Promise<{ applied: boolean }>;
  rewindFiles?(input: GatewayRewindFilesInput): Promise<GatewayRewindFilesResult>;
  stopBackgroundTask?(input: GatewayStopBackgroundTaskInput): Promise<GatewayStopBackgroundTaskResult>;
  backgroundTasks?(input: GatewayBackgroundTasksInput): Promise<GatewayBackgroundTasksResult>;
  submitAsyncHookResult?(input: GatewayAsyncHookResultInput): Promise<GatewayAsyncHookResult>;
  seedReadState?(input: GatewaySeedReadStateInput): Promise<GatewaySeedReadStateResult>;
  setSdkSessionConfig?(
    sessionKey: string,
    config: GatewaySessionSdkConfig,
    projectKey?: string,
  ): Promise<{ changed: boolean }> | { changed: boolean };
  supportedAgents?(): Promise<GatewaySupportedAgentsResult>;
  outputStylesList?(input: GatewayOutputStylesListInput): Promise<GatewayOutputStylesListResult>;
  setOutputStyle?(input: GatewaySetOutputStyleInput): Promise<GatewaySetOutputStyleResult>;
  reloadOutputStyles?(input?: GatewayReloadOutputStylesInput): Promise<GatewayReloadOutputStylesResult>;
  usageSnapshot?(input: GatewayUsageSnapshotInput): Promise<GatewayUsageSnapshotResult>;
  modelUsageSnapshot?(input: GatewayModelUsageSnapshotInput): Promise<GatewayModelUsageSnapshotResult>;
  cronCreate(input: CronCreateInput): Promise<CronCreateResult>;
  cronList(input: CronListInput): Promise<CronListResult>;
  cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult>;
  cronDelete(input: CronDeleteInput): Promise<CronDeleteResult>;
  cronStop(input: CronStopInput): Promise<CronStopResult>;
  cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult>;
  /**
   * B1 — host responds to an `elicitation_request` event surfaced through
   * `submitTurn`. Resolves the waiting tool's `askUser()` promise. Returns
   * `{ delivered: false }` if the requestId is unknown (already cancelled
   * or the session has ended).
   */
  respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }>;
  /** Resolve an active Gateway-owned generic user dialog for this session. */
  respondUserDialog(input: GatewayUserDialogResponseInput): Promise<{
    delivered: boolean;
    /** Gateway persisted a restart-recovery answer for the next new turn. */
    recovered?: true;
    reason?: "gateway_restarted";
  }>;
  /** Read live dialogs and restart-terminated recovery records for this session. */
  listUserDialogs?(input: GatewayListUserDialogsInput): Promise<GatewayListUserDialogsResult>;
  /** Reserve or renew one live dialog for a remote renderer. */
  claimUserDialog?(input: GatewayUserDialogClaimInput): Promise<GatewayUserDialogClaimResult>;
  /** Release one live renderer lease without changing the dialog. */
  releaseUserDialog?(input: GatewayUserDialogReleaseInput): Promise<GatewayUserDialogReleaseResult>;
  /**
   * Web Phase 2 — host responds to a `permission_request` event surfaced
   * through `submitTurn`. Resolves the agent-side permission promise so the
   * blocked tool either runs (allow) or returns a denial. Returns
   * `{ delivered: false }` if the requestId is unknown.
   */
  permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }>;
  /**
   * Grants a tool only for the current session. This is intentionally
   * non-persistent: global Settings / permissions.json stay unchanged.
   */
  grantSessionPermission(input: GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }>;
  /**
   * Web Phase 2 — read transcript history for a session and project it onto
   * the Web `WebMessage` DTO.
   */
  readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult>;
  /**
   * Fork a session transcript at a prior user turn into a new session file.
   */
  forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult>;
  /** Abort any active run and atomically remove the latest turn from the transcript. */
  replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult>;
  /** Commit a durable replacement input or restore the transcript when submission failed. */
  finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult>;
  /**
   * Read a subagent's sidechain transcript and return its messages in WebMessage format.
   */
  readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult>;
  /**
   * Web Phase 3 — enumerate projects from PilotDeck home + an optional
   * registry.
   */
  listProjects(): Promise<WebListProjectsResult>;
  /**
   * Web Phase 3 — load a single project summary.
   */
  describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary>;
  /**
   * Trigger a config reload from `~/.pilotdeck/pilotdeck.yaml` and
   * invalidate cached runtimes. Returns the list of changed config paths
   * so callers can decide whether further action is needed.
   *
   * Optional — implementations that don't own a config store (e.g. the
   * fallback gateway or `RemoteGateway` backed by a server without the
   * capability) may leave it undefined.
   */
  reloadConfig?(): Promise<ReloadConfigResult>;

  /**
   * Ask the gateway host to start or restart the Weixin channel so it can
   * generate a runtime QR code. The host owns channel construction; UI/server
   * callers must not invoke `weixin-ilink.loginWithQR()` directly.
   */
  prepareWeixinLogin?(): Promise<PrepareWeixinLoginResult>;

  /**
   * Trigger a plugin/skill/MCP extension reload without waiting for the file
   * watcher. Used by UI config writers that already know an extension-backed
   * file changed (for example `mcp.json`).
   */
  reloadExtensions?(input?: ReloadExtensionsInput): Promise<ReloadExtensionsResult>;

  /**
   * Skill-management RPCs. The gateway is the authoritative owner of
   * bundled read-only skills, `~/.pilotdeck/skills/` (user scope), and
   * `<project>/.pilotdeck/skills/` (project scope). The Web UI's REST endpoints under `/api/skills/*`
   * are now thin shims that forward here, so a skill the agent loads
   * and a skill the UI shows always come from the same place.
   *
   * Optional — a `RemoteGateway` backed by an older server without
   * these methods leaves them undefined; hosts should feature-detect.
   */
  /**
   * Trigger an Always-On apply phase: merge workspace changes into the
   * project root via a `bypassPermissions` agent loop inside
   * `DiscoveryFire.drainTurn`. Progress events are broadcast as
   * `always-on:turn-event` notifications.
   */
  alwaysOnApply?(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult>;
  /**
   * Re-execute an existing Always-On plan through DiscoveryFire phases 2-4
   * (workspace, execution, report). Used by the UI retry button.
   */
  alwaysOnRerunPlan?(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult>;

  skillsList?(input: SkillsListInput): Promise<SkillsListResult>;
  skillRead?(input: SkillAddressInput): Promise<SkillReadResult>;
  skillWrite?(input: SkillWriteInput): Promise<SkillWriteResult>;
  skillCreate?(input: SkillCreateInput): Promise<SkillCreateResult>;
  skillDelete?(input: SkillDeleteInput): Promise<SkillDeleteResult>;
  skillImport?(input: SkillImportInput): Promise<SkillImportResult>;
  skillValidate?(input: SkillValidateInput): Promise<SkillValidationResult>;
  skillScan?(input: SkillScanInput): Promise<SkillScanResult>;
}
