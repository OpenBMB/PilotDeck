import { randomUUID } from "node:crypto";
import {
  readFile as readFileAsync,
  realpath,
  rename as renameAsync,
  rm as rmAsync,
  stat as statAsync,
} from "node:fs/promises";
import { resolve, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AlwaysOnControlPort } from "../always-on/protocol/AlwaysOnControlPort.js";
import {
  AgentLoop,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentLoopRuntimeFactory,
  type AgentLoopSeedState,
  type AgentLoopRunner,
  type AgentLoopSidecarTransportObserver,
} from "../agent/index.js";
import {
  createStaffDeckSopAgentLoop,
  StaffDeckSopControlPlane,
} from "../sop/staffdeck/index.js";
import {
  createNodeAttachmentPort,
  type CompactionPort,
  type CompactionAutomaticTriggerObservation,
  type PromptCacheCoordinatorPort,
  type AttachmentPort,
} from "../context/index.js";
import type { PilotDeckLoadedPlugin } from "../extension/index.js";
import { isPilotDeckHookEvent } from "../extension/hooks/protocol/events.js";
import {
  InProcessGateway,
  SessionRouter,
  GatewayAgentEventProjector,
  GatewayAgentEventTelemetryObserver,
  GatewayToolResultArtifactStore,
  GatewayManualCompactionCoordinator,
  GatewayTurnReplayStore,
  GatewayTurnTelemetryContextResolver,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type Gateway,
  type GatewayCronController,
  type GatewayToolResultArtifactStorePort,
} from "../gateway/index.js";
import {
  createGatewayNativeSessionCatalog,
  type GatewayNativeSessionStorageAdapter,
} from "../gateway/storage/NativeSessionStorageAdapter.js";
import type { GatewayUserDialogStore } from "../gateway/user-dialog/GatewayUserDialogStore.js";
import { DialogGatewayError } from "../gateway/dialog/errors.js";
import type { UploadLifecyclePort } from "../gateway/dialog/UploadLifecyclePort.js";
import {
  type McpRuntimeFactory,
} from "../mcp/index.js";
import {
  NativeSessionModelSelectionPolicy,
  NativeSessionModelSelectionPort,
  flattenToolResultBlockText,
  type CanonicalMessage,
  type ModelRuntime,
  type ModelInvocationProvider,
} from "../model/index.js";
import {
  type InteractionProfileName,
} from "../interaction/index.js";
import type { RouterSessionStateProvider } from "../router/index.js";
import type { RouterSessionCustomRouterPort } from "../router/index.js";
import type { RouterProviderHealthPort } from "../router/index.js";
import type { LspServicePort } from "../lsp/index.js";
import {
  ensureWritableDirectory,
  resolveProjectStorageId,
  updatePilotLocalSettings,
  validatePilotSdkSessionSettings,
  validatePilotSdkSettingSources,
  PilotSdkSessionSettingsError,
  type PilotProxyConfig,
  type PilotSdkSessionSettings,
} from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import { redactConfig } from "../pilot/config/redact.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import {
  createProjectSessionDataPlane,
  ProjectSessionWriteCoordinator,
  type ProjectSessionDataPlane,
  type ProjectSessionForkPort,
  type ProjectSessionPersistenceProvider,
  type ProjectSessionReplacementPort,
  type ProjectSessionStorageProvider,
  type SessionCatalogPort,
  type SessionSearchPort,
  type SessionTitlePort,
  sanitizeSessionIdForPath,
  JsonlTranscriptWriter,
  InMemoryTranscriptWriter,
  replayTranscriptEntries,
} from "../session/index.js";
import { readAgentProjectSessionTranscript } from "../session/storage/ProjectSessionStorage.js";
import {
  type ExecutionWorldBundle,
  type SandboxMode,
} from "../tool/index.js";
import type {
  PilotDeckToolDefinition,
} from "../tool/index.js";
import {
  SkillManager,
  migrateLegacyBundledSkillCopies,
  type SkillManagementPort,
} from "../extension/skills/index.js";
import { createSkillManagementPort, isDisabledModuleBinding, isExternalModuleBinding } from "../composition/index.js";
import { getPilotDeckInstallCommand } from "../mcp/runtime/projectMcpSpec.js";
import { isPathWithinRoot } from "../tool/builtin/filesystem/pathSafety.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import {
  type TelemetryClient,
  type TelemetryObserverRegistry,
} from "../telemetry/index.js";
import { LocalGatewayBootResources } from "./LocalGatewayBootResources.js";
import { readPositiveIntegerEnv, resolveLocalGatewayBootConfig } from "./LocalGatewayBootConfig.js";
import {
  createAgentLoopDeploymentFactory,
  createAgentLoopBindingFactory,
  resolveAgentLoopDeploymentProfile,
} from "./AgentLoopDeploymentProfile.js";
import { GatewaySessionModelBundle } from "./GatewaySessionModelBundle.js";
import { GatewaySessionHistoryBundle } from "./GatewaySessionHistoryBundle.js";
import { GatewayDialogBundle } from "./GatewayDialogBundle.js";
import type { ProjectContextStorageBundleOptions } from "./ProjectContextStorageBundle.js";
import type { ProjectMemoryProviderFactory } from "./ProjectMemoryBundle.js";
import { GatewayCommandCatalogBundle } from "./GatewayCommandCatalogBundle.js";
import { GatewayRuntimeRefreshBundle } from "./GatewayRuntimeRefreshBundle.js";
import { GatewayTelemetryBundle } from "./GatewayTelemetryBundle.js";
import { ProjectMemoryMaintenanceController } from "./ProjectMemoryMaintenanceController.js";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.js";
import {
  GatewaySubagentRuntimeBundle,
  type GatewaySubagentContinuations,
} from "./GatewaySubagentRuntimeBundle.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  /** Read-only skills shipped with this PilotDeck build. Auto-discovered when omitted. */
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Maximum time an interactive permission request may wait for a host answer. */
  permissionTimeoutMs?: number;
  /** Maximum time an interactive question may wait for a host answer. */
  elicitationTimeoutMs?: number;
  /**
   * Explicit provider profile for approval and user-question interaction.
   * Takes precedence over the project config; `autoElicitation` remains a
   * compatibility alias for `headless` when this option is omitted.
   */
  interactionProfile?: InteractionProfileName;
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PilotDeckToolDefinition[];
  /**
   * Gateway-host-only organization policy. It is deliberately not part of
   * the SDK wire schema: a remote client may request narrower session rules,
   * but can never install or relax this host-owned restriction.
   */
  organizationPolicy?: GatewayOrganizationPolicy;
  /**
   * Host-owned layout for persistent native session files. The adapter is
   * evaluated only by this Gateway process; SDK clients cannot provide or
   * override it. Omit it to retain the historical project JSONL layout.
   */
  nativeSessionStorage?: GatewayNativeSessionStorageAdapter;
  /**
   * Optional host-owned persistence for pending SDK generic dialogs. It is
   * never configurable through the SDK wire and does not revive a stopped
   * AgentLoop; it gives independently running Gateway hosts a common durable
   * dialog discovery surface.
   */
  userDialogStore?: GatewayUserDialogStore;
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
  /** @internal Narrow session-config override for production-path Gateway tests. */
  __testAgentConfigOverrides?: Pick<AgentRuntimeConfig, "maxContextMessages">;
  /** @internal Test-only observer for native Context automatic-compaction triggers. */
  __testOnAutomaticCompactionTrigger?: (observation: CompactionAutomaticTriggerObservation) => void;
  /** Application-selected model invocation providers for each project generation. */
  modelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  /** Application-selected project execution-world provider. */
  executionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  /** Application-selected MCP runtime provider factory. */
  mcpRuntimeFactory?: McpRuntimeFactory;
  /** Application-selected context I/O providers for each project generation. */
  contextStorage?: ProjectContextStorageBundleOptions;
  /** Application-selected project memory provider for each project generation. */
  memoryProviderFactory?: ProjectMemoryProviderFactory;
  /** Application-selected compaction provider for each project generation. */
  compactionProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => CompactionPort | undefined;
  /** Application-selected prompt-cache generation provider for each project generation. */
  promptCacheCoordinatorFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => PromptCacheCoordinatorPort | undefined;
  /** Application-selected session-title provider for each project generation. */
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
  /** Application-selected frozen builtin plugin contribution set. */
  builtinPlugins?: PilotDeckLoadedPlugin[];
  /** @deprecated Use `modelInvocationProviderFactory`. */
  __testModelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  /** @deprecated Use `executionWorldBundleFactory`. */
  __testExecutionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  /** @deprecated Use `mcpRuntimeFactory`. */
  __testMcpRuntimeFactory?: McpRuntimeFactory;
  /** @deprecated Use `contextStorage`. */
  __testContextStorage?: ProjectContextStorageBundleOptions;
  /** @deprecated Use `builtinPlugins`. */
  __testBuiltinPlugins?: PilotDeckLoadedPlugin[];
  /**
   * Application-selected external AgentLoop runtime. It receives the
   * capability-only contract required by a sidecar or other provider.
   */
  agentLoopFactory?: AgentLoopRuntimeFactory;
  /** Optional live observer for the selected stdio/TCP AgentLoop deployment. */
  agentLoopTransportObserver?: AgentLoopSidecarTransportObserver;
  /** @internal Test hook for exercising the complete Gateway with an external AgentLoop transport. */
  __testAgentLoopFactory?: (input: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
    seedState?: AgentLoopSeedState;
  }) => AgentLoopRunner;
  /** @internal Test hook for asserting rollback after both filesystem watchers are active. */
  __testFailAfterBootstrapWatchers?: () => void;
  /**
   * Fallback project root used as the agent cwd when no explicit
   * `projectKey` is provided (e.g. IM channels without a bound project).
   * Defaults to `projectRoot` when omitted; server mode should set this
   * to `pilotHome` so IM sessions land in the general workspace instead
   * of the gateway process's cwd.
   */
  fallbackProjectRoot?: string;
  /** @deprecated Use `interactionProfile: "headless"`. */
  autoElicitation?: boolean;
  telemetry?: TelemetryClient;
  /**
   * Read-only durable-session query provider. The local Gateway selects the
   * JSONL provider when omitted; callers may supply a compatible catalog.
   */
  sessionCatalog?: SessionCatalogPort;
  sessionForkPort?: ProjectSessionForkPort;
  sessionReplacementPort?: ProjectSessionReplacementPort;
  sessionSearch?: SessionSearchPort;
  /** Application-owned session data plane, resolved once before consumer composition. */
  sessionDataPlane?: ProjectSessionDataPlane;
  /** Application-selected backend for project-session events and projection caches. */
  persistenceProvider?: ProjectSessionPersistenceProvider;
  /** @deprecated Use persistenceProvider and independent session ports. */
  storageProvider?: ProjectSessionStorageProvider;
  /**
   * Application-selected attachment I/O provider for Gateway turn composition.
   * The provider only reads declared attachment paths; AttachmentResolver keeps
   * MIME, size, and model-visible projection policy.
   */
  attachmentPort?: AttachmentPort;
  /**
   * Application-selected upload lifecycle provider for browser artifacts.
   * The provider owns upload admission, retention, cleanup, and attachment
   * leases; Gateway only consumes the resolved lease projection.
   */
  uploadLifecycle?: UploadLifecyclePort;
  /**
   * Application-selected advisory store for large Gateway tool-result previews.
   * It participates only in live event projection and never replaces the
   * Session transcript or turn terminal owner.
   */
  toolResultArtifactStore?: GatewayToolResultArtifactStorePort;
};

