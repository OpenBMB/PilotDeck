import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join as joinPath, resolve } from "node:path";

import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type {
  AgentRuntimeConfig,
  AgentLoopRuntimeFactory,
  AgentTurnResult,
  CreateAgentSessionOptions,
} from "../agent/index.js";
import { BackgroundSubagentRuntime } from "../agent/sub/BackgroundSubagentRuntime.js";
import { loadPluginFromPath, type PilotDeckLoadedPlugin } from "../extension/index.js";
import type { PilotDeckHookEvent } from "../extension/hooks/protocol/events.js";
import {
  GatewaySessionPermissionRuleSetRegistry,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type GatewayRecoveredUserDialog,
  type GatewayUserDialogResponseInput,
  type GatewayUserDialogStoreKey,
  type ListSessionsInput,
  type ListSessionsResult,
  InProcessGateway,
  createGatewayUserDialogJournal,
  createGatewaySessionCatalogConsumer,
} from "../gateway/index.js";
import {
  createGatewayNativeSessionStorage,
  resolveGatewayNativeProjectChatDir,
  type GatewayNativeSessionStorageAdapter,
} from "../gateway/storage/NativeSessionStorageAdapter.js";
import { DialogGatewayError } from "../gateway/dialog/errors.js";
import {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "../gateway/index.js";
import type { McpRuntimeFactory } from "../mcp/index.js";
import { parsePluginMcpServers } from "../mcp/index.js";
import type {
  ModelInvocationProvider,
  ModelRuntime,
  ProviderConfig,
} from "../model/index.js";
import type { InteractionProfileName } from "../interaction/index.js";
import type { PilotProxyConfig } from "../pilot/index.js";
import {
  PilotSdkSessionSettingsError,
  resolvePilotSdkSessionSettings,
  validatePilotSdkSettingSources,
} from "../pilot/index.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import { isOptionalFeatureEnabled } from "../pilot/config/optionalFeature.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_TRIGGER_TIERS,
  type RouterConfig,
} from "../router/config/schema.js";
import {
  createNativeRouterSessionStateProvider,
  RouterRuntimeError,
  type RouterSessionStatePort,
  type RouterSessionCustomRouterPort,
  type RouterProviderHealthPort,
  type RouterSessionStateProvider,
} from "../router/index.js";
import {
  createAgentProjectSessionStorage,
  FileHistoryStore,
  type AgentProjectSessionStorage,
  type ProjectSessionPersistenceProvider,
  type SessionCatalogPort,
} from "../session/index.js";
import { readAgentProjectSessionTranscript } from "../session/storage/ProjectSessionStorage.js";
import type { AgentFileSnapshotRecordedTranscriptEntry } from "../session/transcript/TranscriptEntry.js";
import type {
  ExecutionWorldBundle,
  PilotDeckToolDefinition,
  PilotDeckUnavailableToolDiagnostic,
  SandboxMode,
} from "../tool/index.js";
import type { TelemetryClient } from "../telemetry/index.js";
import type { ProjectContextStorageBundleOptions } from "./ProjectContextStorageBundle.js";
import type { ProjectMemoryProviderFactory } from "./ProjectMemoryBundle.js";
import type { CompactionPort, PromptCacheCoordinatorPort } from "../context/index.js";
import type { SessionTitlePort } from "../session/index.js";
import type { LspServicePort } from "../lsp/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import {
  ProjectRuntimeResourcesBundle,
  type ProjectRuntimeResources,
} from "./ProjectRuntimeResourcesBundle.js";
import { ProjectSessionFactory } from "./ProjectSessionFactory.js";
import { ProjectRouterEventBusProvider } from "./ProjectRouterEventBusProvider.js";
import { BrowserUseSessionMcpSpecPreparer } from "./BrowserUseSessionMcpSpecPreparer.js";
import type { GatewaySubagentContinuations } from "./GatewaySubagentRuntimeBundle.js";
import type {
  GatewayApplyFlagSettingsInput,
  GatewayApplyFlagSettingsResult,
  GatewaySessionSdkConfig,
  GatewaySetSessionThinkingInput,
} from "../gateway/protocol/types.js";
import type { GatewayUserDialogStore } from "../gateway/user-dialog/GatewayUserDialogStore.js";
import { acceptsFormDialogAnswer } from "../tool/dialog/FormDialogSchema.js";
import { recoverPendingLastTurnReplacements } from "../web/server/replaceLastTurn.js";
import { permissionEntryToRule, type PermissionRule } from "../permission/index.js";
import type { ResolvedGatewayOrganizationPolicy } from "./createLocalGateway.js";

export type ProjectRuntime = ProjectRuntimeResources & {
  projectRoot: string;
  resourcesBundle: ProjectRuntimeResourcesBundle;
  backgroundSubagents: BackgroundSubagentRuntime;
  runtimeState: "active" | "retired" | "disposed";
  sessionLeases: number;
  disposePromise?: Promise<void>;
  resolveSessionDrain?: () => void;
  unavailableTools?: PilotDeckUnavailableToolDiagnostic[];
  projectStorage: GatewayProjectStorageOptions;
};

type SdkTaskBudgetScope = "session" | "project";
type SdkTaskBudgetLedger = {
  spentUsd: number;
  settledRunIds: Set<string>;
  totalUsd?: number;
  projectRetentionMs?: number;
  lastActivityAtMs?: number;
};
type SdkTaskBudgetLedgerRecord =
  | { version: 1; kind: "snapshot"; projectRoot: string; sessionKey: string; scope: SdkTaskBudgetScope; spentUsd: number; settledRunIds: string[]; totalUsd?: number; projectRetentionMs?: number; lastActivityAtMs?: number }
  | { version: 1; kind: "configured"; projectRoot: string; sessionKey: string; scope: "project"; totalUsd: number; projectRetentionMs?: number; lastActivityAtMs?: number }
  | { version: 1; kind: "settled"; projectRoot: string; sessionKey: string; scope?: SdkTaskBudgetScope; runId: string; turnSpentUsd: number; lastActivityAtMs?: number }
  | { version: 1; kind: "cleared"; projectRoot: string; sessionKey: string; scope?: SdkTaskBudgetScope };

const DEFAULT_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS = 512;

export type ProjectRuntimeRegistryOptions = {
  fallbackProjectRoot: string;
  pilotHome: string;
  builtinSkillsRoot?: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  permissionTimeoutMs: number;
  elicitationTimeoutMs: number;
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  subagentIdFactory?: () => string;
  organizationToolPolicy?: { allow: readonly string[]; deny: readonly string[] };
  organizationPolicy?: ResolvedGatewayOrganizationPolicy;
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  testAgentConfigOverrides?: Pick<AgentRuntimeConfig, "maxContextMessages">;
  testOnAutomaticCompactionTrigger?: (observation: import("../context/index.js").CompactionAutomaticTriggerObservation) => void;
  modelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  executionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  mcpRuntimeFactory?: McpRuntimeFactory;
  /** Application-selected context I/O providers for published project generations. */
  contextStorage?: ProjectContextStorageBundleOptions;
  /** Application-selected project memory provider for published generations. */
  memoryProviderFactory?: ProjectMemoryProviderFactory;
  /** Application-selected compaction provider for published generations. */
  compactionProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => CompactionPort | undefined;
  /** Application-selected prompt-cache generation provider for published generations. */
  promptCacheCoordinatorFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => PromptCacheCoordinatorPort | undefined;
  /** Application-selected provider for session title generation. */
  sessionTitleProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    modelRuntime: ModelRuntime;
    now: () => Date;
  }) => SessionTitlePort | undefined;
  /** Application-selected project-generation LSP capability provider. */
  lspServiceFactory?: (input: { projectRoot: string; now: () => Date }) => LspServicePort;
  /** Application-owned volatile routing state retained across generation reloads. */
  routerSessionState?: RouterSessionStateProvider;
  /** Application-selected per-generation session custom-router provider. */
  routerSessionCustomRouterFactory?: () => RouterSessionCustomRouterPort;
  /** Application-selected per-generation Router provider-health policy. */
  routerProviderHealthFactory?: (input: { now: () => number }) => RouterProviderHealthPort;
  builtinPlugins?: PilotDeckLoadedPlugin[];
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  interactionProfile?: InteractionProfileName;
  autoElicitation?: boolean;
  telemetry: TelemetryClient;
  sessionCatalog: SessionCatalogPort;
  storageProvider?: ProjectSessionPersistenceProvider;
  nativeSessionStorage?: GatewayNativeSessionStorageAdapter;
  userDialogStore?: GatewayUserDialogStore;
  onProjectActivated?: (projectRoot: string) => void;
  continuations: GatewaySubagentContinuations;
  buildBrowserUseArgs(
    baseArgs: string[],
    outputDir: string,
    env: Record<string, string | undefined>,
    configProxy?: PilotProxyConfig,
  ): string[];
};

/**
 * Application-owned project generation registry. It is the sole owner of
 * generation publication, retirement and runtime/session leases; individual
 * resource providers remain owned by ProjectRuntimeResourcesBundle.
 */
