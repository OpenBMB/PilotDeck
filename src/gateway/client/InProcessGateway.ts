import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent, AgentInput, AgentTurnResult } from "../../agent/index.js";
import {
  flattenToolResultBlockText,
  type CanonicalContentBlock,
  type CanonicalModelEvent,
} from "../../model/index.js";
import { contentToText } from "../../tool/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import { AsyncQueue } from "../util/AsyncQueue.js";
import type {
  ChannelAttachment,
  GatewayCronController,
  Gateway,
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewaySessionPermissionGrantInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  ReloadConfigResult,
  WebProjectModelSettingsResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadProjectModelSettingsInput,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  WebSaveProjectModelSettingsInput,
  WebSaveProjectModelSettingsResult,
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
} from "../../cron/protocol/types.js";
import { permissionEntryToRule, permissionSettingsToRuleSet, readPermissionSettings } from "../../permission/index.js";
import type { PermissionRule } from "../../permission/index.js";
import { SkillManagerError, type SkillManager } from "../../extension/skills/index.js";
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
import type { TelemetryClient } from "../../telemetry/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";

const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";

export type InProcessGatewayOptions = {
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
  /**
   * Web Phase 3 — pluggable project enumerator + describer.
   */
  listProjects?: () => Promise<WebListProjectsResult>;
  describeProject?: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
  readProjectModelSettings?: (input: WebReadProjectModelSettingsInput) => Promise<WebProjectModelSettingsResult>;
  saveProjectModelSettings?: (input: WebSaveProjectModelSettingsInput) => Promise<WebSaveProjectModelSettingsResult>;
  /**
   * Pluggable config-reload handler wired by `createLocalGateway`.
   * When set, `reloadConfig()` delegates to this callback which owns
   * the PilotConfigStore + ProjectRuntimeRegistry lifecycle.
   */
  reloadConfig?: () => Promise<ReloadConfigResult>;
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
  refreshConfigBeforeTurn?: (input: GatewaySubmitTurnInput) => Promise<void>;
  /**
   * Authoritative skill CRUD manager backed by `~/.pilotdeck/skills/`.
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

type ActiveTurnReplay = {
  sessionKey: string;
  runId: string;
  events: GatewayEvent[];
  bytes: number;
  truncated: boolean;
};

export class InProcessGateway implements Gateway {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  /**
   * B1 — registry of active per-session emit sinks. The gateway shares this
   * map with the per-session `GatewayElicitationChannel` so an `askUser`
   * call can surface an `elicitation_request` event into the active
   * `submitTurn` stream from outside the agent's event iterator.
   */
  private readonly emitSinks = new Map<string, (event: GatewayEvent) => void>();
  private readonly activeTurnReplays = new Map<string, ActiveTurnReplay>();
  /** B1 — pending askUser() promises keyed by sessionKey + requestId. */
  private readonly elicitationBus = new GatewayElicitationBus();
  /**
   * Web Phase 2 — pending permission-decision promises. Tools that need
   * Web confirmation register here while the host UI shows the banner.
   */
  private readonly permissionBus = new GatewayPermissionBus();
  private readonly sessionPermissionGrants = new Map<string, PermissionRule[]>();
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
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.elicitationBus;
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
    this.recordActiveTurnEvent(sessionKey, event);
    sink(event);
    return true;
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

    // Per-turn config refresh (defensive). The fs watcher path already
    // catches most edits, but this guarantees a fresh apiKey/url is in
    // effect for the very next turn even when watcher events are
    // dropped or coalesced.
    if (this.options.refreshConfigBeforeTurn) {
      try {
        await this.options.refreshConfigBeforeTurn(input);
      } catch {
        // Intentional: keep streaming on the previous snapshot rather
        // than failing a turn over a transient yaml read error.
      }
    }
    const runId = input.runId ?? this.uuid();
    if (!this.router.beginTurn(input.sessionKey, runId)) {
      yield {
        type: "error",
        code: "session_busy",
        message: `Session ${input.sessionKey} already has an active turn.`,
        recoverable: true,
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

    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }

    const telemetryContext = resolveSubmitTurnTelemetry(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    // Background pump: agent events → queue.
    const pump = (async () => {
      try {
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
        });
        if (input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const gatewayEvent: GatewayEvent = {
              type: "error",
              code: "turn_timeout",
              message: `Turn exceeded the ${input.timeoutMs}ms timeout.`,
              recoverable: false,
            };
            this.recordActiveTurnEvent(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
            this.elicitationBus.rejectSession(input.sessionKey, "turn_timeout");
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
        const inputMode = normalizeGatewayModeForLegacyInput((input as { mode?: unknown }).mode);
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
        const agentInput = await buildAgentInputWithAttachments(
          input.message,
          input.attachments,
        );
        for await (const event of session.submit(
          agentInput,
          {
            turnId: runId,
            maxTurns: input.maxTurns,
            permissionMode,
            basePermissionMode,
            allowPlanModeTools,
            canPrompt: input.canPrompt,
            permissionRules: {
              ...persistedRules,
              allow: [...sessionAllowRules, ...persistedRules.allow],
            },
            sudoPolicy: permissionSettings.sudoPolicy,
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
          for (const gatewayEvent of mapAgentEvent(event, runId)) {
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
          const gatewayEvent: GatewayEvent = {
            type: "error",
            code: "gateway_submit_failed",
            message: error instanceof Error ? error.message : String(error),
            recoverable: false,
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
      this.emitSinks.delete(input.sessionKey);
      this.activeTurnReplays.delete(input.sessionKey);
      this.elicitationBus.rejectSession(input.sessionKey, "turn_ended");
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
      this.options.afterTurnCompleted?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        runId,
      });
    }
  }

  async abortTurn(input: { sessionKey: string; runId?: string }): Promise<void> {
    await this.router.abort(input.sessionKey, input.runId ? `aborted:${input.runId}` : "aborted");
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
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return {
      mode: "in_process",
      sessionCount: this.router.sessionCount(),
      ...this.options.serverInfo,
    };
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
      events: replay.events
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

  async readProjectModelSettings(input: WebReadProjectModelSettingsInput): Promise<WebProjectModelSettingsResult> {
    if (!this.options.readProjectModelSettings) {
      throw new Error("read_project_model_settings is not configured.");
    }
    return this.options.readProjectModelSettings(input);
  }

  async saveProjectModelSettings(input: WebSaveProjectModelSettingsInput): Promise<WebSaveProjectModelSettingsResult> {
    if (!this.options.saveProjectModelSettings) {
      throw new Error("save_project_model_settings is not configured.");
    }
    return this.options.saveProjectModelSettings(input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    if (!this.options.reloadConfig) {
      return { reloaded: false };
    }
    return this.options.reloadConfig();
  }

  async reloadExtensions(input?: import("../protocol/types.js").ReloadExtensionsInput): Promise<import("../protocol/types.js").ReloadExtensionsResult> {
    if (!this.options.reloadExtensions) {
      return { reloaded: false };
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
    if (event.type === "elicitation_cancelled") {
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
}

function cloneGatewayEvent(event: GatewayEvent): GatewayEvent {
  return JSON.parse(JSON.stringify(event)) as GatewayEvent;
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

export function normalizeGatewayModeForLegacyInput(value: unknown): GatewaySubmitTurnInput["mode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "default" || value === "plan" || value === "bypassPermissions") {
    return value;
  }
  return "default";
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

export function mapAgentEvent(event: AgentEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "turn_started":
      return [{ type: "turn_started", runId }];
    case "model_request_started":
      return [{ type: "model_request_started", model: event.model, provider: event.provider }];
    case "model_event":
      return mapModelEvent(event.event);
    case "tool_calls_detected":
      return event.calls.map((call) => ({
        type: "tool_call_started",
        toolCallId: call.id,
        name: call.name,
        argsPreview: previewUnknown(call.input),
      }));
    case "tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
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

      return [
        {
          type: "tool_call_finished",
          toolCallId: event.result.toolCallId,
          ok: event.result.type === "success",
          resultPreview: fullText,
          resultLineCount: lineCount,
          resultBytes: totalBytes,
          toolName: event.result.toolName,
          resultPath,
          ...(images.length > 0 ? { images } : {}),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
          ...(event.result.type === "success" && event.result.data
            ? { data: event.result.data as Record<string, unknown> }
            : {}),
        },
      ];
    }
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
        },
      ];
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
        detail: { trigger: event.trigger, preTokens: event.preTokens },
      }];
    case "compact_completed":
      return [{
        type: "agent_status",
        event: "compact_completed",
        detail: { status: event.status, preTokens: event.preTokens, postTokens: event.postTokens },
      }];
    case "context_budget":
      return [{
        type: "context_budget",
        used: event.snapshot.tokens,
        total: event.snapshot.maxContextTokens,
        ratio: event.snapshot.ratio,
        state: event.snapshot.state,
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
        detail: { subagentId: event.subagentId, subagentType: event.subagentType, success: event.success, durationMs: event.durationMs },
      }];
    case "subagent_model_event":
      return mapSubagentModelEvent(event);
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
          content: fullText,
          preview: lines.slice(0, 3).join("\n"),
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
      return [];
    case "elicitation_requested":
      return [];
    default:
      return [];
  }
}

function mapModelEvent(event: CanonicalModelEvent): GatewayEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_text_delta", text: event.text }];
    case "thinking_delta":
      return [{ type: "assistant_thinking_delta", text: event.text }];
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
): GatewayEvent[] {
  const base = {
    subagentId: event.subagentId,
    subagentType: event.subagentType,
  };
  switch (event.event.type) {
    case "text_delta":
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

async function buildAgentInputWithAttachments(
  message: string,
  attachments: ChannelAttachment[] | undefined,
): Promise<AgentInput> {
  const attachmentBlocks = await attachmentsToContentBlocks(attachments);
  if (attachmentBlocks.length === 0) {
    return { type: "text", text: message };
  }
  const blocks: CanonicalContentBlock[] = [];
  if (message && message.length > 0) {
    blocks.push({ type: "text", text: message });
  }
  for (const block of attachmentBlocks) {
    blocks.push(block);
  }
  return { type: "blocks", content: blocks };
}

async function attachmentsToContentBlocks(
  attachments: ChannelAttachment[] | undefined,
): Promise<CanonicalContentBlock[]> {
  if (!attachments || attachments.length === 0) return [];
  const blocks: CanonicalContentBlock[] = [];
  const resolverRequests: AttachmentRequest[] = [];
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
      continue;
    }

    if (att.type === "text" && att.content) {
      blocks.push({ type: "text", text: att.content });
      continue;
    }

    if (!att.path) continue;
    if (att.type === "image" || att.mimeType?.startsWith("image/")) {
      resolverRequests.push({ type: "image", path: att.path, mimeType: att.mimeType });
    } else if (att.mimeType === "application/pdf" || att.path.toLowerCase().endsWith(".pdf")) {
      resolverRequests.push({ type: "pdf", path: att.path });
    } else {
      resolverRequests.push({ type: "file", path: att.path });
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
  }

  if (diagnostics.length > 0) {
    blocks.push({
      type: "text",
      text: `[Attachment diagnostics]\n${diagnostics.map((message) => `- ${message}`).join("\n")}`,
    });
  }

  return blocks;
}