/**
 * Organization policy available to a Gateway embedding host. Permission,
 * model, tool, source, and token-cap fields are restrictive. Session defaults
 * and enforced settings are host-owned non-secret settings applied only while
 * an SDK session is constructed; remote callers cannot install or relax them.
 */
export type GatewayOrganizationPolicy = {
  permissions?: {
    deny?: string[];
    ask?: string[];
    /** The only permitted mode change because it only narrows execution. */
    defaultMode?: "plan";
    /** A host policy may disable prompting but can never enable it. */
    canPrompt?: false;
  };
  /**
   * Gateway-host model allow/deny policy. Entries are exact `provider/model`,
   * `provider/*`, or `*`; this policy never carries provider credentials.
   */
  models?: {
    allow?: string[];
    deny?: string[];
  };
  /**
   * Host-only provider and credential restrictions. Provider IDs and origins
   * are evaluated before a model request. Credential source labels describe
   * only host-local provenance, never a key value or variable name.
   */
  providers?: {
    /** Exact provider IDs from the resolved Gateway model config. */
    allow?: string[];
    deny?: string[];
    /** Exact normalized HTTP(S) origins, for example `https://api.example`. */
    origins?: {
      allow?: string[];
      deny?: string[];
    };
    credentials?: {
      allow?: Array<"environment" | "literal" | "provider_default">;
      deny?: Array<"environment" | "literal" | "provider_default">;
    };
  };
  /**
   * Host-only model-visible tool policy. Entries are an exact tool name, a
   * `prefix*` selector, or `*`. An explicit allow list narrows the surface;
   * deny always wins. This policy never registers, grants, or executes a
   * tool; it only removes already-resolved tools from every session.
   */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  /**
   * Host-only restrictions over Gateway-owned SDK settings layers. This lets
   * an embedding host reject a remote request to load an untrusted source
   * without exposing its filesystem or configuration contents.
   */
  settingSources?: {
    allow?: Array<"managed" | "user" | "project" | "local">;
    deny?: Array<"managed" | "user" | "project" | "local">;
  };
  /**
   * Host-owned turn ceilings. They are applied by the Gateway when a turn is
   * submitted and cannot be raised by an SDK caller.
   */
  limits?: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    /** Gateway-owned total budget for an SDK session/project. */
    maxTaskBudgetUsd?: number;
    /** Non-negative cap for agent-tool fork depth; zero disables forks. */
    maxSubagentDepth?: number;
  };
  /**
   * Host-owned SDK settings controls. `sessionDefaults`,
   * `managedSessionSettings`, `sessionDefaultSources`, and
   * `enforcedSessionSettings` use the same
   * narrow, non-secret session overlay; none is serialized on the SDK wire
   * and none can configure credentials, plugins, paths, tools, or permission
   * grants.
   */
  settings?: {
    canUpdateLocalSettings?: false;
    /** Positive token ceilings; a host policy can only lower SDK values. */
    maxContextTokens?: number;
    maxOutputTokens?: number;
    /** Non-negative thinking-token ceiling; zero disables thinking. */
    maxThinkingTokens?: number;
    /** Positive subagent timeout ceiling; it also supplies the host default. */
    maxSubagentTimeoutMs?: number;
    /** Applied below selected Gateway-local sources and SDK session settings. */
    sessionDefaults?: PilotSdkSessionSettings;
    /**
     * Gateway-host-only contents of the selectable `managed` source. It is
     * never serialized to, read by, or supplied by an SDK client.
     */
    managedSessionSettings?: PilotSdkSessionSettings;
    /** Gateway-local source layers applied to every marked SDK session. */
    sessionDefaultSources?: Array<"managed" | "user" | "project" | "local">;
    /**
     * Applied after selected sources and all SDK session settings. It also
     * overrides an SDK `model`, `fallbackModel`, and thinking update for the
     * marked session, while organization token caps remain final.
     */
    enforcedSessionSettings?: PilotSdkSessionSettings;
  };
};

type RestrictivePermissionPolicy = {
  deny: string[];
  ask: string[];
  defaultMode?: "plan";
  canPrompt?: false;
};

export type ResolvedGatewayOrganizationPolicy = {
  permissions?: RestrictivePermissionPolicy;
  models?: RestrictiveModelPolicy;
  providers?: RestrictiveProviderPolicy;
  tools?: RestrictiveToolPolicy;
  settingSources?: RestrictiveSettingSourcePolicy;
  limits?: RestrictiveTurnLimitPolicy;
  settings?: RestrictiveSettingsPolicy;
};

type RestrictiveModelPolicy = {
  allow: string[];
  deny: string[];
};

type ProviderCredentialSource = "environment" | "literal" | "provider_default";

type RestrictiveProviderPolicy = {
  allow: string[];
  deny: string[];
  origins: {
    allow: string[];
    deny: string[];
  };
  credentials: {
    allow: ProviderCredentialSource[];
    deny: ProviderCredentialSource[];
  };
};

