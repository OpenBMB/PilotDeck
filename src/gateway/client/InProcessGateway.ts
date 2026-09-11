import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile, readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent, AgentInput, AgentTurnResult } from "../../agent/index.js";
import {
  flattenToolResultBlockText,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalModelError,
  type CanonicalModelEvent,
} from "../../model/index.js";
import type { AgentError } from "../../agent/index.js";
import { SUBAGENT_DEFINITIONS } from "../../agent/sub/builtinSubagentTypes.js";
import { isPilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import { contentToText } from "../../tool/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import {
  GatewayUserDialogBus,
  type GatewayUserDialogChange,
} from "../user-dialog/GatewayUserDialogBus.js";
import { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import { AsyncQueue } from "../util/AsyncQueue.js";
import type {
  ChannelAttachment,
  GatewayCronController,
  Gateway,
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayElicitationResponseInput,
  GatewayListUserDialogsInput,
  GatewayListUserDialogsResult,
  GatewayRecoveredUserDialog,
  GatewayUserDialogClaimInput,
  GatewayUserDialogClaimResult,
  GatewayUserDialogReleaseInput,
  GatewayUserDialogReleaseResult,
  GatewayUserDialogRequestEvent,
  GatewayUserDialogResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayRecordAgentStatusMessageInput,
  GatewaySessionPermissionGrantInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  GatewayCancelSteerInput,
  GatewayCancelSteerResult,
  GatewaySteerTurnInput,
  GatewaySteerTurnResult,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  PrepareWeixinLoginResult,
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  ReloadConfigResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  ProjectFilesListInput,
  ProjectFilesListResult,
  CommandsListInput,
  CommandsListResult,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelInput,
  SessionModelSetInput,
  SessionModelResult,
  UploadedAttachmentRef,
  GatewaySetSessionThinkingInput,
  GatewayRewindFilesInput,
  GatewayRewindFilesResult,
  GatewaySeedReadStateInput,
  GatewaySeedReadStateResult,
  GatewaySessionSdkConfig,
  GatewaySetMcpServersInput,
  GatewayMcpSetServersResult,
  GatewayMcpServerControlInput,
  GatewayMcpServerToggleInput,
  GatewayMcpPermissionModeOverrideInput,
  GatewayMcpPermissionModeOverrideResult,
  GatewayApplyFlagSettingsInput,
  GatewayApplyFlagSettingsResult,
  GatewayUpdateSettingsInput,
  GatewayUpdateSettingsResult,
  GatewayResolvedSettingsResult,
  GatewayOutputStylesListInput,
  GatewayOutputStylesListResult,
  GatewaySetOutputStyleInput,
  GatewaySetOutputStyleResult,
  GatewayReloadOutputStylesInput,
  GatewayReloadOutputStylesResult,
  GatewayUsageSnapshotInput,
  GatewayUsageSnapshotResult,
  GatewayModelUsageSnapshotInput,
  GatewayModelUsageSnapshotResult,
  GatewayAsyncHookResult,
  GatewayAsyncHookResultInput,
} from "../protocol/types.js";
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
import { permissionEntryToRule, permissionSettingsToRuleSet, readPermissionSettings } from "../../permission/index.js";
import type { PermissionRule } from "../../permission/index.js";
import { SkillManagerError, type SkillManager } from "../../extension/skills/index.js";
import { getPilotDeckInstallCommand } from "../../mcp/runtime/projectMcpSpec.js";
import { AttachmentResolver, type AttachmentRequest } from "../../context/attachments/AttachmentResolver.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
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
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";
import { DialogGatewayError } from "../dialog/errors.js";
import { listProjectFiles } from "../dialog/projectFiles.js";
import { isPathWithinRoot } from "../../tool/builtin/filesystem/pathSafety.js";

const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";
const MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS = 20_000;
const MAX_GATEWAY_TOOL_DATA_STRING_CHARS = 4_000;
const DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_ASYNC_HOOK_TIMEOUT_MS = 60_000;
const ASYNC_HOOK_OUTCOME_RETENTION_MS = 5 * 60_000;
const DEFAULT_USER_DIALOG_LEASE_MS = 30_000;
const MIN_USER_DIALOG_LEASE_MS = 1_000;
const MAX_USER_DIALOG_LEASE_MS = 5 * 60_000;

/** A configured host ceiling also supplies the default when callers omit it. */
function capGatewayTurnLimit(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return value === undefined ? cap : Math.min(value, cap);
}

export type InProcessGatewayOptions = {
  /** Absolute command used by the model to install bundled FunASR assets. */
  funasrInstallCommand?: string;
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
  /**
   * Web Phase 2 — pluggable session-history reader. Wired by
   * `createLocalGateway` so the in-process gateway can answer
   * `read_session_messages` without leaking transcript paths.
   */
  readSessionMessages?: (input: WebReadSessionMessagesInput) => Promise<WebReadSessionMessagesResult>;
  readSubagentMessages?: (input: WebReadSubagentMessagesInput) => Promise<WebReadSubagentMessagesResult>;
  forkSession?: (input: WebForkSessionInput) => Promise<WebForkSessionResult>;
  replaceLastTurn?: (input: WebReplaceLastTurnInput) => Promise<WebReplaceLastTurnResult>;
  finalizeLastTurnReplacement?: (
    input: WebFinalizeLastTurnReplacementInput,
  ) => Promise<WebFinalizeLastTurnReplacementResult>;
  /** Roll back a prepared edit that never reaches durable input acceptance. */
  replacementTransactionTimeoutMs?: number;
  recordAgentStatusMessage?: (input: GatewayRecordAgentStatusMessageInput) => Promise<{ recorded: boolean }>;
  /**
   * Web Phase 3 — pluggable project enumerator + describer.
   */
  listProjects?: () => Promise<WebListProjectsResult>;
  describeProject?: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
  commandsList?: (input: CommandsListInput) => Promise<CommandsListResult>;
  modelCatalogList?: (input: ModelCatalogListInput) => Promise<ModelCatalogListResult>;
  sessionModelGet?: (input: SessionModelInput) => Promise<SessionModelResult>;
  sessionModelSet?: (input: SessionModelSetInput) => Promise<SessionModelResult>;
  sessionModelClear?: (input: SessionModelInput) => Promise<void>;
  /** SDK read-only file façade. The host owns path policy and encoding. */
  projectFileRead?: (input: import("../protocol/types.js").GatewayProjectFileReadInput) => Promise<import("../protocol/types.js").GatewayProjectFileReadResult | null>;
  renameSession?: (input: import("../protocol/types.js").GatewaySessionMetadataInput) => Promise<{ updated: boolean }>;
  tagSession?: (input: import("../protocol/types.js").GatewaySessionMetadataInput) => Promise<{ updated: boolean }>;
  /** Permanently removes a session transcript and its subagent sidecars. */
  deleteSession?: (input: { sessionKey: string; projectKey?: string }) => Promise<void>;
  /** Gateway-owned portable transcript archive projection. */
  exportSessionTranscript?: (
    input: import("../protocol/types.js").GatewayExportSessionTranscriptInput,
  ) => Promise<import("../protocol/types.js").GatewaySessionTranscriptArchive>;
  /** Restores a portable archive into a fresh Gateway session transcript. */
  restoreSessionTranscript?: (
    input: import("../protocol/types.js").GatewayRestoreSessionTranscriptInput,
  ) => Promise<import("../protocol/types.js").GatewayRestoreSessionTranscriptResult>;
  /**
   * Handles Gateway-owned ephemeral storage before the router evicts the
   * session. Returning false delegates to ordinary persistent deletion.
   */
  deleteEphemeralSession?: (input: { sessionKey: string; projectKey?: string }) => Promise<boolean>;
  /** SDK MCP status façade. */
  mcpServerStatus?: (input: import("../protocol/types.js").GatewayMcpServerStatusInput) => Promise<import("../protocol/types.js").GatewayMcpServerStatusResult>;
  /** Session-scoped SDK-owned MCP server collection. */
  setMcpServers?: (input: GatewaySetMcpServersInput) => Promise<GatewayMcpSetServersResult>;
  reconnectMcpServer?: (input: GatewayMcpServerControlInput) => Promise<void>;
  toggleMcpServer?: (input: GatewayMcpServerToggleInput) => Promise<void>;
  setMcpPermissionModeOverride?: (input: GatewayMcpPermissionModeOverrideInput) => Promise<GatewayMcpPermissionModeOverrideResult>;
  /** SDK query-level permission mode control. */
  setPermissionMode?: (input: import("../protocol/types.js").GatewaySetPermissionModeInput) => Promise<{ applied: boolean }>;
  /** Clears an SDK flag-layer permission override so lower settings win again. */
  clearPermissionMode?: (input: { sessionKey: string; projectKey?: string }) => Promise<void>;
  /** Applies the supported session-scoped subset of Claude flag settings. */
  applyFlagSettings?: (input: GatewayApplyFlagSettingsInput) => Promise<GatewayApplyFlagSettingsResult>;
  /** Persists the allowlisted SDK local-settings subset at the Gateway host. */
  updateSettings?: (input: GatewayUpdateSettingsInput) => Promise<GatewayUpdateSettingsResult>;
  /** Returns a redacted, host-owned resolved PilotDeck configuration snapshot. */
  resolveSettings?: () => Promise<GatewayResolvedSettingsResult>;
  /** SDK session-level thinking override. The host stores it outside AgentLoop. */
  setSessionThinking?: (input: GatewaySetSessionThinkingInput) => Promise<{ applied: boolean }>;
  outputStylesList?: (input: GatewayOutputStylesListInput) => Promise<GatewayOutputStylesListResult>;
  setOutputStyle?: (input: GatewaySetOutputStyleInput) => Promise<GatewaySetOutputStyleResult>;
  reloadOutputStyles?: (input?: GatewayReloadOutputStylesInput) => Promise<GatewayReloadOutputStylesResult>;
  usageSnapshot?: (input: GatewayUsageSnapshotInput) => Promise<GatewayUsageSnapshotResult>;
  modelUsageSnapshot?: (input: GatewayModelUsageSnapshotInput) => Promise<GatewayModelUsageSnapshotResult>;
  /** SDK file checkpoint adapter backed by the session's native FileHistoryStore. */
  rewindFiles?: (input: GatewayRewindFilesInput) => Promise<GatewayRewindFilesResult>;
  /** SDK control for an existing PilotDeck background task. */
  stopBackgroundTask?: (
    input: import("../protocol/types.js").GatewayStopBackgroundTaskInput,
  ) => Promise<import("../protocol/types.js").GatewayStopBackgroundTaskResult>;
  /** Query-level background operation over the native task runtime. */
  backgroundTasks?: (
    input: import("../protocol/types.js").GatewayBackgroundTasksInput,
  ) => Promise<import("../protocol/types.js").GatewayBackgroundTasksResult>;
  /** Applies serialized SDK session config before the next AgentSession is created. */
  setSdkSessionConfig?: (
    sessionKey: string,
    config: GatewaySessionSdkConfig,
    projectKey?: string,
  ) => Promise<{ changed: boolean }> | { changed: boolean };
  /** Advertises host-owned SDK policy that requires an empty session marker. */
  sdkSessionDefaults?: boolean;
  /**
   * Host-owned ceilings for each submitted turn. These are enforced in the
   * Gateway before AgentSession receives turn options, so a remote SDK cannot
   * raise or bypass them.
   */
  turnLimits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
  };
  /**
   * Returns the Gateway-owned budget state for an SDK session. It runs after
   * session configuration is accepted and before the native turn starts.
   */
  taskBudgetSnapshot?: (input: {
    sessionKey: string;
    projectKey?: string;
  }) => Promise<{ totalUsd: number; spentUsd: number } | undefined> | { totalUsd: number; spentUsd: number } | undefined;
  /** Records one completed native turn against a Gateway-owned task budget. */
  recordTaskBudgetSpend?: (input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
    turnSpentUsd: number;
  }) => Promise<void> | void;
  /** Returns terminal dialog records recovered from a prior Gateway process. */
  listRecoveredUserDialogs?: (
    input: GatewayListUserDialogsInput,
  ) => Promise<GatewayRecoveredUserDialog[]> | GatewayRecoveredUserDialog[];
  /** Marks a restart-terminated dialog as observed by a renderer. */
  acknowledgeRecoveredUserDialog?: (input: {
    sessionKey: string;
    projectKey?: string;
    requestId: string;
  }) => Promise<boolean> | boolean;
  /**
   * Records a validated response for a dialog whose original Gateway process
   * stopped. The host owns the durable transcript write; it must not claim to
   * resume the original AgentLoop/tool promise.
   */
  recoverUserDialog?: (input: GatewayUserDialogResponseInput) => Promise<boolean> | boolean;
  /** Optional host-owned cross-Gateway live dialog renderer coordination. */
  listHostedUserDialogs?: (input: GatewayListUserDialogsInput) => Promise<GatewayUserDialogRequestEvent[]> | GatewayUserDialogRequestEvent[];
  claimHostedUserDialog?: (input: GatewayUserDialogClaimInput) => Promise<GatewayUserDialogClaimResult> | GatewayUserDialogClaimResult;
  releaseHostedUserDialog?: (input: GatewayUserDialogReleaseInput) => Promise<boolean> | boolean;
  submitHostedUserDialogAnswer?: (input: GatewayUserDialogResponseInput) => Promise<boolean> | boolean;
  /** Non-authoritative renderer observation hint for generic dialog changes. */
  onUserDialogChange?: (change: GatewayUserDialogChange) => void;
  /** New turn input supersedes any stale terminal dialog notices. */
  clearRecoveredUserDialogs?: (input: {
    sessionKey: string;
    projectKey?: string;
  }) => Promise<void> | void;
  resolveUploadedAttachments?: (input: {
    projectKey: string;
    uploads: UploadedAttachmentRef[];
  }) => Promise<ChannelAttachment[]>;
  resolveTurnModelSelection?: (input: GatewaySubmitTurnInput) => Promise<{
    selection?: import("../protocol/types.js").ExplicitModelSelection;
    source: "turn" | "session" | "router" | "default";
  }>;
  /**
   * Pluggable config-reload handler wired by `createLocalGateway`.
   * When set, `reloadConfig()` delegates to this callback which owns
   * the PilotConfigStore + ProjectRuntimeRegistry lifecycle.
   */
  reloadConfig?: () => Promise<ReloadConfigResult>;
  prepareWeixinLogin?: () => Promise<PrepareWeixinLoginResult>;
  /**
   * Pluggable extension/MCP reload handler wired by `createLocalGateway`.
   * Unlike `reloadConfig`, this does not depend on `pilotdeck.yaml` changing.
   */
  reloadExtensions?: (input?: import("../protocol/types.js").ReloadExtensionsInput) => Promise<import("../protocol/types.js").ReloadExtensionsResult>;
  /**
   * Optional pre-turn hook that lets the host re-read disk config before
   * `submitTurn` resolves a session and starts streaming. Wired by
   * `createLocalGateway` to `configStore.reload("turn-start")` so that
   * a credential / model edit applied between turns is guaranteed to
   * take effect on the very next message even when fs watchers miss the
   * change (network mounts, debounce gaps, container snapshots).
   *
   * Cheap and singleton-deduped — `PilotConfigStore.reload` is a no-op
   * when the yaml hasn't changed and only re-runs the
   * invalidate-runtimes / mark-sessions-dirty path when something
   * actually moved.
   *
   * Failures are swallowed so a transient yaml read error does not
   * block in-progress chats; the existing snapshot remains in use.
   */
  refreshConfigBeforeTurn?: () => Promise<void>;
  /**
   * Authoritative skill CRUD manager for built-in, user, and project skills.
   * Wired by `createLocalGateway` so every host (CLI, TUI, Web UI bridge,
   * SDK) reads and writes the same skill directory the agent loads from.
   */
  skillManager?: SkillManager;
  dispatchHookForSession?: (sessionKey: string, event: string, payload: Record<string, unknown>) => void;
  /** Directory to persist large tool outputs for TUI/Web viewing. */
  toolResultsDir?: string;
  /** Override a session's cwd via SessionConfigOverrides. */
  setSessionCwd?: (sessionKey: string, cwd: string) => void;
  /** Delegate for Always-On apply — wired to AlwaysOnManager.applyPlan. */
  alwaysOnApply?: (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult>;
  alwaysOnRerunPlan?: (input: AlwaysOnRerunPlanInput) => Promise<AlwaysOnRerunPlanResult>;
  /**
   * Optional non-blocking post-turn callback. Used by createLocalGateway to
   * coalesce project-level memory maintenance after a turn has fully ended.
   */
  afterTurnCompleted?: (input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
  }) => void;
  telemetry?: TelemetryClient;
};

const ACTIVE_TURN_EVENT_LIMIT = 500;
const ACTIVE_TURN_BYTE_LIMIT = 256 * 1024;

function validateGatewayTurnLimits(limits: InProcessGatewayOptions["turnLimits"]): void {
  if (!limits) return;
  if (limits.maxTurns !== undefined && (
    !Number.isSafeInteger(limits.maxTurns) || limits.maxTurns <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_TURN_LIMIT",
      "turnLimits.maxTurns must be a positive safe integer.",
    );
  }
  if (limits.maxBudgetUsd !== undefined && (
    !Number.isFinite(limits.maxBudgetUsd) || limits.maxBudgetUsd <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_TURN_LIMIT",
      "turnLimits.maxBudgetUsd must be a positive finite number.",
    );
  }
}

type ActiveTurnReplay = {
  sessionKey: string;
  runId: string;
  events: GatewayEvent[];
  bytes: number;
  truncated: boolean;
};

