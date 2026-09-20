import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseAgentRunMode } from "../../agent/protocol/input.js";
import type { AgentEvent, AgentInput } from "../../agent/index.js";
import { SUBAGENT_DEFINITIONS } from "../../agent/sub/builtinSubagentTypes.js";
import {
  type CanonicalMessage,
} from "../../model/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import { isPilotDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import {
  GatewayUserDialogBus,
  type GatewayUserDialogChange,
} from "../user-dialog/GatewayUserDialogBus.js";
import {
  type GatewaySessionPermissionGrantPort,
} from "../permission/GatewaySessionPermissionRuleSetRegistry.js";
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
  AlwaysOnAbortInput,
  AlwaysOnAbortResult,
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
  InteractionConnectionBinding,
  InteractionReconnectPort,
} from "../../interaction/index.js";
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
import {
  isPermissionMode,
  permissionSettingsToRuleSet,
  readPermissionSettings,
  type PermissionMode,
} from "../../permission/index.js";
import {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "../permission/GatewaySessionPermissionModeRegistry.js";
import { SkillManagerError, type SkillManagementPort } from "../../extension/skills/index.js";
import { getPilotDeckInstallCommand } from "../../mcp/runtime/projectMcpSpec.js";
import type { AttachmentResolver } from "../../context/attachments/AttachmentResolver.js";
import type { AlwaysOnControlPort } from "../../always-on/protocol/AlwaysOnControlPort.js";
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
import { DialogGatewayError } from "../dialog/errors.js";
import { normalizeSessionModelSelection } from "../dialog/modelCatalog.js";
import { GatewayAttachmentTurnComposer } from "../dialog/GatewayAttachmentTurnComposer.js";
import type { GatewayAttachmentTurnComposerPort } from "../dialog/GatewayAttachmentTurnComposerPort.js";
import { GatewayAgentEventProjector } from "./GatewayAgentEventProjector.js";
import type { GatewayAgentEventProjectorPort } from "./GatewayAgentEventProjectorPort.js";
import { GatewayAgentEventTelemetryObserver } from "./GatewayAgentEventTelemetryObserver.js";
import type { GatewayAgentEventTelemetryObserverPort } from "./GatewayAgentEventTelemetryObserverPort.js";
import { GatewayToolResultArtifactStore } from "./GatewayToolResultArtifactStore.js";
import type { GatewayToolResultArtifactStorePort } from "./GatewayToolResultArtifactStorePort.js";
import type { GatewayTurnReplayStorePort } from "./GatewayTurnReplayStorePort.js";
import { GatewayTurnEventCoordinator } from "./GatewayTurnEventCoordinator.js";
import type { GatewayTurnEventCoordinatorPort } from "./GatewayTurnEventCoordinatorPort.js";
import { GatewayTurnTelemetryContextResolver } from "./GatewayTurnTelemetryContextResolver.js";
import type { GatewayTurnTelemetryContextResolverPort } from "./GatewayTurnTelemetryContextResolverPort.js";
import { GatewayTurnReplacementCoordinator } from "./GatewayTurnReplacementCoordinator.js";
import type { GatewayTurnReplacementCoordinatorPort } from "./GatewayTurnReplacementCoordinatorPort.js";
import { GatewayInteractionCoordinator } from "./GatewayInteractionCoordinator.js";
import type { GatewayInteractionCoordinatorPort } from "./GatewayInteractionCoordinatorPort.js";
import { GatewayTurnCompletionFence } from "./GatewayTurnCompletionFence.js";
import type { GatewayTurnCompletionFencePort } from "./GatewayTurnCompletionFencePort.js";
import { GatewayManualCompactionCoordinator } from "./GatewayManualCompactionCoordinator.js";
import type { GatewayManualCompactionCoordinatorPort } from "./GatewayManualCompactionCoordinatorPort.js";
import type { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import type { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import type { ResolvedUploadedAttachments, UploadedAttachmentResolverPort } from "../dialog/UploadedAttachmentResolverPort.js";
import { listProjectFiles } from "../dialog/projectFiles.js";
import { isPathWithinRoot } from "../../tool/builtin/filesystem/pathSafety.js";
import { RouterRuntimeError } from "../../router/index.js";

export { mapAgentEvent } from "./GatewayAgentEventProjector.js";

const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";
const COMPACT_COMMAND_USAGE = "用法：/compact";
const DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_ABORT_TURN_TIMEOUT_MS = 30_000;
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
  /** Maximum time to wait for an aborted turn to finish unwinding. */
  abortTurnTimeoutMs?: number;
  /** Attachment turn-composition consumer wired by application composition. */
  attachmentTurnComposer?: GatewayAttachmentTurnComposerPort;
  /** Compatibility fallback for direct Gateway callers that do not compose a turn composer. */
  attachmentResolver?: AttachmentResolver;
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
  sopStatus?: (input: import("../protocol/types.js").GatewaySopStatusInput) => Promise<import("../protocol/types.js").GatewaySopStatusResult>;
  resumeSop?: (input: import("../protocol/types.js").GatewaySopResumeInput) => Promise<import("../protocol/types.js").GatewaySopResumeResult>;
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
  projectFileRead?: (input: import("../protocol/types.js").GatewayProjectFileReadInput) => Promise<import("../protocol/types.js").GatewayProjectFileReadResult | null>;
  renameSession?: (input: import("../protocol/types.js").GatewaySessionMetadataInput) => Promise<{ updated: boolean }>;
  tagSession?: (input: import("../protocol/types.js").GatewaySessionMetadataInput) => Promise<{ updated: boolean }>;
  deleteSession?: (input: { sessionKey: string; projectKey?: string }) => Promise<void>;
  exportSessionTranscript?: (
    input: import("../protocol/types.js").GatewayExportSessionTranscriptInput,
  ) => Promise<import("../protocol/types.js").GatewaySessionTranscriptArchive>;
  restoreSessionTranscript?: (
    input: import("../protocol/types.js").GatewayRestoreSessionTranscriptInput,
  ) => Promise<import("../protocol/types.js").GatewayRestoreSessionTranscriptResult>;
  deleteEphemeralSession?: (input: { sessionKey: string; projectKey?: string }) => Promise<boolean>;
  mcpServerStatus?: (input: import("../protocol/types.js").GatewayMcpServerStatusInput) => Promise<import("../protocol/types.js").GatewayMcpServerStatusResult>;
  setMcpServers?: (input: GatewaySetMcpServersInput) => Promise<GatewayMcpSetServersResult>;
  reconnectMcpServer?: (input: GatewayMcpServerControlInput) => Promise<void>;
  toggleMcpServer?: (input: GatewayMcpServerToggleInput) => Promise<void>;
  setMcpPermissionModeOverride?: (input: GatewayMcpPermissionModeOverrideInput) => Promise<GatewayMcpPermissionModeOverrideResult>;
  setPermissionMode?: (input: import("../protocol/types.js").GatewaySetPermissionModeInput) => Promise<{ applied: boolean }>;
  clearPermissionMode?: (input: { sessionKey: string; projectKey?: string }) => Promise<void>;
  applyFlagSettings?: (input: GatewayApplyFlagSettingsInput) => Promise<GatewayApplyFlagSettingsResult>;
  updateSettings?: (input: GatewayUpdateSettingsInput) => Promise<GatewayUpdateSettingsResult>;
  resolveSettings?: () => Promise<GatewayResolvedSettingsResult>;
  setSessionThinking?: (input: GatewaySetSessionThinkingInput) => Promise<{ applied: boolean }>;
  outputStylesList?: (input: GatewayOutputStylesListInput) => Promise<GatewayOutputStylesListResult>;
  setOutputStyle?: (input: GatewaySetOutputStyleInput) => Promise<GatewaySetOutputStyleResult>;
  reloadOutputStyles?: (input?: GatewayReloadOutputStylesInput) => Promise<GatewayReloadOutputStylesResult>;
  usageSnapshot?: (input: GatewayUsageSnapshotInput) => Promise<GatewayUsageSnapshotResult>;
  modelUsageSnapshot?: (input: GatewayModelUsageSnapshotInput) => Promise<GatewayModelUsageSnapshotResult>;
  rewindFiles?: (input: GatewayRewindFilesInput) => Promise<GatewayRewindFilesResult>;
  stopBackgroundTask?: (
    input: import("../protocol/types.js").GatewayStopBackgroundTaskInput,
  ) => Promise<import("../protocol/types.js").GatewayStopBackgroundTaskResult>;
  backgroundTasks?: (
    input: import("../protocol/types.js").GatewayBackgroundTasksInput,
  ) => Promise<import("../protocol/types.js").GatewayBackgroundTasksResult>;
  setSdkSessionConfig?: (
    sessionKey: string,
    config: GatewaySessionSdkConfig,
    projectKey?: string,
  ) => Promise<{ changed: boolean }> | { changed: boolean };
  assertSdkModelAllowed?: (
    sessionKey: string,
    model?: { provider: string; model: string },
    projectKey?: string,
  ) => void;
  sdkSessionDefaults?: boolean;
  turnLimits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
  };
  taskBudgetSnapshot?: (input: {
    sessionKey: string;
    projectKey?: string;
  }) => Promise<{ totalUsd: number; spentUsd: number } | undefined> | { totalUsd: number; spentUsd: number } | undefined;
  recordTaskBudgetSpend?: (input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
    turnSpentUsd: number;
  }) => Promise<void> | void;
  listRecoveredUserDialogs?: (
    input: GatewayListUserDialogsInput,
  ) => Promise<GatewayRecoveredUserDialog[]> | GatewayRecoveredUserDialog[];
  acknowledgeRecoveredUserDialog?: (input: {
    sessionKey: string;
    projectKey?: string;
    requestId: string;
  }) => Promise<boolean> | boolean;
  recoverUserDialog?: (input: GatewayUserDialogResponseInput) => Promise<boolean> | boolean;
  listHostedUserDialogs?: (input: GatewayListUserDialogsInput) => Promise<GatewayUserDialogRequestEvent[]> | GatewayUserDialogRequestEvent[];
  claimHostedUserDialog?: (input: GatewayUserDialogClaimInput) => Promise<GatewayUserDialogClaimResult> | GatewayUserDialogClaimResult;
  releaseHostedUserDialog?: (input: GatewayUserDialogReleaseInput) => Promise<boolean> | boolean;
  submitHostedUserDialogAnswer?: (input: GatewayUserDialogResponseInput) => Promise<boolean> | boolean;
  onUserDialogChange?: (change: GatewayUserDialogChange) => void;
  clearRecoveredUserDialogs?: (input: {
    sessionKey: string;
    projectKey?: string;
  }) => Promise<void> | void;
  resolveUploadedAttachments?: UploadedAttachmentResolverPort["resolve"];
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
  skillManager?: SkillManagementPort;
  dispatchHookForSession?: (sessionKey: string, event: string, payload: Record<string, unknown>) => void;
  /** Directory to persist large tool outputs for TUI/Web viewing. */
  toolResultsDir?: string;
  /** Application-selected best-effort result artifact provider. */
  toolResultArtifacts?: GatewayToolResultArtifactStorePort;
  /** Application-selected Agent-to-Gateway live-event projection provider. */
  agentEventProjector?: GatewayAgentEventProjectorPort;
  /** Application-selected Agent event telemetry observer. */
  agentEventTelemetryObserver?: GatewayAgentEventTelemetryObserverPort;
  /** Application-selected bounded volatile Gateway turn replay provider. */
  turnReplayStore?: GatewayTurnReplayStorePort;
  /** Application-selected live turn sink/replay coordinator. */
  turnEventCoordinator?: GatewayTurnEventCoordinatorPort;
  /** Application-selected host policy for classifying turn telemetry. */
  turnTelemetryContextResolver?: GatewayTurnTelemetryContextResolverPort;
  /** Application-selected volatile coordinator for last-turn replacement transactions. */
  turnReplacementCoordinator?: GatewayTurnReplacementCoordinatorPort;
  /** Application-selected owner for reconnectable Gateway interaction state. */
  interactionCoordinator?: GatewayInteractionCoordinatorPort;
  /** Application-selected abort-to-submit drain fence for live Gateway turns. */
  turnCompletionFence?: GatewayTurnCompletionFencePort;
  /** Application-selected `/compact` command projection provider. */
  manualCompactionCoordinator?: GatewayManualCompactionCoordinatorPort;
  /** Override a session's cwd via SessionConfigOverrides. */
  setSessionCwd?: (sessionKey: string, cwd: string) => void;
  /** Provider-neutral owner of live session permission grants. */
  permissionGrants?: GatewaySessionPermissionGrantPort;
  /** Provider-neutral owner of live session permission mode transitions. */
  permissionModes?: GatewaySessionPermissionModePort;
  /** Application-selected base mode used when a client omits its legacy mode field. */
  defaultPermissionMode?: PermissionMode;
  /** Provider-neutral Always-On control seam. */
  alwaysOnControl?: AlwaysOnControlPort;
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
  private readonly attachmentTurnComposer: GatewayAttachmentTurnComposerPort;
  private readonly agentEventProjector: GatewayAgentEventProjectorPort;
  private readonly agentEventTelemetryObserver: GatewayAgentEventTelemetryObserverPort;
  private readonly turnEventCoordinator: GatewayTurnEventCoordinatorPort;
  private readonly turnTelemetryContextResolver: GatewayTurnTelemetryContextResolverPort;
  private readonly turnReplacementCoordinator: GatewayTurnReplacementCoordinatorPort;
  private readonly interactionCoordinator: GatewayInteractionCoordinatorPort;
  private readonly permissionModes: GatewaySessionPermissionModePort;
  private readonly turnCompletionFence: GatewayTurnCompletionFencePort;
  private readonly manualCompactionCoordinator: GatewayManualCompactionCoordinatorPort;
  private readonly pendingAsyncHooks = new Map<string, PendingAsyncHook>();
  private readonly asyncHookOutcomes = new Map<string, AsyncHookOutcome>();
  private readonly userDialogBus: GatewayUserDialogBus;
  /** Project identity used only to scope observational dialog notifications. */
  private readonly dialogProjectKeys = new Map<string, string>();
  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.userDialogBus = new GatewayUserDialogBus({
      now: this.now,
      uuid: this.uuid,
      onChange: (change) => {
        const projectKey = this.dialogProjectKeys.get(change.sessionKey);
        options.onUserDialogChange?.({
          ...change,
          ...(projectKey ? { projectKey } : {}),
        });
      },
    });
    validateGatewayTurnLimits(options.turnLimits);
    this.attachmentTurnComposer = options.attachmentTurnComposer ?? new GatewayAttachmentTurnComposer({
      ...(options.attachmentResolver ? { attachmentResolver: options.attachmentResolver } : {}),
    });
    this.agentEventProjector = options.agentEventProjector ?? new GatewayAgentEventProjector({
      toolResultArtifacts: options.toolResultArtifacts ?? new GatewayToolResultArtifactStore({
        ...(options.toolResultsDir ? { rootDir: options.toolResultsDir } : {}),
      }),
    });
    this.agentEventTelemetryObserver = options.agentEventTelemetryObserver
      ?? new GatewayAgentEventTelemetryObserver({ telemetry: options.telemetry });
    this.turnEventCoordinator = options.turnEventCoordinator
      ?? new GatewayTurnEventCoordinator({ replayStore: options.turnReplayStore });
    this.turnTelemetryContextResolver = options.turnTelemetryContextResolver
      ?? new GatewayTurnTelemetryContextResolver();
    this.turnReplacementCoordinator = options.turnReplacementCoordinator
      ?? new GatewayTurnReplacementCoordinator({
        storage: {
          replaceLastTurn: options.replaceLastTurn,
          finalizeLastTurnReplacement: options.finalizeLastTurnReplacement,
        },
        session: {
          activeTurnRunId: (sessionKey) => this.router.activeTurnRunId(sessionKey),
          hasActiveTurn: (sessionKey) => this.router.hasActiveTurn(sessionKey),
          abortExpectedTurn: (sessionKey, runId) => this.abortTurn({
            sessionKey,
            runId,
            reason: "message_replaced",
          }),
          closeSession: (sessionKey) => this.router.close(sessionKey),
        },
        timeoutMs: options.replacementTransactionTimeoutMs ?? DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS,
      });
    this.interactionCoordinator = options.interactionCoordinator
      ?? new GatewayInteractionCoordinator({
        permissionGrants: options.permissionGrants,
      });
    this.permissionModes = options.permissionModes ?? new GatewaySessionPermissionModeRegistry();
    this.turnCompletionFence = options.turnCompletionFence ?? new GatewayTurnCompletionFence();
    this.manualCompactionCoordinator = options.manualCompactionCoordinator
      ?? new GatewayManualCompactionCoordinator({ router: this.router });
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.interactionCoordinator.getElicitationBus();
  }

  getUserDialogBus(): GatewayUserDialogBus {
    return this.userDialogBus;
  }

  async sopStatus(input: import("../protocol/types.js").GatewaySopStatusInput): Promise<import("../protocol/types.js").GatewaySopStatusResult> {
    if (!this.options.sopStatus) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "StaffDeck SOP status is unavailable.");
    return this.options.sopStatus(input);
  }

  async resumeSop(input: import("../protocol/types.js").GatewaySopResumeInput): Promise<import("../protocol/types.js").GatewaySopResumeResult> {
    if (!this.options.resumeSop) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "StaffDeck SOP resume is unavailable.");
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot resume StaffDeck SOP while a turn is active.");
    try {
      return await this.options.resumeSop(input);
    } catch (error) {
      if (error instanceof DialogGatewayError) throw error;
      const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "SOP_RESUME_FAILED";
      throw new DialogGatewayError(code, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Web Phase 2 — exposed so per-session bridge channels (or tests) can
   * register pending permission decisions and emit `permission_request`
   * events.
   */
  getPermissionBus(): GatewayPermissionBus {
    return this.interactionCoordinator.getPermissionBus();
  }

  getInteractionReconnectPort(): InteractionReconnectPort {
    return this.interactionCoordinator.getReconnectPort();
  }

  getInteractionBinding(sessionKey: string): InteractionConnectionBinding | undefined {
    return this.interactionCoordinator.getBinding(sessionKey);
  }

  reconnectInteraction(input: import("../protocol/types.js").GatewayReconnectInteractionInput): import("../protocol/types.js").GatewayReconnectInteractionResult {
    return this.interactionCoordinator.reconnect(input);
  }

  disconnectInteraction(input: import("../protocol/types.js").GatewayDisconnectInteractionInput): import("../protocol/types.js").GatewayDisconnectInteractionResult {
    return this.interactionCoordinator.disconnect(input);
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
    return this.turnEventCoordinator.emit(sessionKey, event);
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
    input = {
      ...input,
      ...(input.modelSelection
        ? { modelSelection: normalizeSessionModelSelection(input.modelSelection) }
        : {}),
      ...(input.modelOverride
        ? { modelOverride: normalizeSessionModelSelection(input.modelOverride) as typeof input.modelOverride }
        : {}),
    };
    if (input.projectKey) this.dialogProjectKeys.set(input.sessionKey, input.projectKey);
    if (input.interactionBinding) {
      const reconnect = this.interactionCoordinator.reconnectForTurn(
        input.sessionKey,
        input.interactionBinding,
      );
      if (reconnect.outcome === "stale_binding") {
        yield {
          type: "error",
          code: "interaction_reconnect_required",
          message: "This session has reconnectable interaction requests. Reconnect with the previous binding before submitting a new turn.",
          recoverable: true,
        };
        return;
      }
    }
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
    const compactCommand = parseCompactCommand(input.message);
    if (compactCommand.isCompactCommand) {
      if (!compactCommand.valid) {
        yield { type: "assistant_text_delta", text: COMPACT_COMMAND_USAGE };
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
        return;
      }
      const runId = input.runId ?? this.uuid();
      yield* this.manualCompactionCoordinator.execute({
        sessionKey: input.sessionKey,
        runId,
        timeoutMs: input.timeoutMs,
      });
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
    const replacementClaim = this.turnReplacementCoordinator.claimForSubmit(input.sessionKey, runId);
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

    if (this.turnReplacementCoordinator.hasTranscriptWriteReservation(input.sessionKey)) {
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
        this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
        this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
        this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
    const explicitModel = input.modelSelection?.mode === "model"
      ? input.modelSelection
      : input.modelOverride;
    if (this.options.assertSdkModelAllowed) {
      try {
        this.options.assertSdkModelAllowed(input.sessionKey, explicitModel, input.projectKey);
      } catch (error) {
        this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
        this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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

    const turnCompletion = this.turnCompletionFence.begin(input.sessionKey);

    const queue = new AsyncQueue<GatewayEvent>();
    this.turnEventCoordinator.start(input.sessionKey, runId, (event) => queue.enqueue(event));
    const emitGatewayFailureStatus = async (status: GatewayRecordAgentStatusMessageInput["status"]): Promise<void> => {
      await this.recordGatewayStatusMessage({
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
      this.turnEventCoordinator.record(input.sessionKey, statusEvent);
      queue.enqueue(statusEvent);
    };

    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }

    const telemetryContext = this.turnTelemetryContextResolver.resolve(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timeoutSettlement: Promise<void> | undefined;
    let timedOut = false;
    let uploadedAttachmentLease: ResolvedUploadedAttachments | undefined;

    const timingStart = performance.now();
    let timingPrevious = timingStart;
    const timingStages: Record<string, number> = {};
    const markTiming = (stage: string) => {
      const current = performance.now();
      timingStages[stage] = Math.round(current - timingPrevious);
      timingPrevious = current;
    };
    let completedEventAt: number | undefined;

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
        markTiming("configMs");
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
        });
        const operationDeadline = operationDeadlineForTimeout(input.timeoutMs, this.now);
        if (input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
          const settleTimeout = async (): Promise<void> => {
            timedOut = true;
            const message = `Turn exceeded the ${input.timeoutMs}ms timeout.`;
            const timeoutStatus = createGatewayFailureStatus({
              event: "turn_timeout",
              code: "turn_timeout",
              message,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
              detail: { timeoutMs: input.timeoutMs },
            });
            this.interactionCoordinator.rejectPendingTurn(input.sessionKey, "turn_timeout");
            try {
              session.abort(`timeout:${runId}`);
            } catch {
              // Persistence and publication below still settle the timed-out
              // operation when an injected session cannot abort cleanly.
            }
            try {
              await this.recordAgentStatusMessage({
                sessionKey: input.sessionKey,
                turnId: runId,
                projectKey: input.projectKey,
                status: timeoutStatus,
              });
              const statusEvent: GatewayEvent = {
                type: "agent_status",
                runId,
                event: timeoutStatus.event,
                detail: timeoutStatus.detail,
              };
              this.turnEventCoordinator.record(input.sessionKey, statusEvent);
              queue.enqueue(statusEvent);
            } catch (error) {
              console.warn("[pilotdeck] failed to persist gateway timeout status:", error);
            }
            const gatewayEvent: GatewayEvent = {
              type: "error",
              runId,
              code: "turn_timeout",
              message,
              recoverable: false,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
            };
            this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
            queue.close();
          };
          timeoutHandle = setTimeout(() => {
            timeoutSettlement = settleTimeout().catch((error) => {
              console.warn("[pilotdeck] failed to settle gateway timeout:", error);
              queue.close();
            });
          }, input.timeoutMs);
        }
        const permissionSettings = readPermissionSettings();
        const inputMode = normalizeGatewayModeForLegacyInput((input as { mode?: unknown }).mode)
          ?? this.permissionModes.get(input.sessionKey);
        const runMode = normalizeGatewayRunMode((input as { runMode?: unknown }).runMode)
          ?? (inputMode === "plan" ? "plan" : "agent");
        const livePermissionMode = this.permissionModes.get(input.sessionKey);
        const permissionMode = inputMode
          ?? livePermissionMode
          ?? this.options.defaultPermissionMode
          ?? (permissionSettings.skipPermissions ? "bypassPermissions" : undefined);
        const basePermissionMode = normalizeGatewayModeForLegacyInput(
          (input as { basePermissionMode?: unknown }).basePermissionMode,
        ) ?? this.options.defaultPermissionMode;
        const allowPlanModeTools = input.allowPlanModeTools ?? inputMode === "plan";
        const persistedRules = permissionSettingsToRuleSet(permissionSettings);
        const sessionAllowRules = this.interactionCoordinator.sessionAllowRules(input.sessionKey);
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
        uploadedAttachmentLease = input.uploadedAttachments?.length
          ? await this.resolveUploadedAttachments(input)
          : undefined;
        const attachments = [...(input.attachments ?? []), ...(uploadedAttachmentLease?.attachments ?? [])];
        const { agentInput, allowedReadFiles } = await this.prepareAttachmentTurn(
          input.message,
          attachments,
          input.projectKey,
        );
        const syntheticMessages: CanonicalMessage[] = (input.syntheticMessages ?? []).map((s) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: s.text }],
          metadata: { synthetic: true, purpose: s.purpose ?? "channel_hint" },
        }));
        const modelSelection = this.options.resolveTurnModelSelection
          ? await this.options.resolveTurnModelSelection(input)
          : input.modelSelection?.mode === "auto"
            ? { source: "router" as const }
            : input.modelSelection?.mode === "model" || input.modelOverride
              ? { selection: input.modelSelection?.mode === "model" ? input.modelSelection : input.modelOverride, source: "turn" as const }
              : { source: "default" as const };
        markTiming("selectionMs");
        let lastEmittedModel: string | undefined;
        let actualRequestModel: string | undefined;
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
          this.turnEventCoordinator.record(input.sessionKey, event);
          queue.enqueue(event);
          lastEmittedModel = `${modelSelection.selection.provider}\0${modelSelection.selection.model}`;
        }
        // A wall-clock timeout can fire while the Gateway is still resolving
        // attachments, config, or model selection. Do not admit a new
        // AgentSession turn after that timeout: submit() creates a fresh
        // abort controller and would otherwise revive a closed operation.
        if (timedOut) return;
        for await (const event of session.submit(
          agentInput,
          {
            turnId: runId,
            modelSelection: input.modelSelection,
            execution: {
              runId,
              operationId: runId,
              ...(operationDeadline ? { operationDeadline } : {}),
            },
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
          if (timedOut) break;
          if (!this.turnCompletionFence.isCurrent(input.sessionKey, turnCompletion)) {
            break;
          }
          this.agentEventTelemetryObserver.observe(event, {
            sessionId: input.sessionKey,
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
            ownerModule: telemetryContext.ownerModule,
            executionKind: telemetryContext.executionKind,
            phase: telemetryContext.phase,
          });
          if (event.type === "mode_change_requested" && isPermissionMode(event.mode)) {
            this.permissionModes.set(input.sessionKey, event.mode);
          }
          if (event.type === "input_accepted") {
            await this.turnReplacementCoordinator.commitAcceptedInput(input.sessionKey, runId);
            markTiming("acceptanceMs");
            const totalMs = Math.round(performance.now() - timingStart);
            if (totalMs >= 200) console.info("[gateway:turn-timing]", JSON.stringify({
              sessionKey: input.sessionKey, runId, phase: "accepted", totalMs, ...timingStages,
            }));
          }
          if (event.type === "turn_completed") completedEventAt = performance.now();
          if (event.type === "model_event" && event.event.type === "request_started") {
            actualRequestModel = event.event.model;
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
            this.turnEventCoordinator.record(input.sessionKey, selectionEvent);
            queue.enqueue(selectionEvent);
            lastEmittedModel = `${event.event.provider}\0${event.event.model}`;
          }
          for (const gatewayEvent of this.agentEventProjector.project({
            event,
            runId,
            forwardSubagentText: input.sdkSessionConfig?.forwardSubagentText === true,
          })) {
            if (gatewayEvent.type === "assistant_text_delta" && actualRequestModel) {
              gatewayEvent.model = actualRequestModel;
            }
            if (gatewayEvent.type === "input_accepted" && input.modelSelection) {
              gatewayEvent.modelSelection = { ...input.modelSelection };
            }
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
            this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
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
        if (this.turnCompletionFence.isCurrent(input.sessionKey, turnCompletion)) {
          const message = error instanceof Error ? error.message : String(error);
          const managedModelDenied = (error instanceof DialogGatewayError || error instanceof RouterRuntimeError)
            && error.code === "SDK_MANAGED_MODEL_DENIED";
          // Gateway embedding hosts may reject a model/provider before an
          // AgentLoop or provider request exists. Keep the host policy code
          // intact instead of flattening it into an operational failure so a
          // remote SDK can distinguish a denied configuration from a retry.
          const organizationPolicyDenied = (error instanceof DialogGatewayError || error instanceof RouterRuntimeError)
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
          this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
          queue.enqueue(gatewayEvent);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (uploadedAttachmentLease) {
          try {
            await uploadedAttachmentLease.release();
          } catch (error) {
            console.warn("[pilotdeck] failed to release uploaded attachment lease:", error);
          }
        }
        if (timedOut && timeoutSettlement) await timeoutSettlement;
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
      this.turnEventCoordinator.retainTerminal(input.sessionKey, runId);
      this.interactionCoordinator.rejectPendingTurn(input.sessionKey, "turn_ended");
      this.router.endTurn(input.sessionKey, runId);
      if (completedEventAt !== undefined) {
        const releaseMs = Math.round(performance.now() - completedEventAt);
        if (releaseMs >= 200) console.info("[gateway:turn-timing]", JSON.stringify({
          sessionKey: input.sessionKey, runId, phase: "released", releaseMs,
        }));
      }
      if (timedOut) {
        // The timed-out AgentSession is never safe to reuse. Do not await a
        // misbehaving tool here: the hard timeout must release the Cron run.
        void this.router.close(input.sessionKey).catch(() => undefined);
        void pump.catch(() => undefined);
      } else {
        // Defensive — make sure the pump promise is settled before we resolve.
        await pump.catch(() => undefined);
      }
      // Signal any in-flight `abortTurn` awaiters after Router cleanup.
      // The fence only owns this short-lived drain promise; it does not
      // decide whether another turn may be admitted.
      this.turnCompletionFence.complete(input.sessionKey, turnCompletion);
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
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
    const { agentInput, allowedReadFiles } = await this.prepareAttachmentTurn(
      input.message,
      attachments,
      input.projectKey,
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
    await this.turnCompletionFence.waitForCompletion(input.sessionKey);
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

  async closeProjectSessions(input: { projectKey: string; resume?: boolean }): Promise<{ sessionKeys: string[] }> {
    if (!input.projectKey?.trim()) throw new Error("projectKey is required.");
    const projectKey = resolve(input.projectKey);
    if (input.resume) { this.router.resumeProject(projectKey); return { sessionKeys: [] }; }
    const sessionKeys = await this.router.closeProject(projectKey);
    for (const key of sessionKeys) {
      this.interactionCoordinator.closeSession(key, "project_closed");
      this.permissionModes.clear(key);
      this.dialogProjectKeys.delete(key);
    }
    return { sessionKeys };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.router.close(input.sessionKey);
    this.interactionCoordinator.closeSession(input.sessionKey, input.reason ?? "session_closed");
    this.permissionModes.clear(input.sessionKey);
    this.dialogProjectKeys.delete(input.sessionKey);
  }

  /**
   * Gateway ownership boundary. Session scopes own their individual channels;
   * this drains any remaining host round-trips and then releases the shared
   * reconnect provider when the process-level Gateway exits.
   */
  dispose(reason = "gateway_disposed"): void {
    this.turnReplacementCoordinator.dispose();
    this.turnEventCoordinator.dispose();
    this.interactionCoordinator.dispose(reason);
    this.permissionModes.dispose();
  }

  async recordAgentStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    const recordLive = this.router.recordAgentStatusMessage;
    if (typeof recordLive === "function") {
      const live = await recordLive.call(this.router, input.sessionKey, input.turnId, input.status);
      if (live.owner === "live") {
        return { recorded: live.recorded };
      }
    }
    if (!this.options.recordAgentStatusMessage) return { recorded: false };
    return this.options.recordAgentStatusMessage(input);
  }

  private async recordGatewayStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<void> {
    try {
      await this.recordAgentStatusMessage(input);
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
    this.turnReplacementCoordinator.reserveTranscriptWrite(input.sessionKey, "change the session model");
    try {
      return await this.options.sessionModelSet(input);
    } finally {
      this.turnReplacementCoordinator.releaseTranscriptWrite(input.sessionKey);
    }
  }

  async sessionModelClear(input: SessionModelInput): Promise<void> {
    if (!this.options.sessionModelClear) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_clear is unavailable.");
    this.turnReplacementCoordinator.reserveTranscriptWrite(input.sessionKey, "clear the session model");
    try {
      await this.options.sessionModelClear(input);
    } finally {
      this.turnReplacementCoordinator.releaseTranscriptWrite(input.sessionKey);
    }
  }

  async renameSession(
    input: import("../protocol/types.js").GatewaySessionMetadataInput,
  ): Promise<{ updated: boolean }> {
    if (!this.options.renameSession) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "rename_session is unavailable.");
    }
    return this.options.renameSession(input);
  }

  async tagSession(
    input: import("../protocol/types.js").GatewaySessionMetadataInput,
  ): Promise<{ updated: boolean }> {
    if (!this.options.tagSession) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "tag_session is unavailable.");
    }
    return this.options.tagSession(input);
  }

  async deleteSession(input: { sessionKey: string; projectKey?: string }): Promise<void> {
    if (this.options.deleteEphemeralSession && await this.options.deleteEphemeralSession(input)) {
      this.dialogProjectKeys.delete(input.sessionKey);
      return;
    }
    if (!this.options.deleteSession) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "delete_session is unavailable.");
    }
    await this.options.deleteSession(input);
    this.dialogProjectKeys.delete(input.sessionKey);
  }

  async exportSessionTranscript(
    input: import("../protocol/types.js").GatewayExportSessionTranscriptInput,
  ): Promise<import("../protocol/types.js").GatewaySessionTranscriptArchive> {
    if (!this.options.exportSessionTranscript) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "export_session_transcript is unavailable.");
    }
    return this.options.exportSessionTranscript(input);
  }

  async restoreSessionTranscript(
    input: import("../protocol/types.js").GatewayRestoreSessionTranscriptInput,
  ): Promise<import("../protocol/types.js").GatewayRestoreSessionTranscriptResult> {
    if (!this.options.restoreSessionTranscript) {
      throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "restore_session_transcript is unavailable.");
    }
    return this.options.restoreSessionTranscript(input);
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
    const buffer = await readFile(canonical);
    return input.encoding === "base64"
      ? { path: input.path, content: buffer.subarray(0, maxBytes).toString("base64"), encoding: "base64" }
      : { path: input.path, content: buffer.subarray(0, maxBytes).toString("utf8"), encoding: "utf-8" };
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

  async setMcpPermissionModeOverride(input: GatewayMcpPermissionModeOverrideInput): Promise<GatewayMcpPermissionModeOverrideResult> {
    if (!this.options.setMcpPermissionModeOverride) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "set_mcp_permission_mode_override is unavailable.");
    if (!input.sessionKey?.trim() || !input.serverName?.trim()) throw new DialogGatewayError("INVALID_MCP_SERVER", "sessionKey and serverName are required.");
    if (input.mode !== null && input.mode !== "default" && input.mode !== "auto") {
      throw new DialogGatewayError("INVALID_MCP_PERMISSION_MODE", `Unsupported MCP permission mode: ${input.mode}`);
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change MCP permission mode while a turn is active.");
    const result = await this.options.setMcpPermissionModeOverride(input);
    await this.router.close(input.sessionKey);
    return result;
  }

  async setPermissionMode(input: import("../protocol/types.js").GatewaySetPermissionModeInput): Promise<{ applied: boolean }> {
    if (input.mode !== "default" && input.mode !== "plan" && input.mode !== "bypassPermissions") {
      throw new DialogGatewayError("INVALID_PERMISSION_MODE", `Unsupported permission mode: ${input.mode}`);
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change permission mode during an active turn.");
    this.permissionModes.set(input.sessionKey, input.mode);
    if (this.options.setPermissionMode) return this.options.setPermissionMode(input);
    return { applied: true };
  }

  async clearPermissionMode(input: { sessionKey: string; projectKey?: string }): Promise<void> {
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot clear permission mode during an active turn.");
    this.permissionModes.clear(input.sessionKey);
    await this.options.clearPermissionMode?.(input);
  }

  async applyFlagSettings(input: GatewayApplyFlagSettingsInput): Promise<GatewayApplyFlagSettingsResult> {
    if (!this.options.applyFlagSettings) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "apply_flag_settings is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
      throw new DialogGatewayError("INVALID_FLAG_SETTINGS", "settings must be an object.");
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot apply flag settings during an active turn.");
    validateSdkFlagSettings(input.settings);
    const result = await this.options.applyFlagSettings(input);
    if (result.applied.length > 0 || result.cleared.length > 0) await this.router.close(input.sessionKey);
    return result;
  }

  async updateSettings(input: GatewayUpdateSettingsInput): Promise<GatewayUpdateSettingsResult> {
    if (!this.options.updateSettings) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "update_settings is unavailable.");
    if (input.source !== "localSettings") throw new DialogGatewayError("INVALID_SETTINGS_SOURCE", "Only localSettings is supported.");
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
      throw new DialogGatewayError("INVALID_LOCAL_SETTINGS", "settings must be an object.");
    }
    return this.options.updateSettings(input);
  }

  async resolveSettings(): Promise<GatewayResolvedSettingsResult> {
    if (!this.options.resolveSettings) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "resolve_settings is unavailable.");
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

  async stopBackgroundTask(input: import("../protocol/types.js").GatewayStopBackgroundTaskInput): Promise<import("../protocol/types.js").GatewayStopBackgroundTaskResult> {
    if (!this.options.stopBackgroundTask) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "background_task_stop is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.taskId?.trim()) throw new DialogGatewayError("INVALID_TASK_ID", "taskId is required.");
    return this.options.stopBackgroundTask(input);
  }

  async backgroundTasks(input: import("../protocol/types.js").GatewayBackgroundTasksInput): Promise<import("../protocol/types.js").GatewayBackgroundTasksResult> {
    if (!this.options.backgroundTasks) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "background_tasks is unavailable.");
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    return this.options.backgroundTasks(input);
  }

  async seedReadState(input: GatewaySeedReadStateInput): Promise<GatewaySeedReadStateResult> {
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.path?.trim()) throw new DialogGatewayError("INVALID_FILE_PATH", "path is required.");
    if (!Number.isFinite(input.mtime) || !Number.isInteger(input.mtime) || input.mtime < 0) {
      throw new DialogGatewayError("INVALID_FILE_MTIME", "mtime must be a non-negative integer in milliseconds.");
    }
    if (this.router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot seed file read state while a turn is active.");
    if (input.workspaceCwd && this.options.setSessionCwd) this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    if (input.sdkSessionConfig) {
      if (!this.options.setSdkSessionConfig) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "sdk_session_config is unavailable.");
      validateSdkSessionConfig(input.sdkSessionConfig);
      const configUpdate = await this.options.setSdkSessionConfig(input.sessionKey, input.sdkSessionConfig, input.projectKey);
      if (configUpdate.changed) await this.router.close(input.sessionKey);
    }
    return this.router.seedReadState({
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

  private async resolveUploadedAttachments(input: GatewaySubmitTurnInput): Promise<ResolvedUploadedAttachments> {
    if (!input.projectKey) throw new DialogGatewayError("PROJECT_NOT_FOUND", "projectKey is required for uploaded attachments.");
    if (!this.options.resolveUploadedAttachments) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "Uploaded attachments are unavailable.");
    return this.options.resolveUploadedAttachments({ projectKey: input.projectKey, uploads: input.uploadedAttachments ?? [] });
  }

  private prepareAttachmentTurn(
    message: string,
    attachments: ChannelAttachment[] | undefined,
    projectRoot?: string,
  ) {
    return this.attachmentTurnComposer.prepare({
      message,
      attachments,
      projectRoot,
      funasrInstallCommand: this.options.funasrInstallCommand ?? getPilotDeckInstallCommand(),
    });
  }

  async getActiveTurnSnapshot(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot> {
    return this.turnEventCoordinator.snapshot(input);
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
    const result = this.interactionCoordinator.respondElicitation(input);
    if (result.delivered) {
      this.options.dispatchHookForSession?.(input.sessionKey, "ElicitationResult", {
        requestId: input.requestId,
        delivered: true,
      });
    }
    return result;
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
    if (this.userDialogBus.release(input.sessionKey, input.requestId, input.leaseId.trim())) {
      return { released: true };
    }
    const hosted = await this.options.releaseHostedUserDialog?.(input);
    return { released: hosted ?? false };
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    return this.interactionCoordinator.decidePermission(input);
  }

  async grantSessionPermission(input: GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }> {
    return this.interactionCoordinator.grantSessionPermission(input);
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    if (!this.options.readSessionMessages) {
      throw new Error(
        "read_session_messages is not configured. Wire `readSessionMessages` via createLocalGateway.",
      );
    }
    // A turn snapshot is an epoch. If it settles or is replaced while durable
    // history is being read, reread so the completed turn cannot fall between
    // the durable result and the live replay snapshot.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.turnEventCoordinator.snapshot({
        sessionKey: input.sessionKey,
        includeEvents: false,
      });
      const history = await this.options.readSessionMessages(input);
      const stream = this.turnEventCoordinator.snapshot({ sessionKey: input.sessionKey });
      if (!sameTurnEpoch(before, stream)) continue;
      return { ...history, stream };
    }
    throw new Error("Session changed during transcript synchronization; retry the snapshot.");
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
    return this.turnReplacementCoordinator.replaceLastTurn(input);
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    return this.turnReplacementCoordinator.finalizeLastTurnReplacement(input);
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

  setAlwaysOnControl(control: AlwaysOnControlPort | undefined): void {
    (this.options as { alwaysOnControl?: AlwaysOnControlPort }).alwaysOnControl = control;
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

  private requireSkills(): SkillManagementPort {
    if (!this.options.skillManager) {
      throw new SkillManagerError(
        "not_configured",
        "Skill manager is not configured on this gateway.",
      );
    }
    return this.options.skillManager;
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    if (!this.options.alwaysOnControl) {
      return { sessionKey: "", error: { code: "not_configured", message: "Always-On apply is not configured on this gateway." } };
    }
    return this.options.alwaysOnControl.applyCycle(input);
  }

  async alwaysOnAbort(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult> {
    if (!this.options.alwaysOnControl) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: { code: "not_configured", message: "Always-On abort is not configured on this gateway." },
      };
    }
    return this.options.alwaysOnControl.abortRun(input);
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    if (!this.options.alwaysOnControl) {
      return { runId: "", error: { code: "not_configured", message: "Always-On rerun is not configured on this gateway." } };
    }
    return this.options.alwaysOnControl.rerunPlan(input);
  }

  private requireCron(): GatewayCronController {
    if (!this.options.cron) {
      throw new Error("Cron runtime is not configured.");
    }
    return this.options.cron;
  }

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
  if (isPermissionMode(value)) {
    return value;
  }
  return undefined;
}

