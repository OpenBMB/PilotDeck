import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync } from "node:fs";
import { resolve, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentEventBuffer,
  createAgentSessionWithStorage,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "../agent/index.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  ContextOverflowRecovery,
  DefaultContextRuntime,
  InstructionDiscovery,
  MicroCompactionEngine,
  PluginRuntimeExtensionResolver,
  SnipEngine,
  TokenBudgetManager,
  ToolResultBudget,
  createEdgeClawMemoryProviderFromConfig,
} from "../context/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { createPlanTodoStateManager } from "../agent/runtime/PlanTodoState.js";
import { HookRuntime, PluginRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  GatewayElicitationChannel,
  InProcessGateway,
  type InProcessGatewayOptions,
  SessionRouter,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type Gateway,
  type GatewayCronController,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import {
  GATEWAY_PERMISSION_CALLBACK_NAME,
  createGatewayPermissionHook,
} from "../gateway/permission/createGatewayPermissionHook.js";
import {
  McpRuntime,
  createMcpToolDefinitionsFromRuntime,
  loadMcpServerConfig,
  parsePluginMcpServers,
} from "../mcp/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { createDefaultPermissionContext, type PermissionRule } from "../permission/index.js";
import { loadPilotConfig, resolvePilotHome } from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import { DEFAULT_JUDGE_TIMEOUT_MS, DEFAULT_SUBAGENT_MAX_TOKENS, DEFAULT_ALLOWED_TOOLS, DEFAULT_TRIGGER_TIERS, type RouterConfig } from "../router/config/schema.js";
import { createAgentProjectSessionStorage, listProjectSessions, resumeAgentSession } from "../session/index.js";
import { sanitizeSessionIdForPath } from "../session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages, readSubagentWebMessages } from "../web/server/readSessionMessages.js";
import { forkWebSession } from "../web/server/forkSession.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import { createBuiltinRegistry, createPlanFileManager } from "../tool/index.js";
import type { PilotDeckToolDefinition, ToolRegistry, PilotDeckElicitationChannel } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import { SessionRouterStore } from "../router/session/SessionRouterStore.js";
import type { RouterEventBus, RouterEvent } from "../router/protocol/events.js";
import type { EdgeClawMemoryProvider } from "../context/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { SkillManager } from "../extension/skills/index.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import { createTelemetryCollector, type TelemetryClient } from "../telemetry/index.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PilotDeckToolDefinition[];
  /** Per-sessionKey config overrides (cwd / permissionMode). */
  sessionOverrides?: SessionConfigOverrides;
  /** Optional Cron runtime controller exposed through Gateway management methods. */
  cron?: GatewayCronController;
  /**
   * Additional directories the agent is allowed to read/write outside of `projectRoot`.
   * Passed to PermissionContext so `pathSafety` accepts paths within these roots.
   */
  additionalWorkingDirectories?: string[];
  /**
   * @internal Testing hook — replaces the production `createModelRuntime`
   * call when present. Tests can return a fake `ModelRuntime` (e.g. a scripted
   * stream) so the rest of the wiring (Router, Tools, Context, AgentLoop) runs
   * end-to-end against a deterministic transport. NOT part of the public API.
   */
  __testModelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /**
   * When true, the project list will not auto-include `projectRoot`.
   * Set by non-interactive launchers (dev mode, install.sh wrapper) where
   * `process.cwd()` is the PilotDeck source tree, not a user project.
   */
  skipDefaultProject?: boolean;
  /**
   * When true, `ask_user_question` tool calls are answered automatically
   * (first option selected) instead of waiting for a human. Intended for
   * benchmark / headless runs where no interactive user is present.
   */
  autoElicitation?: boolean;
  telemetry?: TelemetryClient;
};

export type SubsystemUpdate = {
  extraTools: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  cron?: GatewayCronController;
  alwaysOnApply?: InProcessGatewayOptions["alwaysOnApply"];
  alwaysOnRerunPlan?: InProcessGatewayOptions["alwaysOnRerunPlan"];
};