export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private reloadTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposePromise?: Promise<void>;
  private readonly runtimeDisposals = new Set<Promise<void>>();
  private gateway?: InProcessGateway;
  /** Exact session retains avoid leaking fallback permission state by key. */
  private readonly permissionRuleSets = new GatewaySessionPermissionRuleSetRegistry();
  private readonly permissionModes = new GatewaySessionPermissionModeRegistry();
  private readonly sdkSessionConfigs = new Map<string, GatewaySessionSdkConfig>();
  private readonly sdkConfigChangeHandlers = new Map<string, {
    handler: (payload: { changedPaths: string[]; changeClasses: string[] }) => void;
  }>();
  private readonly sessionHookHandlers = new Map<string, {
    handler: (event: PilotDeckHookEvent, payload: Record<string, unknown>) => void;
  }>();
  private readonly sdkSessionPlugins = new Map<string, PilotDeckLoadedPlugin[]>();
  private readonly sdkSessionMcpServers = new Map<string, Map<string, {
    config: import("../gateway/protocol/types.js").GatewayMcpServerConfig;
    enabled: boolean;
  }>>();
  private readonly sdkMcpPermissionOverrides = new Map<string, Map<string, "default" | "auto">>();
  private readonly sdkMcpPermissionRules = new Map<string, Map<string, PermissionRule>>();
  private readonly sdkThinkingOverrides = new Map<string, GatewaySetSessionThinkingInput["thinking"]>();
  private readonly sdkSessionProjects = new Map<string, string | undefined>();
  private readonly ephemeralSessions = new Map<string, {
    root: string;
    storage: AgentProjectSessionStorage;
  }>();
  private readonly recoveredUserDialogs = new Map<string, GatewayRecoveredUserDialog[]>();
  private readonly recoveringUserDialogs = new Map<string, Promise<boolean>>();
  private readonly recoveredUserDialogWriteQueues = new Map<string, Promise<void>>();
  private readonly sdkTaskBudgetLedgers = new Map<string, SdkTaskBudgetLedger>();
  private taskBudgetLedgerLoad?: Promise<void>;
  private taskBudgetLedgerRecordCount = 0;
  private readonly taskBudgetLedgerCompactAfterRecords: number;
  private readonly recoveredNativeStorageChatDirs = new Set<string>();
  private readonly sessionFactory: ProjectSessionFactory<ProjectRuntime>;

  private _extraTools: PilotDeckToolDefinition[];
  private _sessionOverrides: SessionConfigOverrides | undefined;
  /** Shared only across Router generations; it is never durable Session state. */
  private readonly sharedSessionState: RouterSessionStatePort;
  private readonly ownsSharedSessionState: boolean;
  private readonly sessionCatalogConsumer: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  private readonly routerEvents: ProjectRouterEventBusProvider;
  private readonly browserUseMcpSpecs: BrowserUseSessionMcpSpecPreparer;

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
    this.taskBudgetLedgerCompactAfterRecords = readPositiveIntegerEnv(
      options.env.PILOTDECK_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS,
    ) ?? DEFAULT_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS;
    this.sharedSessionState = options.routerSessionState ?? createNativeRouterSessionStateProvider({
      now: () => options.now().getTime(),
    });
    this.ownsSharedSessionState = options.routerSessionState === undefined;
    this.sessionCatalogConsumer = createGatewaySessionCatalogConsumer({
      catalog: options.sessionCatalog,
      resolveStorage: (input) => this.resolve(input.projectKey).projectStorage,
    });
    this.routerEvents = new ProjectRouterEventBusProvider({
      pilotHome: options.pilotHome,
      onRetryProgress: (event) => this.gateway?.broadcastRetryProgress(event),
    });
    this.browserUseMcpSpecs = new BrowserUseSessionMcpSpecPreparer({
      env: options.env,
      buildArgs: options.buildBrowserUseArgs,
    });
    this.sessionFactory = new ProjectSessionFactory<ProjectRuntime>({
      resolveRuntime: (projectKey) => this.resolve(projectKey),
      acquireRuntimeLease: (runtime) => this.acquireRuntimeLease(runtime),
      acquirePermissionRuleSet: ({ sessionKey, permissionRules }) => {
        const lease = this.permissionRuleSets.acquire(sessionKey, permissionRules);
        this.syncSdkMcpPermissionRules(sessionKey, lease.rules.ask);
        return lease;
      },
      getSessionOverride: (sessionKey) => this._sessionOverrides?.get(sessionKey),
      getGateway: () => this.gateway,
      getSdkSessionConfig: (sessionKey, runtime) => this.resolveSdkSessionConfig(sessionKey, runtime),
      getSdkSessionPlugins: (sessionKey) => this.sdkSessionPlugins.get(sessionKey) ?? [],
      getSdkOutputStyleContent: (sessionKey, runtime) => {
        const name = this.sdkSessionConfigs.get(sessionKey)?.outputStyle;
        if (!name) return undefined;
        const plugins = this.sdkSessionPlugins.get(sessionKey) ?? [];
        return (plugins.length > 0
          ? runtime.pluginRuntime.createView(plugins).getOutputStyle(name)
          : runtime.pluginRuntime.getOutputStyle(name))?.content;
      },
      getSdkMcpServers: (sessionKey) => Object.fromEntries(
        [...(this.sdkSessionMcpServers.get(sessionKey)?.entries() ?? [])]
          .filter(([, server]) => server.enabled)
          .map(([name, server]) => [name, server.config]),
      ),
      getSdkThinking: (sessionKey) => this.sdkThinkingOverrides.get(sessionKey) ?? undefined,
      userDialogStore: options.userDialogStore,
      registerSdkConfigChangeHandler: (sessionKey, handler) =>
        this.registerSdkConfigChangeHandler(sessionKey, handler),
      registerSessionHookHandler: (sessionKey, handler) =>
        this.registerSessionHookHandler(sessionKey, handler),
      organizationToolPolicy: options.organizationToolPolicy,
      organizationPolicy: options.organizationPolicy,
      createStorage: ({ runtime, sessionKey, now }) => this.isEphemeralSession(sessionKey)
        ? this.getOrCreateEphemeralStorage(sessionKey, now)
        : createGatewayNativeSessionStorage({
            ...runtime.projectStorage,
            sessionId: sessionKey,
            now,
          }, options.nativeSessionStorage),
      permissionMode: options.permissionMode,
      additionalWorkingDirectories: options.additionalWorkingDirectories,
      mcpRuntimeFactory: options.mcpRuntimeFactory,
      preparePerSessionSpecs: ({ runtime, context, specs }) => this.browserUseMcpSpecs.prepare({
        projectRoot: runtime.projectRoot,
        sessionKey: context.sessionKey,
        proxy: runtime.snapshot.config.proxy,
        specs,
      }),
      getAlwaysOnToolNames: () => this._extraTools
        .filter((tool) => tool.name.startsWith("always_on_"))
        .map((tool) => tool.name),
      permissionTimeoutMs: options.permissionTimeoutMs,
      elicitationTimeoutMs: options.elicitationTimeoutMs,
      pilotHome: options.pilotHome,
      env: options.env,
      now: options.now,
      continuations: options.continuations,
      agentLoopFactory: options.agentLoopFactory,
      testAgentConfigOverrides: options.testAgentConfigOverrides,
      testOnAutomaticCompactionTrigger: options.testOnAutomaticCompactionTrigger,
      testAgentLoopFactory: options.testAgentLoopFactory,
      shouldCollectFileArtifacts: (runtime) => resolve(runtime.projectRoot) !== resolve(options.pilotHome),
      onDiagnostic: (message, error) => {
        // eslint-disable-next-line no-console
        console.warn(`[pilotdeck] ${message}`, error instanceof Error ? error.message : error ?? "");
      },
    });
  }

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  /** Gateway consumes this port; the registry keeps session rule ownership. */
  permissionGrantPort(): GatewaySessionPermissionRuleSetRegistry {
    return this.permissionRuleSets;
  }

  /** Gateway consumes this volatile host policy; it is never durable Session state. */
  permissionModePort(): GatewaySessionPermissionModePort {
    return this.permissionModes;
  }

  async disposeSessionMcpRuntimes(): Promise<void> {
    await this.sessionFactory.dispose();
    await Promise.all([...this.ephemeralSessions.keys()].map((sessionKey) =>
      this.disposeEphemeralSession(sessionKey)));
  }

  disposeProjectRuntimes(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.disposePromise = this.reloadTail
      .catch(() => undefined)
      .then(async () => {
        const runtimes = [...this.runtimes.values()];
        this.runtimes.clear();
        try {
          await this.disposePublishedRuntimes(runtimes);
        } finally {
          this.permissionModes.dispose();
          if (this.ownsSharedSessionState) {
            (this.sharedSessionState as RouterSessionStateProvider).clear();
          }
        }
      });
    return this.disposePromise;
  }

  invalidate(projectRoot?: string): void {
    if (this.disposed) return;
    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime) this.retireRuntime(runtime);
      this.runtimes.delete(projectRoot);
      return;
    }
    for (const runtime of this.runtimes.values()) this.retireRuntime(runtime);
    this.runtimes.clear();
  }

  private acquireRuntimeLease(runtime: ProjectRuntime): () => Promise<void> {
    if (runtime.runtimeState !== "active") {
      throw new Error(`Project runtime is ${runtime.runtimeState}.`);
    }
    runtime.sessionLeases += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      runtime.sessionLeases -= 1;
      if (runtime.sessionLeases === 0) runtime.resolveSessionDrain?.();
      if (runtime.runtimeState === "retired" && runtime.sessionLeases === 0) {
        await this.trackRuntimeDispose(runtime);
      }
    };
  }

  private retireRuntime(runtime: ProjectRuntime): void {
    if (runtime.runtimeState !== "active") return;
    runtime.runtimeState = "retired";
    if (runtime.sessionLeases === 0) {
      void this.trackRuntimeDispose(runtime).catch((error) => {
        console.warn(`[pilotdeck] failed to dispose retired runtime for ${runtime.projectRoot}:`, error);
      });
    }
  }

  private trackRuntimeDispose(runtime: ProjectRuntime): Promise<void> {
    const disposal = this.disposeRuntime(runtime);
    this.runtimeDisposals.add(disposal);
    void disposal.then(
      () => this.runtimeDisposals.delete(disposal),
      () => this.runtimeDisposals.delete(disposal),
    );
    return disposal;
  }

  private disposeRuntime(runtime: ProjectRuntime): Promise<void> {
    if (runtime.disposePromise) return runtime.disposePromise;
    runtime.disposePromise = (async () => {
      try {
        runtime.backgroundSubagents.shutdown();
        await runtime.resourcesBundle.dispose();
      } finally {
        runtime.runtimeState = "disposed";
      }
    })();
    return runtime.disposePromise;
  }

  updateSubsystems(config: {
    extraTools: PilotDeckToolDefinition[];
    sessionOverrides?: SessionConfigOverrides;
  }): void {
    this._extraTools = config.extraTools;
    this._sessionOverrides = config.sessionOverrides;
    this.invalidate();
  }

  reload(): Promise<void> {
    this.assertActive();
    const queued = this.reloadTail
      .catch(() => undefined)
      .then(() => this.performReload());
    this.reloadTail = queued;
    return queued;
  }

  private async performReload(): Promise<void> {
    this.assertActive();
    const current = [...this.runtimes.entries()];
    const staged = new Map<string, ProjectRuntime>();
    let disposePartialBuild: (() => Promise<void>) | undefined;
    try {
      for (const [projectRoot] of current) {
        staged.set(projectRoot, this.buildRuntime(projectRoot, {
          onFailure: (dispose) => { disposePartialBuild = dispose; },
        }));
      }
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(disposePartialBuild ? [disposePartialBuild()] : []),
        ...[...staged.values()].map(async (runtime) => {
          runtime.runtimeState = "retired";
          await this.disposeRuntime(runtime);
        }),
      ]);
      const cleanupFailures = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Failed to stage and clean up project runtime reload.");
      }
      throw error;
    }
    for (const [projectRoot, runtime] of staged) this.runtimes.set(projectRoot, runtime);
    for (const [, runtime] of current) this.retireRuntime(runtime);
  }

  setSessionCwd(sessionKey: string, cwd: string): void {
    if (!this._sessionOverrides) return;
    const existing = this._sessionOverrides.get(sessionKey);
    this._sessionOverrides.set(sessionKey, { ...existing, cwd });
  }

  createPersistentSessionStorage(
    projectRoot: string,
    sessionId: string,
    now: () => Date = this.options.now,
  ) {
    const runtime = this.resolve(projectRoot);
    return createGatewayNativeSessionStorage({
      ...runtime.projectStorage,
      sessionId,
      now,
    }, this.options.nativeSessionStorage);
  }

  async listRecoveredUserDialogsForSdk(
    projectRoot: string,
    sessionKey: string,
  ): Promise<GatewayRecoveredUserDialog[]> {
    if (this.isEphemeralSession(sessionKey)) return [];
    const dialogs = await this.loadRecoveredUserDialogs(projectRoot, sessionKey);
    return dialogs.map((dialog) => structuredClone(dialog));
  }

  async acknowledgeRecoveredUserDialogForSdk(
    projectRoot: string,
    sessionKey: string,
    requestId: string,
  ): Promise<boolean> {
    if (this.isEphemeralSession(sessionKey)) return false;
    const key = this.recoveredUserDialogKey(projectRoot, sessionKey);
    const dialogs = await this.loadRecoveredUserDialogs(projectRoot, sessionKey);
    const index = dialogs.findIndex((dialog) => dialog.request.requestId === requestId);
    if (index < 0) return false;
    const storage = this.createPersistentSessionStorage(projectRoot, sessionKey);
    createGatewayUserDialogJournal(storage)?.remove(requestId);
    await this.options.userDialogStore?.remove(this.userDialogStoreKey(projectRoot, sessionKey), requestId);
    dialogs.splice(index, 1);
    if (dialogs.length === 0) this.recoveredUserDialogs.delete(key);
    return true;
  }

  async listHostedUserDialogsForSdk(
    projectRoot: string,
    sessionKey: string,
  ): Promise<import("../gateway/protocol/types.js").GatewayUserDialogRequestEvent[]> {
    if (this.isEphemeralSession(sessionKey)) return [];
    const store = this.options.userDialogStore;
    if (!hasLiveUserDialogStore(store)) return [];
    const dialogs = await store.listLive(this.userDialogStoreKey(projectRoot, sessionKey));
    return dialogs.map((dialog) => structuredClone(dialog.request));
  }

  async claimHostedUserDialogForSdk(
    projectRoot: string,
    input: import("../gateway/protocol/types.js").GatewayUserDialogClaimInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayUserDialogClaimResult> {
    const store = this.options.userDialogStore;
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(store)) {
      return { claimed: false, reason: "not_pending" };
    }
    return store.claimLive(this.userDialogStoreKey(projectRoot, input.sessionKey), {
      requestId: input.requestId,
      ttlMs: input.ttlMs ?? 30_000,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    });
  }

  async releaseHostedUserDialogForSdk(
    projectRoot: string,
    input: import("../gateway/protocol/types.js").GatewayUserDialogReleaseInput,
  ): Promise<boolean> {
    const store = this.options.userDialogStore;
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(store)) return false;
    return store.releaseLive(this.userDialogStoreKey(projectRoot, input.sessionKey), {
      requestId: input.requestId,
      leaseId: input.leaseId,
    });
  }

  async submitHostedUserDialogAnswerForSdk(
    projectRoot: string,
    input: GatewayUserDialogResponseInput,
  ): Promise<boolean> {
    const store = this.options.userDialogStore;
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(store)) return false;
    const key = this.userDialogStoreKey(projectRoot, input.sessionKey);
    const dialog = (await store.listLive(key))
      .find((candidate) => candidate.request.requestId === input.requestId);
    if (!dialog) return false;
    if (input.result.behavior === "answered" && !acceptsRecoveredUserDialogAnswer(dialog.request, input.result.value)) {
      throw new DialogGatewayError(
        "INVALID_USER_DIALOG_RESPONSE",
        `answered ${dialog.request.dialogKind} dialog result does not match the pending dialog contract.`,
      );
    }
    return store.submitLiveAnswer(key, {
      requestId: input.requestId,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      result: structuredClone(input.result),
    });
  }

  async recoverUserDialogForSdk(
    projectRoot: string,
    input: GatewayUserDialogResponseInput,
  ): Promise<boolean> {
    if (this.isEphemeralSession(input.sessionKey)) return false;
    const sessionRecoveryKey = this.recoveredUserDialogKey(projectRoot, input.sessionKey);
    const recoveryKey = `${sessionRecoveryKey}\u0000${input.requestId}`;
    const inFlight = this.recoveringUserDialogs.get(recoveryKey);
    if (inFlight) return inFlight;
    const previous = this.recoveredUserDialogWriteQueues.get(sessionRecoveryKey) ?? Promise.resolve();
    const recovery = previous
      .catch(() => undefined)
      .then(() => this.writeRecoveredUserDialogAnswer(projectRoot, input));
    const queueTail = recovery.then(() => undefined, () => undefined);
    this.recoveredUserDialogWriteQueues.set(sessionRecoveryKey, queueTail);
    void queueTail.finally(() => {
      if (this.recoveredUserDialogWriteQueues.get(sessionRecoveryKey) === queueTail) {
        this.recoveredUserDialogWriteQueues.delete(sessionRecoveryKey);
      }
    });
    recovery.finally(() => this.recoveringUserDialogs.delete(recoveryKey)).catch(() => undefined);
    this.recoveringUserDialogs.set(recoveryKey, recovery);
    return recovery;
  }

  private async writeRecoveredUserDialogAnswer(
    projectRoot: string,
    input: GatewayUserDialogResponseInput,
  ): Promise<boolean> {
    const cacheKey = this.recoveredUserDialogKey(projectRoot, input.sessionKey);
    const dialogs = await this.loadRecoveredUserDialogs(projectRoot, input.sessionKey);
    const index = dialogs.findIndex((dialog) => dialog.request.requestId === input.requestId);
    if (index < 0) return false;
    const dialog = dialogs[index]!;
    if (input.result.behavior === "answered" && !acceptsRecoveredUserDialogAnswer(dialog.request, input.result.value)) {
      throw new DialogGatewayError(
        "INVALID_USER_DIALOG_RESPONSE",
        `answered ${dialog.request.dialogKind} dialog result does not match the recovered dialog contract.`,
      );
    }

    const storage = this.createPersistentSessionStorage(projectRoot, input.sessionKey);
    const transcript = await readAgentProjectSessionTranscript(storage);
    if (transcript.entries.length > 0) {
      const last = transcript.entries[transcript.entries.length - 1]!;
      storage.transcript.restoreState(
        transcript.entries.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0),
        last.entryId ?? null,
      );
    }

    const purpose = recoveredUserDialogPurpose(input.requestId);
    const alreadyPersisted = transcript.entries.some((entry) => (
      (entry.type === "durable_message" || entry.type === "tool_result_message")
      && entry.message.metadata?.purpose === purpose
    ));
    if (!alreadyPersisted) {
      const timestamp = this.options.now().toISOString();
      const turnId = `gateway:dialog-recovery:${randomUUID()}`;
      await storage.transcript.recordDurableMessage(input.sessionKey, turnId, {
        role: "user",
        content: [{
          type: "text",
          text: formatRecoveredUserDialogAnswer(dialog.request, input.result),
        }],
        metadata: {
          synthetic: true,
          purpose,
          toolCallId: dialog.request.toolCallId,
        },
      });
      const result: AgentTurnResult = {
        type: "aborted",
        sessionId: input.sessionKey,
        turnId,
        stopReason: "aborted_tools",
        usage: {},
        permissionDenials: [],
        turns: 0,
        startedAt: timestamp,
        completedAt: timestamp,
      };
      await storage.transcript.recordTurnResult(input.sessionKey, turnId, result);
    }

    createGatewayUserDialogJournal(storage)?.remove(input.requestId);
    await this.options.userDialogStore?.remove(this.userDialogStoreKey(projectRoot, input.sessionKey), input.requestId);
    dialogs.splice(index, 1);
    if (dialogs.length === 0) this.recoveredUserDialogs.delete(cacheKey);
    return true;
  }

  async clearRecoveredUserDialogsForSdk(projectRoot: string, sessionKey: string): Promise<void> {
    this.recoveredUserDialogs.delete(this.recoveredUserDialogKey(projectRoot, sessionKey));
    if (this.isEphemeralSession(sessionKey)) return;
    const storage = this.createPersistentSessionStorage(projectRoot, sessionKey);
    createGatewayUserDialogJournal(storage)?.clear();
    await this.options.userDialogStore?.clear?.(this.userDialogStoreKey(projectRoot, sessionKey));
  }

  private async loadRecoveredUserDialogs(
    projectRoot: string,
    sessionKey: string,
  ): Promise<GatewayRecoveredUserDialog[]> {
    const key = this.recoveredUserDialogKey(projectRoot, sessionKey);
    const cached = this.recoveredUserDialogs.get(key);
    const storage = this.createPersistentSessionStorage(projectRoot, sessionKey);
    const journalRecovered = createGatewayUserDialogJournal(storage)?.recover() ?? [];
    const stored = this.options.userDialogStore
      ? await this.options.userDialogStore.list(this.userDialogStoreKey(projectRoot, sessionKey))
      : [];
    const fromStore = stored.map((dialog) => ({
      type: "user_dialog_terminated" as const,
      request: structuredClone(dialog.request),
      reason: "gateway_restarted" as const,
      terminatedAt: dialog.createdAt,
      recovery: "next_turn_context" as const,
    }));
    const recoveredByRequestId = new Map<string, GatewayRecoveredUserDialog>();
    for (const dialog of [...journalRecovered, ...fromStore]) {
      recoveredByRequestId.set(dialog.request.requestId, dialog);
    }
    const recovered = [...recoveredByRequestId.values()];
    if (recovered.length === 0) {
      this.recoveredUserDialogs.delete(key);
      return recovered;
    }
    const terminatedAt = new Map(cached?.map((dialog) => [dialog.request.requestId, dialog.terminatedAt]));
    for (const dialog of recovered) {
      const prior = terminatedAt.get(dialog.request.requestId);
      if (prior) dialog.terminatedAt = prior;
    }
    this.recoveredUserDialogs.set(key, recovered);
    return recovered;
  }

  private recoveredUserDialogKey(projectRoot: string, sessionKey: string): string {
    return `${projectRoot}\u0000${sessionKey}`;
  }

  private userDialogStoreKey(projectRoot: string, sessionKey: string): GatewayUserDialogStoreKey {
    return Object.freeze({ projectRoot, pilotHome: this.options.pilotHome, sessionId: sessionKey });
  }

  clearSdkSessionState(sessionKey: string): void {
    const projectRoot = this.sdkSessionProjects.get(sessionKey);
    if (projectRoot) this.clearTaskBudgetLedger(projectRoot, sessionKey);
    this.sdkSessionConfigs.delete(sessionKey);
    this.sdkSessionPlugins.delete(sessionKey);
    this.sdkSessionMcpServers.delete(sessionKey);
    this.sdkMcpPermissionOverrides.delete(sessionKey);
    this.sdkMcpPermissionRules.delete(sessionKey);
    this.sdkThinkingOverrides.delete(sessionKey);
    this.sdkSessionProjects.delete(sessionKey);
    this.sdkConfigChangeHandlers.delete(sessionKey);
    this.sessionHookHandlers.delete(sessionKey);
  }

  registerSdkConfigChangeHandler(
    sessionKey: string,
    handler: (payload: { changedPaths: string[]; changeClasses: string[] }) => void,
  ): () => void {
    const registration = { handler };
    this.sdkConfigChangeHandlers.set(sessionKey, registration);
    return () => {
      if (this.sdkConfigChangeHandlers.get(sessionKey) === registration) {
        this.sdkConfigChangeHandlers.delete(sessionKey);
      }
    };
  }

  registerSessionHookHandler(
    sessionKey: string,
    handler: (event: PilotDeckHookEvent, payload: Record<string, unknown>) => void,
  ): () => void {
    const registration = { handler };
    this.sessionHookHandlers.set(sessionKey, registration);
    return () => {
      if (this.sessionHookHandlers.get(sessionKey) === registration) {
        this.sessionHookHandlers.delete(sessionKey);
      }
    };
  }

  dispatchSessionHook(
    sessionKey: string,
    event: PilotDeckHookEvent,
    payload: Record<string, unknown>,
  ): void {
    this.sessionHookHandlers.get(sessionKey)?.handler(event, payload);
  }

  dispatchSdkConfigChange(payload: { changedPaths: string[]; changeClasses: string[] }): void {
    for (const registration of this.sdkConfigChangeHandlers.values()) {
      registration.handler(payload);
    }
  }

  assertSdkModelAllowed(
    sessionKey: string,
    model?: { provider: string; model: string },
    projectKey?: string,
  ): void {
    const projectRoot = projectKey
      ?? this.sdkSessionProjects.get(sessionKey)
      ?? this.options.fallbackProjectRoot;
    const runtime = this.resolve(projectRoot);
    const resolvedModel = model ?? (() => {
      const requested = this.resolveSdkSessionConfig(sessionKey, runtime)?.settings?.agent?.model;
      return requested
        ? resolveSdkConfiguredModel(runtime.snapshot, requested, "agentModel")
        : runtime.snapshot.config.agent.model;
    })();
    this.assertOrganizationModelAllowed(
      runtime.projectRoot,
      resolvedModel,
    );
    assertSdkManagedModelAllowed(this.sdkSessionConfigs.get(sessionKey)?.managedModels, resolvedModel);
  }

  private assertOrganizationModelAllowed(
    projectRoot: string,
    model: { provider: string; model: string },
  ): void {
    if (!isOrganizationModelAllowed(this.options.organizationPolicy, model.provider, model.model)) {
      throw new DialogGatewayError(
        "GATEWAY_ORGANIZATION_MODEL_DENIED",
        `Gateway organization policy denies model ${model.provider}/${model.model}.`,
      );
    }
    const provider = this.resolve(projectRoot).snapshot.config.model.providers[model.provider];
    const rejection = organizationProviderPolicyRejection(this.options.organizationPolicy, model.provider, provider);
    if (rejection) throw new DialogGatewayError(rejection.code, rejection.message);
  }

  isEphemeralSession(sessionKey: string): boolean {
    return this.sdkSessionConfigs.get(sessionKey)?.persistSession === false;
  }

  async deleteEphemeralSession(sessionKey: string): Promise<boolean> {
    if (!this.ephemeralSessions.has(sessionKey)) return false;
    await this.disposeEphemeralSession(sessionKey);
    return true;
  }

  private async getOrCreateEphemeralStorage(
    sessionKey: string,
    now: () => Date,
  ): Promise<AgentProjectSessionStorage> {
    const existing = this.ephemeralSessions.get(sessionKey);
    if (existing) return existing.storage;
    const root = await mkdtemp(joinPath(tmpdir(), "pilotdeck-sdk-ephemeral-"));
    const storage = createAgentProjectSessionStorage({
      projectRoot: root,
      pilotHome: root,
      sessionId: sessionKey,
      now,
    });
    this.ephemeralSessions.set(sessionKey, { root, storage });
    return storage;
  }

  private async disposeEphemeralSession(sessionKey: string): Promise<void> {
    const record = this.ephemeralSessions.get(sessionKey);
    if (!record) return;
    this.ephemeralSessions.delete(sessionKey);
    try {
      await record.storage.dispose();
    } finally {
      await rm(record.root, { recursive: true, force: true });
      this.clearSdkSessionState(sessionKey);
    }
  }

  setSessionThinkingForSdk(
    sessionKey: string,
    thinking: GatewaySetSessionThinkingInput["thinking"],
  ): void {
    if (thinking === undefined) this.sdkThinkingOverrides.delete(sessionKey);
    else this.sdkThinkingOverrides.set(sessionKey, structuredClone(thinking));
  }

  async applyFlagSettingsForSdk(
    input: GatewayApplyFlagSettingsInput,
  ): Promise<GatewayApplyFlagSettingsResult> {
    const applied: string[] = [];
    const cleared: string[] = [];
    if (Object.prototype.hasOwnProperty.call(input.settings, "effortLevel")) {
      const effort = input.settings.effortLevel;
      if (effort === null) {
        this.sdkThinkingOverrides.delete(input.sessionKey);
        cleared.push("effortLevel");
      } else {
        this.sdkThinkingOverrides.set(input.sessionKey, {
          enabled: true,
          mode: effort as "low" | "medium" | "high",
        });
        applied.push("effortLevel");
      }
    }
    if (Object.prototype.hasOwnProperty.call(input.settings, "permissions")) {
      const permissions = input.settings.permissions;
      const defaultMode = permissions === null
        ? null
        : (permissions as Record<string, unknown>).defaultMode;
      if (defaultMode === null || defaultMode === undefined) {
        const existing = this._sessionOverrides?.get(input.sessionKey);
        if (existing?.permissionMode !== undefined && this._sessionOverrides) {
          const { permissionMode: _removed, ...rest } = existing;
          this._sessionOverrides.set(input.sessionKey, rest);
        }
        cleared.push("permissions.defaultMode");
      } else {
        const existing = this._sessionOverrides?.get(input.sessionKey) ?? {};
        this._sessionOverrides?.set(input.sessionKey, {
          ...existing,
          permissionMode: defaultMode as AgentRuntimeConfig["permissionMode"],
        });
        applied.push("permissions.defaultMode");
      }
    }
    return { applied, cleared };
  }

  async setSdkSessionConfig(
    sessionKey: string,
    config: GatewaySessionSdkConfig,
    projectKey?: string,
    signal?: AbortSignal,
  ): Promise<{ changed: boolean }> {
    signal?.throwIfAborted();
    const next = structuredClone(config);
    applyOrganizationTaskBudgetCap(next, this.options.organizationPolicy?.limits?.maxTaskBudgetUsd);
    validateSdkManagedPermissions(next.managedPermissions);
    validateSdkSelectorPolicy(next.managedTools, "tools");
    validateSdkSelectorPolicy(next.managedModels, "models");
    try {
      validatePilotSdkSettingSources(next.settingSources);
    } catch (error) {
      throw mapPilotSdkSettingsError(error);
    }
    assertOrganizationSettingSourcesAllowed(this.options.organizationPolicy, next.settingSources);
    const previous = this.sdkSessionConfigs.get(sessionKey);
    const runtime = this.resolve(projectKey);
    const resolvedSettings = this.resolveSdkSettings(runtime, next);
    for (const [requested, field] of [
      [resolvedSettings?.agent?.model, "agentModel"],
      [resolvedSettings?.agent?.fallbackModel, "fallbackModel"],
      [resolvedSettings?.agent?.subagents?.default, "subagentModel"],
    ] as const) {
      if (requested === undefined || requested === null) continue;
      const resolvedModel = resolveSdkConfiguredModel(runtime.snapshot, requested, field);
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolvedModel);
      assertSdkManagedModelAllowed(next.managedModels, resolvedModel);
    }
    const hasHostDefaults = hasOrganizationSdkSessionDefaults(this.options.organizationPolicy);
    if (JSON.stringify(previous) === JSON.stringify(next) && !(hasHostDefaults && previous === undefined)) {
      return { changed: false };
    }
    await runtime.pluginRuntime.refresh();
    signal?.throwIfAborted();
    const sessionPlugins = await resolveSdkSessionPlugins(next.plugins, runtime);
    const extensionView = runtime.pluginRuntime.createView(sessionPlugins);
    if (Array.isArray(next.skills)) {
      next.skills = resolveSdkSessionSkills(next.skills, extensionView.getAllSkills());
    }
    resolveSdkSubagentScopes(
      next.agents,
      next.skills,
      extensionView.getAllSkills(),
      this.sdkSessionMcpServers.get(sessionKey),
      runtime.snapshot,
      next.managedModels,
    );
    if (next.settings?.agent?.model) {
      const resolvedModel = resolveSdkConfiguredModel(runtime.snapshot, next.settings.agent.model, "model");
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolvedModel);
      assertSdkManagedModelAllowed(next.managedModels, resolvedModel);
    }
    if (next.fallbackModel) {
      const resolvedFallback = resolveSdkConfiguredModel(runtime.snapshot, next.fallbackModel, "fallbackModel");
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolvedFallback);
      assertSdkManagedModelAllowed(next.managedModels, resolvedFallback);
    }
    await this.configureProjectTaskBudget(runtime.projectRoot, sessionKey, next.taskBudget, signal);
    signal?.throwIfAborted();
    this.sdkSessionConfigs.set(sessionKey, next);
    if (sessionPlugins.length > 0) this.sdkSessionPlugins.set(sessionKey, sessionPlugins);
    else this.sdkSessionPlugins.delete(sessionKey);
    this.sdkSessionProjects.set(sessionKey, runtime.projectRoot);
    return { changed: true };
  }

  private resolveSdkSessionConfig(
    sessionKey: string,
    runtime: ProjectRuntime,
  ): GatewaySessionSdkConfig | undefined {
    const stored = this.sdkSessionConfigs.get(sessionKey);
    if (!stored) return undefined;
    const settings = this.resolveSdkSettings(runtime, stored);
    return {
      ...structuredClone(stored),
      ...(settings ? { settings } : { settings: undefined }),
    };
  }

  private resolveSdkSettings(
    runtime: ProjectRuntime,
    config: GatewaySessionSdkConfig,
  ) {
    try {
      return resolvePilotSdkSessionSettings({
        projectRoot: runtime.projectRoot,
        env: this.options.env,
        hostDefaults: this.options.organizationPolicy?.settings?.sessionDefaults,
        hostManagedSettings: this.options.organizationPolicy?.settings?.managedSessionSettings,
        hostSettingSources: this.options.organizationPolicy?.settings?.sessionDefaultSources,
        settings: config.settings,
        settingSources: config.settingSources,
        hostEnforcedSettings: this.options.organizationPolicy?.settings?.enforcedSessionSettings,
      });
    } catch (error) {
      throw mapPilotSdkSettingsError(error);
    }
  }

  async taskBudgetSnapshotForSdk(input: {
    sessionKey: string;
    projectKey?: string;
  }): Promise<{ totalUsd: number; spentUsd: number } | undefined> {
    const taskBudget = this.sdkSessionConfigs.get(input.sessionKey)?.taskBudget;
    if (!taskBudget) return undefined;
    const runtime = this.resolve(input.projectKey ?? this.sdkSessionProjects.get(input.sessionKey));
    const scope = sdkTaskBudgetScope(taskBudget);
    await this.ensureTaskBudgetLedgerLoaded();
    const key = taskBudgetLedgerKey(runtime.projectRoot, scope, input.sessionKey);
    const ledger = this.sdkTaskBudgetLedgers.get(key);
    return {
      totalUsd: scope === "project" ? ledger?.totalUsd ?? taskBudget.total : taskBudget.total,
      spentUsd: ledger?.spentUsd ?? 0,
    };
  }

  async outputStylesListForSdk(
    input: import("../gateway/protocol/types.js").GatewayOutputStylesListInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayOutputStylesListResult> {
    const runtime = this.resolve(input.projectKey);
    await runtime.pluginRuntime.refresh();
    const styles = runtime.pluginRuntime.createView(
      input.sessionKey ? this.sdkSessionPlugins.get(input.sessionKey) ?? [] : [],
    ).listOutputStyles().map((style) => ({
      name: style.name,
      ...(style.description ? { description: style.description } : {}),
      ...(style.plugin ? { plugin: style.plugin } : {}),
      ...(style.source ? { source: style.source } : {}),
    }));
    const selected = input.sessionKey ? this.sdkSessionConfigs.get(input.sessionKey)?.outputStyle : undefined;
    return { styles, ...(selected ? { selected } : {}) };
  }

  async setOutputStyleForSdk(
    input: import("../gateway/protocol/types.js").GatewaySetOutputStyleInput,
  ): Promise<import("../gateway/protocol/types.js").GatewaySetOutputStyleResult> {
    const runtime = this.resolve(input.projectKey);
    await runtime.pluginRuntime.refresh();
    if (input.name !== null && !runtime.pluginRuntime.createView(
      this.sdkSessionPlugins.get(input.sessionKey) ?? [],
    ).getOutputStyle(input.name)) {
      throw new DialogGatewayError("OUTPUT_STYLE_NOT_FOUND", `Unknown output style: ${input.name}`);
    }
    const previous = this.sdkSessionConfigs.get(input.sessionKey) ?? {};
    const next = { ...previous, ...(input.name === null ? {} : { outputStyle: input.name }) };
    if (input.name === null) delete next.outputStyle;
    this.sdkSessionConfigs.set(input.sessionKey, next);
    this.sdkSessionProjects.set(input.sessionKey, runtime.projectRoot);
    await this.gateway?.closeSession({ sessionKey: input.sessionKey, reason: "sdk_output_style_changed" });
    return { applied: true, ...(input.name !== null ? { selected: input.name } : {}) };
  }

  async reloadOutputStylesForSdk(
    input: import("../gateway/protocol/types.js").GatewayReloadOutputStylesInput = {},
  ): Promise<import("../gateway/protocol/types.js").GatewayReloadOutputStylesResult> {
    const runtime = this.resolve(input.projectKey);
    const result = await runtime.pluginRuntime.reloadOutputStyles();
    for (const [sessionKey, projectRoot] of this.sdkSessionProjects) {
      if (input.projectKey && projectRoot !== runtime.projectRoot) continue;
      if (this.sdkSessionConfigs.has(sessionKey)) {
        await this.gateway?.closeSession({ sessionKey, reason: "sdk_output_styles_reloaded" });
      }
    }
    return { reloaded: true, changed: result.changed };
  }

  async rewindFilesForSdk(
    input: import("../gateway/protocol/types.js").GatewayRewindFilesInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayRewindFilesResult> {
    const runtime = this.resolve(input.projectKey);
    const storage = this.createPersistentSessionStorage(runtime.projectRoot, input.sessionKey, this.options.now);
    try {
      const transcript = await readAgentProjectSessionTranscript(storage);
      const snapshots = transcript.entries
        .filter((entry): entry is AgentFileSnapshotRecordedTranscriptEntry =>
          entry.type === "file_snapshot_recorded",
        )
        .map((entry) => ({
          messageId: entry.messageId,
          trackedFileBackups: entry.trackedFileBackups,
          expectedFileStates: entry.expectedFileStates,
          timestamp: entry.snapshotTimestamp,
        }));
      if (snapshots.length === 0) {
        return { canRewind: false, error: "No persisted file checkpoint is available for this session." };
      }
      const history = new FileHistoryStore({
        backupDir: storage.fileHistoryDir,
        backupStorage: storage.fileHistoryBackupStorage,
        now: this.options.now,
      });
      history.replayFromTranscript(snapshots);
      const conflicts = await history.getConflictPaths(input.userMessageId);
      if (conflicts.length > 0) {
        return {
          canRewind: false,
          conflicts,
          error: `Files changed outside PilotDeck since checkpoint: ${conflicts.join(", ")}`,
        };
      }
      const stats = await history.getDiffStats(input.userMessageId);
      if (input.dryRun) {
        return { canRewind: true, insertions: stats.insertions, deletions: stats.deletions };
      }
      const result = await history.rewind(input.userMessageId);
      return result.conflicts.length > 0
        ? {
            canRewind: false,
            conflicts: result.conflicts,
            error: `Files changed outside PilotDeck since checkpoint: ${result.conflicts.join(", ")}`,
          }
        : {
            canRewind: true,
            filesChanged: result.filesChanged,
            insertions: stats.insertions,
            deletions: stats.deletions,
            ...(result.missing.length > 0 ? { missing: result.missing } : {}),
          };
    } catch (error) {
      return { canRewind: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await storage.dispose();
    }
  }

  async setMcpServersForSdk(
    input: import("../gateway/protocol/types.js").GatewaySetMcpServersInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayMcpSetServersResult> {
    const runtime = this.resolve(input.projectKey);
    await runtime.pluginRuntime.refresh();
    const reserved = new Set<string>();
    for (const plugin of runtime.pluginRuntime.snapshot()) {
      for (const name of Object.keys(plugin.mcpServers ?? {})) reserved.add(name);
    }
    for (const plugin of this.sdkSessionPlugins.get(input.sessionKey) ?? []) {
      for (const name of Object.keys(plugin.mcpServers ?? {})) reserved.add(name);
    }
    const current = this.sdkSessionMcpServers.get(input.sessionKey) ?? new Map();
    const next = new Map<string, { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean }>();
    const errors: Array<{ name: string; error: string }> = [];
    for (const [name, config] of Object.entries(input.servers ?? {})) {
      if (reserved.has(name)) {
        errors.push({ name, error: "This MCP server name is owned by project configuration or a plugin." });
        continue;
      }
      const parsed = parsePluginMcpServers({ [name]: toPluginMcpConfig(config) });
      if (parsed.servers.length !== 1 || parsed.diagnostics.length > 0) {
        errors.push({ name, error: parsed.diagnostics[0]?.message ?? "Invalid MCP server configuration." });
        continue;
      }
      next.set(name, { config: structuredClone(config), enabled: current.get(name)?.enabled ?? true });
    }
    if (errors.length > 0) return { added: [], removed: [], errors };
    const added = [...next.entries()]
      .filter(([name, value]) => JSON.stringify(current.get(name)) !== JSON.stringify(value))
      .map(([name]) => name);
    const removed = [...current.keys()].filter((name) => !next.has(name));
    if (next.size > 0) this.sdkSessionMcpServers.set(input.sessionKey, next);
    else this.sdkSessionMcpServers.delete(input.sessionKey);
    this.sdkSessionProjects.set(input.sessionKey, runtime.projectRoot);
    await this.gateway?.closeSession({ sessionKey: input.sessionKey, reason: "sdk_mcp_servers_changed" });
    return { added, removed, errors: [] };
  }

  async setMcpPermissionModeOverrideForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpPermissionModeOverrideInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayMcpPermissionModeOverrideResult> {
    if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (!input.serverName?.trim()) throw new DialogGatewayError("INVALID_MCP_SERVER", "serverName is required.");
    if (input.mode !== null && input.mode !== "default" && input.mode !== "auto") {
      throw new DialogGatewayError("INVALID_MCP_PERMISSION_MODE", `Unsupported MCP permission mode: ${input.mode}`);
    }
    if (input.mode === null) {
      const session = this.sdkMcpPermissionOverrides.get(input.sessionKey);
      session?.delete(input.serverName);
      if (session?.size === 0) this.sdkMcpPermissionOverrides.delete(input.sessionKey);
    } else {
      const session = this.sdkMcpPermissionOverrides.get(input.sessionKey) ?? new Map<string, "default" | "auto">();
      session.set(input.serverName, input.mode);
      this.sdkMcpPermissionOverrides.set(input.sessionKey, session);
    }
    this.permissionRuleSets.updateAskRules(
      input.sessionKey,
      (rules) => this.syncSdkMcpPermissionRules(input.sessionKey, rules),
    );
    return input.mode === "auto"
      ? { warning: "PilotDeck does not expose Claude's MCP safety classifier; auto uses conservative ask semantics for this server." }
      : {};
  }

  private syncSdkMcpPermissionRules(sessionKey: string, askRules: PermissionRule[]): void {
    const generated = this.sdkMcpPermissionRules.get(sessionKey) ?? new Map<string, PermissionRule>();
    const active = this.sdkMcpPermissionOverrides.get(sessionKey) ?? new Map<string, "default" | "auto">();
    for (const [serverName, rule] of generated) {
      if (active.has(serverName)) continue;
      const index = askRules.indexOf(rule);
      if (index >= 0) askRules.splice(index, 1);
      generated.delete(serverName);
    }
    for (const serverName of active.keys()) {
      let rule = generated.get(serverName);
      if (!rule) {
        rule = {
          source: "session",
          behavior: "ask",
          toolName: `mcp__${normalizeMcpPermissionSegment(serverName)}__*`,
          force: true,
        };
        generated.set(serverName, rule);
      }
      if (!askRules.includes(rule)) askRules.push(rule);
    }
    if (generated.size > 0) this.sdkMcpPermissionRules.set(sessionKey, generated);
    else this.sdkMcpPermissionRules.delete(sessionKey);
  }

  async toggleMcpServerForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerToggleInput,
  ): Promise<void> {
    const server = this.sdkSessionMcpServers.get(input.sessionKey)?.get(input.serverName);
    if (!server) throw new DialogGatewayError("MCP_SERVER_NOT_FOUND", `SDK-owned MCP server ${input.serverName} is not configured for session ${input.sessionKey}.`);
    server.enabled = input.enabled;
    await this.gateway?.closeSession({ sessionKey: input.sessionKey, reason: "sdk_mcp_server_toggled" });
  }

  async reconnectMcpServerForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerControlInput,
  ): Promise<void> {
    const server = this.sdkSessionMcpServers.get(input.sessionKey)?.get(input.serverName);
    if (!server) throw new DialogGatewayError("MCP_SERVER_NOT_FOUND", `SDK-owned MCP server ${input.serverName} is not configured for session ${input.sessionKey}.`);
    if (!server.enabled) throw new DialogGatewayError("MCP_SERVER_DISABLED", `SDK-owned MCP server ${input.serverName} is disabled; enable it before reconnecting.`);
    await this.gateway?.closeSession({ sessionKey: input.sessionKey, reason: "sdk_mcp_server_reconnect" });
  }

  async mcpServerStatusForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerStatusInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayMcpServerStatusResult> {
    const runtime = this.resolve(input.projectKey);
    await runtime.pluginRuntime.refresh();
    const servers = new Map<string, { name: string; status: string }>();
    if (input.sessionKey) {
      for (const plugin of this.sdkSessionPlugins.get(input.sessionKey) ?? []) {
        for (const name of Object.keys(plugin.mcpServers ?? {})) servers.set(name, { name, status: "configured" });
      }
      for (const [name, configured] of this.sdkSessionMcpServers.get(input.sessionKey) ?? []) {
        servers.set(name, { name, status: configured.enabled ? "configured" : "disabled" });
      }
    }
    return { servers: [...servers.values()] };
  }

  usageSnapshotForSdk(
    input: import("../gateway/protocol/types.js").GatewayUsageSnapshotInput,
  ): import("../gateway/protocol/types.js").GatewayUsageSnapshotResult {
    const runtime = this.resolve(input.projectKey);
    const session = input.sessionKey ? runtime.router.stats.sessionSnapshot?.(input.sessionKey) : undefined;
    const aggregate = session?.aggregate ?? runtime.router.stats.snapshot();
    const requests = session?.requestLog.map((record) => ({
      ...(record.turnId ? { turnId: record.turnId } : {}),
      provider: record.provider,
      model: record.model,
      ...(record.role ? { role: record.role } : {}),
      usage: { ...record.usage },
      ...(record.cost ? { cost: { ...record.cost } } : {}),
      ...(record.costSource ? { costSource: record.costSource } : {}),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    }));
    return {
      scope: session ? "session" : "project",
      ...(session ? { sessionId: session.sessionId } : {}),
      aggregate: {
        totalRequests: aggregate.totalRequests,
        totalInputTokens: aggregate.totalInputTokens,
        totalOutputTokens: aggregate.totalOutputTokens,
        totalCost: aggregate.totalCost,
        totalBaselineCost: aggregate.totalBaselineCost,
        totalSavedCost: aggregate.totalSavedCost,
        perScenario: { ...aggregate.perScenario },
        perModel: { ...aggregate.perModel },
        perProvider: { ...aggregate.perProvider },
        perTier: { ...aggregate.perTier },
        perRole: { ...aggregate.perRole },
        costSources: { ...(aggregate.costSources ?? {}) },
      },
      ...(requests ? { requests } : {}),
    };
  }

  modelUsageSnapshotForSdk(
    input: import("../gateway/protocol/types.js").GatewayModelUsageSnapshotInput,
  ): import("../gateway/protocol/types.js").GatewayModelUsageSnapshotResult {
    const runtime = this.resolve(input.projectKey);
    const session = input.sessionKey ? runtime.router.stats.sessionSnapshot?.(input.sessionKey) : undefined;
    return {
      scope: session ? "session" : "project",
      ...(session ? { sessionId: session.sessionId } : {}),
      models: (runtime.router.stats.modelUsageSnapshot?.(input.sessionKey) ?? []).map((usage) => ({
        provider: usage.provider,
        model: usage.model,
        totalRequests: usage.totalRequests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
        totalCost: usage.totalCost,
        costSources: { ...(usage.costSources ?? {}) },
        roles: Object.fromEntries(Object.entries(usage.roles).map(([role, totals]) => [role, {
          ...totals,
          costSources: { ...(totals.costSources ?? {}) },
        }])),
      })),
    };
  }

  async recordTaskBudgetSpendForSdk(input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
    turnSpentUsd: number;
  }): Promise<void> {
    if (!Number.isFinite(input.turnSpentUsd) || input.turnSpentUsd < 0) return;
    const taskBudget = this.sdkSessionConfigs.get(input.sessionKey)?.taskBudget;
    if (!taskBudget) return;
    const runtime = this.resolve(input.projectKey ?? this.sdkSessionProjects.get(input.sessionKey));
    const scope = sdkTaskBudgetScope(taskBudget);
    await this.ensureTaskBudgetLedgerLoaded();
    const key = taskBudgetLedgerKey(runtime.projectRoot, scope, input.sessionKey);
    const ledger = this.sdkTaskBudgetLedgers.get(key) ?? { spentUsd: 0, settledRunIds: new Set<string>() };
    this.sdkTaskBudgetLedgers.set(key, ledger);
    if (ledger.settledRunIds.has(input.runId)) return;
    ledger.settledRunIds.add(input.runId);
    ledger.spentUsd += input.turnSpentUsd;
    if (scope === "project" && ledger.projectRetentionMs !== undefined) {
      ledger.lastActivityAtMs = this.options.now().getTime();
    }
    this.appendTaskBudgetLedgerRecord({
      version: 1,
      kind: "settled",
      projectRoot: runtime.projectRoot,
      sessionKey: input.sessionKey,
      ...(scope === "project" ? { scope } : {}),
      runId: input.runId,
      turnSpentUsd: input.turnSpentUsd,
      ...(ledger.lastActivityAtMs !== undefined ? { lastActivityAtMs: ledger.lastActivityAtMs } : {}),
    });
  }

  private async configureProjectTaskBudget(
    projectRoot: string,
    sessionKey: string,
    taskBudget: GatewaySessionSdkConfig["taskBudget"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!taskBudget || sdkTaskBudgetScope(taskBudget) !== "project") return;
    await this.ensureTaskBudgetLedgerLoaded();
    signal?.throwIfAborted();
    const key = taskBudgetLedgerKey(projectRoot, "project", sessionKey);
    let ledger = this.sdkTaskBudgetLedgers.get(key);
    if (ledger && this.expireProjectTaskBudgetLedgerIfInactive(key, ledger)) ledger = undefined;
    if (!ledger) {
      ledger = { spentUsd: 0, settledRunIds: new Set() };
      this.sdkTaskBudgetLedgers.set(key, ledger);
    }
    if (ledger.totalUsd !== undefined) {
      if (ledger.totalUsd !== taskBudget.total) {
        throw new DialogGatewayError(
          "SDK_PROJECT_TASK_BUDGET_TOTAL_CONFLICT",
          `Project taskBudget.total is fixed at $${ledger.totalUsd.toFixed(6)}; received $${taskBudget.total.toFixed(6)}.`,
        );
      }
      if (ledger.projectRetentionMs !== taskBudget.projectRetentionMs) {
        throw new DialogGatewayError(
          "SDK_PROJECT_TASK_BUDGET_RETENTION_CONFLICT",
          "Project taskBudget.projectRetentionMs is fixed by the first project budget configuration.",
        );
      }
      return;
    }
    ledger.totalUsd = taskBudget.total;
    ledger.projectRetentionMs = taskBudget.projectRetentionMs;
    if (taskBudget.projectRetentionMs !== undefined) ledger.lastActivityAtMs = this.options.now().getTime();
    this.appendTaskBudgetLedgerRecord({
      version: 1,
      kind: "configured",
      projectRoot,
      sessionKey,
      scope: "project",
      totalUsd: taskBudget.total,
      ...(taskBudget.projectRetentionMs !== undefined
        ? { projectRetentionMs: taskBudget.projectRetentionMs, lastActivityAtMs: ledger.lastActivityAtMs! }
        : {}),
    });
  }

  private expireProjectTaskBudgetLedgerIfInactive(key: string, ledger: SdkTaskBudgetLedger): boolean {
    if (ledger.projectRetentionMs === undefined || ledger.lastActivityAtMs === undefined) return false;
    if (this.options.now().getTime() - ledger.lastActivityAtMs < ledger.projectRetentionMs) return false;
    const identity = taskBudgetLedgerIdentity(key);
    this.sdkTaskBudgetLedgers.delete(key);
    this.appendTaskBudgetLedgerRecord({ version: 1, kind: "cleared", ...identity });
    return true;
  }

  private async ensureTaskBudgetLedgerLoaded(): Promise<void> {
    if (this.taskBudgetLedgerLoad) return this.taskBudgetLedgerLoad;
    this.taskBudgetLedgerLoad = (async () => {
      const raw = await readFile(this.taskBudgetLedgerPath(), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (!isSdkTaskBudgetLedgerRecord(record)) continue;
        this.taskBudgetLedgerRecordCount += 1;
        const scope = normalizeSdkTaskBudgetScope(record.scope);
        const key = taskBudgetLedgerKey(record.projectRoot, scope, record.sessionKey);
        if (record.kind === "cleared") {
          this.sdkTaskBudgetLedgers.delete(key);
          continue;
        }
        const ledger = this.sdkTaskBudgetLedgers.get(key) ?? { spentUsd: 0, settledRunIds: new Set<string>() };
        this.sdkTaskBudgetLedgers.set(key, ledger);
        if (record.kind === "snapshot") {
          ledger.spentUsd = record.spentUsd;
          ledger.settledRunIds = new Set(record.settledRunIds);
          ledger.totalUsd = record.totalUsd;
          ledger.projectRetentionMs = record.projectRetentionMs;
          ledger.lastActivityAtMs = record.lastActivityAtMs;
        } else if (record.kind === "configured") {
          ledger.totalUsd ??= record.totalUsd;
          ledger.projectRetentionMs ??= record.projectRetentionMs;
          ledger.lastActivityAtMs ??= record.lastActivityAtMs;
        } else if (!ledger.settledRunIds.has(record.runId)) {
          ledger.settledRunIds.add(record.runId);
          ledger.spentUsd += record.turnSpentUsd;
          if (record.lastActivityAtMs !== undefined) {
            ledger.lastActivityAtMs = Math.max(ledger.lastActivityAtMs ?? 0, record.lastActivityAtMs);
          }
        }
      }
    })();
    return this.taskBudgetLedgerLoad;
  }

  private clearTaskBudgetLedger(projectRoot: string, sessionKey: string): void {
    this.sdkTaskBudgetLedgers.delete(taskBudgetLedgerKey(projectRoot, "session", sessionKey));
    this.appendTaskBudgetLedgerRecord({ version: 1, kind: "cleared", projectRoot, sessionKey });
  }

  private taskBudgetLedgerPath(): string {
    return joinPath(this.options.pilotHome, "gateway", "sdk-task-budget-ledger.jsonl");
  }

  private appendTaskBudgetLedgerRecord(record: SdkTaskBudgetLedgerRecord): void {
    const filePath = this.taskBudgetLedgerPath();
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    this.taskBudgetLedgerRecordCount += 1;
    if (this.taskBudgetLedgerRecordCount >= this.taskBudgetLedgerCompactAfterRecords) {
      const snapshots = [...this.sdkTaskBudgetLedgers.entries()].map(([key, ledger]) => ({
        version: 1 as const,
        kind: "snapshot" as const,
        ...taskBudgetLedgerIdentity(key),
        spentUsd: ledger.spentUsd,
        settledRunIds: [...ledger.settledRunIds].sort(),
        ...(ledger.totalUsd !== undefined ? { totalUsd: ledger.totalUsd } : {}),
        ...(ledger.projectRetentionMs !== undefined
          ? { projectRetentionMs: ledger.projectRetentionMs, lastActivityAtMs: ledger.lastActivityAtMs! }
          : {}),
      } satisfies SdkTaskBudgetLedgerRecord));
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, snapshots.map((snapshot) => `${JSON.stringify(snapshot)}\n`).join(""), "utf8");
      renameSync(temporaryPath, filePath);
      this.taskBudgetLedgerRecordCount = snapshots.length;
    }
  }

  resolve(projectKey?: string): ProjectRuntime {
    this.assertActive();
    const projectRoot = resolve(projectKey ?? this.options.fallbackProjectRoot);
    this.recoverNativeSessionStorage(projectRoot);
    this.options.onProjectActivated?.(projectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) return cached;

    const runtime = this.buildRuntime(projectRoot);
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  private recoverNativeSessionStorage(projectRoot: string): void {
    if (!this.options.nativeSessionStorage) return;
    const chatDir = resolveGatewayNativeProjectChatDir({
      projectRoot,
      pilotHome: this.options.pilotHome,
    }, this.options.nativeSessionStorage);
    if (this.recoveredNativeStorageChatDirs.has(chatDir)) return;
    this.recoveredNativeStorageChatDirs.add(chatDir);
    const recovery = recoverPendingLastTurnReplacements(this.options.pilotHome, { chatDirs: [chatDir] });
    for (const failure of recovery.failures) {
      console.warn(
        `[pilotdeck] Could not recover replacement transaction for ${failure.transcriptPath}: ${failure.message}`,
      );
    }
  }

  private async disposePublishedRuntimes(runtimes: readonly ProjectRuntime[]): Promise<void> {
    const failures: unknown[] = [];
    for (const runtime of runtimes) {
      if (runtime.runtimeState === "active") runtime.runtimeState = "retired";
      if (runtime.sessionLeases > 0 || runtime.runtimeState === "disposed") continue;
      try {
        await this.trackRuntimeDispose(runtime);
      } catch (error) {
        failures.push(error);
      }
    }
    while (this.runtimeDisposals.size > 0) {
      const results = await Promise.allSettled([...this.runtimeDisposals]);
      failures.push(...results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose project runtime generations.");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Project runtime registry is disposed.");
  }

  private buildRuntime(
    projectRoot: string,
    options: { onFailure?: (dispose: () => Promise<void>) => void } = {},
  ): ProjectRuntime {
    const bundle = new ProjectRuntimeResourcesBundle({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinSkillsRoot: this.options.builtinSkillsRoot,
      env: this.options.env,
      now: this.options.now,
      telemetry: this.options.telemetry,
      extraTools: this._extraTools,
      subagentIdFactory: this.options.subagentIdFactory,
      builtinPlugins: this.options.builtinPlugins ?? loadBuiltinPlugins(),
      modelFactory: this.options.modelFactory,
      modelInvocationProviderFactory: this.options.modelInvocationProviderFactory,
      executionWorldBundleFactory: this.options.executionWorldBundleFactory,
      mcpRuntimeFactory: this.options.mcpRuntimeFactory,
      contextStorage: this.options.contextStorage,
      memoryProviderFactory: this.options.memoryProviderFactory,
      compactionProviderFactory: this.options.compactionProviderFactory,
      promptCacheCoordinatorFactory: this.options.promptCacheCoordinatorFactory,
      sessionTitleProviderFactory: this.options.sessionTitleProviderFactory,
      lspServiceFactory: this.options.lspServiceFactory,
      routerSessionCustomRouterFactory: this.options.routerSessionCustomRouterFactory,
      routerProviderHealthFactory: this.options.routerProviderHealthFactory,
      ...(this.options.organizationPolicy?.models || this.options.organizationPolicy?.providers
        ? {
            modelPolicy: {
              isAllowed: (snapshot, model) => isOrganizationModelAllowed(
                this.options.organizationPolicy,
                model.provider,
                model.model,
              ),
              assertAllowed: (snapshot, model) => {
                if (!isOrganizationModelAllowed(this.options.organizationPolicy, model.provider, model.model)) {
                  throw new RouterRuntimeError(
                    "GATEWAY_ORGANIZATION_MODEL_DENIED",
                    `Gateway organization policy denies model ${model.provider}/${model.model}.`,
                  );
                }
                const rejection = organizationProviderPolicyRejection(
                  this.options.organizationPolicy,
                  model.provider,
                  snapshot.config.model.providers[model.provider],
                );
                if (rejection) throw new RouterRuntimeError(rejection.code, rejection.message);
              },
            },
          }
        : {}),
      runtimeProfileOverrides: {
        interactionProfileOverride: this.options.interactionProfile,
        autoElicitation: this.options.autoElicitation,
      },
      createRouterConfig: (snapshot) =>
        ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model),
      createRouterEventBus: () => this.routerEvents.create(),
      routerSessionState: this.sharedSessionState,
      onDiagnostic: (message, error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] ${message} for project ${projectRoot}:`,
          error instanceof Error ? error.message : error ?? "",
        );
      },
    });
    try {
      const resources = bundle.stage();
      const backgroundSubagents = new BackgroundSubagentRuntime();
      return {
        projectRoot,
        runtimeState: "active",
        sessionLeases: 0,
        resourcesBundle: bundle,
        backgroundSubagents,
        projectStorage: {
          projectRoot,
          pilotHome: this.options.pilotHome,
          storageProvider: this.options.storageProvider,
        },
        ...resources,
      };
    } catch (error) {
      const dispose = () => bundle.dispose();
      if (options.onFailure) {
        options.onFailure(dispose);
      } else {
        void dispose().catch((cleanupError) => {
          console.warn(`[pilotdeck] failed to clean up incomplete project runtime for ${projectRoot}:`, cleanupError);
        });
      }
      throw error;
    }
  }

  async createSession(context: GatewaySessionContext) {
    return this.sessionFactory.createSession(context);
  }

  async recreateSession(context: GatewaySessionContext, previousSession: import("../agent/index.js").AgentSession) {
    return this.sessionFactory.recreateSession(context, previousSession);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.sessionCatalogConsumer(input);
  }

  async stopBackgroundTaskForSdk(
    input: import("../gateway/protocol/types.js").GatewayStopBackgroundTaskInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayStopBackgroundTaskResult> {
    const runtime = this.resolve(input.projectKey);
    const task = runtime.backgroundSubagents.get(input.taskId);
    if (task?.kind === "background" && task.sessionId === input.sessionKey) {
      const stopped = await runtime.backgroundSubagents.stopAndWait(input.taskId);
      const status = runtime.backgroundSubagents.get(input.taskId)?.status;
      return { stopped, ...(status === "unknown" ? {} : { status }) };
    }
    const shellTask = runtime.executionWorld.backgroundTasks.get(input.taskId);
    if (!shellTask || shellTask.sessionId !== input.sessionKey) {
      throw new DialogGatewayError(
        "BACKGROUND_TASK_NOT_FOUND",
        `Background task ${input.taskId} is not owned by session ${input.sessionKey}.`,
      );
    }
    await runtime.executionWorld.backgroundTasks.stop(input.taskId);
    const status = runtime.executionWorld.backgroundTasks.get(input.taskId)?.status;
    return { stopped: true, ...(status === "unknown" ? {} : { status }) };
  }

  async backgroundTasksForSdk(
    input: import("../gateway/protocol/types.js").GatewayBackgroundTasksInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayBackgroundTasksResult> {
    const runtime = this.resolve(input.projectKey);
    const subagentTasks = runtime.backgroundSubagents.list({
      sessionId: input.sessionKey,
      kind: "background",
      status: ["pending", "running"],
    });
    if (input.taskId && subagentTasks.some((task) => task.taskId === input.taskId)) {
      return { backgrounded: true, taskIds: [input.taskId] };
    }
    if (!input.taskId && subagentTasks.length > 0) {
      return { backgrounded: true, taskIds: subagentTasks.map((task) => task.taskId) };
    }
    const running = runtime.executionWorld.backgroundTasks.list({ status: "running" })
      .filter((task) => task.sessionId === input.sessionKey);
    if (input.taskId && !running.some((task) => task.taskId === input.taskId)) {
      return { backgrounded: false, reason: "task_not_found" };
    }
    return running.length > 0
      ? { backgrounded: false, reason: "no_foreground_tasks" }
      : { backgrounded: false, reason: input.taskId ? "task_not_found" : "no_foreground_tasks" };
  }
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  if (!isOptionalFeatureEnabled(router)) return { enabled: false };
  if (router) {
    return {
      enabled: true,
      ...router,
      scenarios: router.scenarios ?? { default: defaultRef },
      fallback: router.fallback ?? { default: [defaultRef] },
      tokenSaver: router.tokenSaver ?? buildDefaultTokenSaver(defaultRef),
      autoOrchestrate: router.autoOrchestrate ?? buildDefaultAutoOrchestrate(),
      stats: { enabled: true, baselineModel: defaultRef, ...(router.stats ?? {}) },
    };
  }
  return {
    enabled: true,
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
  };
}

async function resolveSdkSessionPlugins(
  requested: GatewaySessionSdkConfig["plugins"],
  runtime: ProjectRuntime,
): Promise<PilotDeckLoadedPlugin[]> {
  if (!requested || requested.length === 0) return [];
  const names = new Set(runtime.pluginRuntime.snapshot().map((plugin) => plugin.name));
  const paths = new Set<string>();
  const plugins: PilotDeckLoadedPlugin[] = [];
  for (const descriptor of requested) {
    let pluginPath: string;
    try {
      pluginPath = await realpath(descriptor.path);
    } catch {
      throw new DialogGatewayError(
        "SDK_PLUGIN_NOT_FOUND",
        `Gateway-local SDK plugin path does not exist: ${descriptor.path}`,
      );
    }
    if (paths.has(pluginPath)) {
      throw new DialogGatewayError("SDK_PLUGIN_DUPLICATE_PATH", `Gateway-local SDK plugin path is listed more than once: ${descriptor.path}`);
    }
    paths.add(pluginPath);
    if (!(await stat(pluginPath)).isDirectory()) {
      throw new DialogGatewayError("SDK_PLUGIN_NOT_DIRECTORY", `Gateway-local SDK plugin path is not a directory: ${descriptor.path}`);
    }
    let plugin: PilotDeckLoadedPlugin;
    try {
      plugin = await loadPluginFromPath(pluginPath, "project");
    } catch (error) {
      throw new DialogGatewayError(
        "SDK_PLUGIN_LOAD_FAILED",
        `Could not load SDK plugin ${descriptor.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (names.has(plugin.name)) {
      throw new DialogGatewayError("SDK_PLUGIN_NAME_CONFLICT", `SDK plugin ${plugin.name} conflicts with an already discovered project plugin.`);
    }
    names.add(plugin.name);
    plugins.push(plugin);
  }
  return plugins;
}

function resolveSdkSessionSkills(
  requested: readonly string[],
  available: readonly { name: string }[],
): string[] {
  const resolved: string[] = [];
  for (const requestedName of requested) {
    const exact = available.filter((skill) => skill.name === requestedName);
    const candidates = exact.length > 0
      ? exact
      : available.filter((skill) => skill.name.endsWith(`:${requestedName}`));
    if (candidates.length === 0) {
      throw new DialogGatewayError("SDK_SKILL_NOT_FOUND", `SDK session skill is not available in this project: ${requestedName}`);
    }
    if (candidates.length > 1) {
      throw new DialogGatewayError("SDK_SKILL_AMBIGUOUS", `SDK session skill is ambiguous; use its fully-qualified name: ${requestedName}`);
    }
    if (!resolved.includes(candidates[0]!.name)) resolved.push(candidates[0]!.name);
  }
  return resolved;
}

function toPluginMcpConfig(
  config: import("../gateway/protocol/types.js").GatewayMcpServerConfig,
): Record<string, unknown> {
  if (config.type === "stdio") {
    return {
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
    };
  }
  return {
    url: config.url,
    transport: config.type,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
  };
}

function resolveSdkConfiguredModel(
  snapshot: PilotConfigSnapshot,
  requested: string,
  field: "model" | "agentModel" | "fallbackModel" | "subagentModel",
): { provider: string; model: string } {
  const candidates = Object.entries(snapshot.config.model.providers).flatMap(([provider, config]) =>
    Object.entries(config.models).map(([model, definition]) => ({
      provider,
      model,
      id: definition.id,
    })),
  ).filter((candidate) => requested === candidate.id
    || requested === `${candidate.provider}/${candidate.model}`
    || requested === candidate.model);
  if (candidates.length !== 1 || !candidates[0]) {
    const errorByField = {
      model: "INVALID_SDK_MODEL",
      agentModel: "INVALID_SDK_AGENT_MODEL",
      fallbackModel: "INVALID_SDK_FALLBACK_MODEL",
      subagentModel: "INVALID_SDK_SUBAGENT_MODEL",
    } as const;
    const labelByField = {
      model: "model",
      agentModel: "settings.agent.model",
      fallbackModel: "fallbackModel",
      subagentModel: "settings.agent.subagents.default",
    } as const;
    throw new DialogGatewayError(
      errorByField[field],
      `${labelByField[field]} is not uniquely resolvable from the Gateway catalog: ${requested}`,
    );
  }
  return { provider: candidates[0].provider, model: candidates[0].model };
}

function assertSdkManagedModelAllowed(
  policy: GatewaySessionSdkConfig["managedModels"],
  model: { provider: string; model: string },
): void {
  if (!policy) return;
  const matches = (selector: string) => selector === "*"
    || selector === `${model.provider}/*`
    || selector === `${model.provider}/${model.model}`;
  if (!policy.deny.some(matches) && (policy.allow.length === 0 || policy.allow.some(matches))) return;
  throw new DialogGatewayError(
    "SDK_MANAGED_MODEL_DENIED",
    `SDK managedSettings.models denies model ${model.provider}/${model.model}.`,
  );
}

function validateSdkManagedPermissions(
  value: GatewaySessionSdkConfig["managedPermissions"],
): void {
  if (!value) return;
  for (const [label, entries] of [["deny", value.deny], ["ask", value.ask]] as const) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new DialogGatewayError("INVALID_SDK_MANAGED_SETTINGS", `managedPermissions.${label} must contain non-empty strings.`);
    }
  }
  if (value.defaultMode !== undefined && value.defaultMode !== "plan") {
    throw new DialogGatewayError("UNSUPPORTED_SDK_MANAGED_SETTINGS", "managedPermissions.defaultMode may only force plan mode.");
  }
  if (value.canPrompt !== undefined && value.canPrompt !== false) {
    throw new DialogGatewayError("UNSUPPORTED_SDK_MANAGED_SETTINGS", "managedPermissions.canPrompt may only disable prompts.");
  }
}

function validateSdkSelectorPolicy(
  value: GatewaySessionSdkConfig["managedTools"] | GatewaySessionSdkConfig["managedModels"],
  kind: "tools" | "models",
): void {
  if (!value) return;
  const valid = kind === "tools"
    ? (selector: string) => selector === "*" || /^[A-Za-z0-9][A-Za-z0-9_.:-]*\*?$/.test(selector)
    : (selector: string) => selector === "*" || /^[^/\s]+\/(?:[^/\s]+|\*)$/.test(selector);
  for (const [label, entries] of [["allow", value.allow], ["deny", value.deny]] as const) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !valid(entry.trim()))) {
      throw new DialogGatewayError("INVALID_SDK_MANAGED_SETTINGS", `managed${kind === "tools" ? "Tools" : "Models"}.${label} contains an invalid selector.`);
    }
    if (new Set(entries.map((entry) => entry.trim())).size !== entries.length) {
      throw new DialogGatewayError("INVALID_SDK_MANAGED_SETTINGS", `managed${kind === "tools" ? "Tools" : "Models"}.${label} cannot contain duplicates.`);
    }
  }
}