function validateGatewayPermissionModes(input: GatewaySubmitTurnInput): string | undefined {
  const mode = (input as { mode?: unknown }).mode;
  if (mode !== undefined && mode !== null && mode !== "" && !isPermissionMode(mode)) {
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
  if (config.managedModels !== undefined) {
    const managed = config.managedModels;
    const validSelector = (value: unknown): value is string => typeof value === "string"
      && (value === "*" || /^[^/*\s]+\/(?:\*|[^/*\s]+)$/.test(value));
    if (!managed || typeof managed !== "object" || Array.isArray(managed)
      || !Array.isArray(managed.allow) || !Array.isArray(managed.deny)
      || managed.allow.some((entry) => !validSelector(entry))
      || managed.deny.some((entry) => !validSelector(entry))) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        "managedModels selectors must be *, provider/*, or provider/model.",
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
      || Object.keys(config.sandbox as Record<string, unknown>).some((key) => key !== "type" && key !== "filesystem" && key !== "network" && key !== "process")
      || (config.sandbox.type !== undefined && config.sandbox.type !== "tool_policy")
      || (config.sandbox.filesystem !== undefined
        && config.sandbox.filesystem !== "read_only"
        && config.sandbox.filesystem !== "deny")
      || (config.sandbox.network !== undefined && config.sandbox.network !== "deny")
      || (config.sandbox.process !== undefined && config.sandbox.process !== "deny")
      || (config.sandbox.filesystem === undefined
        && config.sandbox.network === undefined
        && config.sandbox.process === undefined))) {
    throw new DialogGatewayError(
      "INVALID_SDK_SESSION_CONFIG",
      "sandbox must contain supported tool_policy restrictions.",
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
  return parseAgentRunMode(value) ?? "agent";
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

function parseCompactCommand(message: string): { isCompactCommand: boolean; valid: boolean } {
  const trimmed = message.trim();
  if (!/^\/compact(?:\s|$)/u.test(trimmed)) return { isCompactCommand: false, valid: false };
  return { isCompactCommand: true, valid: /^\/compact$/u.test(trimmed) };
}

function operationDeadlineForTimeout(
  timeoutMs: number | undefined,
  now: () => Date,
): string | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const startedAt = now().getTime();
  if (!Number.isFinite(startedAt)) return undefined;
  return new Date(startedAt + timeoutMs).toISOString();
}

function sameTurnEpoch(
  left: GatewayActiveTurnSnapshot,
  right: GatewayActiveTurnSnapshot,
): boolean {
  return left.active === right.active
    && left.runId === right.runId
    && left.terminal === right.terminal;
}
