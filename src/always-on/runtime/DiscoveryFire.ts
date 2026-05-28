import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../gateway/index.js";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { buildChatDigest } from "../context/ChatDigestBuilder.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import { buildFallbackReport, type ReportMetadata } from "../contracts/ReportContract.js";
import { AlwaysOnError } from "../protocol/errors.js";
import type {
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  AlwaysOnEventPhase,
  DiscoveryFireResult,
  DiscoveryPlanRecord,
  DiscoveryRunHistoryEvent,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import type { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import type { AlwaysOnRunContextRegistry, ExecutionRunContext, DiscoveryRunContext, WorkspaceRunContext, ReportRunContext } from "./AlwaysOnRunContextRegistry.js";
import { generateWorkspaceDiff } from "../workspace/WorkspaceApply.js";
import { buildDiscoveryPrompt, buildExecutionPrompt, buildWorkspacePrompt, buildReportPrompt, buildApplyPrompt } from "./discoveryPrompts.js";
import type { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import type { PermissionRule } from "../../permission/index.js";

export type DiscoveryFireDependencies = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  gateway: Gateway;
  runContexts: AlwaysOnRunContextRegistry;
  workspaceRegistry: WorkspaceProviderRegistry;
  sessionOverrides: SessionConfigOverrides;
  stateStore: DiscoveryStateStore;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  reportStore: DiscoveryReportStore;
  eventStore: AlwaysOnEventStore;
  uuid: () => string;
  now: () => Date;
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void };
  onTurnEvent?: (sessionKey: string, channelKey: string, event: GatewayEvent) => void;
};

export type DiscoveryFireRunInput = {
  /** Pre-allocated runId (already used by the lock + state store). */
  runId: string;
  startedAt: Date;
};

const DISCOVERY_CHANNEL: GatewayChannelKey = "always-on/discovery";
const WORKSPACE_CHANNEL: GatewayChannelKey = "always-on/workspace";
const EXECUTION_CHANNEL: GatewayChannelKey = "always-on/execute";
const REPORT_CHANNEL: GatewayChannelKey = "always-on/report";
const APPLY_CHANNEL: GatewayChannelKey = "always-on/apply";

/**
 * Tools that require user interaction or could block an unattended session.
 * Excluded from all Always-On agent loops via SessionConfigOverride.excludeTools.
 */
const ALWAYS_ON_EXCLUDED_TOOLS = [
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
];

/**
 * Deny rules injected into the execution phase session. These override
 * `bypassPermissions` because deny rules always win in `PermissionRuntime.decide()`.
 * Prevents the agent from pushing code or modifying remote configuration.
 */
export const ALWAYS_ON_EXECUTION_DENY_RULES: PermissionRule[] = [
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git remote*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git remote*" },
];

export type EnsureActiveWorkCycleInput = {
  state: AlwaysOnDiscoveryState;
  projectKey: string;
  runId: string;
  cycleId: string;
  workspaceRegistry: WorkspaceProviderRegistry;
  stateStore: DiscoveryStateStore;
  cycleStore: WorkCycleStore;
  now: () => Date;
  fileExists?: (path: string) => boolean;
};

export type EnsureActiveWorkCycleResult = {
  handle: WorkspaceHandle;
  cycle: WorkCycleRecord;
  reused: boolean;
};

/**
 * Look up the project's active work cycle. If a cycle exists with its
 * workspace still on disk, reuse it. Otherwise prepare a new workspace and
 * create a new cycle. Always-On runs at most one active cycle (and one
 * workspace) per project; this function is the single source of truth.
 */
export async function ensureActiveWorkCycle(
  input: EnsureActiveWorkCycleInput,
): Promise<EnsureActiveWorkCycleResult> {
  const fileExists = input.fileExists ?? existsSync;

  if (input.state.activeWorkCycleId) {
    const existing = await input.cycleStore.getRecord(input.state.activeWorkCycleId);
    if (existing && existing.status === "active" && fileExists(existing.workspace.cwd)) {
      return {
        handle: {
          runId: existing.createdByRunId,
          projectKey: input.projectKey,
          strategy: existing.workspace.strategy,
          cwd: existing.workspace.cwd,
          metadata: { ...existing.workspace.metadata },
        },
        cycle: existing,
        reused: true,
      };
    }
  }

  // Legacy migration: state still has currentWorkspace but no activeWorkCycleId
  if (input.state.currentWorkspace && fileExists(input.state.currentWorkspace.cwd)) {
    const ref = input.state.currentWorkspace;
    const handle: WorkspaceHandle = {
      runId: ref.runId,
      projectKey: input.projectKey,
      strategy: ref.strategy,
      cwd: ref.cwd,
      metadata: { ...ref.metadata },
    };
    const cycle = await input.cycleStore.create(handle, ref.runId, input.cycleId, input.now());
    await input.stateStore.setActiveWorkCycleId(cycle.id, input.now());
    return { handle, cycle, reused: true };
  }

  const prepared = await input.workspaceRegistry.prepare({
    projectRoot: input.projectKey,
    runId: input.runId,
  });
  const cycle = await input.cycleStore.create(
    prepared.handle,
    input.runId,
    input.cycleId,
    input.now(),
  );
  await input.stateStore.setActiveWorkCycleId(cycle.id, input.now());
  return { handle: prepared.handle, cycle, reused: false };
}

export class DiscoveryFire {
  constructor(private readonly deps: DiscoveryFireDependencies) {}

  private emitEvent(
    runId: string,
    phase: AlwaysOnEventPhase,
    extra?: { title?: string; planId?: string; outcome?: AlwaysOnDiscoveryOutcome; error?: { code: string; message: string } },
  ): void {
    this.deps.eventStore
      .appendEvent({
        schemaVersion: 1,
        eventId: this.deps.uuid(),
        runId,
        projectKey: this.deps.projectKey,
        phase,
        timestamp: this.deps.now().toISOString(),
        ...extra,
      })
      .catch(() => undefined);
  }

  static deriveDiscoverySessionKey(projectKey: string, runId: string): string {
    return `always-on/discovery:project=${projectKey}:run=${runId}`;
  }

  static deriveWorkspaceSessionKey(projectKey: string, runId: string): string {
    return `always-on/workspace:project=${projectKey}:run=${runId}`;
  }

  static deriveExecutionSessionKey(projectKey: string, runId: string): string {
    return `always-on/execute:project=${projectKey}:run=${runId}`;
  }

  static deriveReportSessionKey(projectKey: string, runId: string): string {
    return `always-on/report:project=${projectKey}:run=${runId}`;
  }

  static deriveApplySessionKey(projectKey: string, runId: string): string {
    return `always-on/apply:project=${projectKey}:run=${runId}`;
  }

  async runApplyPhase(input: {
    runId: string;
    cycle: WorkCycleRecord;
    plans: Array<{ id: string; title: string }>;
    projectName: string;
    projectRoot: string;
  }): Promise<{ events: GatewayEvent[]; error?: { code: string; message: string }; sessionKey: string }> {
    const { cycle, projectRoot } = input;

    const diff = await generateWorkspaceDiff(
      cycle.workspace.strategy,
      cycle.workspace.cwd,
      projectRoot,
    );

    const sessionKey = DiscoveryFire.deriveApplySessionKey(this.deps.projectKey, input.runId);
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: projectRoot,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
    });

    try {
      const events = await this.drainTurn({
        sessionKey,
        channelKey: APPLY_CHANNEL,
        runId: `${input.runId}.apply`,
        message: buildApplyPrompt({
          plan: {
            id: cycle.id,
            title: input.plans.map((p) => p.title).join("; "),
            workspace: { cwd: cycle.workspace.cwd, strategy: cycle.workspace.strategy },
          },
          projectName: input.projectName,
          projectRoot,
          diff,
          branchName: cycle.workspace.metadata?.branchName as string | undefined,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      const error = pickFirstError(events);
      return {
        events,
        sessionKey,
        error: error ? { code: error.code ?? "apply_failed", message: error.message } : undefined,
      };
    } finally {
      this.deps.sessionOverrides.delete(sessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }
  }

  async rerunPlan(input: {
    planId: string;
    runId: string;
    startedAt: Date;
  }): Promise<DiscoveryFireResult> {
    const { planId, runId, startedAt } = input;

    const planRecord = await this.deps.planStore.getRecord(planId);
    if (!planRecord) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_not_found", message: `Plan ${planId} not found` },
      };
    }

    const planMarkdown = await this.deps.planStore.readPlanMarkdown(planId);
    if (!planMarkdown) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_body_missing", message: `Plan markdown for ${planId} not found on disk` },
      };
    }

    await this.deps.planStore.updateStatus(planId, { status: "ready" });

    const baseHistory: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId,
      planId,
      startedAt: startedAt.toISOString(),
      outcome: "no_plan",
    };

    const state = await this.deps.stateStore.read(startedAt);

    // Phase 2: Workspace
    let workspace: WorkspaceHandle;
    let workCycle: WorkCycleRecord;
    try {
      const wsResult = await this.runWorkspacePhase({ runId, state });
      workspace = wsResult.handle;
      workCycle = wsResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent(runId, "run_failed", { planId, error: { code, message }, outcome: "failed" });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId, now: finishedAt });
      await this.deps.reportStore.appendHistory({ ...baseHistory, outcome: "failed", finishedAt: finishedAt.toISOString(), error: { code, message } });
      return { outcome: "failed", runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, error: { code, message } };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();

    // Phase 3: Execution
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
      permissionRules: { deny: ALWAYS_ON_EXECUTION_DENY_RULES },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planId, { status: "executing", workCycleId: workCycle.id });
    await this.deps.cycleStore.addPlan(workCycle.id, planId);
    this.emitEvent(runId, "execution_started", { planId, title: planRecord.title });

    let executionError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: executionSessionKey,
        channelKey: EXECUTION_CHANNEL,
        runId: `${runId}.execute`,
        message: buildExecutionPrompt({
          plan: planRecord,
          planMarkdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      executionError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.deps.gateway.closeSession({ sessionKey: executionSessionKey, reason: "always-on/done" }).catch(() => undefined);
    }

    if (executionError) {
      this.emitEvent(runId, "run_failed", { planId, error: { code: executionError.code ?? "execution_failed", message: executionError.message }, outcome: "failed" });
      const finishedAt = this.deps.now();
      const reportFilePath = await this.writeFallbackReport({ runId, plan: planRecord, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), reason: `execution_failed: ${executionError.message}`, workspaceStrategy: workspace.strategy, workspaceHandle: workspace.cwd });
      await this.deps.planStore.updateStatus(planId, { status: "failed", reportFilePath, workCycleId: workCycle.id });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId, now: finishedAt });
      await this.deps.reportStore.appendHistory({ ...baseHistory, outcome: "failed", finishedAt: finishedAt.toISOString(), workCycleId: workCycle.id, workspace: { strategy: workspace.strategy, handle: workspace.cwd }, error: { code: executionError.code ?? "execution_failed", message: executionError.message } });
      return { outcome: "failed", runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, workspace, reportFilePath, error: { code: executionError.code ?? "execution_failed", message: executionError.message } };
    }

    this.emitEvent(runId, "execution_completed", { planId, title: planRecord.title });

    // Phase 4: Report
    const reportSessionKey = DiscoveryFire.deriveReportSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(reportSessionKey, { cwd: workspace.cwd, permissionMode: "bypassPermissions", bypassAvailable: true, canPrompt: false, excludeTools: ALWAYS_ON_EXCLUDED_TOOLS });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey: reportSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: reportSessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({ plan: planRecord, planMarkdown, workspaceCwd: workspace.cwd, workspaceStrategy: workspace.strategy, language: this.deps.config.language }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      reportError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(reportSessionKey);
      this.deps.sessionOverrides.delete(reportSessionKey);
      await this.deps.gateway.closeSession({ sessionKey: reportSessionKey, reason: "always-on/done" }).catch(() => undefined);
    }

    const finishedAt = this.deps.now();
    const outcome: AlwaysOnDiscoveryOutcome = reportCtx.report && !reportError ? "executed" : "failed";

    if (reportCtx.report && !reportError) {
      this.emitEvent(runId, "report_produced", { planId, title: planRecord.title, outcome });
      this.emitEvent(runId, "run_completed", { planId, title: planRecord.title, outcome });
    } else {
      this.emitEvent(runId, "run_failed", { planId, error: reportError ? { code: reportError.code ?? "report_failed", message: reportError.message } : { code: "report_tool_not_invoked", message: "Report tool was not invoked" }, outcome });
    }

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.writeFallbackReport({ runId, plan: planRecord, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), reason: reportError ? `report_failed: ${reportError.message}` : "report_tool_not_invoked", workspaceStrategy: workspace.strategy, workspaceHandle: workspace.cwd });
    }

    await this.deps.planStore.updateStatus(planId, { status: outcome === "executed" ? "completed" : "failed", reportFilePath, workCycleId: workCycle.id });
    await this.deps.stateStore.markFireCompleted({ outcome, runId, planId, now: finishedAt });
    await this.deps.reportStore.appendHistory({ ...baseHistory, outcome, finishedAt: finishedAt.toISOString(), workCycleId: workCycle.id, workspace: { strategy: workspace.strategy, handle: workspace.cwd }, error: reportError ? { code: reportError.code ?? "report_failed", message: reportError.message } : undefined });

    return { outcome, runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, workspace, reportFilePath, error: reportError ? { code: reportError.code ?? "report_failed", message: reportError.message } : undefined };
  }

  async run(input: DiscoveryFireRunInput): Promise<DiscoveryFireResult> {
    const { runId, startedAt } = input;

    const state = await this.deps.stateStore.read(startedAt);

    const baseHistory: DiscoveryRunHistoryEvent = {
      schemaVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      outcome: "no_plan",
    };

    // ── Phase 1: Discovery (bypassPermissions) ──
    this.emitEvent(runId, "discovery_started");
    const discoverySessionKey = DiscoveryFire.deriveDiscoverySessionKey(this.deps.projectKey, runId);

    const activeCycle = state.activeWorkCycleId
      ? await this.deps.cycleStore.getRecord(state.activeWorkCycleId)
      : undefined;
    const existingWorkspace = activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)
      ? { cwd: activeCycle.workspace.cwd, strategy: activeCycle.workspace.strategy, metadata: activeCycle.workspace.metadata }
      : state.currentWorkspace && existsSync(state.currentWorkspace.cwd)
        ? state.currentWorkspace
        : undefined;

    const discoveryCtx: DiscoveryRunContext = {
      kind: "discovery",
      sessionKey: discoverySessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      startedAt,
      planStore: this.deps.planStore,
      planCallCount: 0,
    };
    this.deps.runContexts.register(discoveryCtx);
    this.deps.sessionOverrides.set(discoverySessionKey, {
      cwd: existingWorkspace?.cwd ?? this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
    });

    const chatDigest = await buildChatDigest({
      projectRoot: this.deps.projectKey,
      pilotHome: this.deps.paths.pilotHome,
      maxSessions: 10,
      maxPromptsPerSession: 8,
      maxPromptLength: 500,
    });
    discoveryCtx.chatSessionAliases = chatDigest.aliasMap;

    const planIndex = await this.deps.planStore.readIndex();
    const existingPlans = planIndex.plans.map((p) => ({
      id: p.id,
      title: p.title,
      dedupeKey: p.dedupeKey,
      status: p.status,
    }));

    let discoveryEvents: GatewayEvent[];
    try {
      discoveryEvents = await this.drainTurn({
        sessionKey: discoverySessionKey,
        channelKey: DISCOVERY_CHANNEL,
        runId: `${runId}.discovery`,
        message: buildDiscoveryPrompt({
          projectRoot: this.deps.projectKey,
          runId,
          createdAt: startedAt.toISOString(),
          chatDir: getPilotProjectChatDir(this.deps.projectKey, this.deps.paths.pilotHome),
          workspace: existingWorkspace
            ? { cwd: existingWorkspace.cwd, strategy: existingWorkspace.strategy }
            : undefined,
          chatDigest,
          existingPlans,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
    } finally {
      this.deps.runContexts.unregister(discoverySessionKey);
      this.deps.sessionOverrides.delete(discoverySessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: discoverySessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const discoveryError = pickFirstError(discoveryEvents);
    if (discoveryError && !discoveryCtx.plan) {
      const finishedAt = this.deps.now();
      this.emitEvent(runId, "run_failed", {
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
        outcome: "failed",
      });
      await this.markFailedNoPlan(runId, discoveryError, finishedAt, baseHistory);
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: "",
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
      };
    }

    if (!discoveryCtx.plan) {
      this.emitEvent(runId, "no_plan", { outcome: "no_plan" });
      const finishedAt = this.deps.now();
      await this.deps.stateStore.markFireCompleted({
        outcome: "no_plan",
        runId,
        now: finishedAt,
      });
      if (this.deps.config.dormancy.enabled) {
        await this.deps.stateStore.setDormant(finishedAt);
      }
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        finishedAt: finishedAt.toISOString(),
        outcome: "no_plan",
      });
      return {
        outcome: "no_plan",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    }

    const planRecord = discoveryCtx.plan.record;
    this.emitEvent(runId, "plan_produced", { title: planRecord.title, planId: planRecord.id });

    // ── Phase 2: Workspace (bypassPermissions, agent-driven) ──
    let workspace: WorkspaceHandle;
    let workCycle: WorkCycleRecord;
    try {
      const wsResult = await this.runWorkspacePhase({ runId, state });
      workspace = wsResult.handle;
      workCycle = wsResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent(runId, "run_failed", {
        planId: planRecord.id,
        error: { code, message },
        outcome: "failed",
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId: planRecord.id,
        now: finishedAt,
      });
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        planId: planRecord.id,
        outcome: "failed",
        finishedAt: finishedAt.toISOString(),
        error: { code, message },
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: planRecord.id,
        error: { code, message },
      };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();
    this.emitEvent(runId, "workspace_ready", { planId: planRecord.id });

    // ── Phase 3: Execution (bypassPermissions, plan only) ──
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
      permissionRules: {
        deny: ALWAYS_ON_EXECUTION_DENY_RULES,
      },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planRecord.id, {
      status: "executing",
      workCycleId: workCycle.id,
    });
    await this.deps.cycleStore.addPlan(workCycle.id, planRecord.id);
    this.emitEvent(runId, "execution_started", { planId: planRecord.id, title: planRecord.title });

    let executionError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: executionSessionKey,
        channelKey: EXECUTION_CHANNEL,
        runId: `${runId}.execute`,
        message: buildExecutionPrompt({
          plan: planRecord,
          planMarkdown: discoveryCtx.plan.markdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      executionError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: executionSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    if (executionError) {
      this.emitEvent(runId, "run_failed", {
        planId: planRecord.id,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
        outcome: "failed",
      });
      const finishedAt = this.deps.now();
      const reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: `execution_failed: ${executionError.message}`,
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
      await this.deps.planStore.updateStatus(planRecord.id, {
        status: "failed",
        reportFilePath,
        workCycleId: workCycle.id,
      });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId: planRecord.id, now: finishedAt });
      await this.deps.reportStore.appendHistory({
        ...baseHistory,
        planId: planRecord.id,
        outcome: "failed",
        finishedAt: finishedAt.toISOString(),
        workCycleId: workCycle.id,
        workspace: { strategy: workspace.strategy, handle: workspace.cwd },
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: planRecord.id,
        workspace,
        reportFilePath,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      };
    }

    this.emitEvent(runId, "execution_completed", { planId: planRecord.id, title: planRecord.title });

    // ── Phase 4: Report (bypassPermissions, independent agent loop) ──
    const reportSessionKey = DiscoveryFire.deriveReportSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(reportSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
    });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey: reportSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportError: { code?: string; message: string } | undefined;
    try {
      const events = await this.drainTurn({
        sessionKey: reportSessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({
          plan: planRecord,
          planMarkdown: discoveryCtx.plan.markdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
        persistEvents: true,
      });
      reportError = pickFirstError(events);
    } finally {
      this.deps.runContexts.unregister(reportSessionKey);
      this.deps.sessionOverrides.delete(reportSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: reportSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const finishedAt = this.deps.now();
    const outcome: AlwaysOnDiscoveryOutcome = reportCtx.report && !reportError ? "executed" : "failed";

    if (reportCtx.report && !reportError) {
      this.emitEvent(runId, "report_produced", { planId: planRecord.id, title: planRecord.title, outcome });
      this.emitEvent(runId, "run_completed", { planId: planRecord.id, title: planRecord.title, outcome });
    } else {
      this.emitEvent(runId, "run_failed", {
        planId: planRecord.id,
        error: reportError
          ? { code: reportError.code ?? "report_failed", message: reportError.message }
          : { code: "report_tool_not_invoked", message: "Report tool was not invoked" },
        outcome,
      });
    }

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: reportError
          ? `report_failed: ${reportError.message}`
          : "report_tool_not_invoked",
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
    }

    await this.deps.planStore.updateStatus(planRecord.id, {
      status: outcome === "executed" ? "completed" : "failed",
      reportFilePath,
      workCycleId: workCycle.id,
    });
    await this.deps.stateStore.markFireCompleted({
      outcome,
      runId,
      planId: planRecord.id,
      now: finishedAt,
    });
    await this.deps.reportStore.appendHistory({
      ...baseHistory,
      planId: planRecord.id,
      outcome,
      finishedAt: finishedAt.toISOString(),
      workCycleId: workCycle.id,
      workspace: { strategy: workspace.strategy, handle: workspace.cwd },
      error: reportError ? { code: reportError.code ?? "report_failed", message: reportError.message } : undefined,
    });

    return {
      outcome,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      planId: planRecord.id,
      workspace,
      reportFilePath,
      error: reportError ? { code: reportError.code ?? "report_failed", message: reportError.message } : undefined,
    };
  }

  /**
   * Phase 2: Ensure an isolated workspace exists for plan execution.
   *
   * The runtime decides deterministically whether to reuse an existing
   * workspace or create a new one — the agent loop is only started when
   * a fresh workspace is needed.
   */
  private async runWorkspacePhase(input: {
    runId: string;
    state: AlwaysOnDiscoveryState;
  }): Promise<{ handle: WorkspaceHandle; cycle: WorkCycleRecord }> {
    const { runId, state } = input;

    // ── Deterministic reuse check ──
    if (state.activeWorkCycleId) {
      const activeCycle = await this.deps.cycleStore.getRecord(state.activeWorkCycleId);
      if (activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)) {
        return {
          handle: {
            runId: activeCycle.createdByRunId,
            projectKey: this.deps.projectKey,
            strategy: activeCycle.workspace.strategy,
            cwd: activeCycle.workspace.cwd,
            metadata: { ...activeCycle.workspace.metadata },
          },
          cycle: activeCycle,
        };
      }
    }

    // ── No reusable workspace — start agent loop to create one ──
    const workspaceSessionKey = DiscoveryFire.deriveWorkspaceSessionKey(this.deps.projectKey, runId);

    const workspaceCtx: WorkspaceRunContext = {
      kind: "workspace",
      sessionKey: workspaceSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspaceRegistry: this.deps.workspaceRegistry,
      stateStore: this.deps.stateStore,
      cycleStore: this.deps.cycleStore,
      now: this.deps.now,
    };
    this.deps.runContexts.register(workspaceCtx);
    this.deps.sessionOverrides.set(workspaceSessionKey, {
      cwd: this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: ALWAYS_ON_EXCLUDED_TOOLS,
    });

    try {
      await this.drainTurn({
        sessionKey: workspaceSessionKey,
        channelKey: WORKSPACE_CHANNEL,
        runId: `${runId}.workspace`,
        message: buildWorkspacePrompt({
          projectRoot: this.deps.projectKey,
          runId,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
    } finally {
      this.deps.runContexts.unregister(workspaceSessionKey);
      this.deps.sessionOverrides.delete(workspaceSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: workspaceSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const cycleId = this.deps.uuid();
    if (workspaceCtx.handle) {
      const cycle = await this.deps.cycleStore.create(
        workspaceCtx.handle,
        runId,
        cycleId,
        this.deps.now(),
      );
      await this.deps.stateStore.setActiveWorkCycleId(cycle.id, this.deps.now());
      return { handle: workspaceCtx.handle, cycle };
    }

    const ensured = await ensureActiveWorkCycle({
      state,
      projectKey: this.deps.projectKey,
      runId,
      cycleId,
      workspaceRegistry: this.deps.workspaceRegistry,
      stateStore: this.deps.stateStore,
      cycleStore: this.deps.cycleStore,
      now: this.deps.now,
    });
    return { handle: ensured.handle, cycle: ensured.cycle };
  }

  private assertWorkspaceCwdSafe(workspace: WorkspaceHandle): void {
    if (workspace.cwd === this.deps.projectKey) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        "workspace cwd must not equal projectRoot — refusing to run Always-On turns in the project root.",
      );
    }
    const inWorktree = workspace.cwd.startsWith(this.deps.paths.worktreesDir);
    const inSnapshot = workspace.cwd.startsWith(this.deps.paths.snapshotsDir);
    if (!inWorktree && !inSnapshot) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        `workspace cwd ${workspace.cwd} is outside the configured Always-On workspace bases.`,
      );
    }
  }

  private async drainTurn(input: {
    sessionKey: string;
    channelKey: GatewayChannelKey;
    runId: string;
    message: string;
    mode: "default" | "bypassPermissions";
    /** When true, each event is appended to the run events log on disk. */
    persistEvents?: boolean;
  }): Promise<GatewayEvent[]> {
    const events: GatewayEvent[] = [];
    for await (const event of this.deps.gateway.submitTurn({
      sessionKey: input.sessionKey,
      channelKey: input.channelKey,
      message: input.message,
      mode: input.mode,
      runId: input.runId,
      projectKey: this.deps.projectKey,
    })) {
      events.push(event);
      this.deps.onTurnEvent?.(input.sessionKey, input.channelKey, event);
      if (input.persistEvents) {
        await this.deps.reportStore
          .appendRunEvent(input.runId, event as unknown as Record<string, unknown>)
          .catch(() => undefined);
      }
    }
    return events;
  }

  private async writeFallbackReport(input: {
    runId: string;
    plan: DiscoveryPlanRecord;
    startedAt: string;
    finishedAt: string;
    reason: string;
    workspaceStrategy: string;
    workspaceHandle: string;
  }): Promise<string> {
    const metadata: ReportMetadata = {
      runId: input.runId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: "failed",
      workspaceStrategy: input.workspaceStrategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
      workspaceHandle: input.workspaceHandle,
    };
    const markdown = buildFallbackReport({
      metadata,
      title: input.plan.title,
      reason: input.reason,
    });
    return this.deps.reportStore.writeReport(input.runId, markdown);
  }

  private async markFailedNoPlan(
    runId: string,
    error: { code?: string; message: string },
    finishedAt: Date,
    baseHistory: DiscoveryRunHistoryEvent,
  ): Promise<void> {
    await this.deps.stateStore.markFireCompleted({
      outcome: "failed",
      runId,
      now: finishedAt,
    });
    await this.deps.reportStore.appendHistory({
      ...baseHistory,
      outcome: "failed",
      finishedAt: finishedAt.toISOString(),
      error: { code: error.code ?? "discovery_failed", message: error.message },
    });
  }
}

export async function acquireDiscoveryLock(
  paths: AlwaysOnPaths,
  payload: { pid: number; startedAt: string; runId: string },
): Promise<boolean> {
  await mkdir(dirname(paths.discoveryLockFile), { recursive: true });
  try {
    await writeFile(paths.discoveryLockFile, JSON.stringify(payload, null, 2), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function releaseDiscoveryLock(paths: AlwaysOnPaths): Promise<void> {
  await unlink(paths.discoveryLockFile).catch(() => undefined);
}

function pickFirstError(events: GatewayEvent[]): { code?: string; message: string } | undefined {
  for (const event of events) {
    if (event.type === "error") {
      return { code: event.code, message: event.message };
    }
  }
  return undefined;
}