type RestrictiveToolPolicy = {
  allow: string[];
  deny: string[];
};

type RestrictiveSettingSourcePolicy = {
  allow: Array<"managed" | "user" | "project" | "local">;
  deny: Array<"managed" | "user" | "project" | "local">;
};

type RestrictiveTurnLimitPolicy = {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxTaskBudgetUsd?: number;
  maxSubagentDepth?: number;
};

type RestrictiveSettingsPolicy = {
  canUpdateLocalSettings?: false;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  maxThinkingTokens?: number;
  maxSubagentTimeoutMs?: number;
  sessionDefaults?: PilotSdkSessionSettings;
  managedSessionSettings?: PilotSdkSessionSettings;
  sessionDefaultSources?: Array<"managed" | "user" | "project" | "local">;
  enforcedSessionSettings?: PilotSdkSessionSettings;
};

export type SubsystemUpdate = {
  extraTools: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  cron?: GatewayCronController;
  alwaysOnControl?: AlwaysOnControlPort;
};

export function resolveBrowserUseOutputDir(input: {
  pilotHome: string;
  projectRoot: string;
  sessionKey: string;
}): string {
  const projectId = resolveProjectStorageId(input.projectRoot, input.pilotHome);
  const sessionId = sanitizeSessionIdForPath(input.sessionKey);
  return ensureWritableDirectory({
    preferredDir: joinPath(input.pilotHome, "browser_screenshots", projectId, sessionId),
    fallbackDir: joinPath(input.pilotHome, "runtime", "browser_screenshots", projectId, sessionId),
    purpose: "browser-use",
  }).dir;
}