function applyOrganizationTaskBudgetCap(
  config: GatewaySessionSdkConfig,
  cap: number | undefined,
): void {
  if (cap === undefined) return;
  const budget = config.taskBudget;
  config.taskBudget = {
    total: budget ? Math.min(budget.total, cap) : cap,
    ...(budget?.scope === "project" ? { scope: "project" as const } : {}),
    ...(budget?.projectRetentionMs !== undefined ? { projectRetentionMs: budget.projectRetentionMs } : {}),
  };
}

function assertOrganizationSettingSourcesAllowed(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  sources: GatewaySessionSdkConfig["settingSources"],
): void {
  if (!policy?.settingSources || !sources) return;
  const denied = sources.find((source) => policy.settingSources!.deny.includes(source)
    || (policy.settingSources!.allow.length > 0 && !policy.settingSources!.allow.includes(source)));
  if (denied) {
    throw new DialogGatewayError(
      "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED",
      `Gateway organization policy denies the ${denied} SDK settings source.`,
    );
  }
}

function mapPilotSdkSettingsError(error: unknown): unknown {
  return error instanceof PilotSdkSessionSettingsError
    ? new DialogGatewayError(error.code, error.message)
    : error;
}

function hasOrganizationSdkSessionDefaults(policy: ResolvedGatewayOrganizationPolicy | undefined): boolean {
  return policy?.settings?.sessionDefaults !== undefined
    || policy?.settings?.managedSessionSettings !== undefined
    || policy?.settings?.sessionDefaultSources !== undefined
    || policy?.settings?.enforcedSessionSettings !== undefined
    || policy?.limits?.maxTaskBudgetUsd !== undefined;
}