export type CreateLocalGatewayResult = {
  gateway: Gateway;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  dispose: () => void;
  bindServer: (server: { broadcastNotification(name: string, payload?: unknown): void }) => void;
  /**
   * Returns true when at least one interactive (non-background) turn is
   * in flight for `projectKey`.  Used by AlwaysOnManager to feed the
   * `agent_busy` gate with real session data.
   */
  isProjectBusy: (projectKey: string) => boolean;
  /**
   * Replace subsystem-owned tools, session overrides, and cron controller.
   * Called by the server command after tearing down and rebuilding
   * AlwaysOnManager / CronManager in response to a config change.
   */
  updateSubsystems: (update: SubsystemUpdate) => void;
};

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const pilotHome = options.pilotHome ?? resolvePilotHome(baseEnv);
  const env = options.pilotHome ? { ...baseEnv, PILOT_HOME: pilotHome } : baseEnv;
  const now = () => new Date();
  const telemetry = options.telemetry ?? createTelemetryCollector({ env, pilotHome });
  const ownsTelemetry = !options.telemetry;
  let registry!: ProjectRuntimeRegistry;
  let router: SessionRouter | undefined;
  const extensionWatchManager = new ExtensionWatchManager({
    pilotHome,
    onChange: (event) => {
      handleExtensionWatchEvent(event, registry, router);
    },
    onError: (scope, error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[pilotdeck] Extension watcher failed for ${describeExtensionScope(scope)}:`,
        error.message,
      );
    },
  });
  registry = new ProjectRuntimeRegistry({
    defaultProjectRoot: projectRoot,
    pilotHome,
    env,
    permissionMode: options.permissionMode ?? "default",
    now,
    extraTools: options.extraTools,
    sessionOverrides: options.sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    autoElicitation: options.autoElicitation,
    telemetry,
    onProjectActivated: (activeProjectRoot) => extensionWatchManager.watchProject(activeProjectRoot),
  });
  const defaultRuntime = registry.resolve();
  const memoryDiagnosticsEnabled = isGatewayMemoryDiagnosticsEnabled(
    env,
    defaultRuntime.snapshot.config.gateway?.memoryDiagnostics,
  );

  const configStore = createPilotConfigStoreSync({ projectRoot, env });
  const stopConfigWatching = configStore.startWatching();
  const stopExtensionWatching = extensionWatchManager.start();

  let boundServer: { broadcastNotification(name: string, payload?: unknown): void } | undefined;
  const configChangeLifecycle = new LifecycleRuntime(new HookRuntime({}));

  configStore.subscribe((event) => {
    const { changeClasses, changedPaths } = event;
    if (changeClasses.length === 0) {
      return;
    }
    if (changeClasses.every((c) => c === "restart-required")) {
      // eslint-disable-next-line no-console
      console.warn("[pilotdeck] Config change requires process restart:", changedPaths.join(", "));
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[pilotdeck] Config reloaded, invalidating runtimes:", changedPaths.join(", "));
    registry.invalidate();
    if (memoryDiagnosticsEnabled) {
      logGatewayMemoryDiagnostic({
        event: "runtime_invalidated",
        sessionCount: router?.cachedSessionCount(),
        projectKey: projectRoot,
        reason: "config_changed",
      });
    }
    router?.markAllDirty("config_changed");
    configChangeLifecycle.dispatch({
      event: "ConfigChange",
      baseInput: { sessionId: "", transcriptPath: "", cwd: projectRoot },
      payload: { changedPaths, changeClasses },
      matchQuery: "ConfigChange",
    }).catch(() => {});
    boundServer?.broadcastNotification("config_changed", { changedPaths, changeClasses });
  });

  router = new SessionRouter({
    createSession: (ctx) => registry.createSession(ctx),
    recreateSession: (ctx, session) => registry.recreateSession(ctx, session),
    listSessions: (input) => registry.listSessions(input),
    idleSessionTimeoutMs:
      (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    idleSweepIntervalMs:
      Math.max(0, defaultRuntime.snapshot.config.gateway?.idleSweepIntervalSeconds ?? 60) * 1_000,
    now,
    onSessionEvict: (sessionKey) => registry.evictSessionMcp(sessionKey),
    onSessionIdleEvict: memoryDiagnosticsEnabled
      ? (_sessionKey, snapshot) => {
          logGatewayMemoryDiagnostic({
            event: "session_idle_evicted",
            sessionCount: router?.cachedSessionCount(),
            session: {
              sessionKey: snapshot.sessionKey,
              projectKey: snapshot.context.projectKey,
              messageCount: snapshot.messageCount,
            },
          });
        }
      : undefined,
  });
  const skillManager = new SkillManager({ pilotHome });
  const gateway = new InProcessGateway(router, {
    now,
    serverInfo: { mode: "in_process", projectKey: projectRoot },
    telemetry,
    toolResultsDir: resolve(tmpdir(), "pilotdeck-tool-output", process.pid.toString()),
    cron: options.cron,
    skillManager,
    setSessionCwd: (sessionKey, cwd) => registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: (input) =>
      readWebSessionMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : projectRoot,
        pilotHome,
        now,
      }),
    readSubagentMessages: (input) =>
      readSubagentWebMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : projectRoot,
        pilotHome,
        now,
      }),
    forkSession: (input) =>
      forkWebSession(input, {
        projectRoot: input.projectKey ? input.projectKey : projectRoot,
        pilotHome,
        now,
      }),
    listProjects: () =>
      listWebProjects({ pilotHome, defaultProjectRoot: options.skipDefaultProject ? undefined : projectRoot }),
    describeProject: (input) =>
      describeWebProject(input.projectKey, { pilotHome, defaultProjectRoot: options.skipDefaultProject ? undefined : projectRoot }),
    async reloadConfig() {
      let changedPaths: string[] = [];
      const unsubscribe = configStore.subscribe((event) => {
        changedPaths = event.changedPaths;
      });
      try {
        await configStore.reload("rpc");
      } finally {
        unsubscribe();
      }
      return { reloaded: true, changedPaths };
    },
    async reloadExtensions(input) {
      const changedPaths = input?.changedPaths ?? [];
      if (input?.projectKey) {
        // eslint-disable-next-line no-console
        console.log(
          `[pilotdeck] Extensions reload requested for project ${input.projectKey}:`,
          changedPaths.join(", ") || "(manual)",
        );
        registry.invalidate(input.projectKey);
        router?.markProjectDirty(input.projectKey, "extension_changed");
      } else {
        // eslint-disable-next-line no-console
        console.log("[pilotdeck] Extensions reload requested for all runtimes:", changedPaths.join(", ") || "(manual)");
        registry.invalidate();
        router?.markAllDirty("extension_changed");
      }
      boundServer?.broadcastNotification("config_changed", {
        changedPaths,
        changeClasses: ["extension-changed"],
      });
      return { reloaded: true, changedPaths };
    },
    // Defensive: re-check the on-disk config at the start of every
    // turn so an apiKey/url edit applied between two messages takes
    // effect on the next one, even if the fs watcher missed it.
    // Singleton-deduped inside PilotConfigStore.reload — concurrent
    // turns share a single in-flight read, and unchanged config is a
    // no-op (no invalidation, no session recreation).
    async refreshConfigBeforeTurn() {
      await configStore.reload("turn-start");
    },
    afterTurnCompleted: ({ sessionKey, projectKey, runId }) => {
      if (memoryDiagnosticsEnabled) {
        const snapshot = router?.snapshotSession(sessionKey);
        logGatewayMemoryDiagnostic({
          event: "turn_completed",
          sessionCount: router?.cachedSessionCount(),
          session: {
            sessionKey,
            projectKey,
            runId,
            ...(snapshot ? summarizeCanonicalMessages(snapshot.messages) : {}),
          },
        });
      }
      registry.scheduleMemoryMaintenance(projectKey ?? projectRoot);
    },
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  return {
    gateway,
    configStore,
    registry,
    dispose: () => {
      registry.invalidate();
      router?.shutdown();
      stopConfigWatching();
      stopExtensionWatching();
      if (ownsTelemetry) {
        void telemetry.shutdown();
      }
    },
    bindServer: (server) => { boundServer = server; },
    isProjectBusy: (projectKey: string) => router!.hasActiveUserTurn(projectKey),
    updateSubsystems: (update: SubsystemUpdate) => {
      registry.updateSubsystems({
        extraTools: update.extraTools,
        sessionOverrides: update.sessionOverrides,
      });
      gateway.setCronController(update.cron);
      gateway.setAlwaysOnApply(update.alwaysOnApply);
      gateway.setAlwaysOnRerunPlan(update.alwaysOnRerunPlan);
    },
  };
}

type ProjectRuntimeRegistryOptions = {
  defaultProjectRoot: string;
  pilotHome: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  /** @internal Test hook from `CreateLocalGatewayOptions.__testModelFactory`. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  autoElicitation?: boolean;
  telemetry: TelemetryClient;
  onProjectActivated?: (projectRoot: string) => void;
};

type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
  router: RouterRuntime;
  pluginRuntime: PluginRuntime;
  tools: ToolRegistry;
  projectStorage: GatewayProjectStorageOptions;
  /** Per-project background task runtime (shared across sessions). C5. */
  backgroundTasks: BackgroundTaskRuntime;
  /** Memory provider, undefined when memory is disabled in PilotConfig. */
  memory?: EdgeClawMemoryProvider;
  /** Backing memory service for maintenance / introspection. */
  memoryService?: EdgeClawMemoryService;
  /** Coalesced project-level memory maintenance loop. */
  memoryMaintenanceInFlight?: Promise<void>;
  memoryMaintenanceRequested?: boolean;
  /**
   * Lazily-started MCP runtime (C1). Built on first session creation by
   * `ensureMcpReady()` because plugin refresh + connect is async.
   * Only contains non-`perSession` servers (shared across sessions).
   */
  mcpRuntime?: McpRuntime;
  /** Tracks the in-flight `ensureMcpReady` promise so concurrent sessions share it. */
  mcpReady?: Promise<void>;
  /**
   * Server specs marked `perSession: true`. These are NOT started at the
   * project level — each agent session creates its own `McpRuntime` from
   * these specs so that e.g. browser-use gets an isolated process per
   * session.  Populated during `ensureMcpReady()`.
   */
  perSessionServerSpecs?: import("../mcp/protocol/types.js").PilotDeckMcpServerSpec[];
};

class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private gateway?: InProcessGateway;
  /**
   * Per-session live permission rules used when no `sessionOverrides`
   * entry exists. Same array reference is handed to:
   *   - `createDefaultPermissionContext({ rules })` so `PermissionRuntime.decide`
   *     sees current allow/deny entries.
   *   - `createGatewayPermissionHook({ permissionRules })` so the hook can
   *     push session-scoped allow rules on `remember=true` and have the
   *     very next `decide()` call inside this turn see them.
   * Without this fallback, remote-gateway clients (Web UI talking to
   * `pilotdeck server`) wouldn't be able to round-trip permission
   * prompts because they can't reach into the server's `sessionOverrides`
   * map from outside the process.
   */
  private readonly fallbackRuleSets = new Map<
    string,
    { allow: PermissionRule[]; deny: PermissionRule[]; ask: PermissionRule[] }
  >();

  /**
   * Per-session MCP runtimes for `perSession: true` servers (e.g.
   * browser-use).  Each entry owns one or more child processes and a temp
   * directory.  Cleaned up by `evictSessionMcp()` when the SessionRouter
   * evicts the session (idle sweep, explicit close, or dirty-recreate).
   */
  private readonly sessionMcpRuntimes = new Map<string, McpRuntime>();

  private _extraTools: PilotDeckToolDefinition[];
  private _sessionOverrides: SessionConfigOverrides | undefined;
  private readonly sharedSessionStore = new SessionRouterStore({
    now: () => this.options.now().getTime(),
  });

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
  }

  /**
   * Stop and discard the per-session MCP runtime for `sessionKey`.
   * Called by the `SessionRouter.onSessionEvict` callback.
   */
  evictSessionMcp(sessionKey: string): void {
    const mcp = this.sessionMcpRuntimes.get(sessionKey);
    if (mcp) {
      this.sessionMcpRuntimes.delete(sessionKey);
      mcp.stop().catch(() => {});
    }
  }

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  private buildRouterEventBus(): RouterEventBus {
    const pilotHome = this.options.pilotHome;
    const routerDir = joinPath(pilotHome, "router");
    try { mkdirSyncFs(routerDir, { recursive: true }); } catch { /* exists */ }
    const eventsPath = joinPath(routerDir, "events.jsonl");
    try {
      const oldPath = joinPath(pilotHome, "router-events.jsonl");
      if (!existsSync(eventsPath) && existsSync(oldPath)) {
        renameSync(oldPath, eventsPath);
      }
    } catch { /* best-effort migration */ }
    const self = this;
    return {
      emit(event: RouterEvent) {
        try {
          appendFileSync(eventsPath, JSON.stringify(event) + "\n");
        } catch { /* best-effort, never crash the agent loop */ }
        if (event.type === "pilotdeck_router_retry_progress") {
          try {
            self.gateway?.broadcastRetryProgress(event);
          } catch { /* best-effort */ }
        }
      },
    };
  }

  /**
   * Resolve the live permission-rule set for a session. Prefers any
   * explicit `sessionOverrides` entry (used by `always-on` to inject a
   * pre-populated allow list); otherwise lazily mints a per-session
   * fallback so the gateway permission hook always has a live array to
   * push `remember=true` grants into.
   */
  private getLiveRuleSet(sessionKey: string): {
    allow: PermissionRule[];
    deny: PermissionRule[];
    ask: PermissionRule[];
  } {
    const explicit = this._sessionOverrides?.get(sessionKey)?.permissionRules;
    if (explicit) {
      return {
        allow: explicit.allow ?? [],
        deny: explicit.deny ?? [],
        ask: explicit.ask ?? [],
      };
    }
    let auto = this.fallbackRuleSets.get(sessionKey);
    if (!auto) {
      auto = { allow: [], deny: [], ask: [] };
      this.fallbackRuleSets.set(sessionKey, auto);
    }
    return auto;
  }

  /**
   * Drop cached runtimes so the next `resolve()` call rebuilds from
   * a fresh `loadPilotConfig()` snapshot. Gracefully shuts down any
   * active MCP connections (both shared and per-session) before
   * discarding the entry.
   */
  invalidate(projectRoot?: string): void {
    for (const [, mcp] of this.sessionMcpRuntimes) {
      mcp.stop().catch(() => {});
    }
    this.sessionMcpRuntimes.clear();

    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime?.mcpRuntime) {
        runtime.mcpRuntime.stop().catch(() => {});
      }
      runtime?.memoryService?.close();
      runtime?.router?.shutdown().catch(() => {});
      this.runtimes.delete(projectRoot);
    } else {
      for (const [, runtime] of this.runtimes) {
        if (runtime.mcpRuntime) {
          runtime.mcpRuntime.stop().catch(() => {});
        }
        runtime.memoryService?.close();
        runtime.router?.shutdown().catch(() => {});
      }
      this.runtimes.clear();
    }
  }

  /**
   * Replace subsystem-owned tools and session overrides (Always-On / Cron).
   * Called after the subsystem lifecycle is torn down and rebuilt so that
   * future session creations pick up the new tool definitions and override
   * map. Also invalidates cached runtimes.
   */
  updateSubsystems(config: {
    extraTools: PilotDeckToolDefinition[];
    sessionOverrides?: SessionConfigOverrides;
  }): void {
    this._extraTools = config.extraTools;
    this._sessionOverrides = config.sessionOverrides;
    this.invalidate();
  }

  /**
   * Set the working directory override for a specific session.
   * Used by the Web UI execution path to point an agent session at
   * an isolated workspace (git-worktree / snapshot-copy) without
   * going through DiscoveryFire.
   */
  setSessionCwd(sessionKey: string, cwd: string): void {
    if (!this._sessionOverrides) return;
    const existing = this._sessionOverrides.get(sessionKey);
    this._sessionOverrides.set(sessionKey, { ...existing, cwd });
  }

  resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolve(projectKey ?? this.options.defaultProjectRoot);
    this.options.onProjectActivated?.(projectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPilotConfig({ projectRoot, env: this.options.env });
    const model = this.options.modelFactory
      ? this.options.modelFactory(snapshot)
      : createModelRuntime(snapshot.config.model);
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinPlugins: loadBuiltinPlugins(),
      builtinPluginsEnabled: snapshot.config.extension.builtinPluginsEnabled,
    });
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: this.options.now,
      customRouterRegistry: pluginRuntime,
      loadSkillPrompt: (extensionId) => pluginRuntime.loadSkillPrompt(extensionId),
      events: this.buildRouterEventBus(),
      telemetry: this.options.telemetry,
    });
    const backgroundTasks = new BackgroundTaskRuntime({ now: this.options.now });
    const webSearchConfig = snapshot.config.tools?.webSearch;
    const tools = createBuiltinRegistry({
      backgroundTasks: { runtime: backgroundTasks },
      readSkill: {
        loader: (name) => pluginRuntime.loadSkillPrompt(name),
        lister: () => pluginRuntime.getAllSkills(),
      },
      // Pass the YAML-configured web-search provider through to the built-in
      // `web_search` tool. When absent, the tool may infer GLM/Tavily from
      // provider-specific environment variables.
      ...(webSearchConfig
        ? {
            webSearch: {
              ...(webSearchConfig.provider ? { provider: webSearchConfig.provider } : {}),
              ...(webSearchConfig.apiKey ? { apiKey: webSearchConfig.apiKey } : {}),
              ...(webSearchConfig.endpoint ? { endpoint: webSearchConfig.endpoint } : {}),
              ...(webSearchConfig.customProvider ? { customProvider: webSearchConfig.customProvider } : {}),
            },
          }
        : {}),
    });
    for (const tool of this._extraTools) {
      tools.register(tool);
    }

    const memory = createEdgeClawMemoryProviderFromConfig({
      config: snapshot.config.memory,
      modelConfig: snapshot.config.model,
      agentModel: snapshot.config.agent.model.id,
      projectRoot,
      now: this.options.now,
      telemetry: this.options.telemetry,
    });

    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      router,
      pluginRuntime,
      tools,
      backgroundTasks,
      memory: memory?.provider,
      memoryService: memory?.service,
      projectStorage: {
        projectRoot,
        pilotHome: this.options.pilotHome,
      },
    };
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  scheduleMemoryMaintenance(projectKey?: string): void {
    const runtime = this.resolve(projectKey);
    const service = runtime.memoryService;
    if (!service) return;
    runtime.memoryMaintenanceRequested = true;
    if (runtime.memoryMaintenanceInFlight) return;
    runtime.memoryMaintenanceInFlight = (async () => {
      while (runtime.memoryMaintenanceRequested) {
        runtime.memoryMaintenanceRequested = false;
        try {
          await service.runDueScheduledMaintenance("scheduled");
          this.options.telemetry.trackFeatureLoopStage({
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "module_event",
            outcome: "success",
            metadata: {
              phase: "maintenance_completed",
            },
          });
        } catch (error) {
          this.options.telemetry.trackError(error, {
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "loop_end",
            errorCategory: "loop_error",
            code: error instanceof Error ? error.name : "UnknownError",
          });
          // eslint-disable-next-line no-console
          console.warn(
            `[pilotdeck] memory maintenance failed for project ${runtime.projectRoot}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })().finally(() => {
      runtime.memoryMaintenanceInFlight = undefined;
      if (runtime.memoryMaintenanceRequested) {
        this.scheduleMemoryMaintenance(projectKey);
      }
    });
  }

  /**
   * Lazily start the MCP runtime for this project. Idempotent — concurrent
   * callers share a single in-flight promise. Errors are swallowed (logged
   * to stderr) so a misbehaving MCP server can't take the gateway down.
   */
  private ensureMcpReady(runtime: ProjectRuntime): Promise<void> {
    if (runtime.mcpReady) return runtime.mcpReady;
    runtime.mcpReady = (async () => {
      try {
        const configServers = loadMcpServerConfig(runtime.projectRoot, this.options.pilotHome);
        for (const diagnostic of configServers.diagnostics) {
          // eslint-disable-next-line no-console
          console.warn(`[pilotdeck] Ignoring invalid MCP config ${diagnostic.path}: ${diagnostic.message}`);
        }
        const rawServers = {
          ...runtime.pluginRuntime.mcpServers(),
          ...configServers.servers,
        };
        const { servers } = parsePluginMcpServers(rawServers);
        if (servers.length === 0) return;

        const sharedServers = servers.filter((s) => s.transport !== "stdio" || !s.perSession);
        const perSessionServers = servers.filter((s) => s.transport === "stdio" && s.perSession);

        runtime.perSessionServerSpecs = perSessionServers.length > 0 ? perSessionServers : undefined;

        if (sharedServers.length > 0) {
          const mcp = new McpRuntime(sharedServers);
          runtime.mcpRuntime = mcp;
          await mcp.start();
          const defs = await createMcpToolDefinitionsFromRuntime(mcp);
          for (const def of defs) {
            if (!runtime.tools.has(def.name)) runtime.tools.register(def);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] MCP runtime startup partial-failed for project ${runtime.projectRoot}:`,
          (err as Error).message,
        );
      }
    })();
    return runtime.mcpReady;
  }

  async createSession(context: GatewaySessionContext) {
    const prepared = await this.prepareSessionRuntime(context);
    const resumed = await resumeAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
      dependencies: prepared.baseDependencies,
      projectStorage: prepared.runtime.projectStorage,
      extendDependencies: prepared.extendDependencies,
    });
    return resumed.session;
  }

  async recreateSession(context: GatewaySessionContext, previousSession: AgentSession) {
    const prepared = await this.prepareSessionRuntime(context);
    const previous = previousSession.snapshotForRuntimeReload();
    const storage = createAgentProjectSessionStorage({
      ...prepared.runtime.projectStorage,
      sessionId: context.sessionKey,
      now: prepared.baseDependencies.now,
    });
    if (previous.transcriptWriterState) {
      storage.transcript.restoreState(
        previous.transcriptWriterState.sequence,
        previous.transcriptWriterState.lastEntryId,
      );
    }
    const extensionDependencies = prepared.extendDependencies(storage);
    const { session } = createAgentSessionWithStorage({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
      dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
      storage,
      transcript: storage.transcript,
      initialState: previous.state,
      seedState: previous.fileState,
    });
    return session;
  }

  private async prepareSessionRuntime(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    await runtime.pluginRuntime.refresh();
    await this.ensureMcpReady(runtime);
    const contributions = runtime.pluginRuntime.snapshotContributions();

    // -- per-session MCP runtime (e.g. browser-use) --------------------
    let sessionTools: ToolRegistry = runtime.tools;
    const perSpecs = runtime.perSessionServerSpecs;
    const maxInstances = runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5;
    if (perSpecs && perSpecs.length > 0 && this.sessionMcpRuntimes.size < maxInstances) {
      this.evictSessionMcp(context.sessionKey);
      const patchedPerSpecs = perSpecs.map((spec) => {
        if (spec.transport === "stdio" && spec.id === "browser-use") {
          const outDir = joinPath(
            runtime.projectRoot,
            ".pilotdeck",
            "browser_screenshots",
            sanitizeSessionIdForPath(context.sessionKey),
          );
          mkdirSyncFs(outDir, { recursive: true });
          return { ...spec, cwd: outDir, args: [...(spec.args ?? []), `--output-dir=${outDir}`] };
        }
        return spec;
      });
      const sessionMcp = new McpRuntime(patchedPerSpecs);
      this.sessionMcpRuntimes.set(context.sessionKey, sessionMcp);
      try {
        await sessionMcp.start();
        const defs = await createMcpToolDefinitionsFromRuntime(sessionMcp);
        if (defs.length > 0) {
          sessionTools = runtime.tools.clone();
          for (const def of defs) {
            if (sessionTools.has(def.name)) {
              sessionTools.replace(def);
            } else {
              sessionTools.register(def);
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] Per-session MCP startup failed for ${context.sessionKey}:`,
          (err as Error).message,
        );
      }
    } else if (perSpecs && perSpecs.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pilotdeck] Per-session MCP limit reached (${maxInstances}). ` +
        `Session ${context.sessionKey} will share the project-level browser instance.`,
      );
    }

    // -- excludeTools filtering (unattended sessions) -------------------
    const override = this._sessionOverrides?.get(context.sessionKey);
    if (override?.excludeTools && override.excludeTools.length > 0) {
      if (sessionTools === runtime.tools) {
        sessionTools = runtime.tools.clone();
      }
      for (const name of override.excludeTools) {
        sessionTools.unregister(name);
      }
    }

    // -- Strip always_on_* tools from non-Always-On sessions -------------
    // These tools require an AlwaysOnRunContext to execute; surfacing them
    // in regular user sessions just pollutes the model's tool list.
    const isAlwaysOnSession = context.sessionKey.startsWith("always-on/");
    if (!isAlwaysOnSession) {
      const alwaysOnNames = this._extraTools
        .filter((t) => t.name.startsWith("always_on_"))
        .map((t) => t.name);
      if (alwaysOnNames.length > 0) {
        if (sessionTools === runtime.tools) {
          sessionTools = runtime.tools.clone();
        }
        for (const name of alwaysOnNames) {
          sessionTools.unregister(name);
        }
      }
    }
    // Inject the gateway's interactive permission hook so the agent's
    // PermissionRequest lifecycle is round-tripped through whichever
    // client is streaming this session (Web UI, TUI, etc.) instead of
    // returning `permission_required` errors. The hook mutates the
    // session's live `permissionRules.allow` array on `remember=true`,
    // so a subsequent tool call inside the same turn bypasses the ask
    // path without waiting for the next turn.
    //
    // We register unconditionally whenever a gateway is wired up. If no
    // client is actively streaming, `gw.emitForSession()` returns false
    // and the hook auto-denies — better than silently hanging.
    const gw = this.gateway;
    const liveRuleSet = this.getLiveRuleSet(context.sessionKey);
    const hookSettings: typeof contributions.hooks = gw
      ? {
          ...contributions.hooks,
          PermissionRequest: [
            ...(contributions.hooks.PermissionRequest ?? []),
            {
              hooks: [
                { type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME },
              ],
            },
          ],
        }
      : contributions.hooks;
    const hookRuntime = new HookRuntime(hookSettings);
    if (gw) {
      hookRuntime.getCallbackExecutor().register(
        GATEWAY_PERMISSION_CALLBACK_NAME,
        createGatewayPermissionHook({
          sessionKey: context.sessionKey,
          bus: gw.getPermissionBus(),
          emit: (event) => gw.emitForSession(context.sessionKey, event),
          permissionRules: liveRuleSet.allow,
        }),
      );
    }
    const lifecycle = new LifecycleRuntime(hookRuntime);
    const extension = new PluginRuntimeExtensionResolver(runtime.pluginRuntime);
    const projectRoot = runtime.projectRoot;
    const memoryResolver = runtime.memory;
    const now = this.options.now;
    const eventBuf = createAgentEventBuffer();

    const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
      router: runtime.router,
      tools: { registry: sessionTools },
      lifecycle,
      now: this.options.now,
      eventEmitter: eventBuf.emitter,
      drainEvents: eventBuf.drain,
      getModelMaxContextTokens: (provider, model) => {
        try {
          return runtime.model.getCapabilities(provider, model).maxContextTokens;
        } catch {
          return undefined;
        }
      },
    };
    const extendDependencies = (storage: ReturnType<typeof createAgentProjectSessionStorage>) => {
      const toolResultBudget = new ToolResultBudget({ toolResultsDir: storage.toolResultsDir });
      const tokenBudget = new TokenBudgetManager();
      const compactionEngine = new CompactionEngine({
        model: {
          stream: (request, signal) =>
            runtime.router.stream(request, {
              sessionId: context.sessionKey,
              turnId: "compact",
              projectPath: context.projectKey,
              abortSignal: signal,
              isMainAgent: false,
            }),
        },
        tokenBudget,
        lifecycle: {
          async dispatch(input) {
            await lifecycle.dispatch({
              event: input.event,
              baseInput: {
                sessionId: context.sessionKey,
                transcriptPath: "",
                cwd: projectRoot,
                permissionMode: "default",
              },
              payload: input.payload,
              matchQuery: input.event,
            });
          },
        },
        provider: runtime.snapshot.config.agent.model.provider,
        model_: runtime.snapshot.config.agent.model.model,
        now,
        eventEmitter: eventBuf.emitter,
      });
      const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
      const microcompactEngine = new CachedMicroCompactionEngine({ enabled: true });
      const microCompaction = new MicroCompactionEngine();
      const snipEngine = new SnipEngine();
      const overflowRecovery = new ContextOverflowRecovery();
      const caps = runtime.model.getCapabilities(
        runtime.snapshot.config.agent.model.provider,
        runtime.snapshot.config.agent.model.model,
      );
      const instructionDiscovery = new InstructionDiscovery(
        projectRoot,
        projectRoot,
        this.options.pilotHome,
      );
      const contextRuntime = new DefaultContextRuntime({
        extension,
        projectRoot,
        memoryResolver,
        memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
        instructionDiscovery,
        toolResultBudget,
        tokenBudget,
        compactionEngine,
        autoCompactionPolicy,
        microcompactEngine,
        microCompaction,
        snipEngine,
        overflowRecovery,
        maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
        now,
      });
      const fileHistory = new FileHistoryStore({
        backupDir: storage.fileHistoryDir,
        now: this.options.now,
      });
      const gw = this.gateway;
      const elicitation = this.options.autoElicitation
        ? createAutoElicitationChannel()
        : gw
          ? new GatewayElicitationChannel({
              sessionKey: context.sessionKey,
              bus: gw.getElicitationBus(),
              emit: (event) => gw.emitForSession(context.sessionKey, event),
              dispatchHook: (hookEvent, payload) => {
                lifecycle.dispatch({
                  event: hookEvent as import("../extension/hooks/protocol/events.js").PilotDeckHookEvent,
                  baseInput: { sessionId: context.sessionKey, transcriptPath: "", cwd: projectRoot },
                  payload,
                  matchQuery: hookEvent,
                }).catch(() => {});
              },
              emitAgentEvent: (_type, payload) => {
                eventBuf.emitter({
                  type: "elicitation_requested",
                  sessionId: context.sessionKey,
                  turnId: "",
                  requestId: payload.requestId,
                  toolName: payload.toolName,
                });
              },
            })
          : undefined;
      const subagentTranscript: AgentSubagentTranscriptHooks = {
        recordSubagentStarted: (args) =>
          storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
            subagentId: args.subagentId,
            subagentType: args.subagentType,
            prompt: args.prompt,
            transcriptRelativePath: args.transcriptRelativePath,
            subagentSessionId: args.subagentSessionId,
          }),
        recordSubagentCompleted: (args) =>
          storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
            subagentId: args.subagentId,
            subagentType: args.subagentType,
            summary: args.summary,
            usage: args.usage,
            turns: args.turns,
            durationMs: args.durationMs,
            errored: args.errored,
          }),
        subagentTranscriptResolver: (subagentId) => {
          const handle = storage.transcript.forSubagent(subagentId, this.options.now);
          return {
            recordAcceptedInput: (sessionId, turnId, messages) =>
              handle.writer.recordAcceptedInput(sessionId, turnId, messages),
            recordDurableMessage: (sessionId, turnId, message) =>
              handle.writer.recordDurableMessage(sessionId, turnId, message),
            transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
          };
        },
      };
      const planFileManager = createPlanFileManager({ projectRoot });
      const planTodoManager = createPlanTodoStateManager();
      return {
        context: contextRuntime,
        fileHistory,
        subagentTranscript,
        elicitation,
        planFileManager,
        planTodoManager,
      };
    };
    return {
      runtime,
      baseDependencies,
      extendDependencies,
    };
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const runtime = this.resolve(input.projectKey);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const sessions = await listProjectSessions({
      ...runtime.projectStorage,
      limit: input.limit,
      offset: safeOffset,
    });
    const nextOffset = safeOffset + sessions.length;
    return {
      sessions,
      nextCursor: input.limit && sessions.length === input.limit ? String(nextOffset) : undefined,
    };
  }

  private createAgentConfig(
    runtime: ProjectRuntime,
    sessionKey: string,
  ): CreateAgentSessionOptions["config"] {
    const agent = runtime.snapshot.config.agent;
    const override = this._sessionOverrides?.get(sessionKey);
    const permissionMode = override?.permissionMode ?? this.options.permissionMode;
    const cwd = override?.cwd ?? runtime.projectRoot;
    // Hand `PermissionContext` the same live rule-set reference the
    // gateway permission hook owns (see `getLiveRuleSet`). With this
    // shared reference, an "allow + remember" decision pushed by the
    // hook is visible to `PermissionRuntime.decide` on the very next
    // tool call inside the same turn — no roundtrip back to the client
    // needed, even when the client lives in a different process.
    const liveRuleSet = this.getLiveRuleSet(sessionKey);
    let modelMultimodal: import("../model/index.js").MultimodalConstraints | undefined;
    try {
      modelMultimodal = runtime.model.getMultimodal(agent.model.provider, agent.model.model);
    } catch {
      // Model or provider not found — fall back to text-only.
    }
    let maxContextTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(agent.model.provider, agent.model.model);
      maxContextTokens = agent.maxContextTokens ?? caps.maxContextTokens;
    } catch {
      maxContextTokens = agent.maxContextTokens;
    }
    return {
      provider: agent.model.provider,
      model: agent.model.model,
      modelMultimodal,
      cwd,
      permissionMode,
      jsonSelfCorrect: true,
      subagentTimeoutMs: agent.subagents?.timeoutMs,
      maxContextTokens,
      thinking: agent.thinking,
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        canPrompt: override?.canPrompt ?? false,
        bypassAvailable: override?.bypassAvailable ?? true,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        rules: {
          allow: liveRuleSet.allow,
          deny: liveRuleSet.deny,
          ask: liveRuleSet.ask,
        },
      }),
    };
  }
}

function mergeSessionDependencies(
  base: CreateAgentSessionOptions["dependencies"],
  extension: Partial<
    Pick<
      AgentRuntimeDependencies,
      "context" | "fileHistory" | "subagentTranscript" | "elicitation" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager"
    >
  >,
): CreateAgentSessionOptions["dependencies"] {
  return {
    ...base,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
    ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
    ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
    ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
  };
}

function handleExtensionWatchEvent(
  event: ExtensionWatchEvent,
  registry: ProjectRuntimeRegistry,
  router: SessionRouter | undefined,
): void {
  const changed = event.changedPaths.join(", ");
  if (event.scope.kind === "global") {
    // eslint-disable-next-line no-console
    console.log("[pilotdeck] Extensions changed, invalidating all runtimes:", changed);
    registry.invalidate();
    router?.markAllDirty("extension_changed");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[pilotdeck] Extensions changed for project ${event.scope.projectRoot}, invalidating runtime:`,
    changed,
  );
  registry.invalidate(event.scope.projectRoot);
  router?.markProjectDirty(event.scope.projectRoot, "extension_changed");
}