type PendingTurnReplacement = {
  transactionId: string;
  replacementTurnId: string;
  projectKey?: string;
  timeout?: ReturnType<typeof setTimeout>;
  phase: "prepared" | "submitting" | "finalizing";
};

type PendingAsyncHook = {
  invocationId: string;
  sessionKey: string;
  runId: string;
  hookName: string;
  hookEvent: string;
  expiresAt: number;
  includeHookEvents: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  delivery?: Promise<GatewayAsyncHookResult>;
};

type AsyncHookOutcome = {
  sessionKey: string;
  status: "delivered" | "expired";
  timeout?: ReturnType<typeof setTimeout>;
};

export class InProcessGateway implements Gateway {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly replacementTransactionTimeoutMs: number;
  /**
   * B1 — registry of active per-session emit sinks. The gateway shares this
   * map with the per-session `GatewayElicitationChannel` so an `askUser`
   * call can surface an `elicitation_request` event into the active
   * `submitTurn` stream from outside the agent's event iterator.
   */
  private readonly emitSinks = new Map<string, (event: GatewayEvent) => void>();
  private readonly activeTurnReplays = new Map<string, ActiveTurnReplay>();
  private readonly transcriptWriteReservations = new Set<string>();
  private readonly pendingTurnReplacements = new Map<string, PendingTurnReplacement>();
  /** Gateway-owned deferred SDK hook records, scoped to one active turn. */
  private readonly pendingAsyncHooks = new Map<string, PendingAsyncHook>();
  /** Short-lived idempotency outcomes retained after a deferred record settles. */
  private readonly asyncHookOutcomes = new Map<string, AsyncHookOutcome>();
  /** B1 — pending askUser() promises keyed by sessionKey + requestId. */
  private readonly elicitationBus = new GatewayElicitationBus();
  /** Pending opt-in generic user dialogs, scoped by session and request id. */
  private readonly userDialogBus: GatewayUserDialogBus;
  /** Project identity used only to scope observational dialog notifications. */
  private readonly dialogProjectKeys = new Map<string, string>();
  /**
   * Web Phase 2 — pending permission-decision promises. Tools that need
   * Web confirmation register here while the host UI shows the banner.
   */
  private readonly permissionBus = new GatewayPermissionBus();
  private readonly sessionPermissionGrants = new Map<string, PermissionRule[]>();
  private readonly sessionPermissionModes = new Map<string, import("../protocol/types.js").GatewayMode>();
  /**
   * Per-session "turn ended" deferreds. Set when `submitTurn`'s consumer
   * loop starts and resolved in its `finally` after `router.endTurn` has
   * cleared `inFlightTurns`. `abortTurn` awaits this so callers see a
   * consistent contract: once `abortTurn` resolves, a fresh `submitTurn`
   * for the same session is guaranteed not to be rejected with
   * `session_busy`. Without it the gateway's `abort_turn` RPC could return
   * while `inFlightTurns` was still populated, racing the next submit.
   */
  private readonly turnCompletions = new Map<string, Promise<void>>();
  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.userDialogBus = new GatewayUserDialogBus({
      onChange: (change) => {
        const projectKey = this.dialogProjectKeys.get(change.sessionKey);
        this.options.onUserDialogChange?.({
          ...change,
          ...(projectKey ? { projectKey } : {}),
        });
      },
    });
    validateGatewayTurnLimits(options.turnLimits);
    this.replacementTransactionTimeoutMs = Math.max(
      1,
      options.replacementTransactionTimeoutMs ?? DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS,
    );
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.elicitationBus;
  }

  getUserDialogBus(): GatewayUserDialogBus {
    return this.userDialogBus;
  }

  /**
   * Web Phase 2 — exposed so per-session bridge channels (or tests) can
   * register pending permission decisions and emit `permission_request`
   * events.
   */
  getPermissionBus(): GatewayPermissionBus {
    return this.permissionBus;
  }

  /**
   * Push a synthesized {@link GatewayEvent} into the active `submitTurn`
   * stream for the given session. Returns true when a sink existed and
   * the event was queued, false otherwise (e.g. no turn currently in
   * progress for that session).
   *
   * Used by per-session bridge hooks (notably the interactive
   * permission hook) that need to surface UI prompts mid-turn without
   * waiting for the agent's own event loop to emit them.
   */
  emitForSession(sessionKey: string, event: GatewayEvent): boolean {
    const sink = this.emitSinks.get(sessionKey);
    if (!sink) return false;
    const eventWithRunId = this.withActiveTurnRunId(sessionKey, event);
    this.recordActiveTurnEvent(sessionKey, eventWithRunId);
    sink(eventWithRunId);
    return true;
  }

  /**
   * Registers an SDK HTTP-hook marker against the currently active turn.
   * This is a default-absent protocol adapter: ordinary native hooks never
   * allocate a deferred record or change their lifecycle behavior.
   */
  registerAsyncHook(input: {
    sessionKey: string;
    hookName: string;
    hookEvent: string;
    invocationId: string;
    timeoutMs?: number;
    includeHookEvents: boolean;
  }): void {
    const runId = this.router.activeTurnRunId(input.sessionKey);
    if (!runId || !input.invocationId.trim()) return;
    const existing = this.pendingAsyncHooks.get(input.invocationId);
    if (existing) {
      if (existing.sessionKey === input.sessionKey && existing.runId === runId) return;
      throw new DialogGatewayError(
        "ASYNC_HOOK_INVOCATION_CONFLICT",
        "Async hook invocation id is already owned by another active turn.",
      );
    }
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_ASYNC_HOOK_TIMEOUT_MS);
    const pending: PendingAsyncHook = {
      invocationId: input.invocationId,
      sessionKey: input.sessionKey,
      runId,
      hookName: input.hookName,
      hookEvent: input.hookEvent,
      expiresAt: Date.now() + timeoutMs,
      includeHookEvents: input.includeHookEvents,
    };
    pending.timeout = setTimeout(() => this.expireAsyncHook(pending), timeoutMs);
    pending.timeout.unref?.();
    this.pendingAsyncHooks.set(pending.invocationId, pending);
  }

  broadcastRetryProgress(detail: {
    sessionId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    provider: string;
    model: string;
  }): void {
    const event: GatewayEvent = {
      type: "agent_status",
      event: "retry_progress",
      detail: {
        attempt: detail.attempt,
        maxAttempts: detail.maxAttempts,
        delayMs: detail.delayMs,
        reason: detail.reason,
        provider: detail.provider,
        model: detail.model,
      },
    };
    this.emitForSession(detail.sessionId, event);
  }

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    if (input.projectKey) this.dialogProjectKeys.set(input.sessionKey, input.projectKey);
    const invalidPermission = validateGatewayPermissionModes(input);
    if (invalidPermission) {
      yield {
        type: "error",
        code: "INVALID_PERMISSION_MODE",
        message: invalidPermission,
        recoverable: true,
      };
      return;
    }
    const invalidMaxBudget = validateGatewayMaxBudget(input);
    if (invalidMaxBudget) {
      yield {
        type: "error",
        code: "INVALID_MAX_BUDGET_USD",
        message: invalidMaxBudget,
        recoverable: true,
      };
      return;
    }
    const plannedInput = normalizePlanCommandInput(input);
    if (!plannedInput) {
      yield {
        type: "assistant_text_delta",
        text: PLAN_COMMAND_USAGE,
      };
      yield {
        type: "turn_completed",
        usage: {},
        finishReason: "completed",
      };
      return;
    }
    input = plannedInput;
    if (input.sdkPermissionMode) {
      // Older SDK callers may send the adapter mode as a turn field. Fold it
      // into the same session-config path so the runtime has one ownership
      // boundary and native permission mode remains untouched.
      input = {
        ...input,
        sdkSessionConfig: {
          ...(input.sdkSessionConfig ?? {}),
          permissionMode: input.sdkPermissionMode,
        },
      };
    }

    const runId = input.runId ?? this.uuid();
    const replacementClaim = this.claimPendingTurnReplacement(input.sessionKey, runId);
    if (replacementClaim === "conflict") {
      const message = "This session is waiting for its edited replacement turn to be accepted.";
      yield {
        type: "error",
        runId,
        code: "replace_turn_pending",
        message,
        recoverable: true,
        userHint: "Wait for the edited message transaction to finish, then try again.",
      };
      return;
    }

    if (this.transcriptWriteReservations.has(input.sessionKey)) {
      this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
      yield {
        type: "error",
        runId,
        code: "replace_turn_pending",
        message: "This session transcript is currently being updated.",
        recoverable: true,
        userHint: "Wait for the session update to finish, then try again.",
      };
      return;
    }
    if (input.sdkSessionConfig) {
      if (!this.options.setSdkSessionConfig) {
        this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
        yield {
          type: "error",
          runId,
          code: "CAPABILITY_UNAVAILABLE",
          message: "sdk_session_config is unavailable.",
          recoverable: true,
        };
        return;
      }
      if (this.router.hasActiveTurn(input.sessionKey)) {
        this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
        yield {
          type: "error",
          runId,
          code: "SESSION_BUSY",
          message: "Cannot change SDK session configuration while a turn is active.",
          recoverable: true,
        };
        return;
      }
      try {
        validateSdkSessionConfig(input.sdkSessionConfig);
        const configUpdate = await this.options.setSdkSessionConfig(input.sessionKey, input.sdkSessionConfig, input.projectKey);
        if (configUpdate.changed) await this.router.close(input.sessionKey);
      } catch (error) {
        this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
        yield {
          type: "error",
          runId,
          code: error instanceof DialogGatewayError ? error.code : "INVALID_SDK_SESSION_CONFIG",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        };
        return;
      }
    }
    let taskBudget: { totalUsd: number; spentUsd: number } | undefined;
    if (this.options.taskBudgetSnapshot) {
      taskBudget = await this.options.taskBudgetSnapshot({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
      });
      if (taskBudget && taskBudget.spentUsd >= taskBudget.totalUsd) {
        this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
        const message = `Reached Gateway-owned taskBudget.total ($${taskBudget.totalUsd.toFixed(6)}) after spending $${taskBudget.spentUsd.toFixed(6)}.`;
        yield {
          type: "error",
          runId,
          code: "agent_task_budget_reached",
          message,
          recoverable: false,
          userHint: "Increase taskBudget.total or start a new SDK session with a larger budget.",
        };
        yield { type: "turn_completed", runId, usage: {}, finishReason: "task_budget" };
        return;
      }
    } else if (input.sdkSessionConfig?.taskBudget) {
      this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
      yield {
        type: "error",
        runId,
        code: "CAPABILITY_UNAVAILABLE",
        message: "Gateway task-budget accounting is unavailable.",
        recoverable: true,
      };
      return;
    }
    if (!this.router.beginTurn(input.sessionKey, runId)) {
      this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
      const message = `Session ${input.sessionKey} already has an active turn.`;
      const userHint = "Wait for the current turn to finish or stop it before sending another message.";
      yield {
        type: "agent_status",
        event: "session_busy",
        detail: createVisibleErrorStatusDetail({
          message,
          code: "session_busy",
          userHint,
          scope: "session",
          source: "gateway",
        }),
      };
      yield {
        type: "error",
        code: "session_busy",
        message,
        recoverable: true,
        userHint,
      };
      return;
    }

    try {
      await this.options.clearRecoveredUserDialogs?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
      });
    } catch (error) {
      this.router.endTurn(input.sessionKey, runId);
      this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
      yield {
        type: "error",
        runId,
        code: "gateway_dialog_recovery_cleanup_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
        userHint: "Retry the turn after the Gateway storage is available.",
      };
      return;
    }

    let resolveTurnDone!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      resolveTurnDone = resolve;
    });
    this.turnCompletions.set(input.sessionKey, turnDone);

    const queue = new AsyncQueue<GatewayEvent>();
    this.activeTurnReplays.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      runId,
      events: [],
      bytes: 0,
      truncated: false,
    });
    this.emitSinks.set(input.sessionKey, (event) => queue.enqueue(event));
    const emitGatewayFailureStatus = (status: GatewayRecordAgentStatusMessageInput["status"]): Promise<void> => {
      const recorded = this.recordGatewayStatusMessage({
        sessionKey: input.sessionKey,
        turnId: runId,
        projectKey: input.projectKey,
        status,
      });
      const statusEvent: GatewayEvent = {
        type: "agent_status",
        runId,
        event: status.event,
        detail: status.detail,
      };
      this.recordActiveTurnEvent(input.sessionKey, statusEvent);
      queue.enqueue(statusEvent);
      return recorded;
    };

    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }
    const telemetryContext = resolveSubmitTurnTelemetry(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    // Background pump: agent events → queue.
    const pump = (async () => {
      try {
        // Refresh only after beginTurn has reserved the session. Replacement
        // submissions claim their transaction before this await, so an
        // expiration callback cannot roll the transcript back underneath a
        // submission that is already starting.
        if (this.options.refreshConfigBeforeTurn) {
          try {
            await this.options.refreshConfigBeforeTurn();
          } catch {
            // Keep streaming on the previous snapshot rather than failing a
            // turn over a transient yaml read error.
          }
        }
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
        });
        if (input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const message = `Turn exceeded the ${input.timeoutMs}ms timeout.`;
            void emitGatewayFailureStatus(createGatewayFailureStatus({
              event: "turn_timeout",
              code: "turn_timeout",
              message,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
              detail: { timeoutMs: input.timeoutMs },
            }));
            const gatewayEvent: GatewayEvent = {
              type: "error",
              runId,
              code: "turn_timeout",
              message,
              recoverable: false,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
            };
            this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
            this.elicitationBus.rejectSession(input.sessionKey, "turn_timeout");
            this.userDialogBus.rejectSession(input.sessionKey, "turn_timeout");
            this.permissionBus.rejectSession(input.sessionKey, "turn_timeout");
            queue.close();
            try {
              session.abort(`timeout:${runId}`);
            } catch {
              // The queue is already closed, so a faulty abort implementation
              // cannot defeat the hard turn timeout.
            }
          }, input.timeoutMs);
        }
        const permissionSettings = readPermissionSettings();
        const inputMode = normalizeGatewayModeForLegacyInput((input as { mode?: unknown }).mode)
          ?? this.sessionPermissionModes.get(input.sessionKey);
        const runMode = normalizeGatewayRunMode((input as { runMode?: unknown }).runMode)
          ?? (inputMode === "plan" ? "plan" : "agent");
        const permissionMode = inputMode ?? (permissionSettings.skipPermissions ? "bypassPermissions" : undefined);
        const basePermissionMode = normalizeGatewayModeForLegacyInput((input as { basePermissionMode?: unknown }).basePermissionMode);
        const allowPlanModeTools = input.allowPlanModeTools ?? inputMode === "plan";
        const persistedRules = permissionSettingsToRuleSet(permissionSettings);
        const sessionAllowRules = this.sessionPermissionGrants.get(input.sessionKey) ?? [];
        this.options.telemetry?.trackFeatureLoopStage({
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_start",
          outcome: "success",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
          },
        });
        // Promote a text-only turn to blocks when the host channel attached
        // files/images. UI uploads come through this path; resolving them here
        // keeps attachment semantics in the gateway for every client.
        const uploaded = input.uploadedAttachments?.length
          ? await this.resolveUploadedAttachments(input)
          : [];
        const attachments = [...(input.attachments ?? []), ...uploaded];
        const allowedReadFiles = await collectRegisteredAttachmentReadFiles(attachments);
        const agentInput = await buildAgentInputWithAttachments(
          input.message,
          attachments,
          allowedReadFiles,
          input.projectKey,
          this.options.funasrInstallCommand ?? getPilotDeckInstallCommand(),
        );
        const syntheticMessages: CanonicalMessage[] = (input.syntheticMessages ?? []).map((s) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: s.text }],
          metadata: { synthetic: true, purpose: s.purpose ?? "channel_hint" },
        }));
        const modelSelection = this.options.resolveTurnModelSelection
          ? await this.options.resolveTurnModelSelection(input)
          : input.modelOverride
            ? { selection: input.modelOverride, source: "turn" as const }
            : { source: "default" as const };
        let lastEmittedModel: string | undefined;
        if (modelSelection.selection) {
          const event: GatewayEvent = {
            type: "model_selection_changed",
            provider: modelSelection.selection.provider,
            model: modelSelection.selection.model,
            source: modelSelection.source,
            reasoning: modelSelection.selection.reasoning,
            temperature: modelSelection.selection.temperature,
            speed: modelSelection.selection.speed,
            runId,
          };
          this.recordActiveTurnEvent(input.sessionKey, event);
          queue.enqueue(event);
          lastEmittedModel = `${modelSelection.selection.provider}\0${modelSelection.selection.model}`;
        }
        for await (const event of session.submit(
          agentInput,
          {
            turnId: runId,
            maxTurns: capGatewayTurnLimit(input.maxTurns, this.options.turnLimits?.maxTurns),
            maxBudgetUsd: capGatewayTurnLimit(input.maxBudgetUsd, this.options.turnLimits?.maxBudgetUsd),
            ...(taskBudget ? {
              taskBudgetUsd: taskBudget.totalUsd,
              initialTaskBudgetSpentUsd: taskBudget.spentUsd,
            } : {}),
            runMode,
            permissionMode,
            basePermissionMode,
            allowPlanModeTools,
            canPrompt: input.canPrompt,
            canElicit: input.canElicit,
            allowedReadFiles,
            permissionRules: {
              ...persistedRules,
              allow: [...sessionAllowRules, ...persistedRules.allow],
            },
            ...(syntheticMessages.length > 0 ? { syntheticMessages } : {}),
            ...(modelSelection.selection ? {
              modelOverride: {
                provider: modelSelection.selection.provider,
                model: modelSelection.selection.model,
                temperature: modelSelection.selection.temperature,
                speed: modelSelection.selection.speed,
                ...(modelSelection.selection.reasoning !== undefined ? {
                  thinking: {
                    enabled: modelSelection.selection.reasoning > 0,
                    mode: reasoningValueToMode(modelSelection.selection.reasoning),
                  },
                } : {}),
              },
            } : {}),
          },
        )) {
          if (this.turnCompletions.get(input.sessionKey) !== turnDone) {
            break;
          }
          emitSessionTelemetry(this.options.telemetry, event, {
            sessionId: input.sessionKey,
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
            ownerModule: telemetryContext.ownerModule,
            executionKind: telemetryContext.executionKind,
            phase: telemetryContext.phase,
          });
          if (event.type === "input_accepted") {
            await this.commitAcceptedTurnReplacement(input.sessionKey, runId);
          }
          if (event.type === "turn_completed" && event.result.budget?.taskBudgetUsd !== undefined) {
            await this.options.recordTaskBudgetSpend?.({
              sessionKey: input.sessionKey,
              projectKey: input.projectKey,
              runId,
              turnSpentUsd: event.result.budget.turnSpentUsd,
            });
          }
          if (event.type === "model_event" && event.event.type === "request_started"
            && lastEmittedModel !== `${event.event.provider}\0${event.event.model}`) {
            const selectionEvent: GatewayEvent = {
              type: "model_selection_changed",
              provider: event.event.provider,
              model: event.event.model,
              source: modelSelection.source,
              runId,
            };
            this.recordActiveTurnEvent(input.sessionKey, selectionEvent);
            queue.enqueue(selectionEvent);
            lastEmittedModel = `${event.event.provider}\0${event.event.model}`;
          }
          for (const gatewayEvent of mapAgentEvent(event, runId, {
            forwardSubagentText: input.sdkSessionConfig?.forwardSubagentText === true,
          })) {
            if (gatewayEvent.type === "context_budget") {
              this.recordGatewayStatusMessage({
                sessionKey: input.sessionKey,
                turnId: runId,
                projectKey: input.projectKey,
                status: {
                  event: "context_budget",
                  kind: "status",
                  text: "context_budget",
                  detail: { ...gatewayEvent },
                },
              }).catch(() => {});
            }
            this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
          }
        }
      } catch (error) {
        this.options.telemetry?.trackError(error, {
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_end",
          errorCategory: "loop_error",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
          },
        });
        if (this.turnCompletions.get(input.sessionKey) === turnDone) {
          const message = error instanceof Error ? error.message : String(error);
          const managedModelDenied = error instanceof DialogGatewayError
            && error.code === "SDK_MANAGED_MODEL_DENIED";
          // Gateway embedding hosts may reject a model/provider before an
          // AgentLoop or provider request exists. Keep the host policy code
          // intact instead of flattening it into an operational failure so a
          // remote SDK can distinguish a denied configuration from a retry.
          const organizationPolicyDenied = error instanceof DialogGatewayError
            && error.code.startsWith("GATEWAY_ORGANIZATION_");
          const code = managedModelDenied || organizationPolicyDenied
            ? error.code
            : "gateway_submit_failed";
          const userHint = managedModelDenied
            ? "Adjust the SDK session configuration or model selection, then retry."
            : organizationPolicyDenied
              ? "The Gateway host policy denied this configuration. Select an allowed model or contact the Gateway administrator."
            : "PilotDeck failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.";
          await emitGatewayFailureStatus(createGatewayFailureStatus({
            event: code,
            code,
            message,
            userHint,
          }));
          const gatewayEvent: GatewayEvent = {
            type: "error",
            runId,
            code,
            message,
            recoverable: false,
            userHint,
          };
          this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
          queue.enqueue(gatewayEvent);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // Clean up the emit-sink and any orphaned elicitation / permission
      // entries before returning so a subsequent turn doesn't see stale
      // state.
      this.expireAsyncHooksForTurn(input.sessionKey, runId);
      this.emitSinks.delete(input.sessionKey);
      this.activeTurnReplays.delete(input.sessionKey);
      this.elicitationBus.rejectSession(input.sessionKey, "turn_ended");
      this.userDialogBus.rejectSession(input.sessionKey, "turn_ended");
      this.permissionBus.rejectSession(input.sessionKey, "turn_ended");
      this.router.endTurn(input.sessionKey, runId);
      if (timedOut) {
        // The timed-out AgentSession is never safe to reuse. Do not await a
        // misbehaving tool here: the hard timeout must release the Cron run.
        await this.router.close(input.sessionKey);
        void pump.catch(() => undefined);
      } else {
        // Defensive — make sure the pump promise is settled before we resolve.
        await pump.catch(() => undefined);
      }
      // Signal any in-flight `abortTurn` awaiters that the session slot
      // has been released. Drop our deferred only if we still own it —
      // a later turn for the same session may have already installed
      // its own.
      if (this.turnCompletions.get(input.sessionKey) === turnDone) {
        this.turnCompletions.delete(input.sessionKey);
      }
      resolveTurnDone();
      this.releasePendingTurnReplacementClaim(input.sessionKey, runId);
      this.options.afterTurnCompleted?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        runId,
      });
    }
  }

  async steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult> {
    const activeRunId = this.router.activeTurnRunId(input.sessionKey);
    if (!activeRunId) return { accepted: false, reason: "no_active_turn" };
    if (activeRunId !== input.runId) return { accepted: false, reason: "turn_mismatch" };

    const attachments = input.attachments ?? [];
    const allowedReadFiles = await collectRegisteredAttachmentReadFiles(attachments);
    const agentInput = await buildAgentInputWithAttachments(
      input.message,
      attachments,
      allowedReadFiles,
      input.projectKey,
      this.options.funasrInstallCommand ?? getPilotDeckInstallCommand(),
    );
    const message: CanonicalMessage = {
      role: "user",
      content: agentInput.type === "text"
        ? [{ type: "text", text: agentInput.text }]
        : agentInput.content,
      metadata: { purpose: "mid_turn_steer", queueItemId: input.itemId },
    };
    return this.router.steer(input.sessionKey, {
      turnId: input.runId,
      itemId: input.itemId,
      message,
      allowedReadFiles,
    });
  }

  async cancelSteer(input: GatewayCancelSteerInput): Promise<GatewayCancelSteerResult> {
    const activeRunId = this.router.activeTurnRunId(input.sessionKey);
    if (!activeRunId) return { cancelled: false, reason: "no_active_turn" };
    if (activeRunId !== input.runId) return { cancelled: false, reason: "turn_mismatch" };
    return this.router.cancelSteer(input.sessionKey, {
      turnId: input.runId,
      itemId: input.itemId,
    });
  }

  async submitAsyncHookResult(input: GatewayAsyncHookResultInput): Promise<GatewayAsyncHookResult> {
    if (!input.sessionKey?.trim() || !input.invocationId?.trim()) {
      throw new DialogGatewayError("INVALID_ASYNC_HOOK_RESULT", "sessionKey and invocationId are required.");
    }
    const prior = this.asyncHookOutcomes.get(input.invocationId);
    if (prior) {
      if (prior.sessionKey !== input.sessionKey) return { invocationId: input.invocationId, status: "unknown" };
      return {
        invocationId: input.invocationId,
        status: prior.status === "delivered" ? "duplicate" : "expired",
      };
    }
    const pending = this.pendingAsyncHooks.get(input.invocationId);
    if (!pending || pending.sessionKey !== input.sessionKey) {
      return { invocationId: input.invocationId, status: "unknown" };
    }
    if (Date.now() >= pending.expiresAt) {
      this.expireAsyncHook(pending);
      return { invocationId: input.invocationId, status: "expired" };
    }
    if (pending.delivery) {
      const settled = await pending.delivery;
      return {
        invocationId: input.invocationId,
        status: settled.status === "delivered" ? "duplicate" : settled.status,
      };
    }
    const context = deferredHookContext(input.output, pending.hookEvent);
    pending.delivery = this.deliverAsyncHookContext(pending, context);
    try {
      return await pending.delivery;
    } finally {
      pending.delivery = undefined;
    }
  }

  private async deliverAsyncHookContext(
    pending: PendingAsyncHook,
    context: string,
  ): Promise<GatewayAsyncHookResult> {
    const result = context
      ? await this.steerTurn({
          sessionKey: pending.sessionKey,
          runId: pending.runId,
          itemId: `async-hook:${pending.invocationId}`,
          message: context,
        })
      : { accepted: this.router.activeTurnRunId(pending.sessionKey) === pending.runId };
    if (!result.accepted) {
      this.expireAsyncHook(pending);
      return { invocationId: pending.invocationId, status: "expired" };
    }
    this.settleAsyncHook(pending, "delivered");
    if (pending.includeHookEvents) {
      this.emitForSession(pending.sessionKey, {
        type: "hook_async_result",
        invocationId: pending.invocationId,
        hookName: pending.hookName,
        hookEvent: pending.hookEvent,
        status: "delivered",
      });
    }
    return { invocationId: pending.invocationId, status: "delivered" };
  }

  private expireAsyncHook(pending: PendingAsyncHook): void {
    if (this.pendingAsyncHooks.get(pending.invocationId) !== pending) return;
    this.settleAsyncHook(pending, "expired");
    if (pending.includeHookEvents) {
      this.emitForSession(pending.sessionKey, {
        type: "hook_async_result",
        invocationId: pending.invocationId,
        hookName: pending.hookName,
        hookEvent: pending.hookEvent,
        status: "expired",
      });
    }
  }

  private settleAsyncHook(pending: PendingAsyncHook, status: AsyncHookOutcome["status"]): void {
    if (this.pendingAsyncHooks.get(pending.invocationId) === pending) {
      this.pendingAsyncHooks.delete(pending.invocationId);
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    const previous = this.asyncHookOutcomes.get(pending.invocationId);
    if (previous?.timeout) clearTimeout(previous.timeout);
    const outcome: AsyncHookOutcome = { sessionKey: pending.sessionKey, status };
    outcome.timeout = setTimeout(() => {
      if (this.asyncHookOutcomes.get(pending.invocationId) === outcome) {
        this.asyncHookOutcomes.delete(pending.invocationId);
      }
    }, ASYNC_HOOK_OUTCOME_RETENTION_MS);
    outcome.timeout.unref?.();
    this.asyncHookOutcomes.set(pending.invocationId, outcome);
  }

  private expireAsyncHooksForTurn(sessionKey: string, runId: string): void {
    for (const pending of this.pendingAsyncHooks.values()) {
      if (pending.sessionKey === sessionKey && pending.runId === runId) {
        this.expireAsyncHook(pending);
      }
    }
  }

  async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
    const reason = input.reason ?? (input.runId ? `aborted:${input.runId}` : "aborted");
    await this.router.abort(input.sessionKey, reason);
    // Wait for the in-flight `submitTurn` (if any) to fully unwind so
    // `inFlightTurns` has been cleared by the time the RPC response is
    // sent. Otherwise a fast "stop → re-send" from a client races the
    // gateway's own cleanup and the next submit is rejected with
    // `session_busy`.
    const pending = this.turnCompletions.get(input.sessionKey);
    if (!pending) return;
    await pending;
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.router.list(input);
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return input;
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    const suffix = this.uuid();
    const projectKey = input.projectKey ? `project=${input.projectKey}:` : "";
    return { sessionKey: `${input.channelKey}:${projectKey}s_${suffix}` };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.router.close(input.sessionKey);
    this.sessionPermissionGrants.delete(input.sessionKey);
    this.dialogProjectKeys.delete(input.sessionKey);
  }

  async deleteSession(input: { sessionKey: string; projectKey?: string }): Promise<void> {
    if (!this.options.deleteSession && !this.options.deleteEphemeralSession) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "delete_session is unavailable.");
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot delete an active session.");
    if (await this.options.deleteEphemeralSession?.(input)) {
      await this.router.close(input.sessionKey);
      this.sessionPermissionGrants.delete(input.sessionKey);
      this.dialogProjectKeys.delete(input.sessionKey);
      return;
    }
    if (!this.options.deleteSession) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "delete_session is unavailable.");
    await this.router.close(input.sessionKey);
    this.sessionPermissionGrants.delete(input.sessionKey);
    this.dialogProjectKeys.delete(input.sessionKey);
    await this.options.deleteSession(input);
  }

  async exportSessionTranscript(
    input: import("../protocol/types.js").GatewayExportSessionTranscriptInput,
  ): Promise<import("../protocol/types.js").GatewaySessionTranscriptArchive> {
    if (!this.options.exportSessionTranscript) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "export_session_transcript is unavailable.");
    }
    return await this.options.exportSessionTranscript(input);
  }

  async restoreSessionTranscript(
    input: import("../protocol/types.js").GatewayRestoreSessionTranscriptInput,
  ): Promise<import("../protocol/types.js").GatewayRestoreSessionTranscriptResult> {
    if (!this.options.restoreSessionTranscript) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "restore_session_transcript is unavailable.");
    }
    return await this.options.restoreSessionTranscript(input);
  }

  async renameSession(input: import("../protocol/types.js").GatewaySessionMetadataInput): Promise<{ updated: boolean }> {
    if (!this.options.renameSession) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "rename_session is unavailable.");
    return this.options.renameSession(input);
  }

  async tagSession(input: import("../protocol/types.js").GatewaySessionMetadataInput): Promise<{ updated: boolean }> {
    if (!this.options.tagSession) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "tag_session is unavailable.");
    return this.options.tagSession(input);
  }

  async recordAgentStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    if (!this.options.recordAgentStatusMessage) {
      return { recorded: false };
    }
    return this.options.recordAgentStatusMessage(input);
  }

  private async recordGatewayStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<void> {
    if (!this.options.recordAgentStatusMessage) {
      return;
    }
    try {
      await this.options.recordAgentStatusMessage(input);
    } catch (error) {
      console.warn("[pilotdeck] failed to record gateway status message:", error);
    }
  }

  async describeServer(): Promise<GatewayServerInfo> {
    const capabilities = [
      ...(this.options.listProjects ? ["project_files_list" as const] : []),
      ...(this.options.commandsList ? ["commands_list" as const] : []),
      ...(this.options.modelCatalogList ? ["model_catalog_list" as const] : []),
      ...(this.options.sessionModelGet ? ["session_model_get" as const] : []),
      ...(this.options.sessionModelSet ? ["session_model_set" as const] : []),
      ...(this.options.sessionModelClear ? ["session_model_clear" as const] : []),
      ...(this.options.deleteSession || this.options.deleteEphemeralSession ? ["delete_session" as const] : []),
      ...(this.options.exportSessionTranscript && this.options.restoreSessionTranscript
        ? ["session_transcript_archive" as const]
        : []),
      ...(this.options.mcpServerStatus ? ["mcp_server_status" as const] : []),
      ...(this.options.setMcpServers ? ["set_mcp_servers" as const] : []),
      ...(this.options.reconnectMcpServer ? ["mcp_server_reconnect" as const] : []),
      ...(this.options.toggleMcpServer ? ["mcp_server_toggle" as const] : []),
      ...(this.options.setMcpPermissionModeOverride ? ["set_mcp_permission_mode_override" as const] : []),
      ...(this.options.projectFileRead || this.options.listProjects ? ["project_file_read" as const] : []),
      "set_permission_mode" as const,
      ...(this.options.applyFlagSettings ? ["apply_flag_settings" as const] : []),
      ...(this.options.updateSettings ? ["update_settings" as const] : []),
      ...(this.options.resolveSettings ? ["resolve_settings" as const] : []),
      ...(this.options.setSessionThinking ? ["set_session_thinking" as const] : []),
      ...(this.options.outputStylesList ? ["output_styles_list" as const] : []),
      ...(this.options.setOutputStyle ? ["set_output_style" as const] : []),
      ...(this.options.reloadOutputStyles ? ["reload_output_styles" as const] : []),
      ...(this.options.usageSnapshot ? ["usage_snapshot" as const] : []),
      ...(this.options.modelUsageSnapshot ? ["model_usage_snapshot" as const] : []),
      "async_hook_result" as const,
      "user_dialog_list" as const,
      ...(this.options.rewindFiles ? ["rewind_files" as const] : []),
      ...(this.options.stopBackgroundTask ? ["background_task_stop" as const] : []),
      ...(this.options.backgroundTasks ? ["background_tasks" as const] : []),
      "seed_read_state" as const,
      ...(this.options.setSdkSessionConfig ? ["sdk_session_config" as const] : []),
      ...(this.options.setSdkSessionConfig && this.options.sdkSessionDefaults
        ? ["sdk_session_defaults" as const]
        : []),
      "supported_agents" as const,
    ] as GatewayServerInfo["capabilities"];
    return {
      mode: "in_process",
      sessionCount: this.router.sessionCount(),
      ...this.options.serverInfo,
      capabilities,
    };
  }

  async projectFilesList(input: ProjectFilesListInput): Promise<ProjectFilesListResult> {
    if (!this.options.listProjects) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "project_files_list is unavailable.");
    const projects = await this.listProjects();
    const requested = resolve(input.projectKey);
    const registered = projects.projects.find((project) => resolve(project.projectKey) === requested);
    if (!registered) {
      throw new DialogGatewayError("PROJECT_NOT_FOUND", `Unknown projectKey: ${input.projectKey}`);
    }
    return listProjectFiles({ ...input, projectKey: registered.projectKey });
  }

  async commandsList(input: CommandsListInput): Promise<CommandsListResult> {
    if (!this.options.commandsList) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "commands_list is unavailable.");
    return this.options.commandsList(input);
  }

  async modelCatalogList(input: ModelCatalogListInput): Promise<ModelCatalogListResult> {
    if (!this.options.modelCatalogList) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "model_catalog_list is unavailable.");
    return this.options.modelCatalogList(input);
  }

  async sessionModelGet(input: SessionModelInput): Promise<SessionModelResult> {
    if (!this.options.sessionModelGet) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_get is unavailable.");
    return this.options.sessionModelGet(input);
  }

  async sessionModelSet(input: SessionModelSetInput): Promise<SessionModelResult> {
    if (!this.options.sessionModelSet) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_set is unavailable.");
    this.reserveTranscriptWrite(input.sessionKey, "change the session model");
    try {
      return await this.options.sessionModelSet(input);
    } finally {
      this.transcriptWriteReservations.delete(input.sessionKey);
    }
  }

  async sessionModelClear(input: SessionModelInput): Promise<void> {
    if (!this.options.sessionModelClear) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_clear is unavailable.");
    this.reserveTranscriptWrite(input.sessionKey, "clear the session model");
    try {
      await this.options.sessionModelClear(input);
    } finally {
      this.transcriptWriteReservations.delete(input.sessionKey);
    }
  }

  async projectFileRead(input: import("../protocol/types.js").GatewayProjectFileReadInput): Promise<import("../protocol/types.js").GatewayProjectFileReadResult | null> {
    if (this.options.projectFileRead) return this.options.projectFileRead(input);
    if (!this.options.listProjects) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "project_file_read is unavailable.");
    const projects = await this.listProjects();
    const projectRoot = projects.projects.find((project) => resolve(project.projectKey) === resolve(input.projectKey))?.projectKey;
    if (!projectRoot) throw new DialogGatewayError("PROJECT_NOT_FOUND", `Unknown projectKey: ${input.projectKey}`);
    const root = await realpath(projectRoot).catch(() => { throw new DialogGatewayError("PROJECT_NOT_FOUND", `Project does not exist: ${input.projectKey}`); });
    const absolute = resolve(root, input.path);
    if (!isPathWithinRoot(absolute, root)) throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path is outside the project workspace.");
    const canonical = await realpath(absolute).catch(() => undefined);
    if (!canonical || !isPathWithinRoot(canonical, root)) throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path resolves outside the project workspace.");
    const info = await stat(canonical).catch(() => undefined);
    if (!info?.isFile()) return null;
    const maxBytes = Math.max(1, Math.min(input.maxBytes ?? 1_000_000, 10_000_000));
    if (input.encoding === "base64") {
      const buffer = await readFile(canonical);
      return { path: input.path, content: buffer.subarray(0, maxBytes).toString("base64"), encoding: "base64" };
    }
    const buffer = await readFile(canonical);
    return { path: input.path, content: buffer.subarray(0, maxBytes).toString("utf8"), encoding: "utf-8" };
  }

  async mcpServerStatus(input: import("../protocol/types.js").GatewayMcpServerStatusInput): Promise<import("../protocol/types.js").GatewayMcpServerStatusResult> {
    if (!this.options.mcpServerStatus) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "mcp_server_status is unavailable.");
    return this.options.mcpServerStatus(input);
  }

  async setMcpServers(input: GatewaySetMcpServersInput): Promise<GatewayMcpSetServersResult> {
    if (!this.options.setMcpServers) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "set_mcp_servers is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change MCP servers while a turn is active.");
    const result = await this.options.setMcpServers(input);
    await this.router.close(input.sessionKey);
    return result;
  }

  async reconnectMcpServer(input: GatewayMcpServerControlInput): Promise<void> {
    if (!this.options.reconnectMcpServer) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "mcp_server_reconnect is unavailable.");
    if (!input.sessionKey?.trim() || !input.serverName?.trim()) throw new DialogGatewayError("INVALID_MCP_SERVER", "sessionKey and serverName are required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot reconnect MCP while a turn is active.");
    await this.options.reconnectMcpServer(input);
    await this.router.close(input.sessionKey);
  }

  async toggleMcpServer(input: GatewayMcpServerToggleInput): Promise<void> {
    if (!this.options.toggleMcpServer) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "mcp_server_toggle is unavailable.");
    if (!input.sessionKey?.trim() || !input.serverName?.trim()) throw new DialogGatewayError("INVALID_MCP_SERVER", "sessionKey and serverName are required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot toggle MCP while a turn is active.");
    await this.options.toggleMcpServer(input);
    await this.router.close(input.sessionKey);
  }

  async setMcpPermissionModeOverride(
    input: GatewayMcpPermissionModeOverrideInput,
  ): Promise<GatewayMcpPermissionModeOverrideResult> {
    if (!this.options.setMcpPermissionModeOverride) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "set_mcp_permission_mode_override is unavailable.");
    }
    if (!input.sessionKey?.trim() || !input.serverName?.trim()) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", "sessionKey and serverName are required.");
    }
    if (input.mode !== null && input.mode !== "default" && input.mode !== "auto") {
      throw new DialogGatewayError("INVALID_MCP_PERMISSION_MODE", `Unsupported MCP permission mode: ${input.mode}`);
    }
    if (this.router.hasActiveTurn(input.sessionKey)) {
      throw new DialogGatewayError("SESSION_BUSY", "Cannot change MCP permission mode while a turn is active.");
    }
    const result = await this.options.setMcpPermissionModeOverride(input);
    await this.router.close(input.sessionKey);
    return result;
  }

  async setPermissionMode(input: import("../protocol/types.js").GatewaySetPermissionModeInput): Promise<{ applied: boolean }> {
    if (input.mode !== "default" && input.mode !== "plan" && input.mode !== "bypassPermissions") {
      throw new DialogGatewayError("INVALID_PERMISSION_MODE", `Unsupported permission mode: ${input.mode}`);
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change permission mode during an active turn.");
    this.sessionPermissionModes.set(input.sessionKey, input.mode);
    if (this.options.setPermissionMode) return this.options.setPermissionMode(input);
    return { applied: true };
  }

  async applyFlagSettings(input: GatewayApplyFlagSettingsInput): Promise<GatewayApplyFlagSettingsResult> {
    if (!this.options.applyFlagSettings) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "apply_flag_settings is unavailable.");
    }
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
      throw new DialogGatewayError("INVALID_FLAG_SETTINGS", "settings must be an object.");
    }
    if (this.router.hasActiveTurn(input.sessionKey)) {
      throw new DialogGatewayError("SESSION_BUSY", "Cannot apply flag settings during an active turn.");
    }
    validateSdkFlagSettings(input.settings);
    const result = await this.options.applyFlagSettings(input);
    if (result.applied.length > 0 || result.cleared.length > 0) await this.router.close(input.sessionKey);
    return result;
  }

  async updateSettings(input: GatewayUpdateSettingsInput): Promise<GatewayUpdateSettingsResult> {
    if (!this.options.updateSettings) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "update_settings is unavailable.");
    }
    if (input.source !== "localSettings") {
      throw new DialogGatewayError("INVALID_SETTINGS_SOURCE", "Only localSettings is supported.");
    }
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
      throw new DialogGatewayError("INVALID_LOCAL_SETTINGS", "settings must be an object.");
    }
    return this.options.updateSettings(input);
  }

  async resolveSettings(): Promise<GatewayResolvedSettingsResult> {
    if (!this.options.resolveSettings) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "resolve_settings is unavailable.");
    }
    return this.options.resolveSettings();
  }

  async setSessionThinking(input: GatewaySetSessionThinkingInput): Promise<{ applied: boolean }> {
    if (!this.options.setSessionThinking) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "set_session_thinking is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change thinking while a turn is active.");
    validateThinkingConfig(input.thinking);
    const result = await this.options.setSessionThinking(input);
    await this.router.close(input.sessionKey);
    return result;
  }

  async outputStylesList(input: GatewayOutputStylesListInput): Promise<GatewayOutputStylesListResult> {
    if (!this.options.outputStylesList) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "output_styles_list is unavailable.");
    return this.options.outputStylesList(input);
  }

  async setOutputStyle(input: GatewaySetOutputStyleInput): Promise<GatewaySetOutputStyleResult> {
    if (!this.options.setOutputStyle) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "set_output_style is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change output style during an active turn.");
    if (input.name !== null && !input.name.trim()) throw new DialogGatewayError("INVALID_OUTPUT_STYLE", "name must be non-empty or null.");
    return this.options.setOutputStyle(input);
  }

  async reloadOutputStyles(input: GatewayReloadOutputStylesInput = {}): Promise<GatewayReloadOutputStylesResult> {
    if (!this.options.reloadOutputStyles) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "reload_output_styles is unavailable.");
    return this.options.reloadOutputStyles(input);
  }

  async usageSnapshot(input: GatewayUsageSnapshotInput): Promise<GatewayUsageSnapshotResult> {
    if (!this.options.usageSnapshot) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "usage_snapshot is unavailable.");
    return this.options.usageSnapshot(input);
  }

  async modelUsageSnapshot(input: GatewayModelUsageSnapshotInput): Promise<GatewayModelUsageSnapshotResult> {
    if (!this.options.modelUsageSnapshot) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "model_usage_snapshot is unavailable.");
    return this.options.modelUsageSnapshot(input);
  }

  async rewindFiles(input: GatewayRewindFilesInput): Promise<GatewayRewindFilesResult> {
    if (!this.options.rewindFiles) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "rewind_files is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.userMessageId?.trim()) throw new DialogGatewayError("INVALID_MESSAGE_ID", "userMessageId is required.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot rewind files while a turn is active.");
    return this.options.rewindFiles(input);
  }

  async stopBackgroundTask(
    input: import("../protocol/types.js").GatewayStopBackgroundTaskInput,
  ): Promise<import("../protocol/types.js").GatewayStopBackgroundTaskResult> {
    if (!this.options.stopBackgroundTask) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "background_task_stop is unavailable.");
    }
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.taskId?.trim()) throw new DialogGatewayError("INVALID_TASK_ID", "taskId is required.");
    return this.options.stopBackgroundTask(input);
  }

  async backgroundTasks(
    input: import("../protocol/types.js").GatewayBackgroundTasksInput,
  ): Promise<import("../protocol/types.js").GatewayBackgroundTasksResult> {
    if (!this.options.backgroundTasks) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "background_tasks is unavailable.");
    }
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    return this.options.backgroundTasks(input);
  }

  async seedReadState(input: GatewaySeedReadStateInput): Promise<GatewaySeedReadStateResult> {
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.path?.trim()) throw new DialogGatewayError("INVALID_FILE_PATH", "path is required.");
    if (!Number.isFinite(input.mtime) || !Number.isInteger(input.mtime) || input.mtime < 0) {
      throw new DialogGatewayError("INVALID_FILE_MTIME", "mtime must be a non-negative integer in milliseconds.");
    }
    if (this.router.hasActiveTurn(input.sessionKey)) {
      throw new DialogGatewayError("SESSION_BUSY", "Cannot seed file read state while a turn is active.");
    }
    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }
    if (input.sdkSessionConfig) {
      if (!this.options.setSdkSessionConfig) {
        throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "sdk_session_config is unavailable.");
      }
      validateSdkSessionConfig(input.sdkSessionConfig);
      const configUpdate = await this.options.setSdkSessionConfig(input.sessionKey, input.sdkSessionConfig, input.projectKey);
      if (configUpdate.changed) await this.router.close(input.sessionKey);
    }
    return await this.router.seedReadState({
      sessionKey: input.sessionKey,
      projectKey: input.projectKey,
      channelKey: input.channelKey ?? "api_server",
    }, { path: input.path, mtime: input.mtime });
  }

  async supportedAgents(): Promise<import("../protocol/types.js").GatewaySupportedAgentsResult> {
    return {
      agents: Object.values(SUBAGENT_DEFINITIONS).map((agent) => ({
        name: agent.id,
        description: agent.description,
        tools: [...agent.allowedTools],
        readOnly: agent.isReadOnly,
        ...(agent.effort ? { effort: agent.effort } : {}),
      })),
    };
  }


  private reserveTranscriptWrite(sessionKey: string, operation: string): void {
    if (
      this.transcriptWriteReservations.has(sessionKey)
      || this.pendingTurnReplacements.has(sessionKey)
    ) {
      throw new DialogGatewayError(
        "SESSION_BUSY",
        `Cannot ${operation} while another transcript update is pending.`,
      );
    }
    this.transcriptWriteReservations.add(sessionKey);
  }

  private async resolveUploadedAttachments(input: GatewaySubmitTurnInput): Promise<ChannelAttachment[]> {
    if (!input.projectKey) throw new DialogGatewayError("PROJECT_NOT_FOUND", "projectKey is required for uploaded attachments.");
    if (!this.options.resolveUploadedAttachments) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "Uploaded attachments are unavailable.");
    return this.options.resolveUploadedAttachments({ projectKey: input.projectKey, uploads: input.uploadedAttachments ?? [] });
  }

  async getActiveTurnSnapshot(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot> {
    const replay = this.activeTurnReplays.get(input.sessionKey);
    if (!replay) {
      return {
        active: false,
        sessionKey: input.sessionKey,
        events: [],
      };
    }
    return {
      active: true,
      sessionKey: replay.sessionKey,
      runId: replay.runId,
      events: input.includeEvents === false
        ? []
        : replay.events
          .filter((event) => this.shouldReplayActiveTurnEvent(input.sessionKey, event))
          .map((event) => cloneGatewayEvent(event)),
      ...(replay.truncated ? { truncated: true } : {}),
    };
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return this.requireCron().createTask(input);
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return this.requireCron().listTasks(input);
  }

  async cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult> {
    return this.requireCron().updateTask(input);
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return this.requireCron().deleteTask(input);
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return this.requireCron().stopTask(input);
  }

  async cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    return this.requireCron().runTaskNow(input);
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    const entry = this.elicitationBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve(input.answer);
    this.options.dispatchHookForSession?.(input.sessionKey, "ElicitationResult", { requestId: input.requestId, delivered: true });
    return { delivered: true };
  }

  async respondUserDialog(input: GatewayUserDialogResponseInput): Promise<{
    delivered: boolean;
    recovered?: true;
    reason?: "gateway_restarted";
  }> {
    if (!input.sessionKey?.trim() || !input.requestId?.trim()) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RESPONSE", "sessionKey and requestId are required.");
    }
    if (!input.result || (input.result.behavior !== "answered" && input.result.behavior !== "cancelled")) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RESPONSE", "result.behavior must be answered or cancelled.");
    }
    if (input.result.behavior === "answered" && input.result.value === undefined) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RESPONSE", "answered user dialog results require a value.");
    }
    if (input.result.behavior === "cancelled" && input.result.reason !== undefined && typeof input.result.reason !== "string") {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RESPONSE", "cancelled user dialog reason must be a string.");
    }
    if (input.leaseId !== undefined && (typeof input.leaseId !== "string" || !input.leaseId.trim())) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RESPONSE", "leaseId must be a non-empty string when provided.");
    }
    // A configured host dialog protocol owns the cross-Gateway lease and
    // answer handoff, including when this is the Gateway that owns the local
    // AgentLoop. Do not let its in-process bus bypass a remote renderer lease.
    const hosted = await this.options.submitHostedUserDialogAnswer?.(input);
    if (hosted) return { delivered: true };
    const entry = this.userDialogBus.peek(input.sessionKey, input.requestId);
    if (!entry) {
      const recovered = await this.options.recoverUserDialog?.(input);
      if (recovered) return { delivered: true, recovered: true, reason: "gateway_restarted" };
      const acknowledged = await this.options.acknowledgeRecoveredUserDialog?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        requestId: input.requestId,
      });
      return acknowledged ? { delivered: false, reason: "gateway_restarted" } : { delivered: false };
    }
    if (input.result.behavior === "answered" && !entry.accepts(input.result.value)) {
      throw new DialogGatewayError(
        "INVALID_USER_DIALOG_RESPONSE",
        `answered ${entry.dialogKind} dialog result does not match the pending dialog contract.`,
      );
    }
    const consumed = this.userDialogBus.consumeForResponse(
      input.sessionKey,
      input.requestId,
      input.leaseId?.trim(),
      input.result.behavior,
    );
    if (!consumed.entry) {
      if (consumed.reason === "lease_required") {
        throw new DialogGatewayError(
          "USER_DIALOG_LEASE_REQUIRED",
          `User dialog ${input.requestId} is currently claimed by another renderer.`,
        );
      }
      return { delivered: false };
    }
    // `listUserDialogs()` may have inspected the journal while this live
    // request was pending. Drop that process-local restart projection as the
    // live response settles, otherwise a stale terminal copy can outlive the
    // journal removal performed by the channel.
    await this.options.acknowledgeRecoveredUserDialog?.({
      sessionKey: input.sessionKey,
      projectKey: input.projectKey,
      requestId: input.requestId,
    });
    consumed.entry.resolve(input.result.behavior === "answered"
      ? { type: "answered", value: input.result.value }
      : { type: "cancelled", ...(input.result.reason ? { reason: input.result.reason } : {}) });
    return { delivered: true };
  }

  async listUserDialogs(input: GatewayListUserDialogsInput): Promise<GatewayListUserDialogsResult> {
    if (!input.sessionKey?.trim()) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_LIST", "sessionKey is required.");
    }
    const live = this.userDialogBus.list(input.sessionKey);
    const liveRequestIds = new Set(live.map((dialog) => dialog.requestId));
    const hosted = await this.options.listHostedUserDialogs?.(input) ?? [];
    const hostedRequestIds = new Set(hosted.map((dialog) => dialog.requestId));
    const recovered = await this.options.listRecoveredUserDialogs?.(input) ?? [];
    // A journal is written before the live event is published. While this
    // process still owns that pending request, it is not restart recovery
    // state and must not be projected a second time as terminal.
    return {
      dialogs: [
        ...live.filter((dialog) => !hostedRequestIds.has(dialog.requestId)),
        ...hosted,
        ...recovered.filter((dialog) => (
          !liveRequestIds.has(dialog.request.requestId)
          && !hostedRequestIds.has(dialog.request.requestId)
        )),
      ],
    };
  }

  async claimUserDialog(input: GatewayUserDialogClaimInput): Promise<GatewayUserDialogClaimResult> {
    if (!input.sessionKey?.trim() || !input.requestId?.trim()) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_CLAIM", "sessionKey and requestId are required.");
    }
    if (input.leaseId !== undefined && (typeof input.leaseId !== "string" || !input.leaseId.trim())) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_CLAIM", "leaseId must be a non-empty string when provided.");
    }
    const ttlMs = input.ttlMs ?? DEFAULT_USER_DIALOG_LEASE_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_USER_DIALOG_LEASE_MS || ttlMs > MAX_USER_DIALOG_LEASE_MS) {
      throw new DialogGatewayError(
        "INVALID_USER_DIALOG_CLAIM",
        `ttlMs must be a safe integer between ${MIN_USER_DIALOG_LEASE_MS} and ${MAX_USER_DIALOG_LEASE_MS}.`,
      );
    }
    const hosted = await this.options.claimHostedUserDialog?.(input);
    if (hosted && (hosted.claimed || hosted.reason !== "not_pending")) return hosted;
    const claim = this.userDialogBus.claim(
      input.sessionKey,
      input.requestId,
      ttlMs,
      input.leaseId?.trim(),
    );
    if (claim.claimed) {
      return { claimed: true, leaseId: claim.lease.leaseId, expiresAt: claim.lease.expiresAt };
    }
    if (claim.reason === "claimed") {
      return { claimed: false, reason: "claimed", ...(claim.expiresAt ? { expiresAt: claim.expiresAt } : {}) };
    }
    return hosted ?? { claimed: false, reason: "not_pending" };
  }

  async releaseUserDialog(input: GatewayUserDialogReleaseInput): Promise<GatewayUserDialogReleaseResult> {
    if (!input.sessionKey?.trim() || !input.requestId?.trim() || !input.leaseId?.trim()) {
      throw new DialogGatewayError("INVALID_USER_DIALOG_RELEASE", "sessionKey, requestId, and leaseId are required.");
    }
    const hosted = await this.options.releaseHostedUserDialog?.(input);
    if (hosted !== undefined) return { released: hosted };
    return { released: this.userDialogBus.release(input.sessionKey, input.requestId, input.leaseId.trim()) };
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    const entry = this.permissionBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve({
      requestId: input.requestId,
      decision: input.decision,
      remember: input.remember,
      reason: input.reason,
    });
    return { delivered: true };
  }

  async grantSessionPermission(input: GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }> {
    const rule = permissionEntryToRule(input.entry, "allow", "session");
    if (!rule.toolName) {
      return { granted: false };
    }

    const rules = this.sessionPermissionGrants.get(input.sessionKey) ?? [];
    const alreadyGranted = rules.some(
      (existing) => existing.toolName === rule.toolName && existing.pattern === rule.pattern,
    );
    if (!alreadyGranted) {
      rules.push(rule);
      this.sessionPermissionGrants.set(input.sessionKey, rules);
    }
    return { granted: true, entry: input.entry };
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    if (!this.options.readSessionMessages) {
      throw new Error(
        "read_session_messages is not configured. Wire `readSessionMessages` via createLocalGateway.",
      );
    }
    return this.options.readSessionMessages(input);
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    if (!this.options.readSubagentMessages) {
      throw new Error(
        "read_subagent_messages is not configured. Wire `readSubagentMessages` via createLocalGateway.",
      );
    }
    return this.options.readSubagentMessages(input);
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    if (!this.options.forkSession) {
      throw new Error(
        "fork_session is not configured. Wire `forkSession` via createLocalGateway.",
      );
    }
    return this.options.forkSession(input);
  }

  async replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult> {
    if (!this.options.replaceLastTurn) {
      throw new Error(
        "replace_last_turn is not configured. Wire `replaceLastTurn` via createLocalGateway.",
      );
    }
    if (typeof input.replacementTurnId !== "string" || !input.replacementTurnId.trim()) {
      throw new DialogGatewayError("replace_invalid_input", "replacementTurnId is required.");
    }
    if (
      this.transcriptWriteReservations.has(input.sessionKey)
      || this.pendingTurnReplacements.has(input.sessionKey)
    ) {
      throw new DialogGatewayError(
        "replace_turn_pending",
        "A replacement transaction is already pending for this session.",
      );
    }

    const activeRunId = this.router.activeTurnRunId(input.sessionKey);
    if (activeRunId && activeRunId !== input.expectedTurnId) {
      throw new DialogGatewayError(
        "replace_turn_conflict",
        "The selected message is no longer the active turn.",
        { activeRunId, expectedTurnId: input.expectedTurnId },
      );
    }
    if (!this.options.finalizeLastTurnReplacement) {
      throw new Error(
        "finalize_last_turn_replacement is required when replace_last_turn is configured.",
      );
    }
    this.transcriptWriteReservations.add(input.sessionKey);
    let result: WebReplaceLastTurnResult | undefined;
    try {
      // Reserve before awaiting the abort so a new turn cannot start between
      // the expected writer unwinding and the transcript rewrite beginning.
      // Only abort the expected turn; a stale edit must never stop a newer run.
      if (activeRunId) {
        await this.abortTurn({
          sessionKey: input.sessionKey,
          runId: activeRunId,
          reason: "message_replaced",
        });
      }

      result = await this.options.replaceLastTurn(input);
      this.pendingTurnReplacements.set(input.sessionKey, {
        transactionId: result.transactionId,
        replacementTurnId: input.replacementTurnId,
        projectKey: input.projectKey,
        phase: "prepared",
      });
      this.scheduleReplacementTimeout(input.sessionKey);
      // The cached AgentSession and transcript writer still reflect the old tail.
      // Evict them so the replacement submit resumes from the rewritten JSONL.
      await this.router.close(input.sessionKey);
      return result;
    } catch (error) {
      this.clearPendingTurnReplacement(input.sessionKey);
      if (result && this.options.finalizeLastTurnReplacement) {
        await this.options.finalizeLastTurnReplacement({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          transactionId: result.transactionId,
          action: "rollback",
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.transcriptWriteReservations.delete(input.sessionKey);
    }
  }

  private async commitAcceptedTurnReplacement(sessionKey: string, runId: string): Promise<void> {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (
      !pending
      || pending.replacementTurnId !== runId
      || pending.phase !== "submitting"
      || !this.options.finalizeLastTurnReplacement
    ) {
      return;
    }
    pending.phase = "finalizing";
    if (pending.timeout) clearTimeout(pending.timeout);
    try {
      await this.options.finalizeLastTurnReplacement({
        sessionKey,
        projectKey: pending.projectKey,
        transactionId: pending.transactionId,
        action: "commit",
      });
    } catch (error) {
      // accepted_input is already durable. A stale backup is safe to leave for
      // cleanup, but it must not block later turns in the live session.
      console.warn("[pilotdeck] failed to remove accepted replacement backup:", error);
    } finally {
      this.clearPendingTurnReplacement(sessionKey);
    }
  }

  private claimPendingTurnReplacement(
    sessionKey: string,
    runId: string,
  ): "none" | "claimed" | "conflict" {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (!pending) return "none";
    if (pending.replacementTurnId !== runId || pending.phase !== "prepared") {
      return "conflict";
    }
    pending.phase = "submitting";
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    return "claimed";
  }

  private releasePendingTurnReplacementClaim(sessionKey: string, runId: string): void {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (!pending || pending.replacementTurnId !== runId || pending.phase !== "submitting") return;
    pending.phase = "prepared";
    this.scheduleReplacementTimeout(sessionKey);
  }

  private scheduleReplacementTimeout(sessionKey: string): void {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (!pending || pending.phase !== "prepared") return;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      void this.rollbackExpiredTurnReplacement(sessionKey, pending.transactionId);
    }, this.replacementTransactionTimeoutMs);
    pending.timeout.unref?.();
  }

  private clearPendingTurnReplacement(sessionKey: string): void {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (pending?.timeout) clearTimeout(pending.timeout);
    this.pendingTurnReplacements.delete(sessionKey);
  }

  private async rollbackExpiredTurnReplacement(
    sessionKey: string,
    transactionId: string,
  ): Promise<void> {
    const pending = this.pendingTurnReplacements.get(sessionKey);
    if (!pending || pending.transactionId !== transactionId || pending.phase !== "prepared") return;
    if (this.router.hasActiveTurn(sessionKey)) {
      this.scheduleReplacementTimeout(sessionKey);
      return;
    }
    if (!this.options.finalizeLastTurnReplacement) return;

    pending.phase = "finalizing";
    try {
      await this.router.close(sessionKey);
      await this.options.finalizeLastTurnReplacement({
        sessionKey,
        projectKey: pending.projectKey,
        transactionId: pending.transactionId,
        action: "rollback",
      });
      this.clearPendingTurnReplacement(sessionKey);
    } catch (error) {
      pending.phase = "prepared";
      console.warn("[pilotdeck] failed to roll back expired replacement transaction:", error);
      this.scheduleReplacementTimeout(sessionKey);
    }
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    if (!this.options.finalizeLastTurnReplacement) {
      throw new Error(
        "finalize_last_turn_replacement is not configured. Wire `finalizeLastTurnReplacement` via createLocalGateway.",
      );
    }
    const pending = this.pendingTurnReplacements.get(input.sessionKey);
    if (!pending || pending.transactionId !== input.transactionId) {
      throw new DialogGatewayError(
        "replace_transaction_conflict",
        "The replacement transaction is no longer pending.",
      );
    }
    if (pending.phase !== "prepared") {
      throw new DialogGatewayError(
        "replace_transaction_pending",
        "The replacement transaction is already being finalized.",
      );
    }
    pending.phase = "finalizing";
    if (pending.timeout) clearTimeout(pending.timeout);
    try {
      if (input.action === "rollback") {
        if (this.router.hasActiveTurn(input.sessionKey)) {
          throw new DialogGatewayError(
            "replace_transaction_active",
            "The replacement cannot be rolled back while its turn is active.",
          );
        }
        await this.router.close(input.sessionKey);
      }
      const result = await this.options.finalizeLastTurnReplacement(input);
      this.clearPendingTurnReplacement(input.sessionKey);
      return result;
    } catch (error) {
      pending.phase = "prepared";
      this.scheduleReplacementTimeout(input.sessionKey);
      throw error;
    }
  }

  async listProjects(): Promise<WebListProjectsResult> {
    if (!this.options.listProjects) {
      throw new Error("list_projects is not configured.");
    }
    return this.options.listProjects();
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    if (!this.options.describeProject) {
      throw new Error("describe_project is not configured.");
    }
    return this.options.describeProject(input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    if (!this.options.reloadConfig) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadConfig();
  }

  async prepareWeixinLogin(): Promise<PrepareWeixinLoginResult> {
    if (!this.options.prepareWeixinLogin) {
      return {
        requested: false,
        requestedAt: new Date().toISOString(),
        reason: "unsupported",
      };
    }
    return this.options.prepareWeixinLogin();
  }

  async reloadExtensions(input?: import("../protocol/types.js").ReloadExtensionsInput): Promise<import("../protocol/types.js").ReloadExtensionsResult> {
    if (!this.options.reloadExtensions) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadExtensions(input);
  }

  setCronController(cron: GatewayCronController | undefined): void {
    (this.options as { cron?: GatewayCronController }).cron = cron;
  }

  setAlwaysOnApply(handler: InProcessGatewayOptions["alwaysOnApply"]): void {
    (this.options as { alwaysOnApply?: InProcessGatewayOptions["alwaysOnApply"] }).alwaysOnApply = handler;
  }

  setAlwaysOnRerunPlan(handler: InProcessGatewayOptions["alwaysOnRerunPlan"]): void {
    (this.options as { alwaysOnRerunPlan?: InProcessGatewayOptions["alwaysOnRerunPlan"] }).alwaysOnRerunPlan = handler;
  }

  setPrepareWeixinLogin(handler: InProcessGatewayOptions["prepareWeixinLogin"]): void {
    (this.options as { prepareWeixinLogin?: InProcessGatewayOptions["prepareWeixinLogin"] }).prepareWeixinLogin = handler;
  }

  // -------------------------------------------------------------------
  // Skill management — see `SkillManager` for the actual disk ops. The
  // gateway methods just guard "skill manager configured" and translate
  // domain errors into structured failures the WS dispatcher and host
  // bridges can render. `SkillValidationError` is preserved as a special
  // case so the UI can surface the `validation` payload to the user.
  // -------------------------------------------------------------------

  async skillsList(input: SkillsListInput): Promise<SkillsListResult> {
    return this.requireSkills().list(input);
  }

  async skillRead(input: SkillAddressInput): Promise<SkillReadResult> {
    return this.requireSkills().read(input);
  }

  async skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
    return this.requireSkills().write(input);
  }

  async skillCreate(input: SkillCreateInput): Promise<SkillCreateResult> {
    return this.requireSkills().create(input);
  }

  async skillDelete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    return this.requireSkills().delete(input);
  }

  async skillImport(input: SkillImportInput): Promise<SkillImportResult> {
    return this.requireSkills().import(input);
  }

  async skillValidate(input: SkillValidateInput): Promise<SkillValidationResult> {
    return this.requireSkills().validate(input);
  }

  async skillScan(input: SkillScanInput): Promise<SkillScanResult> {
    return this.requireSkills().scan(input);
  }

  private requireSkills(): SkillManager {
    if (!this.options.skillManager) {
      throw new SkillManagerError(
        "not_configured",
        "Skill manager is not configured on this gateway.",
      );
    }
    return this.options.skillManager;
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    if (!this.options.alwaysOnApply) {
      return { sessionKey: "", error: { code: "not_configured", message: "Always-On apply is not configured on this gateway." } };
    }
    return this.options.alwaysOnApply(input);
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    if (!this.options.alwaysOnRerunPlan) {
      return { runId: "", error: { code: "not_configured", message: "Always-On rerun is not configured on this gateway." } };
    }
    return this.options.alwaysOnRerunPlan(input);
  }

  private requireCron(): GatewayCronController {
    if (!this.options.cron) {
      throw new Error("Cron runtime is not configured.");
    }
    return this.options.cron;
  }

  private shouldReplayActiveTurnEvent(sessionKey: string, event: GatewayEvent): boolean {
    if (event.type === "permission_request") {
      return this.permissionBus.hasPending(sessionKey, event.requestId);
    }
    if (event.type === "elicitation_request") {
      return this.elicitationBus.hasPending(sessionKey, event.requestId);
    }
    if (event.type === "user_dialog_request") {
      return this.userDialogBus.hasPending(sessionKey, event.requestId);
    }
    if (event.type === "elicitation_cancelled" || event.type === "user_dialog_cancelled") {
      return false;
    }
    return true;
  }

  private recordActiveTurnEvent(sessionKey: string, event: GatewayEvent): void {
    const replay = this.activeTurnReplays.get(sessionKey);
    if (!replay) return;
    const copy = cloneGatewayEvent(event);
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    replay.events.push(copy);
    replay.bytes += bytes;
    while (
      replay.events.length > ACTIVE_TURN_EVENT_LIMIT ||
      replay.bytes > ACTIVE_TURN_BYTE_LIMIT
    ) {
      const dropped = replay.events.shift();
      if (!dropped) break;
      replay.bytes -= Buffer.byteLength(JSON.stringify(dropped), "utf8");
      replay.truncated = true;
    }
  }

  private withActiveTurnRunId(sessionKey: string, event: GatewayEvent): GatewayEvent {
    if (getGatewayEventRunId(event)) return event;
    const replay = this.activeTurnReplays.get(sessionKey);
    if (!replay) return event;
    return { ...event, runId: replay.runId };
  }
}