export type CreateLocalGatewayResult = {
  gateway: Gateway;
  sopControl: StaffDeckSopControlPlane;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  /** Application-owned registration point for live, non-durable telemetry observers. */
  telemetryObservers: TelemetryObserverRegistry;
  sessionDataPlane: ProjectSessionDataPlane;
  dispose: () => void | Promise<void>;
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
  const bootConfig = resolveLocalGatewayBootConfig(options);
  const {
    env,
    projectRoot,
    pilotHome,
    builtinSkillsRoot,
    fallbackProjectRoot,
    permissionMode,
    permissionTimeoutMs,
    elicitationTimeoutMs,
  } = bootConfig;
  const organizationPolicy = normalizeGatewayOrganizationPolicy(options.organizationPolicy);
  const sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
  const deploymentProfile = resolveAgentLoopDeploymentProfile({ env, cwd: projectRoot });
  const configuredAgentLoopFactory = options.agentLoopFactory ?? createAgentLoopDeploymentFactory(
    deploymentProfile,
    { transportObserver: options.agentLoopTransportObserver },
  );
  const agentLoopFactory: AgentLoopRuntimeFactory = (input) => {
    const sop = input.config.staffDeckSop;
    const bindingFactory = createAgentLoopBindingFactory(input.config.agentLoopBinding, {
      transportObserver: options.agentLoopTransportObserver,
    });
    const selectedFactory = bindingFactory ?? configuredAgentLoopFactory;
    if (sop && input.config.isSubagent !== true) {
      return createStaffDeckSopAgentLoop(input, sop, selectedFactory);
    }
    return selectedFactory?.(input)
      ?? new AgentLoop(input.config, input.capabilities, input.seedState);
  };
  const sessionDataPlane = options.sessionDataPlane ?? createProjectSessionDataPlane({
    ...(options.persistenceProvider ? { persistenceProvider: options.persistenceProvider } : {}),
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
    ...(options.sessionCatalog ? { catalog: options.sessionCatalog } : {}),
    ...(options.sessionForkPort ? { fork: options.sessionForkPort } : {}),
    ...(options.sessionReplacementPort ? { replacement: options.sessionReplacementPort } : {}),
    ...(options.sessionSearch ? { search: options.sessionSearch } : {}),
  });
  const replacementTransactionOwner = { instanceId: randomUUID(), pid: process.pid };
  const replacementRecovery = sessionDataPlane.replacement.recover({ pilotHome });
  if (replacementRecovery.committed > 0 || replacementRecovery.rolledBack > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pilotdeck] Recovered last-turn replacements: committed=${replacementRecovery.committed} ` +
      `rolledBack=${replacementRecovery.rolledBack}.`,
    );
  }
  for (const failure of replacementRecovery.failures) {
    // Keep the backup/journal in place so a later startup can retry safely.
    // eslint-disable-next-line no-console
    console.warn(
      `[pilotdeck] Could not recover replacement transaction for ${failure.scope}: ${failure.message}`,
    );
  }
  const legacySkillMigration = migrateLegacyBundledSkillCopies({ pilotHome, builtinSkillsRoot });
  if (legacySkillMigration.migrated.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pilotdeck] Activated bundled skills directly; moved ${legacySkillMigration.migrated.length} ` +
      `unchanged legacy ${legacySkillMigration.migrated.length === 1 ? "copy" : "copies"} to ` +
      `${joinPath(pilotHome, "skill-backups", "legacy-bundled-v1")}.`,
    );
  }
  for (const failure of legacySkillMigration.failures) {
    // eslint-disable-next-line no-console
    console.warn(`[pilotdeck] Could not migrate legacy skill '${failure.slug}': ${failure.message}`);
  }
  const now = () => new Date();
  const sessionCatalog = options.sessionCatalog
    ?? (options.nativeSessionStorage
      ? createGatewayNativeSessionCatalog(options.nativeSessionStorage)
      : sessionDataPlane.catalog);
  const telemetryBundle = new GatewayTelemetryBundle({
    env,
    pilotHome,
    telemetry: options.telemetry,
  });
  const telemetryObservers = telemetryBundle.observers;
  const telemetry = telemetryBundle.client;
  const bootResources = new LocalGatewayBootResources({
    warn: (message, error) => console.warn(message, error),
  });
  bootResources.ownTelemetry(telemetryBundle);
  try {
  const attachmentPort = options.attachmentPort ?? createNodeAttachmentPort();
  const subagentRuntime = new GatewaySubagentRuntimeBundle({
    onCleanupError: (error) => {
      console.warn("[pilotdeck] failed to clean up continuable subagent resources:", error);
    },
  });
  bootResources.ownSubagentRuntime(subagentRuntime);
  const liveAgents = subagentRuntime.agents;
  const continuations: GatewaySubagentContinuations = subagentRuntime.continuations;
  let registry!: ProjectRuntimeRegistry;
  let router: SessionRouter | undefined;
  const extensionWatchManager = new ExtensionWatchManager({
    pilotHome,
    builtinSkillsRoot,
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
    fallbackProjectRoot,
    pilotHome,
    builtinSkillsRoot,
    env,
    permissionMode,
    permissionTimeoutMs,
    elicitationTimeoutMs,
    now,
    extraTools: options.extraTools,
    organizationToolPolicy: organizationPolicy?.tools,
    organizationPolicy,
    sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    testAgentConfigOverrides: options.__testAgentConfigOverrides,
    testOnAutomaticCompactionTrigger: options.__testOnAutomaticCompactionTrigger,
    modelInvocationProviderFactory:
      options.modelInvocationProviderFactory ?? options.__testModelInvocationProviderFactory,
    executionWorldBundleFactory: options.executionWorldBundleFactory ?? options.__testExecutionWorldBundleFactory,
    mcpRuntimeFactory: options.mcpRuntimeFactory ?? options.__testMcpRuntimeFactory,
    contextStorage: options.contextStorage ?? options.__testContextStorage,
    memoryProviderFactory: options.memoryProviderFactory,
    compactionProviderFactory: options.compactionProviderFactory,
    promptCacheCoordinatorFactory: options.promptCacheCoordinatorFactory,
    sessionTitleProviderFactory: options.sessionTitleProviderFactory,
    lspServiceFactory: options.lspServiceFactory,
    routerSessionState: options.routerSessionState,
    routerSessionCustomRouterFactory: options.routerSessionCustomRouterFactory,
    routerProviderHealthFactory: options.routerProviderHealthFactory,
    builtinPlugins: options.builtinPlugins ?? options.__testBuiltinPlugins,
    agentLoopFactory,
    testAgentLoopFactory: options.__testAgentLoopFactory,
    interactionProfile: options.interactionProfile,
    autoElicitation: options.autoElicitation,
    telemetry,
    sessionCatalog,
    storageProvider: sessionDataPlane.persistence,
    nativeSessionStorage: options.nativeSessionStorage,
    userDialogStore: options.userDialogStore,
    continuations,
    buildBrowserUseArgs,
    onProjectActivated: (activeProjectRoot) => extensionWatchManager.watchProject(activeProjectRoot),
  });
  bootResources.ownRegistry(registry);
  const defaultRuntime = registry.resolve();
  const memoryDiagnosticsEnabled = isGatewayMemoryDiagnosticsEnabled(
    env,
    defaultRuntime.snapshot.config.gateway?.memoryDiagnostics,
  );

  const configStore = createPilotConfigStoreSync({ projectRoot, env });
  const stopConfigWatching = configStore.startWatching();
  bootResources.ownConfigWatcher(stopConfigWatching);
  const stopExtensionWatching = extensionWatchManager.start();
  bootResources.ownExtensionWatcher(stopExtensionWatching);
  const runtimeRefresh = new GatewayRuntimeRefreshBundle({
    configStore,
    registry,
    memoryMaintenance: new ProjectMemoryMaintenanceController({
      resolveRuntime: (projectKey) => registry.resolve(projectKey),
      telemetry,
    }),
    getRouter: () => router,
    projectRoot,
    memoryDiagnosticsEnabled,
    logMemoryDiagnostic: (input) => logGatewayMemoryDiagnostic(input as Parameters<typeof logGatewayMemoryDiagnostic>[0]),
    summarizeMessages: (messages) => summarizeCanonicalMessages(messages as import("../model/index.js").CanonicalMessage[]),
    dispatchSdkConfigChange: (payload) => registry.dispatchSdkConfigChange(payload),
  });
  runtimeRefresh.attach();
  bootResources.ownRuntimeRefresh(runtimeRefresh);
  options.__testFailAfterBootstrapWatchers?.();

  router = new SessionRouter({
    agents: liveAgents,
    createSession: (ctx) => registry.createSession(ctx),
    recreateSession: (ctx, session) => registry.recreateSession(ctx, session),
    listSessions: (input) => registry.listSessions(input),
    idleSessionTimeoutMs:
      (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    idleSweepIntervalMs:
      Math.max(0, defaultRuntime.snapshot.config.gateway?.idleSweepIntervalSeconds ?? 60) * 1_000,
    now,
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
    onSessionEvict: (sessionKey) => registry.permissionModePort().clear(sessionKey),
  });
  bootResources.ownRouter(router);
  const nativeSkillManager = new SkillManager({ pilotHome, builtinSkillsRoot });
  const disabledSkillManager = createDisabledSkillManagementPort();
  const resolveSkillManager = (projectKey?: string | null): SkillManagementPort => {
    const skillsBinding = registry.resolve(projectKey ?? projectRoot).snapshot.config.modules?.skills;
    return isDisabledModuleBinding(skillsBinding)
      ? disabledSkillManager
      : isExternalModuleBinding(skillsBinding)
      ? createSkillManagementPort(skillsBinding)
      : nativeSkillManager;
  };
  const skillManager: SkillManagementPort = Object.freeze({
    list: (input) => resolveSkillManager(input.projectKey).list(input),
    read: (input) => resolveSkillManager(input.projectKey).read(input),
    write: (input) => resolveSkillManager(input.projectKey).write(input),
    create: (input) => resolveSkillManager(input.projectKey).create(input),
    delete: (input) => resolveSkillManager(input.projectKey).delete(input),
    import: (input) => resolveSkillManager(input.projectKey).import(input),
    validate: (input) => resolveSkillManager().validate(input),
    scan: (input) => resolveSkillManager().scan(input),
  });
  const dialog = new GatewayDialogBundle({
    pilotHome,
    sessionCatalog,
    attachmentPort,
    uploadLifecycle: options.uploadLifecycle,
  });
  const sessionWriteCoordinator = new ProjectSessionWriteCoordinator();
  const sessionModels = new GatewaySessionModelBundle({
    fallbackProjectKey: fallbackProjectRoot,
    resolveProjectKey: dialog.projects.resolveProjectKey,
    router: router!,
    selectionPort: new NativeSessionModelSelectionPort({
      pilotHome,
      now,
      storageProvider: sessionDataPlane.persistence,
      writeCoordinator: sessionWriteCoordinator,
    }),
    policy: new NativeSessionModelSelectionPolicy(env),
  });
  const sessionHistory = new GatewaySessionHistoryBundle({
    fallbackProjectRoot,
    pilotHome,
    sessionCatalog,
    now,
    maxContextTokens: defaultRuntime.snapshot.config.agent.maxContextTokens,
    maxOutputTokens: defaultRuntime.snapshot.config.agent.maxOutputTokens,
    transactionOwner: replacementTransactionOwner,
    storageProvider: sessionDataPlane.persistence,
    ...(options.nativeSessionStorage
      ? {
          resolveStorage: ({ projectRoot: historyProjectRoot, sessionId, now: historyNow }) =>
            registry.createPersistentSessionStorage(historyProjectRoot, sessionId, historyNow),
        }
      : {}),
    sessionForkPort: sessionDataPlane.fork,
    sessionReplacementPort: sessionDataPlane.replacement,
    writeCoordinator: sessionWriteCoordinator,
  });
  const commandCatalog = new GatewayCommandCatalogBundle({
    pilotHome,
    resolveProjectKey: dialog.projects.resolveProjectKey,
    resolveRuntime: (projectKey) => registry.resolve(projectKey),
  });
  const toolResultArtifacts = options.toolResultArtifactStore ?? new GatewayToolResultArtifactStore({
    rootDir: resolve(tmpdir(), "pilotdeck-tool-output", process.pid.toString()),
  });
  const agentEventProjector = new GatewayAgentEventProjector({ toolResultArtifacts });
  const agentEventTelemetryObserver = new GatewayAgentEventTelemetryObserver({ telemetry });
  const turnReplayStore = new GatewayTurnReplayStore();
  const turnTelemetryContextResolver = new GatewayTurnTelemetryContextResolver();
  const manualCompactionCoordinator = new GatewayManualCompactionCoordinator({ router });
  const sopControl = new StaffDeckSopControlPlane(
    (requestedProjectKey) => registry.resolve(requestedProjectKey).snapshot.config.modules?.sop,
  );
  const restoringSessionKeys = new Set<string>();
  let boundServer: { broadcastNotification(name: string, payload?: unknown): void } | undefined;
  const gateway = new InProcessGateway(router, {
    funasrInstallCommand: getPilotDeckInstallCommand(),
    attachmentTurnComposer: dialog.attachmentTurnComposer,
    now,
    serverInfo: { mode: "in_process", projectKey: projectRoot },
    sdkSessionDefaults: organizationPolicy?.settings?.sessionDefaults !== undefined
      || organizationPolicy?.settings?.managedSessionSettings !== undefined
      || organizationPolicy?.settings?.sessionDefaultSources !== undefined
      || organizationPolicy?.settings?.enforcedSessionSettings !== undefined
      || organizationPolicy?.limits?.maxTaskBudgetUsd !== undefined,
    turnLimits: organizationPolicy?.limits,
    // A renderer notification is observational only. The Gateway user-dialog
    // bus remains the authority; disconnected or slow renderers resync with
    // user_dialog_list before acting.
    onUserDialogChange(change) {
      boundServer?.broadcastNotification("user_dialog_changed", change);
    },
    telemetry,
    permissionGrants: registry.permissionGrantPort(),
    permissionModes: registry.permissionModePort(),
    defaultPermissionMode: permissionMode,
    dispatchHookForSession: (sessionKey, event, payload) => {
      if (isPilotDeckHookEvent(event)) registry.dispatchSessionHook(sessionKey, event, payload);
    },
    toolResultArtifacts,
    agentEventProjector,
    agentEventTelemetryObserver,
    turnReplayStore,
    turnTelemetryContextResolver,
    manualCompactionCoordinator,
    sopStatus: (input) => sopControl.status(input).then((status) => status ?? null),
    resumeSop: (input) => sopControl.resume(input),
    cron: options.cron,
    skillManager,
    commandsList: (input) => commandCatalog.commandsList(input),
    modelCatalogList: (input) => sessionModels.modelCatalogList(input),
    sessionModelGet: (input) => sessionModels.sessionModelGet(input),
    sessionModelSet: (input) => sessionModels.sessionModelSet(input),
    sessionModelClear: (input) => sessionModels.sessionModelClear(input),
    async projectFileRead(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey);
      const root = await realpath(projectKey);
      const absolute = resolve(root, input.path);
      if (!isPathWithinRoot(absolute, root)) {
        throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path is outside the project workspace.");
      }
      const canonical = await realpath(absolute).catch(() => undefined);
      if (!canonical || !isPathWithinRoot(canonical, root)) {
        throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path resolves outside the project workspace.");
      }
      const info = await statAsync(canonical).catch(() => undefined);
      if (!info?.isFile()) return null;
      const data = await readFileAsync(canonical);
      const maxBytes = Math.max(1, Math.min(input.maxBytes ?? 1_000_000, 10_000_000));
      const encoding = input.encoding === "base64" ? "base64" as const : "utf-8" as const;
      return { path: input.path, content: data.subarray(0, maxBytes).toString(encoding), encoding };
    },
    async renameSession(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router!.hasActiveTurn(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot rename an active session.");
      }
      await registry.createPersistentSessionStorage(projectKey, input.sessionKey, now).transcript.recordSessionMetadata(
        input.sessionKey,
        "sdk-rename",
        { title: input.value == null ? undefined : String(input.value), updatedAt: now().toISOString() },
      );
      return { updated: true };
    },
    async tagSession(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router!.hasActiveTurn(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot tag an active session.");
      }
      await registry.createPersistentSessionStorage(projectKey, input.sessionKey, now).transcript.recordSessionMetadata(
        input.sessionKey,
        "sdk-tag",
        { tag: input.value == null ? undefined : String(input.value), updatedAt: now().toISOString() },
      );
      return { updated: true };
    },
    async deleteSession(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      await router!.close(input.sessionKey);
      const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
      const transcriptExists = storage.transcriptExists
        ? await storage.transcriptExists()
        : await statAsync(storage.transcriptPath).then((info) => info.isFile()).catch(() => false);
      if (!transcriptExists) throw new DialogGatewayError("SESSION_NOT_FOUND", `Session not found: ${input.sessionKey}`);
      if (storage.deleteSessionTranscripts) await storage.deleteSessionTranscripts();
      else if (storage.deleteTranscript) await storage.deleteTranscript();
      else await rmAsync(storage.transcriptPath, { force: false });
      if (storage.deleteFileHistoryBackups) await storage.deleteFileHistoryBackups();
      else await rmAsync(storage.fileHistoryDir, { recursive: true, force: true });
      if (storage.deleteToolResultArtifacts) await storage.deleteToolResultArtifacts();
      else await rmAsync(storage.toolResultsDir, { recursive: true, force: true });
      await rmAsync(storage.subagentsDir, { recursive: true, force: true });
      registry.clearSdkSessionState(input.sessionKey);
    },
    async exportSessionTranscript(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router!.hasActiveTurn(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot export a transcript while its session has an active turn.");
      }
      const transcript = await readAgentProjectSessionTranscript(
        registry.createPersistentSessionStorage(projectKey, input.sessionKey, now),
      );
      if (transcript.diagnostics.some((diagnostic) => diagnostic.code === "transcript_missing")) {
        throw new DialogGatewayError("SESSION_NOT_FOUND", `Session not found: ${input.sessionKey}`);
      }
      if (transcript.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new DialogGatewayError("SESSION_TRANSCRIPT_INVALID", "Cannot export a transcript with invalid entries.");
      }
      const archive = validatePortableSessionArchive(toPortableSessionArchive(transcript.entries));
      if (archive.messages.length === 0) {
        throw new DialogGatewayError("SESSION_TRANSCRIPT_EMPTY", "Session has no portable text messages to export.");
      }
      return archive;
    },
    async restoreSessionTranscript(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router!.hasActiveTurn(input.sessionKey) || router!.hasSession(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot restore over an active Gateway session.");
      }
      if (restoringSessionKeys.has(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_RESTORE_CONFLICT", "A transcript restore is already in progress for this session.");
      }
      const archive = validatePortableSessionArchive(input.archive);
      const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
      const transcriptExists = storage.transcriptExists
        ? await storage.transcriptExists()
        : await statAsync(storage.transcriptPath).then((info) => info.isFile()).catch(() => false);
      if (transcriptExists) {
        throw new DialogGatewayError("SESSION_RESTORE_CONFLICT", "A persistent transcript already exists for this session.");
      }
      if (storage.externalTranscriptStore && !storage.replaceTranscript) {
        throw new DialogGatewayError(
          "SESSION_RESTORE_UNSUPPORTED",
          "The configured external transcript store does not support atomic restore.",
        );
      }
      restoringSessionKeys.add(input.sessionKey);
      const restoredEntries: import("../session/index.js").AgentTranscriptEntry[] = [];
      const temporaryPath = `${storage.transcriptPath}.${randomUUID()}.restore.tmp`;
      try {
        const memoryWriter = storage.externalTranscriptStore ? new InMemoryTranscriptWriter({ now }) : undefined;
        const writer = memoryWriter ?? new JsonlTranscriptWriter({ path: temporaryPath, now });
        const turnId = `sdk:restore:${randomUUID()}`;
        if (archive.title) {
          await writer.recordSessionMetadata(input.sessionKey, turnId, {
            title: archive.title,
            updatedAt: now().toISOString(),
          });
        }
        await writer.recordAcceptedInput(
          input.sessionKey,
          turnId,
          archive.messages.map((message) => ({
            role: message.role,
            content: [{ type: "text" as const, text: message.text }],
          })),
          { restoredFromGatewayArchive: true, archiveSchemaVersion: 1 },
        );
        if (memoryWriter) restoredEntries.push(...memoryWriter.entries);
        if (storage.replaceTranscript) await storage.replaceTranscript(restoredEntries);
        else await renameAsync(temporaryPath, storage.transcriptPath);
      } catch (error) {
        await rmAsync(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        restoringSessionKeys.delete(input.sessionKey);
      }
      return { sessionKey: input.sessionKey, importedMessages: archive.messages.length };
    },
    async setPermissionMode(input) {
      if (input.mode !== "default" && input.mode !== "plan" && input.mode !== "bypassPermissions") {
        throw new DialogGatewayError("INVALID_PERMISSION_MODE", `Unsupported permission mode: ${input.mode}`);
      }
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router!.hasActiveTurn(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot change permission mode during an active turn.");
      }
      const existing = sessionOverrides.get(input.sessionKey) ?? {};
      sessionOverrides.set(input.sessionKey, { ...existing, permissionMode: input.mode });
      return { applied: true };
    },
    applyFlagSettings: (input) => registry.applyFlagSettingsForSdk(input),
    async updateSettings(input) {
      if (organizationPolicy?.settings?.canUpdateLocalSettings === false) {
        throw new DialogGatewayError(
          "GATEWAY_ORGANIZATION_SETTINGS_UPDATE_DENIED",
          "Gateway organization policy denies SDK localSettings updates.",
        );
      }
      const updated = await updatePilotLocalSettings({ settings: input.settings, env, projectRoot });
      if (updated.changedPaths.length === 0) return updated;
      let changedPaths = updated.changedPaths;
      const unsubscribe = configStore.subscribe((event) => { changedPaths = event.changedPaths; });
      try {
        await configStore.reload("sdk-update-settings");
      } finally {
        unsubscribe();
      }
      return { ...updated, changedPaths };
    },
    resolveSettings: async () => toGatewayResolvedSettings(configStore.getSnapshot()),
    async setSessionThinking(input) {
      registry.setSessionThinkingForSdk(input.sessionKey, input.thinking);
      await router!.close(input.sessionKey);
      return { applied: true };
    },
    outputStylesList: (input) => registry.outputStylesListForSdk(input),
    setOutputStyle: (input) => registry.setOutputStyleForSdk(input),
    reloadOutputStyles: (input) => registry.reloadOutputStylesForSdk(input),
    usageSnapshot: async (input) => registry.usageSnapshotForSdk(input),
    modelUsageSnapshot: async (input) => registry.modelUsageSnapshotForSdk(input),
    setSdkSessionConfig: (sessionKey, config, projectKey) =>
      registry.setSdkSessionConfig(sessionKey, config, projectKey),
    assertSdkModelAllowed: (sessionKey, model, projectKey) =>
      registry.assertSdkModelAllowed(sessionKey, model, projectKey),
    deleteEphemeralSession: (input) => registry.deleteEphemeralSession(input.sessionKey),
    async listRecoveredUserDialogs(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.listRecoveredUserDialogsForSdk(projectKey, input.sessionKey);
    },
    async acknowledgeRecoveredUserDialog(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.acknowledgeRecoveredUserDialogForSdk(projectKey, input.sessionKey, input.requestId);
    },
    async recoverUserDialog(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.recoverUserDialogForSdk(projectKey, input);
    },
    async listHostedUserDialogs(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.listHostedUserDialogsForSdk(projectKey, input.sessionKey);
    },
    async claimHostedUserDialog(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.claimHostedUserDialogForSdk(projectKey, input);
    },
    async releaseHostedUserDialog(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.releaseHostedUserDialogForSdk(projectKey, input);
    },
    async submitHostedUserDialogAnswer(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.submitHostedUserDialogAnswerForSdk(projectKey, input);
    },
    async clearRecoveredUserDialogs(input) {
      const projectKey = await dialog.projects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      await registry.clearRecoveredUserDialogsForSdk(projectKey, input.sessionKey);
    },
    taskBudgetSnapshot: (input) => registry.taskBudgetSnapshotForSdk(input),
    recordTaskBudgetSpend: (input) => registry.recordTaskBudgetSpendForSdk(input),
    rewindFiles: (input) => registry.rewindFilesForSdk(input),
    stopBackgroundTask: (input) => registry.stopBackgroundTaskForSdk(input),
    backgroundTasks: (input) => registry.backgroundTasksForSdk(input),
    mcpServerStatus: (input) => registry.mcpServerStatusForSdk(input),
    setMcpServers: (input) => registry.setMcpServersForSdk(input),
    reconnectMcpServer: (input) => registry.reconnectMcpServerForSdk(input),
    toggleMcpServer: (input) => registry.toggleMcpServerForSdk(input),
    setMcpPermissionModeOverride: (input) => registry.setMcpPermissionModeOverrideForSdk(input),
    resolveTurnModelSelection: (input) => sessionModels.resolveTurnModelSelection(input),
    resolveUploadedAttachments: (input) => dialog.uploadedAttachments.resolve(input),
    setSessionCwd: (sessionKey, cwd) => registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: (input) => sessionHistory.readSessionMessages(input),
    readSubagentMessages: (input) => sessionHistory.readSubagentMessages(input),
    forkSession: (input) => sessionHistory.forkSession(input),
    replaceLastTurn: (input) => sessionHistory.replaceLastTurn(input),
    finalizeLastTurnReplacement: (input) => sessionHistory.finalizeLastTurnReplacement(input),
    recordAgentStatusMessage: (input) => sessionHistory.recordAgentStatusMessage(input),
    listProjects: dialog.listProjects,
    describeProject: dialog.describeProject,
    reloadConfig: () => runtimeRefresh.reloadConfig(),
    reloadExtensions: (input) => runtimeRefresh.reloadExtensions(input),
    // Defensive: re-check the on-disk config at the start of every
    // turn so an apiKey/url edit applied between two messages takes
    // effect on the next one, even if the fs watcher missed it.
    // Singleton-deduped inside PilotConfigStore.reload — concurrent
    // turns share a single in-flight read, and unchanged config is a
    // no-op (no invalidation, no session recreation).
    refreshConfigBeforeTurn: () => runtimeRefresh.refreshConfigBeforeTurn(),
    afterTurnCompleted: (input) => runtimeRefresh.afterTurnCompleted(input),
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  const lifecycle = bootResources.commit({ gateway });
  return {
    gateway,
    sopControl,
    configStore,
    registry,
    sessionDataPlane,
    telemetryObservers,
    dispose: () => lifecycle.dispose(),
    bindServer: (server) => {
      boundServer = server;
      runtimeRefresh.bindServer(server);
    },
    isProjectBusy: (projectKey: string) => router!.hasActiveUserTurn(projectKey),
    updateSubsystems: (update: SubsystemUpdate) => {
      registry.updateSubsystems({
        extraTools: update.extraTools,
        sessionOverrides: update.sessionOverrides ?? sessionOverrides,
      });
      gateway.setCronController(update.cron);
      gateway.setAlwaysOnControl(update.alwaysOnControl);
    },
  };
  } catch (error) {
    void bootResources.rollback().catch((rollbackError) => {
      console.warn("[pilotdeck] failed to roll back local Gateway bootstrap:", rollbackError);
    });
    throw error;
  }
}

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;
const DEFAULT_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS = 512;

function toGatewayResolvedSettings(
  snapshot: PilotConfigSnapshot,
): import("../gateway/protocol/types.js").GatewayResolvedSettingsResult {
  return {
    schemaVersion: snapshot.schemaVersion,
    version: snapshot.version,
    loadedAt: snapshot.loadedAt.toISOString(),
    contentHash: snapshot.contentHash,
    config: redactConfig(snapshot.config) as Record<string, unknown>,
    sources: snapshot.sources.map((source) => ({
      kind: source.kind,
      priority: source.priority,
      loadedAt: source.loadedAt.toISOString(),
      ...(source.path ? { path: source.path } : {}),
      ...(source.contentHash ? { contentHash: source.contentHash } : {}),
      ...(source.phase ? { phase: source.phase } : {}),
    })),
    diagnostics: snapshot.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
      ...(diagnostic.hint ? { hint: diagnostic.hint } : {}),
      ...(diagnostic.redactedValue ? { redactedValue: diagnostic.redactedValue } : {}),
      ...(diagnostic.recoverable !== undefined ? { recoverable: diagnostic.recoverable } : {}),
    })),
  };
}