function isOrganizationModelAllowed(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  provider: string,
  model: string,
): boolean {
  if (!policy?.models) return true;
  const matches = (selector: string) => selector === "*"
    || selector === `${provider}/*`
    || selector === `${provider}/${model}`;
  return !policy.models.deny.some(matches)
    && (policy.models.allow.length === 0 || policy.models.allow.some(matches));
}

function organizationProviderPolicyRejection(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  providerId: string,
  provider: ProviderConfig | undefined,
): { code: string; message: string } | undefined {
  const providers = policy?.providers;
  if (!providers) return undefined;
  if (providers.deny.includes(providerId) || (providers.allow.length > 0 && !providers.allow.includes(providerId))) {
    return { code: "GATEWAY_ORGANIZATION_PROVIDER_DENIED", message: `Gateway organization policy denies provider ${providerId}.` };
  }
  let origin: string | undefined;
  try { origin = provider?.url ? new URL(provider.url).origin : undefined; } catch { origin = undefined; }
  if (providers.origins.deny.includes(origin ?? "") || (providers.origins.allow.length > 0 && !providers.origins.allow.includes(origin ?? ""))) {
    return { code: "GATEWAY_ORGANIZATION_PROVIDER_ORIGIN_DENIED", message: `Gateway organization policy denies provider origin ${origin ?? "<unknown>"} for ${providerId}.` };
  }
  const credentialSource = provider?.credentialSource;
  if (credentialSource && (providers.credentials.deny.includes(credentialSource)
    || (providers.credentials.allow.length > 0 && !providers.credentials.allow.includes(credentialSource)))) {
    return { code: "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED", message: `Gateway organization policy denies ${credentialSource} credentials for provider ${providerId}.` };
  }
  if (!credentialSource && providers.credentials.allow.length > 0) {
    return { code: "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED", message: `Gateway organization policy requires a known credential source for provider ${providerId}.` };
  }
  return undefined;
}

function normalizeMcpPermissionSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return normalized || value;
}

function recoveredUserDialogPurpose(requestId: string): string {
  return `gateway_user_dialog_recovery:${requestId}`;
}

function hasLiveUserDialogStore(
  store: GatewayUserDialogStore | undefined,
): store is GatewayUserDialogStore & Required<Pick<
  GatewayUserDialogStore,
  "listLive" | "claimLive" | "releaseLive" | "submitLiveAnswer" | "takeLiveAnswer"
>> {
  return Boolean(
    store?.listLive
    && store.claimLive
    && store.releaseLive
    && store.submitLiveAnswer
    && store.takeLiveAnswer,
  );
}

function acceptsRecoveredUserDialogAnswer(
  request: GatewayRecoveredUserDialog["request"],
  value: unknown,
): boolean {
  if (request.dialogKind === "input") return typeof value === "string";
  if (request.dialogKind === "select") {
    return typeof value === "string" && request.choices.some((choice) => choice.value === value);
  }
  if (request.dialogKind === "confirm") return typeof value === "boolean";
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
    && acceptsFormDialogAnswer(request.schema, value as Record<string, unknown>);
}

function formatRecoveredUserDialogAnswer(
  request: GatewayRecoveredUserDialog["request"],
  result: GatewayUserDialogResponseInput["result"],
): string {
  const prefix = [
    "[Gateway restart dialog recovery]",
    `The Gateway restarted while waiting for ${request.toolName}.`,
    `Question: ${request.prompt}`,
  ];
  if (result.behavior === "cancelled") {
    return [...prefix, `The user cancelled the dialog${result.reason ? `: ${result.reason}` : "."}`].join("\n");
  }
  if (request.dialogKind === "input") {
    return [...prefix, `The user answered: ${result.value as string}`].join("\n");
  }
  if (request.dialogKind === "select") {
    return [...prefix, `The user selected: ${result.value as string}`].join("\n");
  }
  if (request.dialogKind === "confirm") {
    return [...prefix, `The user confirmed: ${result.value === true ? "yes" : "no"}`].join("\n");
  }
  return [...prefix, `The user submitted: ${JSON.stringify(result.value)}`].join("\n");
}