function cloneGatewayEvent(event: GatewayEvent): GatewayEvent {
  return JSON.parse(JSON.stringify(event)) as GatewayEvent;
}

function getGatewayEventRunId(event: GatewayEvent): string | undefined {
  return typeof event.runId === "string" && event.runId.trim()
    ? event.runId.trim()
    : undefined;
}

function withGatewayRunId(event: GatewayEvent, runId: string): GatewayEvent {
  if (getGatewayEventRunId(event)) return event;
  return { ...event, runId };
}

function resolveSubmitTurnTelemetry(input: GatewaySubmitTurnInput): {
  ownerModule: TelemetryModule;
  executionKind: TelemetryExecutionKind;
  phase?: string;
} {
  if (input.telemetry?.ownerModule && input.telemetry.executionKind) {
    return {
      ownerModule: input.telemetry.ownerModule,
      executionKind: input.telemetry.executionKind,
      phase: input.telemetry.phase,
    };
  }
  if (String(input.channelKey).startsWith("always-on/")) {
    return {
      ownerModule: "always_on",
      executionKind: "always_on",
      phase: String(input.channelKey).slice("always-on/".length) || input.telemetry?.phase,
    };
  }
  return {
    ownerModule: input.telemetry?.ownerModule ?? "session",
    executionKind: input.telemetry?.executionKind ?? "user_session",
    phase: input.telemetry?.phase,
  };
}