const MAX_PORTABLE_SESSION_ARCHIVE_MESSAGES = 10_000;
const MAX_PORTABLE_SESSION_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_PORTABLE_SESSION_ARCHIVE_TITLE_LENGTH = 512;

function toPortableSessionArchive(
  entries: import("../session/index.js").AgentTranscriptEntry[],
): import("../gateway/protocol/types.js").GatewaySessionTranscriptArchive {
  const replay = replayTranscriptEntries(entries);
  const messages = replay.messages.flatMap((message) => {
    if (message.metadata?.synthetic === true) return [];
    const text = portableTranscriptText(message);
    return text ? [{ role: message.role, text }] : [];
  });
  const title = replay.metadata.title ?? replay.metadata.aiTitle;
  return {
    schemaVersion: 1,
    format: "portable_text_messages",
    messages,
    ...(title && title.length <= MAX_PORTABLE_SESSION_ARCHIVE_TITLE_LENGTH ? { title } : {}),
  };
}

function portableTranscriptText(message: CanonicalMessage): string | undefined {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text) parts.push(block.text);
    } else if (block.type === "tool_call") {
      parts.push(`[Tool call: ${block.name}]\n${stringifyPortableTranscriptValue(block.input)}`);
    } else if (block.type === "tool_result") {
      const text = flattenToolResultBlockText(block);
      parts.push(text ? `[Tool result]\n${text}` : "[Tool result]");
    } else if (block.type === "tool_result_reference") {
      parts.push(`[Tool result reference: ${block.toolCallId}]`);
    } else if (block.type === "image") {
      parts.push("[Image]");
    }
  }
  const text = parts.join("\n\n").trim();
  return text || undefined;
}

function stringifyPortableTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function validatePortableSessionArchive(
  value: import("../gateway/protocol/types.js").GatewaySessionTranscriptArchive,
): import("../gateway/protocol/types.js").GatewaySessionTranscriptArchive {
  if (!value || value.schemaVersion !== 1 || value.format !== "portable_text_messages" || !Array.isArray(value.messages)) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "Unsupported or malformed session transcript archive.");
  }
  if (value.messages.length === 0 || value.messages.length > MAX_PORTABLE_SESSION_ARCHIVE_MESSAGES) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "Session transcript archive has an invalid message count.");
  }
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > MAX_PORTABLE_SESSION_ARCHIVE_TITLE_LENGTH)) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "Session transcript archive title is invalid.");
  }
  for (const message of value.messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string") {
      throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "Session transcript archive contains an invalid message.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PORTABLE_SESSION_ARCHIVE_BYTES) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "Session transcript archive is too large.");
  }
  return value;
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

export function buildBrowserUseArgs(
  baseArgs: string[],
  outputDir: string,
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): string[] {
  let args = [...baseArgs];
  args = appendCliArg(args, "--output-dir", outputDir);
  args = appendCliArg(
    args,
    "--timeout-action",
    String(
      readPositiveIntegerEnv(env.PILOTDECK_BROWSER_TIMEOUT_ACTION_MS)
        ?? readPositiveIntegerEnv(env.PILOTDECK_BROWSER_ACTION_TIMEOUT_MS)
        ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    ),
  );
  args = appendCliArg(
    args,
    "--timeout-navigation",
    String(
      readPositiveIntegerEnv(env.PILOTDECK_BROWSER_TIMEOUT_NAVIGATION_MS)
        ?? readPositiveIntegerEnv(env.PILOTDECK_BROWSER_NAVIGATION_TIMEOUT_MS)
        ?? DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
    ),
  );

  const proxy = resolveBrowserProxyServer(env, configProxy);
  if (proxy) {
    args = appendCliArg(args, "--proxy-server", proxy.server);
    const proxyBypass = resolveBrowserProxyBypass(env, configProxy, proxy.source);
    if (proxyBypass) {
      args = appendCliArg(args, "--proxy-bypass", proxyBypass);
    }
  }
  return args;
}