function resolveSdkSubagentScopes(
  agents: GatewaySessionSdkConfig["agents"],
  parentSkills: GatewaySessionSdkConfig["skills"],
  availableSkills: readonly { name: string }[],
  sessionMcpServers: ReadonlyMap<string, {
    config: import("../gateway/protocol/types.js").GatewayMcpServerConfig;
    enabled: boolean;
  }> | undefined,
  snapshot: PilotConfigSnapshot,
  managedModels: GatewaySessionSdkConfig["managedModels"],
): void {
  if (!agents) return;
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.model) {
      let resolved: { provider: string; model: string };
      try {
        resolved = resolveSdkConfiguredModel(snapshot, agent.model, "model");
      } catch {
        throw new DialogGatewayError(
          "INVALID_SDK_AGENT_MODEL",
          `Agent ${agentId} model is not uniquely resolvable from the Gateway catalog: ${agent.model}`,
        );
      }
      assertSdkManagedModelAllowed(managedModels, resolved);
      agent.model = `${resolved.provider}/${resolved.model}`;
    }
    if (Array.isArray(agent.skills)) {
      const resolved = resolveSdkSessionSkills(agent.skills, availableSkills);
      if (Array.isArray(parentSkills)) {
        const parent = new Set(parentSkills);
        const escaped = resolved.find((name) => !parent.has(name));
        if (escaped) {
          throw new DialogGatewayError(
            "SDK_AGENT_SKILL_OUT_OF_SCOPE",
            `Agent ${agentId} skill is not visible to the parent SDK session: ${escaped}`,
          );
        }
      }
      agent.skills = resolved;
    } else if (agent.skills === "all" && Array.isArray(parentSkills)) {
      agent.skills = [...parentSkills];
    } else if (agent.skills === undefined && Array.isArray(parentSkills)) {
      agent.skills = [...parentSkills];
    }
    if (agent.mcpServers !== undefined) {
      agent.mcpServers = resolveSdkSubagentMcpServers(agentId, agent.mcpServers, sessionMcpServers);
    }
  }
}