function createGatewayFailureStatus(args: {
  event: string;
  code: string;
  message: string;
  userHint: string;
  detail?: Record<string, unknown>;
}): GatewayRecordAgentStatusMessageInput["status"] {
  return {
    event: args.event,
    kind: "error",
    text: args.message,
    detail: createVisibleErrorStatusDetail({
      message: args.message,
      code: args.code,
      userHint: args.userHint,
      scope: "turn",
      source: "gateway",
      detail: args.detail,
    }),
  };
}

export function normalizeGatewayModeForLegacyInput(value: unknown): GatewaySubmitTurnInput["mode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "default" || value === "plan" || value === "bypassPermissions") {
    return value;
  }
  return undefined;
}

function validateGatewayPermissionModes(input: GatewaySubmitTurnInput): string | undefined {
  const mode = (input as { mode?: unknown }).mode;
  if (mode !== undefined && mode !== null && mode !== ""
    && mode !== "default" && mode !== "plan" && mode !== "bypassPermissions") {
    return `Invalid mode: ${String(mode)}.`;
  }
  const baseMode = (input as { basePermissionMode?: unknown }).basePermissionMode;
  if (baseMode !== undefined && baseMode !== null && baseMode !== ""
    && baseMode !== "default" && baseMode !== "bypassPermissions") {
    return `Invalid basePermissionMode: ${String(baseMode)}.`;
  }
  return undefined;
}

