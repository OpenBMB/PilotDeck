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
} from "../../cron/protocol/types.js";
import type { CanonicalUsage } from "../../model/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import type { SessionInfo as ProjectSessionInfo } from "../../session/index.js";
import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationQuestion,
} from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type {
  WebListProjectsResult as WebUiListProjectsResult,
  WebProjectSummary as WebUiProjectSummary,
  WebReadSessionMessagesInput as WebUiReadSessionMessagesInput,
  WebReadSessionMessagesResult as WebUiReadSessionMessagesResult,
  WebReadSubagentMessagesInput as WebUiReadSubagentMessagesInput,
  WebReadSubagentMessagesResult as WebUiReadSubagentMessagesResult,
  WebForkSessionInput as WebUiForkSessionInput,
  WebForkSessionResult as WebUiForkSessionResult,
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
  runId?: string;
  maxTurns?: number;
  /** Hard wall-clock limit for this turn. The gateway aborts and closes the session when exceeded. */
  timeoutMs?: number;
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
  | { type: "model_request_started"; model?: string; provider?: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_attachment"; attachment: GatewayOutboundAttachment }
  | { type: "file_artifacts"; artifacts: import("../../session/artifacts/FileArtifact.js").FileArtifact[] }
  | { type: "assistant_thinking_delta"; text: string }
  | { type: "tool_call_started"; toolCallId: string; name: string; argsPreview?: string }
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
      total: number;
      effectiveTotal?: number;
      reservedOutputTokens?: number;
      ratio: number;
      state: "ok" | "warning" | "blocking";
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

export type GatewayActiveTurnSnapshotInput = {
  sessionKey: string;
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

export type GatewayElicitationResponseInput = {
  sessionKey: string;
  requestId: string;
  answer: PilotDeckElicitationAnswer;
};

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

export type GatewayServerInfo = {
  mode: "in_process" | "remote";
  protocolVersion?: string;
  projectKey?: string;
  sessionCount?: number;
};

export type GatewayCronController = {
  createTask(input: CronCreateInput): Promise<CronCreateResult>;
  listTasks(input: CronListInput): Promise<CronListResult>;
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
  abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void>;
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }>;
  newSession(input: NewSessionInput): Promise<{ sessionKey: string }>;
  closeSession(input: { sessionKey: string; reason?: string }): Promise<void>;
  recordAgentStatusMessage?(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }>;
  describeServer(): Promise<GatewayServerInfo>;
  getActiveTurnSnapshot?(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot>;
  cronCreate(input: CronCreateInput): Promise<CronCreateResult>;
  cronList(input: CronListInput): Promise<CronListResult>;
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