function resolveSdkSubagentMcpServers(
  agentId: string,
  specs: NonNullable<import("../gateway/protocol/types.js").GatewaySdkAgentDefinition["mcpServers"]>,
  sessionMcpServers: ReadonlyMap<string, {
    config: import("../gateway/protocol/types.js").GatewayMcpServerConfig;
    enabled: boolean;
  }> | undefined,
): Record<string, import("../gateway/protocol/types.js").GatewayMcpServerConfig> {
  const resolved: Record<string, import("../gateway/protocol/types.js").GatewayMcpServerConfig> = {};
  const entries = Array.isArray(specs) ? specs : [specs];
  for (const spec of entries) {
    if (typeof spec === "string") {
      const configured = sessionMcpServers?.get(spec);
      if (!configured) {
        throw new DialogGatewayError(
          "SDK_AGENT_MCP_REFERENCE_NOT_FOUND",
          `Agent ${agentId} references SDK-session MCP server ${spec}, but it is not configured for this session.`,
        );
      }
      if (!configured.enabled) {
        throw new DialogGatewayError(
          "SDK_AGENT_MCP_REFERENCE_DISABLED",
          `Agent ${agentId} references SDK-session MCP server ${spec}, but it is disabled.`,
        );
      }
      resolved[spec] = structuredClone(configured.config);
      continue;
    }
    for (const [name, config] of Object.entries(spec)) {
      if (resolved[name]) {
        throw new DialogGatewayError("INVALID_MCP_SERVER", `Agent ${agentId} repeats MCP server ${name}.`);
      }
      resolved[name] = structuredClone(config);
    }
  }
  return resolved;
}