function validateGatewayMaxBudget(input: GatewaySubmitTurnInput): string | undefined {
  const value = input.maxBudgetUsd;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "maxBudgetUsd must be a positive finite number.";
  }
  return undefined;
}

function validateThinkingConfig(
  thinking: import("../protocol/types.js").GatewayThinkingConfig | null,
): void {
  if (thinking === null) return;
  if (!thinking || typeof thinking !== "object" || typeof thinking.enabled !== "boolean") {
    throw new DialogGatewayError("INVALID_THINKING_CONFIG", "thinking must be null or an object with an enabled boolean.");
  }
  const modes = new Set(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (thinking.mode !== undefined && !modes.has(thinking.mode)) {
    throw new DialogGatewayError("INVALID_THINKING_CONFIG", `Unsupported thinking mode: ${String(thinking.mode)}.`);
  }
  if (thinking.budgetTokens !== undefined
    && (!Number.isInteger(thinking.budgetTokens) || thinking.budgetTokens < 0)) {
    throw new DialogGatewayError("INVALID_THINKING_CONFIG", "budgetTokens must be a non-negative integer.");
  }
}

function validateSdkFlagSettings(settings: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(settings)) {
    if (key === "effortLevel") {
      if (value !== null && value !== "low" && value !== "medium" && value !== "high") {
        throw new DialogGatewayError("INVALID_FLAG_SETTINGS", "effortLevel must be low, medium, high, or null.");
      }
      continue;
    }
    if (key === "permissions") {
      if (value === null) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DialogGatewayError("INVALID_FLAG_SETTINGS", "permissions must be an object or null.");
      }
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [permissionKey, permissionValue] of entries) {
        if (permissionKey !== "defaultMode") {
          throw new DialogGatewayError("UNSUPPORTED_FLAG_SETTING", `permissions.${permissionKey} has no PilotDeck session equivalent.`);
        }
        if (permissionValue !== null
          && permissionValue !== "default"
          && permissionValue !== "plan"
          && permissionValue !== "bypassPermissions") {
          throw new DialogGatewayError("UNSUPPORTED_FLAG_SETTING", `permissions.defaultMode=${String(permissionValue)} is not supported.`);
        }
      }
      continue;
    }
    throw new DialogGatewayError("UNSUPPORTED_FLAG_SETTING", `${key} has no PilotDeck session equivalent.`);
  }
}

