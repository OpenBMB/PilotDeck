import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Gateway } from "../../gateway/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import { resolveAlwaysOnPaths, type AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import {
  createAlwaysOnDiscoveryPlanTool,
  type CreateAlwaysOnDiscoveryPlanToolOptions,
} from "../tool/AlwaysOnDiscoveryPlanTool.js";
import {
  createAlwaysOnReportTool,
} from "../tool/AlwaysOnReportTool.js";
import {
  createAlwaysOnWorkspaceTool,
} from "../tool/AlwaysOnWorkspaceTool.js";
import {
  createAlwaysOnChatHistoryTool,
} from "../tool/AlwaysOnChatHistoryTool.js";
import { GitWorktreeProvider } from "../workspace/GitWorktreeProvider.js";
import { SnapshotCopyProvider } from "../workspace/SnapshotCopyProvider.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import { ChannelLeaseRegistry } from "./ChannelLeaseRegistry.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { DiscoveryScheduler } from "./DiscoveryScheduler.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";

export type AlwaysOnRuntimeLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export type CreateAlwaysOnRuntimeOptions = {
  config: AlwaysOnConfig;
  pilotHome: string;
  /** Absolute path of a project that this server hosts. */
  projectKey: string;
  now?: () => Date;
  uuid?: () => string;
  logger?: AlwaysOnRuntimeLogger;
  /** Override for tests. */
  workspaceRegistry?: WorkspaceProviderRegistry;
  toolContractOptions?: CreateAlwaysOnDiscoveryPlanToolOptions["contract"];
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  /** Shared run-context registry (used by AlwaysOnManager for multi-project). */
  runContexts?: AlwaysOnRunContextRegistry;
  /** Shared session-config overrides (used by AlwaysOnManager for multi-project). */
  sessionOverrides?: SessionConfigOverrides;
  /**
   * Project-level callback: returns true when a user session is actively
   * running a turn for this project.  Passed through to the scheduler so
   * the `agent_busy` gate fires from real data instead of the former
   * hard-coded `false`.
   */
  isSessionInFlight?: () => boolean;
  /** When true, the runtime skips internal tool creation (manager owns tools). */
  skipToolCreation?: boolean;
};

const NOOP_LOGGER: AlwaysOnRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/**
 * AlwaysOnRuntime is the lifecycle owner for the entire Always-On module.
 *
 * Wiring sequence (see `02-pilotdeck-always-on-rewrite-plan.md` §1, §5):
 *   1. Construct via `createAlwaysOnRuntime(...)` before the Gateway is built.
 *   2. Pull tools via `runtime.getTools()` and feed them into the per-project
 *      ToolRegistry that the Gateway uses.
 *   3. Pull session overrides via `runtime.getSessionOverrides()` and let
 *      `ProjectRuntimeRegistry` consult them when constructing AgentSessions.
 *   4. Bind the Gateway via `runtime.bindGateway(gateway)`.
 *   5. Call `runtime.start()` to launch the discovery scheduler.
 *   6. Call `runtime.stop()` during server shutdown.
 *
 * The runtime never reaches into AgentSession internals; it only talks to the
 * Gateway via `submitTurn`/`closeSession` so behavior matches what a normal
 * channel adapter would observe.
 */
export class AlwaysOnRuntime {
  readonly config: AlwaysOnConfig;
  readonly projectKey: string;
  readonly paths: AlwaysOnPaths;