function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sdkTaskBudgetScope(
  budget: GatewaySessionSdkConfig["taskBudget"],
): SdkTaskBudgetScope {
  return budget?.scope === "project" ? "project" : "session";
}

function normalizeSdkTaskBudgetScope(scope: unknown): SdkTaskBudgetScope {
  return scope === "project" ? "project" : "session";
}

function taskBudgetLedgerKey(
  projectRoot: string,
  scope: SdkTaskBudgetScope,
  sessionKey: string,
): string {
  return `${resolve(projectRoot)}\u0000${scope}\u0000${scope === "project" ? "*" : sessionKey}`;
}

function taskBudgetLedgerIdentity(key: string): {
  projectRoot: string;
  scope: SdkTaskBudgetScope;
  sessionKey: string;
} {
  const [projectRoot = "", scope = "session", sessionKey = ""] = key.split("\u0000");
  return { projectRoot, scope: normalizeSdkTaskBudgetScope(scope), sessionKey };
}

function isSdkTaskBudgetLedgerRecord(value: unknown): value is SdkTaskBudgetLedgerRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.kind !== "string"
    || typeof record.projectRoot !== "string" || typeof record.sessionKey !== "string") return false;
  if (record.scope !== undefined && record.scope !== "session" && record.scope !== "project") return false;
  if (record.kind === "cleared") return true;
  if (record.kind === "configured") {
    return record.scope === "project" && typeof record.totalUsd === "number";
  }
  if (record.kind === "settled") {
    return typeof record.runId === "string" && typeof record.turnSpentUsd === "number";
  }
  return record.kind === "snapshot"
    && typeof record.spentUsd === "number"
    && Array.isArray(record.settledRunIds)
    && record.settledRunIds.every((runId) => typeof runId === "string");
}