function validateSdkSessionConfig(config: GatewaySessionSdkConfig): void {
  if (!config || typeof config !== "object") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "sdkSessionConfig must be an object.");
  }
  if (config.systemPrompt !== undefined && typeof config.systemPrompt !== "string") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "systemPrompt must be a string.");
  }
  if (config.persistSession !== undefined && config.persistSession !== false) {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "persistSession must be false when specified.");
  }
  if (config.appendSystemPrompt !== undefined && typeof config.appendSystemPrompt !== "string") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "appendSystemPrompt must be a string.");
  }
  if (config.planModeInstructions !== undefined && typeof config.planModeInstructions !== "string") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "planModeInstructions must be a string.");
  }
  if (config.outputStyle !== undefined
    && (typeof config.outputStyle !== "string" || !config.outputStyle.trim())) {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "outputStyle must be a non-empty string.");
  }
  if (config.permissionMode !== undefined
    && config.permissionMode !== "acceptEdits" && config.permissionMode !== "dontAsk") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "permissionMode must be acceptEdits or dontAsk.");
  }
  if (config.managedPermissions !== undefined) {
    const managed = config.managedPermissions;
    if (!managed || typeof managed !== "object" || Array.isArray(managed)
      || Object.keys(managed as Record<string, unknown>).some((key) =>
        key !== "deny" && key !== "ask" && key !== "defaultMode" && key !== "canPrompt",
      )
      || !Array.isArray(managed.deny)
      || !Array.isArray(managed.ask)
      || managed.deny.some((entry) => typeof entry !== "string" || !entry.trim())
      || managed.ask.some((entry) => typeof entry !== "string" || !entry.trim())
      || (managed.defaultMode !== undefined && managed.defaultMode !== "plan")
      || (managed.canPrompt !== undefined && managed.canPrompt !== false)) {
      throw new DialogGatewayError(
        "UNSUPPORTED_SDK_MANAGED_SETTING",
        "managedPermissions may contain deny/ask entries, defaultMode=plan, and canPrompt=false only.",
      );
    }
  }
  if (config.includeHookEvents !== undefined && typeof config.includeHookEvents !== "boolean") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "includeHookEvents must be a boolean.");
  }
  if (config.agentProgressSummaries !== undefined && typeof config.agentProgressSummaries !== "boolean") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "agentProgressSummaries must be a boolean.");
  }
  if (config.forwardSubagentText !== undefined && typeof config.forwardSubagentText !== "boolean") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "forwardSubagentText must be a boolean.");
  }
  if (config.sandbox !== undefined
    && (!config.sandbox || typeof config.sandbox !== "object" || Array.isArray(config.sandbox)
      || Object.keys(config.sandbox as Record<string, unknown>).some((key) => key !== "type" && key !== "profile" && key !== "toolIsolation" && key !== "filesystem" && key !== "network" && key !== "process")
      || (config.sandbox.type !== undefined && config.sandbox.type !== "tool_policy" && config.sandbox.type !== "host")
      || (config.sandbox.type === "host" && (typeof config.sandbox.profile !== "string" || !config.sandbox.profile.trim()))
      || (config.sandbox.type !== "host" && "profile" in config.sandbox && config.sandbox.profile !== undefined)
      || (config.sandbox.type !== "host" && "toolIsolation" in config.sandbox && config.sandbox.toolIsolation !== undefined)
      || (config.sandbox.type === "host"
        && config.sandbox.toolIsolation !== undefined
        && config.sandbox.toolIsolation !== "strict")
      || (config.sandbox.filesystem !== undefined
        && config.sandbox.filesystem !== "read_only"
        && config.sandbox.filesystem !== "deny")
      || (config.sandbox.network !== undefined && config.sandbox.network !== "deny")
      || (config.sandbox.process !== undefined && config.sandbox.process !== "deny")
      || (config.sandbox.type !== "host"
        && config.sandbox.filesystem === undefined
        && config.sandbox.network === undefined
        && config.sandbox.process === undefined))) {
    throw new DialogGatewayError(
      "INVALID_SDK_SESSION_CONFIG",
      "sandbox must be tool_policy restrictions or a named host profile with optional restrictions.",
    );
  }
  if (config.userDialogKinds !== undefined
    && (!Array.isArray(config.userDialogKinds)
      || config.userDialogKinds.length === 0
      || config.userDialogKinds.some((kind) => kind !== "input" && kind !== "select" && kind !== "confirm" && kind !== "form")
      || new Set(config.userDialogKinds).size !== config.userDialogKinds.length)) {
    throw new DialogGatewayError(
      "INVALID_SDK_SESSION_CONFIG",
      "userDialogKinds must be a non-empty unique array containing only input, select, confirm, or form.",
    );
  }
  if (config.taskBudget !== undefined
    && (typeof config.taskBudget !== "object" || config.taskBudget === null
      || !Number.isFinite(config.taskBudget.total) || config.taskBudget.total <= 0)) {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "taskBudget.total must be a positive finite USD amount.");
  }
  if (config.taskBudget?.scope !== undefined
    && config.taskBudget.scope !== "session" && config.taskBudget.scope !== "project") {
    throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "taskBudget.scope must be session or project when provided.");
  }
  if (config.taskBudget?.projectRetentionMs !== undefined
    && (!Number.isSafeInteger(config.taskBudget.projectRetentionMs) || config.taskBudget.projectRetentionMs <= 0)) {
    throw new DialogGatewayError(
      "INVALID_SDK_SESSION_CONFIG",
      "taskBudget.projectRetentionMs must be a positive safe integer in milliseconds.",
    );
  }
  if (config.taskBudget?.projectRetentionMs !== undefined && config.taskBudget.scope !== "project") {
    throw new DialogGatewayError(
      "INVALID_SDK_SESSION_CONFIG",
      "taskBudget.projectRetentionMs requires taskBudget.scope to be project.",
    );
  }
  if (config.settings !== undefined) {
    if (!config.settings || typeof config.settings !== "object" || Array.isArray(config.settings)) {
      throw new DialogGatewayError("INVALID_SDK_SETTINGS", "settings must be an object.");
    }
    if (Object.keys(config.settings).some((key) => key !== "agent")) {
      throw new DialogGatewayError("UNSUPPORTED_SDK_SETTING", "Only settings.agent is supported by the SDK session overlay.");
    }
    const agent = config.settings.agent;
    if (agent !== undefined) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)
        || Object.keys(agent).some((key) => key !== "model" && key !== "fallbackModel" && key !== "maxContextTokens" && key !== "maxOutputTokens" && key !== "thinking" && key !== "subagents")) {
        throw new DialogGatewayError("INVALID_SDK_SETTINGS", "settings.agent contains unsupported fields.");
      }
      if (agent.model !== undefined && agent.model !== null
        && (typeof agent.model !== "string" || !agent.model.trim())) {
        throw new DialogGatewayError("INVALID_SDK_SETTINGS", "settings.agent.model must be a non-empty model id or null.");
      }
      if (agent.fallbackModel !== undefined && agent.fallbackModel !== null
        && (typeof agent.fallbackModel !== "string" || !agent.fallbackModel.trim())) {
        throw new DialogGatewayError("INVALID_SDK_SETTINGS", "settings.agent.fallbackModel must be a non-empty model id or null.");
      }
      for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
        const value = agent[key];
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
          throw new DialogGatewayError("INVALID_SDK_SETTINGS", `settings.agent.${key} must be a positive integer.`);
        }
      }
      if (agent.thinking !== undefined) {
        if (!agent.thinking || typeof agent.thinking !== "object" || Array.isArray(agent.thinking)
          || typeof agent.thinking.enabled !== "boolean"
          || Object.keys(agent.thinking).some((key) => key !== "enabled" && key !== "budgetTokens")
          || (agent.thinking.budgetTokens !== undefined
            && (!Number.isInteger(agent.thinking.budgetTokens) || agent.thinking.budgetTokens < 0))) {
          throw new DialogGatewayError(
            "INVALID_SDK_SETTINGS",
            "settings.agent.thinking must contain enabled and an optional non-negative integer budgetTokens.",
          );
        }
      }
      if (agent.subagents !== undefined && (
        !agent.subagents || typeof agent.subagents !== "object" || Array.isArray(agent.subagents)
        || Object.keys(agent.subagents).some((key) => key !== "default" && key !== "timeoutMs" && key !== "maxDepth")
        || (agent.subagents.default !== undefined && agent.subagents.default !== null
          && (typeof agent.subagents.default !== "string" || !agent.subagents.default.trim()))
        || (agent.subagents.timeoutMs !== undefined
          && (!Number.isInteger(agent.subagents.timeoutMs) || agent.subagents.timeoutMs <= 0))
        || (agent.subagents.maxDepth !== undefined
          && (!Number.isSafeInteger(agent.subagents.maxDepth) || agent.subagents.maxDepth < 0))
      )) {
        throw new DialogGatewayError(
          "INVALID_SDK_SETTINGS",
          "settings.agent.subagents supports a non-empty default model id, positive integer timeoutMs, and non-negative safe integer maxDepth.",
        );
      }
    }
  }
  if (config.settingSources !== undefined
    && (!Array.isArray(config.settingSources)
      || config.settingSources.length === 0
      || config.settingSources.some((source) => source !== "managed" && source !== "user" && source !== "project" && source !== "local")
      || new Set(config.settingSources).size !== config.settingSources.length)) {
    throw new DialogGatewayError(
      "INVALID_SDK_SETTING_SOURCES",
      "settingSources must be a non-empty unique array containing only managed, user, project, or local.",
    );
  }
  if (config.additionalWorkingDirectories !== undefined) {
    if (!Array.isArray(config.additionalWorkingDirectories)
      || config.additionalWorkingDirectories.some((path) => typeof path !== "string" || !isAbsolute(path))) {
      throw new DialogGatewayError(
        "INVALID_SDK_SESSION_CONFIG",
        "additionalWorkingDirectories must contain absolute paths.",
      );
    }
  }
  if (config.toolAliases !== undefined) {
    if (typeof config.toolAliases !== "object" || Array.isArray(config.toolAliases)
      || Object.entries(config.toolAliases).some(([from, to]) => !from.trim() || typeof to !== "string" || !to.trim())) {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "toolAliases must be a non-empty string-to-string map.");
    }
  }
  if (config.outputFormat !== undefined) {
    if (config.outputFormat.type !== "json_schema" || !isSdkJsonSchema(config.outputFormat.schema)) {
      throw new DialogGatewayError(
        "INVALID_SDK_SESSION_CONFIG",
        "outputFormat must be a json_schema object using PilotDeck's JSON-schema subset.",
      );
    }
  }
  if (config.agents !== undefined) {
    if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "agents must be an object.");
    }
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!name.trim() || !agent || typeof agent !== "object" || Array.isArray(agent)
        || !agent.description?.trim() || !agent.prompt?.trim()
        || (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model.trim()))
        || (agent.tools !== undefined && (!Array.isArray(agent.tools) || agent.tools.some((tool) => !tool.trim())))
        || (agent.disallowedTools !== undefined && (!Array.isArray(agent.disallowedTools) || agent.disallowedTools.some((tool) => !tool.trim())))
        || (agent.maxTurns !== undefined && (!Number.isInteger(agent.maxTurns) || agent.maxTurns <= 0))
        || (agent.background !== undefined && typeof agent.background !== "boolean")
        || (agent.observer !== undefined && (typeof agent.observer !== "string" || !agent.observer.trim()))
        || (agent.observerMessage !== undefined && typeof agent.observerMessage !== "string")
        || (agent.observerMessage?.trim() && !agent.observer)
        || (agent.effort !== undefined && !["low", "medium", "high"].includes(agent.effort))
        || (agent.permissionMode !== undefined && !["default", "plan", "bypassPermissions"].includes(agent.permissionMode))) {
        throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", `Agent ${name || "<unnamed>"} is invalid.`);
      }
    }
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!agent.observer) continue;
      if (agent.observer === name || !config.agents[agent.observer]) {
        throw new DialogGatewayError(
          "INVALID_SDK_SESSION_CONFIG",
          `Agent ${name} observer must reference a distinct configured AgentDefinition.`,
        );
      }
    }
  }
  if (config.skills !== undefined && config.skills !== "all") {
    if (!Array.isArray(config.skills)
      || config.skills.length === 0
      || config.skills.some((skill) => typeof skill !== "string" || !skill.trim())
      || new Set(config.skills).size !== config.skills.length) {
      throw new DialogGatewayError(
        "INVALID_SDK_SESSION_CONFIG",
        "skills must be all or a non-empty array of unique skill names.",
      );
    }
  }
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)
      || config.plugins.length === 0
      || config.plugins.some((plugin) => !plugin || plugin.type !== "local"
        || typeof plugin.path !== "string" || !plugin.path.trim() || !isAbsolute(plugin.path))
      || new Set(config.plugins.map((plugin) => plugin.path)).size !== config.plugins.length) {
      throw new DialogGatewayError(
        "INVALID_SDK_SESSION_CONFIG",
        "plugins must be a non-empty array of distinct absolute Gateway-local plugin paths.",
      );
    }
  }
  if (config.hooks !== undefined) {
    if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "hooks must be an object.");
    }
    let url: URL;
    try {
      url = new URL(config.hooks.url);
    } catch {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "hooks.url must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "hooks.url must use http: or https:.");
    }
    if (config.hooks.headers !== undefined
      && (typeof config.hooks.headers !== "object" || Array.isArray(config.hooks.headers)
        || Object.entries(config.hooks.headers).some(([name, value]) => !name.trim() || typeof value !== "string"))) {
      throw new DialogGatewayError("INVALID_SDK_SESSION_CONFIG", "hooks.headers must be a string-to-string map.");
    }
    if (!config.hooks.events || typeof config.hooks.events !== "object" || Array.isArray(config.hooks.events)
      || Object.entries(config.hooks.events).some(([event, matchers]) => !isPilotDeckHookEvent(event)
        || !Array.isArray(matchers)
        || matchers.some((matcher) => !matcher || typeof matcher !== "object" || Array.isArray(matcher)
          || (matcher.matcher !== undefined && typeof matcher.matcher !== "string")
          || (matcher.timeout !== undefined && (!Number.isFinite(matcher.timeout) || matcher.timeout <= 0))))) {
      throw new DialogGatewayError(
        "INVALID_SDK_SESSION_CONFIG",
        "hooks.events must map event names to matcher objects with optional string matcher and positive timeout.",
      );
    }
  }
}

function isSdkJsonSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined
    && typeof schema.type !== "string"
    && (!Array.isArray(schema.type) || schema.type.some((item) => typeof item !== "string"))) return false;
  if (schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false;
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return false;
    if (!Object.values(schema.properties as Record<string, unknown>).every(isSdkJsonSchema)) return false;
  }
  if (schema.items !== undefined && !isSdkJsonSchema(schema.items)) return false;
  return true;
}

function deferredHookContext(output: unknown, expectedEvent: string): string {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new DialogGatewayError("INVALID_ASYNC_HOOK_RESULT", "Deferred hook output must be an object.");
  }
  const record = output as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "hookSpecificOutput")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_ASYNC_HOOK_EFFECT",
      "Deferred hook results may only supply hookSpecificOutput.additionalContext.",
    );
  }
  if (record.hookSpecificOutput === undefined) return "";
  if (!record.hookSpecificOutput || typeof record.hookSpecificOutput !== "object" || Array.isArray(record.hookSpecificOutput)) {
    throw new DialogGatewayError("INVALID_ASYNC_HOOK_RESULT", "hookSpecificOutput must be an object.");
  }
  const specific = record.hookSpecificOutput as Record<string, unknown>;
  if (Object.keys(specific).some((key) => key !== "hookEventName" && key !== "additionalContext")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_ASYNC_HOOK_EFFECT",
      "Deferred hook results may only supply hookEventName and additionalContext.",
    );
  }
  if (specific.hookEventName !== expectedEvent) {
    throw new DialogGatewayError(
      "INVALID_ASYNC_HOOK_RESULT",
      `Deferred hook result belongs to ${String(specific.hookEventName)}, expected ${expectedEvent}.`,
    );
  }
  if (specific.additionalContext === undefined) return "";
  if (typeof specific.additionalContext !== "string") {
    throw new DialogGatewayError("INVALID_ASYNC_HOOK_RESULT", "Deferred hook additionalContext must be a string.");
  }
  return `<async_hook_context event="${expectedEvent}">\n${specific.additionalContext}\n</async_hook_context>`;
}

function reasoningValueToMode(value: number): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const modes = new Map<number, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">([
    [0, "off"], [0.2, "minimal"], [0.4, "low"], [0.6, "medium"], [0.8, "high"], [0.9, "xhigh"], [1, "max"],
  ]);
  const mode = modes.get(value);
  if (!mode) throw new DialogGatewayError("UNSUPPORTED_MODEL_PARAMETER", `Unsupported reasoning value: ${value}`);
  return mode;
}

export function normalizeGatewayRunMode(value: unknown): GatewaySubmitTurnInput["runMode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "agent" || value === "plan" || value === "ask") {
    return value;
  }
  return "agent";
}

function emitSessionTelemetry(
  telemetry: TelemetryClient | undefined,
  event: AgentEvent,
  context: {
    sessionId: string;
    runId: string;
    channelKey: string;
    permissionMode: string;
    ownerModule: TelemetryModule;
    executionKind: TelemetryExecutionKind;
    phase?: string;
  },
): void {
  if (!telemetry) return;
  switch (event.type) {
    case "model_request_started":
      return;
    case "model_event":
      if (event.event.type === "request_started") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_request",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            provider: event.event.provider,
            model: event.event.model,
            ...(event.event.providerBaseUrl
              ? { providerBaseUrl: event.event.providerBaseUrl }
              : {}),
            permissionMode: context.permissionMode,
            channelKey: context.channelKey,
          },
        });
        return;
      }
      if (event.event.type === "message_end") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_response",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: { runId: context.runId },
        });
      }
      if (event.event.type === "error") {
        telemetry.trackError(event.event.error, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "model_request",
          errorCategory: "model_request_error",
          sessionId: context.sessionId,
          code: event.event.error.code,
          metadata: {
            runId: context.runId,
            provider: event.event.error.provider,
          },
        });
      }
      return;
    case "tool_calls_detected":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_prepare",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolCount: event.calls.length,
          toolNames: event.calls.map((call) => call.name),
        },
      });
      return;
    case "pre_tool_execute":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_call",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        },
      });
      return;
    case "post_tool_execute":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "tool_call",
        outcome: event.success ? "success" : "failed",
        errorCategory: event.success ? undefined : "tool_runtime_error",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          success: event.success,
        },
      });
      return;
    case "tool_result":
      if (event.result.type === "error") {
        const code = event.result.error.code;
        telemetry.trackError(event.result.error.message, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: context.executionKind,
          phase: context.phase,
          loopStage: "tool_call",
          errorCategory: inferToolErrorCategory(code),
          sessionId: context.sessionId,
          code,
          toolName: event.result.toolName,
          metadata: {
            runId: context.runId,
            toolName: event.result.toolName,
            toolCallId: event.result.toolCallId,
          },
        });
      }
      return;
    case "permission_requested":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "permission_check",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        },
      });
      return;
    case "permission_denied":
      telemetry.trackError(event.reason, {
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "permission_check",
        errorCategory: "permission_error",
        sessionId: context.sessionId,
        code: "permission_denied",
        toolName: event.toolName,
        metadata: {
          runId: context.runId,
          toolName: event.toolName,
        },
      });
      return;
    case "turn_completed":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          stopReason: event.result.stopReason,
          turns: event.result.turns,
        },
      });
      return;
    case "turn_failed":
      telemetry.trackError(event.error, {
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        errorCategory: "loop_error",
        sessionId: context.sessionId,
        code: event.error.code,
        metadata: {
          runId: context.runId,
        },
      });
      return;
    case "session_aborted":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: context.executionKind,
        phase: context.phase,
        loopStage: "loop_end",
        outcome: "aborted",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          reason: event.reason,
        },
      });
      return;
    case "subagent_model_event":
      if (event.event.type === "request_started") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_request",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            provider: event.event.provider,
            model: event.event.model,
            ...(event.event.providerBaseUrl ? { providerBaseUrl: event.event.providerBaseUrl } : {}),
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      if (event.event.type === "message_end") {
        telemetry.trackFeatureLoopStage({
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_response",
          outcome: "success",
          sessionId: context.sessionId,
          metadata: {
            runId: context.runId,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      if (event.event.type === "error") {
        telemetry.trackError(event.event.error, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "model_request",
          errorCategory: "model_request_error",
          sessionId: context.sessionId,
          code: event.event.error.code,
          metadata: {
            runId: context.runId,
            provider: event.event.error.provider,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
          },
        });
      }
      return;
    case "subagent_tool_calls_detected":
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: "subagent",
        phase: context.phase,
        loopStage: "tool_prepare",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCount: event.calls.length,
          toolNames: event.calls.map((call) => call.name),
        },
      });
      return;
    case "subagent_tool_result":
      if (event.result.type === "error") {
        telemetry.trackError(event.result.error.message, {
          module: "session",
          ownerModule: context.ownerModule,
          executionKind: "subagent",
          phase: context.phase,
          loopStage: "tool_call",
          errorCategory: inferToolErrorCategory(event.result.error.code),
          sessionId: context.sessionId,
          code: event.result.error.code,
          toolName: event.result.toolName,
          metadata: {
            runId: context.runId,
            subagentId: event.subagentId,
            subagentType: event.subagentType,
            toolName: event.result.toolName,
            toolCallId: event.result.toolCallId,
          },
        });
        return;
      }
      telemetry.trackFeatureLoopStage({
        module: "session",
        ownerModule: context.ownerModule,
        executionKind: "subagent",
        phase: context.phase,
        loopStage: "tool_call",
        outcome: "success",
        sessionId: context.sessionId,
        metadata: {
          runId: context.runId,
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolName: event.result.toolName,
          toolCallId: event.result.toolCallId,
        },
      });
      return;
    default:
      return;
  }
}

function inferToolErrorCategory(code: string | undefined):
  | "tool_param_error"
  | "tool_runtime_error"
  | "tool_result_parse_error" {
  if (!code) return "tool_runtime_error";
  if (/(invalid|argument|param|schema)/i.test(code)) return "tool_param_error";
  if (/(parse|json|decode|format)/i.test(code)) return "tool_result_parse_error";
  return "tool_runtime_error";
}

export function mapAgentEvent(
  event: AgentEvent,
  runId: string,
  options: { forwardSubagentText?: boolean } = {},
): GatewayEvent[] {
  return mapAgentEventForTurn(event, runId, options).map((gatewayEvent) =>
    withGatewayRunId(gatewayEvent, runId)
  );
}

function mapAgentEventForTurn(
  event: AgentEvent,
  runId: string,
  options: { forwardSubagentText?: boolean },
): GatewayEvent[] {
  switch (event.type) {
    case "turn_started":
      return [{ type: "turn_started", runId }];
    case "input_accepted":
      return [{ type: "input_accepted", runId }];
    case "steer_applied":
      return [{ type: "steer_applied", itemId: event.itemId, message: event.message }];
    case "steer_unapplied":
      return [{ type: "steer_unapplied", itemId: event.itemId, reason: event.reason }];
    case "model_request_started":
      return [{ type: "model_request_started", model: event.model, provider: event.provider }];
    case "model_event":
      return mapModelEvent(event.event, runId);
    case "prompt_suggestion":
      return [{ type: "prompt_suggestion", suggestion: event.suggestion }];
    case "tool_calls_detected":
      return event.calls.map((call) => ({
        type: "tool_call_started",
        toolCallId: call.id,
        name: call.name,
        argsPreview: previewUnknown(call.input),
      }));
    case "tool_progress":
      return [{
        type: "tool_progress",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        message: event.message,
        ...(event.metadata ? { metadata: event.metadata } : {}),
        createdAt: event.createdAt,
      }];
    case "tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      const lineCount = lines.length;
      const totalBytes = Buffer.byteLength(fullText, "utf-8");

      const PERSIST_THRESHOLD = 4096;
      let resultPath: string | undefined;
      if (totalBytes > PERSIST_THRESHOLD) {
        const dir = resolve(
          tmpdir(),
          "pilotdeck-tool-results",
          safeGatewayPathPart(event.sessionId),
          safeGatewayPathPart(event.turnId),
        );
        resultPath = resolve(dir, `${safeGatewayPathPart(event.result.toolCallId)}.txt`);
        void (async () => {
          try {
            await mkdir(dir, { recursive: true });
            await writeFile(resultPath!, fullText, { mode: 0o600 });
          } catch { /* best-effort persistence */ }
        })();
      }

      // Surface inline image blocks (e.g. read_file on a PNG) so hosts can
      // render them next to the tool row. Without this the picture only
      // appears on session reload via the persisted canonical message — and
      // it ends up in the "user" bubble because the wire role for tool
      // results is `user`. See `projectToolResults`.
      const images = event.result.content.flatMap((item) =>
        item.type === "image"
          ? [{
              mimeType: item.mimeType,
              data: item.data,
              ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
              ...(item.detail ? { detail: item.detail } : {}),
            }]
          : [],
      );
      const attachments = event.result.content.flatMap((item): GatewayEvent[] => {
        if (item.type === "image" && event.result.toolName !== "read_file") {
          return [{
            type: "assistant_attachment",
            attachment: {
              type: "image",
              mimeType: item.mimeType,
              content: item.data,
              bytes: item.bytes,
              name: `${safeGatewayPathPart(event.result.toolName)}-${safeGatewayPathPart(event.result.toolCallId)}.${extensionForMime(item.mimeType)}`,
              source: "tool_result",
              metadata: { toolCallId: event.result.toolCallId, toolName: event.result.toolName },
            },
          }];
        }
        if (item.type === "file") {
          return [{
            type: "assistant_attachment",
            attachment: {
              type: "file",
              path: item.path,
              mimeType: item.mimeType,
              name: item.path.split(/[\\/]/).pop(),
              source: "tool_result",
              metadata: { toolCallId: event.result.toolCallId, toolName: event.result.toolName, description: item.description },
            },
          }];
        }
        return [];
      });

      return [
        {
          type: "tool_call_finished",
          toolCallId: event.result.toolCallId,
          ok: event.result.type === "success",
          resultPreview,
          resultLineCount: lineCount,
          resultBytes: totalBytes,
          toolName: event.result.toolName,
          resultPath,
          ...(images.length > 0 ? { images } : {}),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
          ...(event.result.type === "success" && event.result.data
            ? { data: sanitizeGatewayToolData(event.result.data) }
            : {}),
        },
        ...attachments,
      ];
    }
    case "file_artifacts":
      return [{ type: "file_artifacts", artifacts: event.artifacts }];
    case "mode_change_requested":
      return [{ type: "plan_mode_changed", mode: event.mode }];
    case "turn_completed":
      return mapTurnCompleted(event.result);
    case "turn_failed":
      return [
        {
          type: "error",
          code: event.error.code,
          message: event.error.message,
          recoverable: false,
          userHint: event.error.userHint,
          providerError: providerErrorFromAgentError(event.error),
        },
      ];
    case "token_cap_adjusted":
      return [{
        type: "agent_status",
        event: "token_cap_adjusted",
        detail: {
          provider: event.provider,
          model: event.model,
          cap: event.cap,
          previous: event.previous,
          next: event.next,
          reason: event.reason,
        },
      }];
    case "empty_output_recovery":
      return [{
        type: "agent_status",
        event: "empty_output_recovery",
        detail: {
          provider: event.provider,
          model: event.model,
          finishReason: event.finishReason,
          previousMaxOutputTokens: event.previousMaxOutputTokens,
          nextMaxOutputTokens: event.nextMaxOutputTokens,
        },
      }];
    case "model_recovery_failed":
      return [{
        type: "agent_status",
        event: "model_recovery_failed",
        detail: {
          provider: event.provider,
          model: event.model,
          code: event.error.code,
          message: event.error.message,
          providerError: providerErrorFromModelError(event.error),
        },
      }];
    case "session_aborted":
      return [
        {
          type: "error",
          code: "agent_aborted",
          message: event.reason ?? "Session aborted.",
          recoverable: true,
        },
      ];
    case "tool_results_projected": {
      const events: GatewayEvent[] = [];
      for (const block of event.message.content) {
        if (block.type === "tool_result_reference") {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
        } else if (block.type === "media_reference" && block.toolCallId) {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
          if (block.reason === "media_result_too_large") continue;
          events.push({
            type: "assistant_attachment",
            attachment: {
              type: block.mediaType === "image" ? "image" : "file",
              path: block.path,
              mimeType: block.mimeType,
              bytes: block.originalBytes,
              name: block.path.split(/[\\/]/).pop(),
              source: "media_reference",
              metadata: { toolCallId: block.toolCallId, reason: block.reason },
            },
          });
        } else if (block.type === "tool_result") {
          const projFullText = flattenToolResultBlockText(block);
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            fullText: projFullText,
          });
        }
      }
      return events;
    }
    case "compact_started":
      return [{
        type: "agent_status",
        event: "compact_started",
        detail: {
          compactionId: event.compactionId,
          trigger: event.trigger,
          preTokens: event.preTokens,
        },
      }];
    case "compact_completed":
      return [{
        type: "agent_status",
        event: "compact_completed",
        detail: {
          compactionId: event.compactionId,
          trigger: event.trigger,
          status: event.status,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          messagesSummarized: event.messagesSummarized,
        },
      }];
    case "context_budget":
      const reservedOutputTokens = event.snapshot.reservedOutputTokens ?? event.snapshot.maxOutputTokens ?? 0;
      const totalContextTokens = event.snapshot.effectiveContextTokens !== undefined
        ? event.snapshot.totalContextTokens ?? event.snapshot.effectiveContextTokens + reservedOutputTokens
        : event.snapshot.totalContextTokens ?? event.snapshot.maxContextTokens + reservedOutputTokens;
      return [{
        type: "context_budget",
        used: event.snapshot.tokens,
        // Preserve the legacy Gateway meaning of `displayUsed` (the budget
        // token value); expose the newer displayTokens field separately.
        displayUsed: event.snapshot.tokens,
        ...(event.snapshot.localEstimateTokens !== undefined ? { localEstimateTokens: event.snapshot.localEstimateTokens } : {}),
        ...(event.snapshot.displayTokens !== undefined ? { displayTokens: event.snapshot.displayTokens } : {}),
        ...(event.snapshot.estimateSource !== undefined ? { estimateSource: event.snapshot.estimateSource } : {}),
        ...(event.snapshot.usageTokens !== undefined ? { usageTokens: event.snapshot.usageTokens } : {}),
        ...(event.snapshot.calibrationActualInputTokens !== undefined ? { calibrationActualInputTokens: event.snapshot.calibrationActualInputTokens } : {}),
        ...(event.snapshot.calibrationEstimatedInputTokens !== undefined ? { calibrationEstimatedInputTokens: event.snapshot.calibrationEstimatedInputTokens } : {}),
        total: totalContextTokens,
        ...(event.snapshot.totalContextTokens !== undefined ? { totalContextTokens: event.snapshot.totalContextTokens } : {}),
        maxContextTokens: event.snapshot.maxContextTokens,
        effectiveTotal: event.snapshot.effectiveContextTokens ?? event.snapshot.maxContextTokens,
        ...(event.snapshot.effectiveContextTokens !== undefined ? { effectiveContextTokens: event.snapshot.effectiveContextTokens } : {}),
        ...(event.snapshot.maxOutputTokens !== undefined ? { maxOutputTokens: event.snapshot.maxOutputTokens } : {}),
        reservedOutputTokens,
        warningRatio: event.snapshot.warningRatio,
        blockingRatio: event.snapshot.blockingRatio,
        ratio: event.snapshot.ratio,
        state: event.snapshot.state,
        ...(event.snapshot.source !== undefined ? { source: event.snapshot.source } : {}),
        ...(event.snapshot.exact !== undefined ? { exact: event.snapshot.exact } : {}),
        ...(event.snapshot.estimatorError !== undefined ? { estimatorError: event.snapshot.estimatorError } : {}),
        ...(event.snapshot.breakdown !== undefined ? { breakdown: event.snapshot.breakdown } : {}),
      }];
    case "warning":
      return [{
        type: "agent_status",
        event: "warning",
        detail: { code: event.code, message: event.message, metadata: event.metadata },
      }];
    case "agent_status":
      return [{
        type: "agent_status",
        event: event.event,
        detail: event.detail,
      }];
    case "turn_continued":
      return [{
        type: "agent_status",
        event: "turn_continued",
        detail: { reason: event.reason },
      }];
    case "subagent_started":
      return [{
        type: "agent_status",
        event: "subagent_started",
        detail: { subagentId: event.subagentId, subagentType: event.subagentType, toolCallId: event.toolCallId },
      }];
    case "subagent_completed":
      return [{
        type: "agent_status",
        event: "subagent_completed",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          success: event.success,
          ...(event.aborted ? { aborted: true } : {}),
          durationMs: event.durationMs,
        },
      }];
    case "observer_report":
      return [{
        type: "agent_status",
        event: "observer_report",
        detail: {
          observedSubagentId: event.observedSubagentId,
          observedSubagentType: event.observedSubagentType,
          observerSubagentId: event.observerSubagentId,
          observerSubagentType: event.observerSubagentType,
          success: event.success,
          ...(event.report ? { report: limitGatewayToolResultPreview(event.report) } : {}),
          ...(event.error ? { error: limitGatewayToolResultPreview(event.error) } : {}),
          durationMs: event.durationMs,
        },
      }];
    case "subagent_model_event":
      return mapSubagentModelEvent(event, options);
    case "subagent_tool_calls_detected":
      return event.calls.map((call) => ({
        type: "agent_status",
        event: "subagent_tool_call_started",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        },
      }));
    case "subagent_tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      return [{
        type: "agent_status",
        event: "subagent_tool_result",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: event.result.toolCallId,
          toolName: event.result.toolName,
          ok: event.result.type === "success",
          content: resultPreview,
          preview: limitGatewayToolResultPreview(lines.slice(0, 3).join("\n")),
          resultLineCount: lines.length,
          resultBytes: Buffer.byteLength(fullText, "utf-8"),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
        },
      }];
    }
    case "subagent_status":
      return [{
        type: "agent_status",
        event: "subagent_status",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          status: event.status,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          success: event.success,
          durationMs: event.durationMs,
        },
      }];
    case "retry_progress":
      return [{
        type: "agent_status",
        event: "retry_progress",
        detail: {
          attempt: event.detail.attempt,
          maxAttempts: event.detail.maxAttempts,
          delayMs: event.detail.delayMs,
          reason: event.detail.reason,
          provider: event.detail.provider,
          model: event.detail.model,
        },
      }];
    case "session_ended":
    case "user_prompt_submitted":
    case "setup_completed":
    case "instructions_loaded":
    case "stop_requested":
    case "stop_failure":
    case "elicitation_resolved":
      return [];
    case "pre_tool_execute":
      return [];
    case "post_tool_execute":
      return [];
    case "permission_requested":
      return [];
    case "permission_denied":
      return [{
        type: "permission_denied",
        toolName: event.toolName,
        reason: event.reason,
      }];
    case "elicitation_requested":
      return [];
    default:
      return [];
  }
}