function appendCliArg(args: string[], flag: string, value: string): string[] {
  if (args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`))) {
    return args;
  }
  return [...args, flag, value];
}

type BrowserProxySource = "browser-env" | "env" | "config";

function resolveBrowserProxyServer(
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): { server: string; source: BrowserProxySource } | undefined {
  const explicit = cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_SERVER);
  if (explicit) {
    if (/^(0|false|off|none|direct)$/i.test(explicit)) return undefined;
    return { server: explicit, source: "browser-env" };
  }
  if (/^(1|true|on|yes)$/i.test(cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_FROM_ENV) ?? "")) {
    const envProxy = (
      cleanEnvValue(env.PILOTDECK_PROXY)
      ?? cleanEnvValue(env.https_proxy)
      ?? cleanEnvValue(env.HTTPS_PROXY)
      ?? cleanEnvValue(env.http_proxy)
      ?? cleanEnvValue(env.HTTP_PROXY)
    );
    if (envProxy) return { server: envProxy, source: "env" };
  }
  const configUrl = cleanEnvValue(configProxy?.url);
  return configUrl ? { server: configUrl, source: "config" } : undefined;
}

function resolveBrowserProxyBypass(
  env: Record<string, string | undefined>,
  configProxy: PilotProxyConfig | undefined,
  proxySource: BrowserProxySource,
): string {
  const explicit = cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_BYPASS);
  if (explicit) return explicit;
  const noProxy = cleanEnvValue(env.no_proxy) ?? cleanEnvValue(env.NO_PROXY);
  const configNoProxy = proxySource === "config" ? cleanEnvValue(configProxy?.noProxy) : undefined;
  return [noProxy, configNoProxy, "localhost", "127.0.0.1", "host.docker.internal"].filter(Boolean).join(",");
}

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGatewayOrganizationPolicy(
  value: GatewayOrganizationPolicy | undefined,
): ResolvedGatewayOrganizationPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = organizationRecord(value, "organizationPolicy");
  assertOrganizationKeys(policy, ["permissions", "models", "providers", "tools", "settingSources", "limits", "settings"]);

  const permissions = policy.permissions === undefined ? undefined : (() => {
    const record = organizationRecord(policy.permissions, "organizationPolicy.permissions");
    assertOrganizationKeys(record, ["deny", "ask", "defaultMode", "canPrompt"]);
    if (record.defaultMode !== undefined && record.defaultMode !== "plan") {
      throw organizationPolicyError("organizationPolicy.permissions.defaultMode may only force plan mode.", true);
    }
    if (record.canPrompt !== undefined && record.canPrompt !== false) {
      throw organizationPolicyError("organizationPolicy.permissions.canPrompt may only disable prompts.", true);
    }
    const deny = organizationStringArray(record.deny, "organizationPolicy.permissions.deny");
    const ask = organizationStringArray(record.ask, "organizationPolicy.permissions.ask");
    return deny.length || ask.length || record.defaultMode === "plan" || record.canPrompt === false
      ? { deny, ask, ...(record.defaultMode === "plan" ? { defaultMode: "plan" as const } : {}), ...(record.canPrompt === false ? { canPrompt: false as const } : {}) }
      : undefined;
  })();
  const models = normalizeSelectorPolicy(policy.models, "models", isOrganizationModelSelector);
  const tools = normalizeSelectorPolicy(policy.tools, "tools", isOrganizationToolSelector);
  const settingSources = policy.settingSources === undefined ? undefined : (() => {
    const record = organizationRecord(policy.settingSources, "organizationPolicy.settingSources");
    assertOrganizationKeys(record, ["allow", "deny"]);
    const normalize = (entry: unknown, label: string) => {
      const values = organizationStringArray(entry, label);
      if (values.some((item) => !["managed", "user", "project", "local"].includes(item))) {
        throw organizationPolicyError(`${label} must contain only managed, user, project, or local.`);
      }
      return values as Array<"managed" | "user" | "project" | "local">;
    };
    const allow = normalize(record.allow, "organizationPolicy.settingSources.allow");
    const deny = normalize(record.deny, "organizationPolicy.settingSources.deny");
    return allow.length || deny.length ? { allow, deny } : undefined;
  })();
  const providers = policy.providers === undefined ? undefined : normalizeOrganizationProviders(policy.providers);
  const limits = policy.limits === undefined ? undefined : normalizeOrganizationLimits(policy.limits);
  const settings = policy.settings === undefined ? undefined : normalizeOrganizationSettings(policy.settings);
  if (!permissions && !models && !providers && !tools && !settingSources && !limits && !settings) return undefined;
  return {
    ...(permissions ? { permissions } : {}),
    ...(models ? { models } : {}),
    ...(providers ? { providers } : {}),
    ...(tools ? { tools } : {}),
    ...(settingSources ? { settingSources } : {}),
    ...(limits ? { limits } : {}),
    ...(settings ? { settings } : {}),
  };
}

function normalizeSelectorPolicy(
  value: unknown,
  name: "models" | "tools",
  valid: (value: string) => boolean,
): RestrictiveModelPolicy | RestrictiveToolPolicy | undefined {
  if (value === undefined) return undefined;
  const record = organizationRecord(value, `organizationPolicy.${name}`);
  assertOrganizationKeys(record, ["allow", "deny"]);
  const normalize = (entry: unknown, label: "allow" | "deny") => {
    const values = organizationStringArray(entry, `organizationPolicy.${name}.${label}`);
    if (values.some((item) => !valid(item))) {
      throw organizationPolicyError(`organizationPolicy.${name}.${label} contains an invalid selector.`);
    }
    return values;
  };
  const allow = normalize(record.allow, "allow");
  const deny = normalize(record.deny, "deny");
  return allow.length || deny.length ? { allow, deny } : undefined;
}

function normalizeOrganizationProviders(value: unknown): RestrictiveProviderPolicy | undefined {
  const record = organizationRecord(value, "organizationPolicy.providers");
  assertOrganizationKeys(record, ["allow", "deny", "origins", "credentials"]);
  const allow = organizationStringArray(record.allow, "organizationPolicy.providers.allow");
  const deny = organizationStringArray(record.deny, "organizationPolicy.providers.deny");
  if ([...allow, ...deny].some((item) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(item))) {
    throw organizationPolicyError("organizationPolicy.providers allow/deny must contain exact provider IDs.");
  }
  const originRecord = record.origins === undefined ? {} : organizationRecord(record.origins, "organizationPolicy.providers.origins");
  assertOrganizationKeys(originRecord, ["allow", "deny"]);
  const normalizeOrigins = (entry: unknown, label: string) => organizationStringArray(entry, label).map((item) => {
    let parsed: URL;
    try { parsed = new URL(item); } catch { throw organizationPolicyError(`${label} contains an invalid origin.`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
      throw organizationPolicyError(`${label} must contain credential-free HTTP(S) origins.`);
    }
    return parsed.origin;
  });
  const origins = {
    allow: normalizeOrigins(originRecord.allow, "organizationPolicy.providers.origins.allow"),
    deny: normalizeOrigins(originRecord.deny, "organizationPolicy.providers.origins.deny"),
  };
  const credentialRecord = record.credentials === undefined ? {} : organizationRecord(record.credentials, "organizationPolicy.providers.credentials");
  assertOrganizationKeys(credentialRecord, ["allow", "deny"]);
  const normalizeCredentials = (entry: unknown, label: string) => {
    const values = organizationStringArray(entry, label);
    if (values.some((item) => item !== "environment" && item !== "literal" && item !== "provider_default")) {
      throw organizationPolicyError(`${label} contains an invalid credential source.`);
    }
    return values as ProviderCredentialSource[];
  };
  const credentials = {
    allow: normalizeCredentials(credentialRecord.allow, "organizationPolicy.providers.credentials.allow"),
    deny: normalizeCredentials(credentialRecord.deny, "organizationPolicy.providers.credentials.deny"),
  };
  return allow.length || deny.length || origins.allow.length || origins.deny.length || credentials.allow.length || credentials.deny.length
    ? { allow, deny, origins, credentials }
    : undefined;
}

function normalizeOrganizationLimits(value: unknown): RestrictiveTurnLimitPolicy | undefined {
  const record = organizationRecord(value, "organizationPolicy.limits");
  assertOrganizationKeys(record, ["maxTurns", "maxBudgetUsd", "maxTaskBudgetUsd", "maxSubagentDepth"]);
  const positiveInteger = (key: "maxTurns") => {
    const item = record[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)) throw organizationPolicyError(`organizationPolicy.limits.${key} must be a positive safe integer.`);
    return item as number | undefined;
  };
  const positiveNumber = (key: "maxBudgetUsd" | "maxTaskBudgetUsd") => {
    const item = record[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isFinite(item) || item <= 0)) throw organizationPolicyError(`organizationPolicy.limits.${key} must be a positive finite number.`);
    return item as number | undefined;
  };
  const maxTurns = positiveInteger("maxTurns");
  const maxBudgetUsd = positiveNumber("maxBudgetUsd");
  const maxTaskBudgetUsd = positiveNumber("maxTaskBudgetUsd");
  const maxSubagentDepth = record.maxSubagentDepth;
  if (maxSubagentDepth !== undefined && (typeof maxSubagentDepth !== "number" || !Number.isSafeInteger(maxSubagentDepth) || maxSubagentDepth < 0)) {
    throw organizationPolicyError("organizationPolicy.limits.maxSubagentDepth must be a non-negative safe integer.");
  }
  return maxTurns !== undefined || maxBudgetUsd !== undefined || maxTaskBudgetUsd !== undefined || maxSubagentDepth !== undefined
    ? { maxTurns, maxBudgetUsd, maxTaskBudgetUsd, maxSubagentDepth: maxSubagentDepth as number | undefined }
    : undefined;
}

function normalizeOrganizationSettings(value: unknown): RestrictiveSettingsPolicy | undefined {
  const record = organizationRecord(value, "organizationPolicy.settings");
  assertOrganizationKeys(record, ["canUpdateLocalSettings", "maxContextTokens", "maxOutputTokens", "maxThinkingTokens", "maxSubagentTimeoutMs", "sessionDefaults", "managedSessionSettings", "sessionDefaultSources", "enforcedSessionSettings"]);
  if (record.canUpdateLocalSettings !== undefined && record.canUpdateLocalSettings !== false) throw organizationPolicyError("organizationPolicy.settings.canUpdateLocalSettings may only disable SDK settings updates.", true);
  for (const key of ["maxContextTokens", "maxOutputTokens", "maxSubagentTimeoutMs"] as const) {
    const item = record[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)) throw organizationPolicyError(`organizationPolicy.settings.${key} must be a positive safe integer.`);
  }
  if (record.maxThinkingTokens !== undefined && (typeof record.maxThinkingTokens !== "number" || !Number.isSafeInteger(record.maxThinkingTokens) || record.maxThinkingTokens < 0)) {
    throw organizationPolicyError("organizationPolicy.settings.maxThinkingTokens must be a non-negative safe integer.");
  }
  const sessionSetting = (key: "sessionDefaults" | "managedSessionSettings" | "enforcedSessionSettings") => {
    if (record[key] === undefined) return undefined;
    try { validatePilotSdkSessionSettings(record[key]); } catch (error) { throw mapPilotSdkSettingsError(error); }
    return structuredClone(record[key] as PilotSdkSessionSettings);
  };
  let sessionDefaultSources: RestrictiveSettingsPolicy["sessionDefaultSources"];
  if (record.sessionDefaultSources !== undefined) {
    try { validatePilotSdkSettingSources(record.sessionDefaultSources); } catch (error) { throw mapPilotSdkSettingsError(error); }
    sessionDefaultSources = [...record.sessionDefaultSources as NonNullable<RestrictiveSettingsPolicy["sessionDefaultSources"]>];
  }
  const settings: RestrictiveSettingsPolicy = {
    ...(record.canUpdateLocalSettings === false ? { canUpdateLocalSettings: false } : {}),
    ...(record.maxContextTokens !== undefined ? { maxContextTokens: record.maxContextTokens as number } : {}),
    ...(record.maxOutputTokens !== undefined ? { maxOutputTokens: record.maxOutputTokens as number } : {}),
    ...(record.maxThinkingTokens !== undefined ? { maxThinkingTokens: record.maxThinkingTokens as number } : {}),
    ...(record.maxSubagentTimeoutMs !== undefined ? { maxSubagentTimeoutMs: record.maxSubagentTimeoutMs as number } : {}),
    ...(sessionSetting("sessionDefaults") ? { sessionDefaults: sessionSetting("sessionDefaults") } : {}),
    ...(sessionSetting("managedSessionSettings") ? { managedSessionSettings: sessionSetting("managedSessionSettings") } : {}),
    ...(sessionDefaultSources ? { sessionDefaultSources } : {}),
    ...(sessionSetting("enforcedSessionSettings") ? { enforcedSessionSettings: sessionSetting("enforcedSessionSettings") } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function organizationRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw organizationPolicyError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertOrganizationKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw organizationPolicyError("organizationPolicy contains an unsupported field.", true);
}

function organizationStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw organizationPolicyError(`${label} must be an array of non-empty strings.`);
  const result = value.map((item) => item.trim());
  if (new Set(result).size !== result.length) throw organizationPolicyError(`${label} cannot contain duplicate entries.`);
  return result;
}

function organizationPolicyError(message: string, unsupported = false): DialogGatewayError {
  return new DialogGatewayError(unsupported ? "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY" : "INVALID_GATEWAY_ORGANIZATION_POLICY", message);
}

function mapPilotSdkSettingsError(error: unknown): unknown {
  return error instanceof PilotSdkSessionSettingsError
    ? new DialogGatewayError(error.code, error.message)
    : error;
}

function isOrganizationModelSelector(value: string): boolean {
  return value === "*" || /^[^/\s]+\/(?:[^/\s]+|\*)$/.test(value);
}

function isOrganizationToolSelector(value: string): boolean {
  return value === "*" || /^[A-Za-z0-9][A-Za-z0-9_.:-]*\*?$/.test(value);
}

function createDisabledSkillManagementPort(): SkillManagementPort {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error("Skill module is disabled for this profile."), {
      code: "SKILL_MODULE_DISABLED",
    });
  };
  return Object.freeze({
    list: unavailable,
    read: unavailable,
    write: unavailable,
    create: unavailable,
    delete: unavailable,
    import: unavailable,
    validate: unavailable,
    scan: unavailable,
  });
}

function normalizeMcpPermissionSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return normalized || value;
}