function describeExtensionScope(scope: ExtensionWatchEvent["scope"]): string {
  return scope.kind === "global" ? "global extensions" : `project extensions (${scope.projectRoot})`;
}

function createAutoElicitationChannel(): PilotDeckElicitationChannel {
  return {
    async askUser(request) {
      const answers: Record<string, string | string[]> = {};
      for (const q of request.questions) {
        if (q.options.length > 0) {
          answers[q.question] = q.multiSelect
            ? [q.options[0].label]
            : q.options[0].label;
        } else {
          answers[q.question] = "yes";
        }
      }
      return { type: "answered", answers };
    },
  };
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  if (router) {
    // Scenarios is optional at the parse boundary (see schema.ts) — the UI
    // can persist a partial `router:` block, e.g. user toggled `enabled`
    // and seeded `tokenSaver.*` without ever opening the Scenarios editor.
    // Fill `scenarios.default` from `agent.model` so RouterRuntime always
    // sees a valid map.
    return {
      ...router,
      scenarios: router.scenarios ?? { default: defaultRef },
      fallback: router.fallback ?? { default: [defaultRef] },
      tokenSaver: router.tokenSaver ?? buildDefaultTokenSaver(defaultRef),
      autoOrchestrate: router.autoOrchestrate ?? buildDefaultAutoOrchestrate(),
      stats: { enabled: true, baselineModel: defaultRef, ...(router.stats ?? {}) },
    };
  }
  return {
    scenarios: { default: defaultRef },
    fallback: { default: [defaultRef] },
    zeroUsageRetry: { enabled: true, maxAttempts: 2 },
    tokenSaver: buildDefaultTokenSaver(defaultRef),
    autoOrchestrate: buildDefaultAutoOrchestrate(),
    stats: { enabled: true, baselineModel: defaultRef },
  };
}

function buildDefaultTokenSaver(defaultRef: { id: string; provider: string; model: string }) {
  return {
    enabled: true,
    judge: defaultRef,
    defaultTier: "medium",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    tiers: {
      simple: { model: defaultRef },
      medium: { model: defaultRef },
      complex: { model: defaultRef },
      reasoning: { model: defaultRef },
    },
  };
}

function buildDefaultAutoOrchestrate() {
  return {
    enabled: true,
    triggerTiers: [...DEFAULT_TRIGGER_TIERS],
    slimSystemPrompt: true,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    subagentMaxTokens: DEFAULT_SUBAGENT_MAX_TOKENS,
  };
}