function limitGatewayToolResultPreview(text: string): string {
  if (text.length <= MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS) {
    return text;
  }
  const marker = `\n\n... [Gateway preview truncated: ${text.length - MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS} characters omitted; full result remains available through persisted tool-result references when shown to the model.] ...\n\n`;
  const available = Math.max(0, MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function sanitizeGatewayToolData(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeGatewayToolDataValue(value);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeGatewayToolDataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return limitGatewayToolDataString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeGatewayToolDataValue);
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitizeGatewayToolDataValue(item);
    }
    return output;
  }
  return value;
}

function limitGatewayToolDataString(value: string): string | { preview: string; originalChars: number; originalBytes: number; truncated: true } {
  if (value.length <= MAX_GATEWAY_TOOL_DATA_STRING_CHARS) {
    return value;
  }
  return {
    preview: headTailString(value, MAX_GATEWAY_TOOL_DATA_STRING_CHARS, "Gateway data string truncated"),
    originalChars: value.length,
    originalBytes: Buffer.byteLength(value, "utf8"),
    truncated: true,
  };
}

function headTailString(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = `\n\n... [${label}: ${text.length - maxChars} characters omitted] ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapModelEvent(event: CanonicalModelEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_text_delta", text: event.text, runId }];
    case "thinking_delta":
      return [{ type: "assistant_thinking_delta", text: event.text, runId }];
    case "error":
      // Model-level errors are internal control flow until AgentLoop decides
      // whether they are recoverable. Surfacing them here duplicates the final
      // turn_failed frame and also shows self-correction retries as red errors.
      return [];
    default:
      return [];
  }
}

function mapSubagentModelEvent(
  event: Extract<AgentEvent, { type: "subagent_model_event" }>,
  options: { forwardSubagentText?: boolean },
): GatewayEvent[] {
  const base = {
    subagentId: event.subagentId,
    subagentType: event.subagentType,
  };
  switch (event.event.type) {
    case "text_delta":
      if (options.forwardSubagentText) {
        return [{
          type: "subagent_text_delta",
          ...base,
          text: event.event.text,
        }];
      }
      return [{
        type: "agent_status",
        event: "subagent_text_delta",
        detail: { ...base, text: event.event.text },
      }];
    case "thinking_delta":
      return [{
        type: "agent_status",
        event: "subagent_thinking_delta",
        detail: { ...base, text: event.event.text },
      }];
    case "error":
      return [{
        type: "agent_status",
        event: "subagent_model_error",
        detail: {
          ...base,
          code: event.event.error.code,
          message: event.event.error.message,
        },
      }];
    default:
      return [];
  }
}

function normalizePlanCommandInput(input: GatewaySubmitTurnInput): GatewaySubmitTurnInput | undefined {
  const parsed = parsePlanCommand(input.message);
  if (!parsed.isPlanCommand) {
    return input;
  }
  if (!parsed.message) {
    return undefined;
  }
  return {
    ...input,
    message: parsed.message,
    runMode: "plan",
    mode: "plan",
    basePermissionMode: input.basePermissionMode ?? input.mode ?? "default",
    allowPlanModeTools: true,
  };
}

function parsePlanCommand(message: string): { isPlanCommand: boolean; message: string } {
  const trimmed = message.trim();
  const match = trimmed.match(/^\/plan(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return { isPlanCommand: false, message };
  }
  return {
    isPlanCommand: true,
    message: (match[1] ?? "").trim(),
  };
}

function mapTurnCompleted(result: AgentTurnResult): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  if (result.structuredOutput !== undefined) {
    events.push({ type: "structured_output", payload: result.structuredOutput });
  }
  events.push({ type: "turn_completed", usage: result.usage, finishReason: result.stopReason });
  return events;
}

function previewUnknown(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeGatewayPathPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}

const ATTACHMENT_PATH_NOTE_MARKER = "[Registered attachment files in this session:]";
const READ_FILE_BINARY_ATTACHMENT_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".key",
  ".numbers",
]);

async function buildAgentInputWithAttachments(
  message: string,
  attachments: ChannelAttachment[] | undefined,
  allowedReadFiles: string[],
  projectRoot?: string,
  funasrInstallCommand?: string,
): Promise<AgentInput> {
  const resolvedAttachments = await attachmentsToContentBlocks(attachments);
  const attachmentBlocks = resolvedAttachments.blocks;
  const pathNote = buildAttachmentPathNote(
    attachments,
    new Set(allowedReadFiles),
    resolvedAttachments.directContentPaths,
    resolvedAttachments.hasDiagnostics,
    projectRoot,
    funasrInstallCommand,
  );
  if (attachmentBlocks.length === 0 && !pathNote) {
    return { type: "text", text: message };
  }
  const blocks: CanonicalContentBlock[] = [];
  if (message && message.length > 0) {
    blocks.push({ type: "text", text: message });
  }
  for (const block of attachmentBlocks) {
    blocks.push(block);
  }
  if (pathNote) {
    blocks.push(pathNote);
  }
  return { type: "blocks", content: blocks };
}

function buildAttachmentPathNote(
  attachments: ChannelAttachment[] | undefined,
  allowedReadFiles: Set<string>,
  directContentPaths: Set<string>,
  hasDiagnostics: boolean,
  projectRoot?: string,
  installCommand = "npm run install:asr",
): CanonicalContentBlock | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!attachment.path) continue;
    const normalized = safeAllowedAttachmentPath(attachment.path, allowedReadFiles);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const fallbackName = normalized.split(/[\\/]/).pop() || "attachment";
    const name = String(attachment.name || fallbackName).replace(/[\r\n]+/g, " ").trim() || fallbackName;
    lines.push(`- ${name}: ${normalized}`);
  }

  if (lines.length === 0) return undefined;
  const guidance = hasDiagnostics || attachments.some(isAudioAttachment)
    ? attachmentDiagnosticsGuidance(attachments, allowedReadFiles, projectRoot, installCommand)
    : "These are path references for reuse. If an image/PDF is already visible in this turn, do not call read_file just to view it.";
  return {
    type: "text",
    text: `\n\n${ATTACHMENT_PATH_NOTE_MARKER}\n${lines.join("\n")}\n${guidance}`,
  };
}

function attachmentDiagnosticsGuidance(
  attachments: ChannelAttachment[],
  allowedReadFiles: Set<string>,
  projectRoot?: string,
  installCommand = "npm run install:asr",
): string {
  const audioAttachments = attachments.filter((attachment) => isAudioAttachment(attachment));
  if (audioAttachments.length > 0) {
    const audioPaths = audioAttachments
      .map((attachment) => attachment.path && mapAudioPathForFunAsr(attachment.path, projectRoot))
      .filter((path): path is string => Boolean(path));
    const mappedHint = audioPaths.length > 0
      ? ` Pass the registered project-local path${audioPaths.length === 1 ? ` ${audioPaths[0]}` : "s " + audioPaths.join(", ")} to transcribe_audio.`
      : " Pass a project-local host path to transcribe_audio; paths outside this project are rejected.";
    return `Audio attachments are not readable with read_file. When the user asks for transcription, subtitles, or audio analysis, use the funasr MCP server's mcp__funasr__transcribe_audio tool.${mappedHint} If that tool reports that its runtime is missing, run ${installCommand} and retry the tool in this session.`;
  }

  const hasInspectableAttachment = attachments.some((attachment) => {
    if (!attachment.path) return false;
    if (!safeAllowedAttachmentPath(attachment.path, allowedReadFiles)) return false;
    return isReadFileInspectableAttachment(attachment);
  });
  if (!hasInspectableAttachment) {
    return "Some attachments were not shown inline. These registered files are not directly inspectable with read_file; ask for a supported export or convert them before inspection.";
  }
  return "Some attachments were not shown inline. Use read_file with the exact path only for readable text, image, PDF, or notebook attachments; Office/archive/binary files need conversion before inspection.";
}

function isReadFileInspectableAttachment(attachment: ChannelAttachment): boolean {
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  if (attachment.type === "image" || mimeType.startsWith("image/")) return true;
  if (mimeType === "application/pdf") return true;
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/json" || mimeType.endsWith("+json")) return true;

  const pathOrName = attachment.path || attachment.name || "";
  const extension = extname(pathOrName).toLowerCase();
  if (extension === ".pdf" || extension === ".ipynb") return true;
  if (READ_FILE_BINARY_ATTACHMENT_EXTENSIONS.has(extension)) return false;
  return true;
}

function safeAllowedAttachmentPath(path: string, allowedReadFiles: Set<string>): string | undefined {
  const normalized = resolve(path);
  if (allowedReadFiles.has(normalized)) return normalized;
  return undefined;
}

async function collectRegisteredAttachmentReadFiles(
  attachments: ChannelAttachment[] | undefined,
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const allowed = new Set<string>();

  for (const attachment of attachments) {
    if (!attachment.path || !attachment.metadata?.channelKey) continue;
    try {
      const info = await stat(attachment.path);
      if (!info.isFile()) continue;
      allowed.add(resolve(attachment.path));
      allowed.add(resolve(await realpath(attachment.path)));
    } catch {
      // Missing or inaccessible attachments are handled by attachment resolution diagnostics.
    }
  }

  return [...allowed];
}

async function attachmentsToContentBlocks(
  attachments: ChannelAttachment[] | undefined,
): Promise<{ blocks: CanonicalContentBlock[]; directContentPaths: Set<string>; hasDiagnostics: boolean }> {
  if (!attachments || attachments.length === 0) {
    return { blocks: [], directContentPaths: new Set<string>(), hasDiagnostics: false };
  }
  const blocks: CanonicalContentBlock[] = [];
  const resolverRequests: AttachmentRequest[] = [];
  const resolverRequestPaths: Array<string | undefined> = [];
  const directContentPaths = new Set<string>();
  const diagnostics: string[] = [];

  for (const att of attachments) {
    if (att.type === "image" && att.content && att.mimeType) {
      blocks.push({
        type: "image",
        source: "base64",
        data: att.content,
        mimeType: att.mimeType,
        ...(typeof att.bytes === "number" ? { bytes: att.bytes } : {}),
      });
      if (att.path) directContentPaths.add(resolve(att.path));
      continue;
    }

    if (att.type === "text" && att.content) {
      blocks.push({ type: "text", text: att.content });
      continue;
    }

    if (!att.path) continue;
    if (isAudioAttachment(att)) {
      // Keep audio as a registered path reference. The ASR Skill invokes the
      // FunASR MCP tool on demand, so audio should not be sent through the
      // text/image/PDF attachment resolver.
      continue;
    }
    if (att.type === "image" || att.mimeType?.startsWith("image/")) {
      resolverRequests.push({ type: "image", path: att.path, mimeType: att.mimeType });
      resolverRequestPaths.push(resolve(att.path));
    } else if (att.mimeType === "application/pdf" || att.path.toLowerCase().endsWith(".pdf")) {
      resolverRequests.push({ type: "pdf", path: att.path });
      resolverRequestPaths.push(resolve(att.path));
    } else {
      resolverRequests.push({ type: "file", path: att.path });
      resolverRequestPaths.push(resolve(att.path));
    }
  }

  if (resolverRequests.length > 0) {
    const resolved = await new AttachmentResolver().resolveAll(resolverRequests);
    blocks.push(...resolved.blocks);
    for (const diagnostic of resolved.diagnostics) {
      if (diagnostic.severity === "error" || diagnostic.severity === "warning") {
        diagnostics.push(diagnostic.message);
      }
    }
    if (resolved.blocks.length > 0 && diagnostics.length === 0) {
      for (const requestPath of resolverRequestPaths) {
        if (requestPath) directContentPaths.add(requestPath);
      }
    }
  }

  if (diagnostics.length > 0) {
    blocks.push({
      type: "text",
      text: `[Attachment diagnostics]\n${diagnostics.map((message) => `- ${message}`).join("\n")}`,
    });
  }

  return { blocks, directContentPaths, hasDiagnostics: diagnostics.length > 0 };
}

function isAudioAttachment(attachment: ChannelAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("audio/")) return true;
  const pathOrName = attachment.path || attachment.name || "";
  return /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/iu.test(pathOrName);
}

function mapAudioPathForFunAsr(audioPath: string, projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined;
  const absoluteRoot = resolve(projectRoot);
  const absolutePath = resolve(audioPath);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  return absolutePath;
}

function sanitizeAttachmentName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim() || "attachment";
}

function providerErrorFromAgentError(error: AgentError): GatewayEventProviderError | undefined {
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  return providerErrorFromRecord(details as Record<string, unknown>);
}

function providerErrorFromModelError(error: CanonicalModelError): GatewayEventProviderError {
  return {
    provider: error.provider,
    protocol: error.protocol,
    status: error.status,
    code: error.code,
    message: error.message,
    raw: stringifyProviderRaw(error.raw),
  };
}

type GatewayEventProviderError = NonNullable<Extract<GatewayEvent, { type: "error" }>["providerError"]>;

function providerErrorFromRecord(details: Record<string, unknown>): GatewayEventProviderError | undefined {
  const provider = stringOrUndefined(details.provider);
  const protocol = stringOrUndefined(details.protocol);
  const status = numberOrUndefined(details.status);
  const code = stringOrUndefined(details.code);
  const message = stringOrUndefined(details.message);
  const raw = stringifyProviderRaw(details.raw);
  if (!provider && !protocol && status === undefined && !code && !message && !raw) return undefined;
  return { provider, protocol, status, code, message, raw };
}

function stringifyProviderRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw : safeJsonStringify(raw);
  if (!text) return undefined;
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}