  private readonly stateStore: DiscoveryStateStore;
  private readonly planStore: DiscoveryPlanStore;
  private readonly cycleStore: WorkCycleStore;
  private readonly reportStore: DiscoveryReportStore;
  private readonly eventStore: AlwaysOnEventStore;
  private readonly runContexts: AlwaysOnRunContextRegistry;
  private readonly leases: ChannelLeaseRegistry;
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly workspaceRegistry: WorkspaceProviderRegistry;
  private readonly logger: AlwaysOnRuntimeLogger;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly tools: PilotDeckToolDefinition[];
  private readonly isSessionInFlight: () => boolean;
  private readonly onWorktreeCreated?: (runId: string, cwd: string) => void;
  private readonly onWorktreeRemoved?: (cwd: string) => void;
  private readonly onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];

  private gateway?: Gateway;
  private fire?: DiscoveryFire;
  private scheduler?: DiscoveryScheduler;

  constructor(options: CreateAlwaysOnRuntimeOptions) {
    this.config = options.config;
    this.projectKey = resolve(options.projectKey);
    this.paths = resolveAlwaysOnPaths({
      pilotHome: options.pilotHome,
      projectKey: this.projectKey,
      worktreesBaseDir: options.config.workspace.gitWorktreeBaseDir,
      snapshotsBaseDir: options.config.workspace.snapshotBaseDir,
    });
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.isSessionInFlight = options.isSessionInFlight ?? (() => false);

    this.stateStore = new DiscoveryStateStore(this.paths);
    this.planStore = new DiscoveryPlanStore(this.paths);
    this.cycleStore = new WorkCycleStore(this.paths);
    this.reportStore = new DiscoveryReportStore(this.paths);
    this.eventStore = new AlwaysOnEventStore(this.paths);
    this.runContexts = options.runContexts ?? new AlwaysOnRunContextRegistry();
    this.leases = new ChannelLeaseRegistry(this.now);
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    this.onWorktreeCreated = options.onWorktreeCreated;
    this.onWorktreeRemoved = options.onWorktreeRemoved;
    this.onTurnEvent = options.onTurnEvent;
    this.workspaceRegistry = options.workspaceRegistry ?? this.buildDefaultWorkspaceRegistry();

    this.tools = options.skipToolCreation
      ? []
      : [
          createAlwaysOnDiscoveryPlanTool({
            runContexts: this.runContexts,
            contract: options.toolContractOptions,
            now: this.now,
            uuid: this.uuid,
          }),
          createAlwaysOnReportTool({
            runContexts: this.runContexts,
            now: this.now,
          }),
          createAlwaysOnWorkspaceTool({
            runContexts: this.runContexts,
          }),
          createAlwaysOnChatHistoryTool({
            runContexts: this.runContexts,
          }),
        ];
  }

  getTools(): PilotDeckToolDefinition[] {
    return [...this.tools];
  }

  getSessionOverrides(): SessionConfigOverrides {
    return this.sessionOverrides;
  }

  getChannelLeases(): ChannelLeaseRegistry {
    return this.leases;
  }

  getRunContexts(): AlwaysOnRunContextRegistry {
    return this.runContexts;
  }

  bindGateway(
    gateway: Gateway,
    hooks?: { isSessionInFlight?: () => boolean },
  ): void {
    if (this.gateway) {
      throw new Error("AlwaysOnRuntime.bindGateway already called.");
    }
    this.gateway = gateway;
    const isSessionInFlight = hooks?.isSessionInFlight ?? this.isSessionInFlight;
    this.fire = new DiscoveryFire({
      config: this.config,
      paths: this.paths,
      projectKey: this.projectKey,
      gateway,
      runContexts: this.runContexts,
      workspaceRegistry: this.workspaceRegistry,
      sessionOverrides: this.sessionOverrides,
      stateStore: this.stateStore,
      planStore: this.planStore,
      cycleStore: this.cycleStore,
      reportStore: this.reportStore,
      eventStore: this.eventStore,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      onTurnEvent: this.onTurnEvent,
    });
    this.scheduler = new DiscoveryScheduler({
      config: this.config,
      projectKey: this.projectKey,
      paths: this.paths,
      stateStore: this.stateStore,
      leases: this.leases,
      fire: this.fire,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      isSessionInFlight,
    });
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info("always-on disabled in config; runtime is a no-op.");
      return;
    }
    if (!this.scheduler) {
      throw new Error("AlwaysOnRuntime.start called before bindGateway.");
    }
    await this.scheduler.start();
    this.logger.info("always-on runtime started", { projectKey: this.projectKey });
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    this.scheduler = undefined;
    this.fire = undefined;
    this.runContexts.list().forEach((ctx) => this.runContexts.unregister(ctx.sessionKey));
    this.sessionOverrides.clear();
    this.logger.info("always-on runtime stopped", { projectKey: this.projectKey });
  }

  async rerunPlan(input: {
    planId: string;
  }): Promise<{ runId: string; error?: { code: string; message: string } }> {
    if (!this.fire) {
      return { runId: "", error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" } };
    }
    const runId = this.uuid();
    const startedAt = this.now();
    const result = await this.fire.rerunPlan({ planId: input.planId, runId, startedAt });
    return { runId: result.runId, error: "error" in result ? result.error : undefined };
  }

  async applyCycle(input: {
    workCycleId: string;
    projectRoot: string;
    projectName: string;
  }): Promise<{ sessionKey: string; error?: { code: string; message: string } }> {
    if (!this.fire) {
      return { sessionKey: "", error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" } };
    }
    const cycle = await this.cycleStore.getRecord(input.workCycleId);
    if (!cycle) {
      return { sessionKey: "", error: { code: "cycle_not_found", message: `Work cycle ${input.workCycleId} not found` } };
    }

    const planIndex = await this.planStore.readIndex();
    const cyclePlans = planIndex.plans
      .filter((p) => cycle.planIds.includes(p.id))
      .map((p) => ({ id: p.id, title: p.title }));

    const runId = this.uuid();
    const result = await this.fire.runApplyPhase({
      runId,
      cycle,
      plans: cyclePlans,
      projectName: input.projectName,
      projectRoot: input.projectRoot,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  }

  private buildDefaultWorkspaceRegistry(): WorkspaceProviderRegistry {
    const registry = new WorkspaceProviderRegistry();
    registry.add(
      new GitWorktreeProvider({
        baseDir: this.paths.worktreesDir,
        onWorktreeCreated: this.onWorktreeCreated,
        onWorktreeRemoved: this.onWorktreeRemoved,
      }),
    );
    registry.add(
      new SnapshotCopyProvider({
        baseDir: this.paths.snapshotsDir,
        maxBytes: this.config.workspace.snapshotMaxBytes,
      }),
    );
    return registry;
  }
}

export function createAlwaysOnRuntime(options: CreateAlwaysOnRuntimeOptions): AlwaysOnRuntime {
  return new AlwaysOnRuntime(options);
}
