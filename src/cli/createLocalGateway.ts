import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  readFile as readFileAsync,
  realpath,
  rename as renameAsync,
  stat as statAsync,
  rm as rmAsync,
} from "node:fs/promises";
import { dirname, resolve, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import {
  SessionConfigOverrides,
  type SessionConfigOverride,
} from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentEventBuffer,
  createAgentSessionWithStorage,
  type AgentLoopRunner,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentLoopSeedState,
  type AgentSession,
  type AgentTurnResult,
  type CreateAgentSessionOptions,
} from "../agent/index.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import {
  AutoCompactionPolicy,
  CompactionEngine,
  ContextOverflowRecovery,
  DefaultContextRuntime,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  InstructionDiscovery,
  MicroCompactionEngine,
  PluginRuntimeExtensionResolver,
  SnipEngine,
  TokenAccountingRuntime,
  TokenBudgetManager,
  ToolResultBudget,
  createEdgeClawMemoryProviderFromConfig,
  type ExtensionResolver,
} from "../context/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { createPlanTodoStateManager } from "../agent/runtime/PlanTodoState.js";
import {
  HookExecutionEventBus,
  HookRuntime,
  PluginRuntime,
  PluginRuntimeView,
  loadPluginFromPath,
  type PilotDeckLoadedPlugin,
} from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  GatewayElicitationChannel,
  GatewayUserDialogChannel,
  createGatewayUserDialogJournal,
  InProcessGateway,
  createGatewayNativeSessionStorage,
  resolveGatewayNativeProjectChatDir,
  type InProcessGatewayOptions,
  SessionRouter,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type Gateway,
  type GatewayCronController,
  type GatewayProjectStorageOptions,
  type GatewayHostSandboxProfile,
  type GatewayHostSandboxProfiles,
  type GatewayNativeSessionStorageAdapter,
  type GatewayRecoveredUserDialog,
  type GatewayUserDialogStore,
  type GatewayUserDialogStoreKey,
  type GatewayUserDialogResponseInput,
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
  type PilotDeckMcpServerSpec,
} from "../mcp/index.js";
import {
  createModelRuntime,
  flattenToolResultBlockText,
  ModelRequestError,
  type CanonicalMessage,
  type ModelConfig,
  type ModelRuntime,
  type ProviderConfig,
} from "../model/index.js";
import { createDefaultPermissionContext, permissionEntryToRule, type PermissionRule } from "../permission/index.js";
import { acceptsFormDialogAnswer } from "../tool/dialog/FormDialogSchema.js";
import {
  loadPilotConfig,
  resolvePilotHome,
  resolvePilotSdkSessionSettings,
  validatePilotSdkSessionSettings,
  validatePilotSdkSettingSources,
  PilotSdkSessionSettingsError,
  type PilotSdkSessionSettings,
  type PilotProxyConfig,
} from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import { redactConfig } from "../pilot/config/redact.js";
import { updatePilotLocalSettings } from "../pilot/config/updateLocalSettings.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import { DEFAULT_JUDGE_TIMEOUT_MS, DEFAULT_ALLOWED_TOOLS, DEFAULT_TRIGGER_TIERS, type RouterConfig } from "../router/config/schema.js";
import {
  InMemoryTranscriptWriter,
  JsonlTranscriptWriter,
  listProjectSessions,
  readAgentProjectSessionTranscript,
  readTranscript,
  replayTranscriptEntries,
  resumeAgentSession,
  type AgentProjectSessionStorage,
} from "../session/index.js";
import { sanitizeSessionIdForPath } from "../session/storage/ProjectSessionStorage.js";
import { createPromptSuggestionGenerator } from "../session/prompt/PromptSuggestionGenerator.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import { readWebSessionMessages, readSubagentWebMessages } from "../web/server/readSessionMessages.js";
import { forkWebSession } from "../web/server/forkSession.js";
import {
  finalizeLastWebSessionTurnReplacement,
  recoverPendingLastTurnReplacements,
  replaceLastWebSessionTurn,
} from "../web/server/replaceLastTurn.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { BackgroundTaskRuntime, type BackgroundTaskCompletionEvent } from "../task/runtime/BackgroundTaskRuntime.js";
import { BackgroundSubagentRuntime } from "../agent/sub/BackgroundSubagentRuntime.js";
import {
  buildMcpToolWireName,
  createBuiltinRegistry,
  createBashTool,
  createDeferredToolSearchTool,
  createExecuteCodeTool,
  createPlanFileManager,
  createReadSkillTool,
  createRequestUserChoiceTool,
  createRequestUserConfirmationTool,
  createRequestUserFormTool,
  createRequestUserInputTool,
  filterAvailableTools,
  type ExecuteCodeHelperToolName,
} from "../tool/index.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckFileUpdateNotification,
  PilotDeckToolDefinition,
  PilotDeckUnavailableToolDiagnostic,
  ToolRegistry,
} from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import { SessionRouterStore } from "../router/session/SessionRouterStore.js";
import type { RouterEventBus, RouterEvent } from "../router/protocol/events.js";
import type { EdgeClawMemoryProvider } from "../context/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import { SkillManager, migrateLegacyBundledSkillCopies } from "../extension/skills/index.js";
import { getPilotDeckInstallCommand, patchProjectScopedMcpSpec } from "../mcp/runtime/projectMcpSpec.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import { createTelemetryCollector, type TelemetryClient } from "../telemetry/index.js";
import { UploadStore } from "../gateway/dialog/UploadStore.js";
import { DialogGatewayError } from "../gateway/dialog/errors.js";
import { listModelCatalog, validateExplicitModelSelection, validateModelSelection } from "../gateway/dialog/modelCatalog.js";
import { createDialogProjectRegistry } from "../gateway/dialog/projectRegistry.js";
import type { SessionModelSelection } from "../gateway/protocol/types.js";
import { listCommands } from "../gateway/dialog/commands.js";
import { isPathWithinRoot } from "../tool/builtin/filesystem/pathSafety.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  /** Read-only skills shipped with this PilotDeck build. Auto-discovered when omitted. */
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PilotDeckToolDefinition[];
  /**
   * Named process sandbox profiles available to SDK sessions. Profiles are
   * resolved only on this Gateway host; remote clients can select a name but
   * cannot install a runner, binary, mount or credential boundary.
   */
  sandboxProfiles?: GatewayHostSandboxProfiles;
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
  /** @internal Test hook for exercising the complete Gateway with an external AgentLoop transport. */
  __testAgentLoopFactory?: (input: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
    seedState?: AgentLoopSeedState;
  }) => AgentLoopRunner;
  /**
   * Fallback project root used as the agent cwd when no explicit
   * `projectKey` is provided (e.g. IM channels without a bound project).
   * Defaults to `projectRoot` when omitted; server mode should set this
   * to `pilotHome` so IM sessions land in the general workspace instead
   * of the gateway process's cwd.
   */
  fallbackProjectRoot?: string;
  /**
   * When true, `ask_user_question` tool calls are answered automatically
   * (first option selected) instead of waiting for a human. Intended for
   * benchmark / headless runs where no interactive user is present.
   */
  autoElicitation?: boolean;
  telemetry?: TelemetryClient;
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

type ResolvedGatewayOrganizationPolicy = {
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

/**
 * Settings inspection is a Gateway protocol projection, not a second config
 * loader. `PilotConfigStore` remains the authoritative snapshot and the
 * public wire shape deliberately excludes unredacted model credentials.
 */
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
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "tool_call":
        parts.push(`[Tool call: ${block.name}]\n${stringifyPortableTranscriptValue(block.input)}`);
        break;
      case "tool_result": {
        const text = flattenToolResultBlockText(block);
        parts.push(text ? `[Tool result]\n${text}` : "[Tool result]");
        break;
      }
      case "tool_result_reference":
        parts.push(`[Persisted tool result omitted]\n${block.preview}`);
        break;
      case "media_reference":
        parts.push(`[Persisted ${block.mediaType} omitted]\n${block.preview}`);
        break;
      case "image":
      case "pdf":
      case "audio":
        parts.push(`[${block.type} attachment omitted from portable archive]`);
        break;
      case "thinking":
        // Provider thinking signatures are intentionally not portable.
        break;
    }
  }
  const text = parts.join("\n\n").trim();
  return text || undefined;
}

function stringifyPortableTranscriptValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unserializable tool input]";
  }
}

function validatePortableSessionArchive(
  value: unknown,
): import("../gateway/protocol/types.js").GatewaySessionTranscriptArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "archive must be an object.");
  }
  const archive = value as Record<string, unknown>;
  if (archive.schemaVersion !== 1 || archive.format !== "portable_text_messages") {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "archive must use portable_text_messages schema version 1.");
  }
  if (!Array.isArray(archive.messages) || archive.messages.length === 0) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", "archive must contain at least one text message.");
  }
  if (archive.messages.length > MAX_PORTABLE_SESSION_ARCHIVE_MESSAGES) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", `archive exceeds ${MAX_PORTABLE_SESSION_ARCHIVE_MESSAGES} messages.`);
  }
  const messages = archive.messages.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", `archive message ${index} must be an object.`);
    }
    const record = message as Record<string, unknown>;
    if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string" || !record.text.trim()) {
      throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", `archive message ${index} must contain a user or assistant text value.`);
    }
    return { role: record.role, text: record.text } as const;
  });
  if (archive.title !== undefined
    && (typeof archive.title !== "string" || archive.title.length > MAX_PORTABLE_SESSION_ARCHIVE_TITLE_LENGTH)) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", `archive title must be at most ${MAX_PORTABLE_SESSION_ARCHIVE_TITLE_LENGTH} characters.`);
  }
  const normalized = {
    schemaVersion: 1 as const,
    format: "portable_text_messages" as const,
    messages,
    ...(typeof archive.title === "string" ? { title: archive.title } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PORTABLE_SESSION_ARCHIVE_BYTES) {
    throw new DialogGatewayError("INVALID_SESSION_ARCHIVE", `archive exceeds ${MAX_PORTABLE_SESSION_ARCHIVE_BYTES} bytes.`);
  }
  return normalized;
}

function reportReplacementRecovery(
  recovery: ReturnType<typeof recoverPendingLastTurnReplacements>,
): void {
  if (recovery.committed > 0 || recovery.rolledBack > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pilotdeck] Recovered last-turn replacements: committed=${recovery.committed} ` +
      `rolledBack=${recovery.rolledBack}.`,
    );
  }
  for (const failure of recovery.failures) {
    // Keep the backup/journal in place so a later startup can retry safely.
    // eslint-disable-next-line no-console
    console.warn(
      `[pilotdeck] Could not recover replacement transaction for ${failure.transcriptPath}: ${failure.message}`,
    );
  }
}

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const pilotHome = options.pilotHome ?? resolvePilotHome(baseEnv);
  const organizationPolicy = normalizeGatewayOrganizationPolicy(options.organizationPolicy);
  const replacementTransactionOwner = { instanceId: randomUUID(), pid: process.pid };
  if (!options.nativeSessionStorage) {
    reportReplacementRecovery(recoverPendingLastTurnReplacements(pilotHome));
  }
  const env = options.pilotHome ? { ...baseEnv, PILOT_HOME: pilotHome } : baseEnv;
  const builtinSkillsRoot = resolveBuiltinSkillsRoot(options.builtinSkillsRoot, env);
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
  const telemetry = options.telemetry ?? createTelemetryCollector({ env, pilotHome });
  const ownsTelemetry = !options.telemetry;
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
  const fallbackProjectRoot = options.fallbackProjectRoot ?? projectRoot;
  // Keep one shared override registry for SDK control-plane updates and
  // session creation.  The registry only supplies AgentSession inputs; it
  // does not alter AgentLoop semantics.
  const sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
  registry = new ProjectRuntimeRegistry({
    fallbackProjectRoot,
    pilotHome,
    builtinSkillsRoot,
    env,
    permissionMode: options.permissionMode ?? "default",
    now,
    extraTools: options.extraTools,
    sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    agentLoopFactory: options.__testAgentLoopFactory,
    autoElicitation: options.autoElicitation,
    sandboxProfiles: options.sandboxProfiles,
    organizationPolicy,
    nativeSessionStorage: options.nativeSessionStorage,
    userDialogStore: options.userDialogStore,
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
    // ConfigChange is SDK-observational. Dispatch only the dedicated
    // session-scoped SDK lifecycle so existing project hooks retain their
    // historical behavior and no hook result can alter config reload.
    registry.dispatchSdkConfigChange({ changedPaths, changeClasses });
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
    onSessionEvict: (sessionKey, reason) => registry.handleSessionEvict(sessionKey, reason),
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
  const skillManager = new SkillManager({ pilotHome, builtinSkillsRoot });
  const dialogProjects = createDialogProjectRegistry({
    pilotHome,
    listProjects: async () => (await listWebProjects({ pilotHome })).projects,
  });
  const uploadStore = new UploadStore({
    listProjects: dialogProjects.listProjectKeys,
    resolveProject: dialogProjects.resolveProjectKey,
  });
  const readSavedModel = async (projectKey: string, sessionKey: string): Promise<SessionModelSelection | undefined> => {
    if (!sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    if (registry.isEphemeralSession(sessionKey)) {
      return registry.getEphemeralModelSelection(sessionKey);
    }
    const storage = registry.createPersistentSessionStorage(projectKey, sessionKey, now);
    const replay = replayTranscriptEntries((await readAgentProjectSessionTranscript(storage)).entries);
    return replay.metadata.modelSelection ?? undefined;
  };
  const modelResult = async (projectKey: string, sessionKey: string, saved?: SessionModelSelection) => {
    const snapshot = loadPilotConfig({ projectRoot: projectKey, env }).config;
    const explicit = saved?.mode === "model" ? saved : undefined;
    return {
      projectKey,
      sessionKey,
      ...(saved ? { saved } : {}),
      effective: explicit ? {
        provider: explicit.provider,
        model: explicit.model,
        source: "session" as const,
        reasoning: explicit.reasoning,
        temperature: explicit.temperature,
        speed: explicit.speed,
      } : {
        provider: snapshot.agent.model.provider,
        model: snapshot.agent.model.model,
        source: snapshot.router?.enabled ? "router" as const : "default" as const,
      },
    };
  };
  // A restore reserves its target key until the atomic rename commits. This
  // prevents concurrent SDK clients from racing to create one transcript.
  const restoringSessionKeys = new Set<string>();
  const gateway = new InProcessGateway(router, {
    funasrInstallCommand: getPilotDeckInstallCommand(),
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
    toolResultsDir: resolve(tmpdir(), "pilotdeck-tool-output", process.pid.toString()),
    cron: options.cron,
    skillManager,
    async commandsList(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      return listCommands({ ...input, projectKey }, pilotHome);
    },
    async modelCatalogList(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      return listModelCatalog({ ...input, projectKey }, env);
    },
    async sessionModelGet(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      return modelResult(projectKey, input.sessionKey, await readSavedModel(projectKey, input.sessionKey));
    },
    async sessionModelSet(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      if (router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change the model during an active turn.");
      if (!input.selection || typeof input.selection !== "object") throw new DialogGatewayError("INVALID_MODEL_OVERRIDE", "selection is required.");
      validateModelSelection(projectKey, input.selection, env);
      if (input.selection.mode === "model") {
        registry.assertOrganizationModelAllowed(projectKey, input.selection.provider, input.selection.model);
        registry.assertManagedModelAllowed(input.sessionKey, input.selection.provider, input.selection.model);
      }
      const metadata = {
        modelSelection: input.selection,
        updatedAt: now().toISOString(),
      };
      if (!await registry.recordEphemeralSessionMetadata(input.sessionKey, "model-selection", metadata)) {
        const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
        await storage.transcript.recordSessionMetadata(input.sessionKey, "model-selection", metadata);
      }
      await router.close(input.sessionKey);
      return modelResult(projectKey, input.sessionKey, input.selection);
    },
    async sessionModelClear(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot clear the model during an active turn.");
      const metadata = {
        modelSelection: null,
        updatedAt: now().toISOString(),
      };
      if (!await registry.recordEphemeralSessionMetadata(input.sessionKey, "model-selection-clear", metadata)) {
        const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
        await storage.transcript.recordSessionMetadata(input.sessionKey, "model-selection-clear", metadata);
      }
      await router.close(input.sessionKey);
    },
    async projectFileRead(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey);
      const root = await realpath(projectKey);
      const absolute = resolve(root, input.path);
      if (!isPathWithinRoot(absolute, root)) throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path is outside the project workspace.");
      const canonical = await realpath(absolute).catch(() => undefined);
      if (!canonical || !isPathWithinRoot(canonical, root)) throw new DialogGatewayError("PATH_NOT_ALLOWED", "File path resolves outside the project workspace.");
      const info = await statAsync(canonical).catch(() => undefined);
      if (!info?.isFile()) return null;
      const data = await readFileAsync(canonical);
      const maxBytes = Math.max(1, Math.min(input.maxBytes ?? 1_000_000, 10_000_000));
      const encoding = input.encoding === "base64" ? "base64" as const : "utf-8" as const;
      return { path: input.path, content: data.subarray(0, maxBytes).toString(encoding), encoding };
    },
    async renameSession(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot rename an active session.");
      const metadata = {
        title: input.value == null ? undefined : String(input.value),
        updatedAt: now().toISOString(),
      };
      if (!await registry.recordEphemeralSessionMetadata(input.sessionKey, "sdk-rename", metadata)) {
        const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
        await storage.transcript.recordSessionMetadata(input.sessionKey, "sdk-rename", metadata);
      }
      return { updated: true };
    },
    async tagSession(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot tag an active session.");
      const metadata = {
        tag: input.value == null ? undefined : String(input.value),
        updatedAt: now().toISOString(),
      };
      if (!await registry.recordEphemeralSessionMetadata(input.sessionKey, "sdk-tag", metadata)) {
        const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
        await storage.transcript.recordSessionMetadata(input.sessionKey, "sdk-tag", metadata);
      }
      return { updated: true };
    },
    async deleteSession(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
      await registry.clearRecoveredUserDialogsForSdk(projectKey, input.sessionKey);
      const transcriptExists = storage.transcriptExists
        ? await storage.transcriptExists()
        : await statAsync(storage.transcriptPath).then((info) => info.isFile()).catch(() => false);
      if (!transcriptExists) throw new DialogGatewayError("SESSION_NOT_FOUND", `Session not found: ${input.sessionKey}`);
      if (storage.deleteSessionTranscripts) {
        await storage.deleteSessionTranscripts();
      } else {
        if (storage.deleteTranscript) await storage.deleteTranscript();
        else await rmAsync(storage.transcriptPath, { force: false });
        await rmAsync(storage.subagentsDir, { recursive: true, force: true });
      }
      if (storage.deleteFileHistoryBackups) await storage.deleteFileHistoryBackups();
      await rmAsync(storage.fileHistoryDir, { recursive: true, force: true });
      if (storage.deleteToolResultArtifacts) await storage.deleteToolResultArtifacts();
      await rmAsync(storage.toolResultsDir, { recursive: true, force: true });
      registry.clearSdkSessionState(input.sessionKey);
    },
    async exportSessionTranscript(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router.hasActiveTurn(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_BUSY", "Cannot export a transcript while its session has an active turn.");
      }
      const storage = registry.createPersistentSessionStorage(projectKey, input.sessionKey, now);
      const transcript = await readAgentProjectSessionTranscript(storage);
      if (transcript.diagnostics.some((diagnostic) => diagnostic.code === "transcript_missing")) {
        throw new DialogGatewayError("SESSION_NOT_FOUND", `Session not found: ${input.sessionKey}`);
      }
      if (transcript.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new DialogGatewayError("SESSION_TRANSCRIPT_INVALID", "Cannot export a transcript with invalid or oversized entries.");
      }
      const archive = validatePortableSessionArchive(toPortableSessionArchive(transcript.entries));
      if (archive.messages.length === 0) {
        throw new DialogGatewayError("SESSION_TRANSCRIPT_EMPTY", "Session has no portable text messages to export.");
      }
      return archive;
    },
    async restoreSessionTranscript(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (registry.isEphemeralSession(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_RESTORE_UNSUPPORTED", "Cannot restore a transcript into an ephemeral session.");
      }
      if (router.hasActiveTurn(input.sessionKey) || router.hasSession(input.sessionKey)) {
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
      if (restoringSessionKeys.has(input.sessionKey)) {
        throw new DialogGatewayError("SESSION_RESTORE_CONFLICT", "A transcript restore is already in progress for this session.");
      }
      restoringSessionKeys.add(input.sessionKey);
      const restoredEntries: import("../session/index.js").AgentTranscriptEntry[] = [];
      const temporaryPath = `${storage.transcriptPath}.${randomUUID()}.restore.tmp`;
      try {
        const writer = new JsonlTranscriptWriter({
          path: storage.externalTranscriptStore ? storage.transcriptPath : temporaryPath,
          now,
          ...(storage.externalTranscriptStore
            ? { appendEntry: (_path, entry) => { restoredEntries.push(entry); } }
            : {}),
        });
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
        if (storage.replaceTranscript) await storage.replaceTranscript(restoredEntries);
        else await renameAsync(temporaryPath, storage.transcriptPath);
      } catch (error) {
        await rmAsync(temporaryPath, { force: true }).catch(() => {});
        throw error;
      } finally {
        restoringSessionKeys.delete(input.sessionKey);
      }
      return { sessionKey: input.sessionKey, importedMessages: archive.messages.length };
    },
    deleteEphemeralSession: (input) => registry.deleteEphemeralSession(input.sessionKey),
    async listRecoveredUserDialogs(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.listRecoveredUserDialogsForSdk(projectKey, input.sessionKey);
    },
    async acknowledgeRecoveredUserDialog(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.acknowledgeRecoveredUserDialogForSdk(projectKey, input.sessionKey, input.requestId);
    },
    async recoverUserDialog(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.recoverUserDialogForSdk(projectKey, input);
    },
    async listHostedUserDialogs(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.listHostedUserDialogsForSdk(projectKey, input.sessionKey);
    },
    async claimHostedUserDialog(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.claimHostedUserDialogForSdk(projectKey, input);
    },
    async releaseHostedUserDialog(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.releaseHostedUserDialogForSdk(projectKey, input);
    },
    async submitHostedUserDialogAnswer(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      return registry.submitHostedUserDialogAnswerForSdk(projectKey, input);
    },
    async clearRecoveredUserDialogs(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      await registry.clearRecoveredUserDialogsForSdk(projectKey, input.sessionKey);
    },
    async setPermissionMode(input) {
      if (input.mode !== "default" && input.mode !== "plan" && input.mode !== "bypassPermissions") {
        throw new DialogGatewayError("INVALID_PERMISSION_MODE", `Unsupported permission mode: ${input.mode}`);
      }
      if (!input.sessionKey?.trim()) throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
      if (router.hasActiveTurn(input.sessionKey)) throw new DialogGatewayError("SESSION_BUSY", "Cannot change permission mode during an active turn.");
      const existing = sessionOverrides.get(input.sessionKey) ?? {};
      sessionOverrides.set(input.sessionKey, { ...existing, permissionMode: input.mode } satisfies SessionConfigOverride);
      return { applied: true };
    },
    async applyFlagSettings(input) {
      return registry.applyFlagSettingsForSdk(input);
    },
    async updateSettings(input) {
      if (organizationPolicy?.settings?.canUpdateLocalSettings === false) {
        throw new DialogGatewayError(
          "GATEWAY_ORGANIZATION_SETTINGS_UPDATE_DENIED",
          "Gateway organization policy denies SDK localSettings updates.",
        );
      }
      const updated = await updatePilotLocalSettings({
        settings: input.settings,
        env,
        projectRoot,
      });
      if (updated.changedPaths.length === 0) return updated;
      let changedPaths: string[] = updated.changedPaths;
      const unsubscribe = configStore.subscribe((event) => {
        changedPaths = event.changedPaths;
      });
      try {
        await configStore.reload("sdk-update-settings");
      } finally {
        unsubscribe();
      }
      return { ...updated, changedPaths };
    },
    async resolveSettings() {
      return toGatewayResolvedSettings(configStore.getSnapshot());
    },
    async setSessionThinking(input) {
      registry.setSessionThinkingForSdk(input.sessionKey, input.thinking);
      return { applied: true };
    },
    outputStylesList: (input) => registry.outputStylesListForSdk(input),
    setOutputStyle: (input) => registry.setOutputStyleForSdk(input),
    reloadOutputStyles: (input) => registry.reloadOutputStylesForSdk(input),
    usageSnapshot: async (input) => registry.usageSnapshotForSdk(input),
    modelUsageSnapshot: async (input) => registry.modelUsageSnapshotForSdk(input),
    setSdkSessionConfig: (sessionKey, config, projectKey) => registry.setSdkSessionConfig(sessionKey, config, projectKey),
    dispatchHookForSession: (sessionKey, event, payload) => registry.dispatchHookForSession(sessionKey, event, payload),
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
    async resolveTurnModelSelection(input) {
      const projectKey = await dialogProjects.resolveProjectKey(input.projectKey ?? fallbackProjectRoot);
      // A Gateway host may pin the primary model for its marked SDK sessions.
      // Resolve this before caller turn or persisted-session selections so an
      // SDK client cannot evade the host setting through a more specific
      // model override. Direct native Gateway submissions never enter this
      // branch because they have no SDK session configuration marker.
      const enforced = registry.getEnforcedSdkSessionModel(input.sessionKey, projectKey);
      if (enforced !== undefined) {
        if (enforced) {
          registry.assertOrganizationModelAllowed(projectKey, enforced.provider, enforced.model);
          registry.assertManagedModelAllowed(input.sessionKey, enforced.provider, enforced.model);
          return { selection: enforced, source: "session" as const };
        }
        return { source: "default" as const };
      }
      if (input.modelOverride) {
        validateExplicitModelSelection(projectKey, input.modelOverride, env);
        registry.assertOrganizationModelAllowed(projectKey, input.modelOverride.provider, input.modelOverride.model);
        registry.assertManagedModelAllowed(input.sessionKey, input.modelOverride.provider, input.modelOverride.model);
        return { selection: input.modelOverride, source: "turn" as const };
      }
      const saved = await readSavedModel(projectKey, input.sessionKey);
      if (saved?.mode === "model") {
        validateExplicitModelSelection(projectKey, saved, env);
        registry.assertOrganizationModelAllowed(projectKey, saved.provider, saved.model);
        registry.assertManagedModelAllowed(input.sessionKey, saved.provider, saved.model);
        return { selection: saved, source: "session" as const };
      }
      const config = loadPilotConfig({ projectRoot: projectKey, env }).config;
      return { source: config.router?.enabled ? "router" as const : "default" as const };
    },
    async resolveUploadedAttachments(input) {
      const resolved = await Promise.all(input.uploads.map(async (upload) => ({
        uploadId: upload.uploadId,
        attachments: await uploadStore.verifyAttachment(upload.uploadId, input.projectKey, upload.attachmentIds),
      })));
      return resolved.flatMap(({ uploadId, attachments }) => attachments.map((attachment) => ({
          type: attachment.mimeType?.startsWith("image/") ? "image" as const : "file" as const,
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
          metadata: {
            uploadId,
            attachmentId: attachment.attachmentId,
            relativePath: attachment.relativePath,
            sha256: attachment.sha256,
          },
        })));
    },
    setSessionCwd: (sessionKey, cwd) => registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: (input) =>
      readWebSessionMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        storage: registry.createPersistentSessionStorage(
          input.projectKey ? input.projectKey : fallbackProjectRoot,
          input.sessionKey,
          now,
        ),
        maxContextTokens: defaultRuntime.snapshot.config.agent.maxContextTokens,
        maxOutputTokens: defaultRuntime.snapshot.config.agent.maxOutputTokens,
        now,
      }),
    readSubagentMessages: (input) =>
      readSubagentWebMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        storage: registry.createPersistentSessionStorage(
          input.projectKey ? input.projectKey : fallbackProjectRoot,
          input.sessionKey,
          now,
        ),
        now,
      }),
    forkSession: (input) =>
      forkWebSession(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        storageForSession: (sessionId) => registry.createPersistentSessionStorage(
          input.projectKey ? input.projectKey : fallbackProjectRoot,
          sessionId,
          now,
        ),
        now,
      }),
    replaceLastTurn: (input) =>
      replaceLastWebSessionTurn(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        storage: registry.createPersistentSessionStorage(
          input.projectKey ? input.projectKey : fallbackProjectRoot,
          input.sessionKey,
          now,
        ),
        now,
        transactionOwner: replacementTransactionOwner,
      }),
    finalizeLastTurnReplacement: (input) =>
      finalizeLastWebSessionTurnReplacement(input, {
        projectRoot: input.projectKey ? input.projectKey : fallbackProjectRoot,
        pilotHome,
        storage: registry.createPersistentSessionStorage(
          input.projectKey ? input.projectKey : fallbackProjectRoot,
          input.sessionKey,
          now,
        ),
        now,
      }),
    async recordAgentStatusMessage(input) {
      if (await registry.recordEphemeralAgentStatus(input.sessionKey, input.turnId, input.status)) {
        return { recorded: true };
      }
      const storage = registry.createPersistentSessionStorage(
        input.projectKey ? input.projectKey : fallbackProjectRoot,
        input.sessionKey,
        now,
      );
      await storage.transcript.recordAgentStatusMessage(input.sessionKey, input.turnId, input.status);
      return { recorded: true };
    },
    listProjects: () =>
      listWebProjects({ pilotHome }),
    describeProject: (input) =>
      describeWebProject(input.projectKey, { pilotHome }),
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
        sessionOverrides: update.sessionOverrides ?? sessionOverrides,
      });
      gateway.setCronController(update.cron);
      gateway.setAlwaysOnApply(update.alwaysOnApply);
      gateway.setAlwaysOnRerunPlan(update.alwaysOnRerunPlan);
    },
  };
}

function resolveBuiltinSkillsRoot(
  configuredRoot: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const explicit = configuredRoot ?? env.PILOTDECK_BUNDLED_SKILLS_DIR;
  if (explicit) return resolve(explicit);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    joinPath(moduleDir, "..", "..", "skills"),
    joinPath(moduleDir, "..", "..", "..", "skills"),
    joinPath(process.cwd(), "skills"),
  ];
  return resolve(candidates.find((candidate) => existsSync(candidate)) ?? candidates[2]);
}

type ProjectRuntimeRegistryOptions = {
  fallbackProjectRoot: string;
  pilotHome: string;
  builtinSkillsRoot?: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  /** @internal Test hook from `CreateLocalGatewayOptions.__testModelFactory`. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /** @internal Test hook from `CreateLocalGatewayOptions.__testAgentLoopFactory`. */
  agentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  autoElicitation?: boolean;
  sandboxProfiles?: GatewayHostSandboxProfiles;
  organizationPolicy?: ResolvedGatewayOrganizationPolicy;
  nativeSessionStorage?: GatewayNativeSessionStorageAdapter;
  userDialogStore?: GatewayUserDialogStore;
  telemetry: TelemetryClient;
  onProjectActivated?: (projectRoot: string) => void;
};

type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
  tokenAccounting: TokenAccountingRuntime;
  router: RouterRuntime;
  pluginRuntime: PluginRuntime;
  tools: ToolRegistry;
  unavailableTools?: PilotDeckUnavailableToolDiagnostic[];
  projectStorage: GatewayProjectStorageOptions;
  /** Per-project background task runtime (shared across sessions). C5. */
  backgroundTasks: BackgroundTaskRuntime;
  /** Per-project lifecycle owner for non-blocking SDK AgentDefinition forks. */
  backgroundSubagents: BackgroundSubagentRuntime;
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

type EphemeralSessionMetadata = {
  modelSelection?: SessionModelSelection | null;
  title?: string;
  tag?: string;
  updatedAt?: string;
};

type EphemeralSessionRecord = {
  root: string;
  storage: AgentProjectSessionStorage;
  metadata: EphemeralSessionMetadata;
};

type SdkSessionPluginScope = {
  plugins: PilotDeckLoadedPlugin[];
  mcpServers: Map<string, PilotDeckMcpServerSpec>;
};

type SdkTaskBudgetLedger = {
  spentUsd: number;
  settledRunIds: Set<string>;
  /** Persisted only for a shared project budget. */
  totalUsd?: number;
  /** Optional project-ledger inactivity window, fixed by its first configuration. */
  projectRetentionMs?: number;
  /** Last creation or settled-spend time for an expiring project ledger. */
  lastActivityAtMs?: number;
};

type SdkTaskBudgetScope = "session" | "project";

type SdkTaskBudgetLedgerRecord =
  | {
      version: 1;
      kind: "snapshot";
      projectRoot: string;
      sessionKey: string;
      scope: SdkTaskBudgetScope;
      spentUsd: number;
      settledRunIds: string[];
      totalUsd?: number;
      projectRetentionMs?: number;
      lastActivityAtMs?: number;
    }
  | {
      version: 1;
      kind: "configured";
      projectRoot: string;
      sessionKey: string;
      scope: "project";
      totalUsd: number;
      projectRetentionMs?: number;
      lastActivityAtMs?: number;
    }
  | {
      version: 1;
      kind: "settled";
      projectRoot: string;
      sessionKey: string;
      /** Missing on historical records means the original session scope. */
      scope?: SdkTaskBudgetScope;
      runId: string;
      turnSpentUsd: number;
      lastActivityAtMs?: number;
    }
  | {
      version: 1;
      kind: "cleared";
      projectRoot: string;
      sessionKey: string;
      scope?: SdkTaskBudgetScope;
    };

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;
const DEFAULT_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS = 512;

class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  /** Custom storage recovery is project-local and runs before first runtime construction. */
  private readonly recoveredNativeStorageChatDirs = new Set<string>();
  private gateway?: InProcessGateway;
  private readonly sdkThinkingOverrides = new Map<
    string,
    import("../gateway/protocol/types.js").GatewayThinkingConfig
  >();
  private readonly sdkSessionConfigs = new Map<
    string,
    import("../gateway/protocol/types.js").GatewaySessionSdkConfig
  >();
  /** Exact Gateway-owned costs, persisted independently of Router diagnostics. */
  private readonly sdkTaskBudgetLedgers = new Map<string, SdkTaskBudgetLedger>();
  private taskBudgetLedgerLoad?: Promise<void>;
  private taskBudgetLedgerRecordCount = 0;
  private readonly taskBudgetLedgerCompactAfterRecords: number;
  /**
   * Plugin records loaded from Gateway-local SDK descriptors. They are merged
   * into a read-only view at session construction time, never into the shared
   * project PluginRuntime registry.
   */
  private readonly sdkSessionPlugins = new Map<string, PilotDeckLoadedPlugin[]>();
  /** MCP endpoints contributed by session-local SDK plugins. */
  private readonly sdkSessionPluginMcpServers = new Map<string, Map<string, PilotDeckMcpServerSpec>>();
  private readonly sdkSessionProjects = new Map<string, string | undefined>();
  /**
   * Session-local lifecycle runtimes needed by Gateway-originated callbacks
   * (for example, completion of an elicitation response). They remain owned
   * by the AgentSession construction path and are dropped on every eviction.
   */
  private readonly sessionLifecycles = new Map<string, {
    lifecycle: LifecycleRuntime;
    /** SDK-only because ConfigChange has no AgentLoop lifecycle dispatch. */
    sdkConfigChangeLifecycle?: LifecycleRuntime;
    cwd: string;
  }>();
  /**
   * SDK `persistSession: false` state. It is Gateway-owned and intentionally
   * separate from project JSONL storage so it cannot appear in session lists
   * or survive a process restart.
   */
  private readonly ephemeralSessions = new Map<string, EphemeralSessionRecord>();
  /**
   * Dialogs recovered from a prior Gateway process. They live outside
   * AgentSession because a restart cannot revive the original tool promise.
   */
  private readonly recoveredUserDialogs = new Map<string, GatewayRecoveredUserDialog[]>();
  /** Coalesces concurrent recovery writes for the same dialog request. */
  private readonly recoveringUserDialogs = new Map<string, Promise<boolean>>();
  /** Serializes durable recovery writes that target the same transcript. */
  private readonly recoveredUserDialogWriteQueues = new Map<string, Promise<void>>();
  private readonly sessionFileHistories = new Map<string, FileHistoryStore>();
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
  /**
   * MCP servers configured through the public SDK are session-scoped and
   * deliberately separate from config/plugin-owned servers. The adapter
   * turns them into the existing McpRuntime + ToolRegistry path when a
   * session is constructed; it never changes ToolRuntime semantics.
   */
  private readonly sdkSessionMcpServers = new Map<
    string,
    Map<string, { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean }>
  >();
  private readonly sdkSessionMcpRuntimes = new Map<string, McpRuntime>();
  /** Session-scoped MCP permission overrides requested through the SDK. */
  private readonly sdkMcpPermissionOverrides = new Map<string, Map<string, "default" | "auto">>();
  /** Rule objects injected for the overrides, so they can be removed safely. */
  private readonly sdkMcpPermissionRules = new Map<string, Map<string, PermissionRule>>();

  private _extraTools: PilotDeckToolDefinition[];
  private _sessionOverrides: SessionConfigOverrides | undefined;
  private readonly sharedSessionStore = new SessionRouterStore({
    now: () => this.options.now().getTime(),
  });

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
    this.taskBudgetLedgerCompactAfterRecords = readPositiveIntegerEnv(
      options.env.PILOTDECK_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS,
    ) ?? DEFAULT_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS;
  }

  assertOrganizationModelAllowed(projectRoot: string, provider: string, model: string): void {
    if (!isOrganizationModelAllowed(this.options.organizationPolicy, provider, model)) {
      throw new DialogGatewayError(
        "GATEWAY_ORGANIZATION_MODEL_DENIED",
        `Gateway organization policy denies model ${provider}/${model}.`,
      );
    }
    const rejection = organizationProviderPolicyRejection(
      this.options.organizationPolicy,
      provider,
      this.resolve(projectRoot).snapshot.config.model.providers[provider],
    );
    if (rejection) throw new DialogGatewayError(rejection.code, rejection.message);
  }

  assertManagedModelAllowed(sessionKey: string, provider: string, model: string): void {
    const policy = this.sdkSessionConfigs.get(sessionKey)?.managedModels;
    assertManagedModelAllowed(policy, provider, model);
  }

  /**
   * Returns the host-forced model for a marked SDK session. `null` means the
   * host explicitly requires the native Gateway default instead; `undefined`
   * means there is no host model override and normal turn/session selection
   * should proceed. This is intentionally not available to native sessions.
   */
  getEnforcedSdkSessionModel(
    sessionKey: string,
    projectRoot: string,
  ): import("../gateway/protocol/types.js").ExplicitModelSelection | null | undefined {
    if (!this.sdkSessionConfigs.has(sessionKey)) return undefined;
    const agent = this.options.organizationPolicy?.settings?.enforcedSessionSettings?.agent;
    if (!agent || !Object.prototype.hasOwnProperty.call(agent, "model")) return undefined;
    if (agent.model === null) return null;
    if (agent.model === undefined) return undefined;
    const resolved = resolveSdkSessionAgentModel(agent.model, projectRoot, this.options.env);
    return { mode: "model", provider: resolved.provider, model: resolved.model };
  }

  /**
   * Resolves persistent native storage at the Gateway boundary. Ephemeral SDK
   * sessions intentionally bypass this method because they are never durable.
   */
  createPersistentSessionStorage(
    projectRoot: string,
    sessionId: string,
    now: () => Date = this.options.now,
  ): AgentProjectSessionStorage {
    return createGatewayNativeSessionStorage({
      projectRoot,
      pilotHome: this.options.pilotHome,
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
    const dialogs = await store.listLive!(this.userDialogStoreKey(projectRoot, sessionKey));
    return dialogs.map((dialog) => structuredClone(dialog.request));
  }

  async claimHostedUserDialogForSdk(
    projectRoot: string,
    input: import("../gateway/protocol/types.js").GatewayUserDialogClaimInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayUserDialogClaimResult> {
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(this.options.userDialogStore)) {
      return { claimed: false, reason: "not_pending" };
    }
    return this.options.userDialogStore.claimLive!(this.userDialogStoreKey(projectRoot, input.sessionKey), {
      requestId: input.requestId,
      ttlMs: input.ttlMs ?? 30_000,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    });
  }

  async releaseHostedUserDialogForSdk(
    projectRoot: string,
    input: import("../gateway/protocol/types.js").GatewayUserDialogReleaseInput,
  ): Promise<boolean> {
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(this.options.userDialogStore)) return false;
    return this.options.userDialogStore.releaseLive!(this.userDialogStoreKey(projectRoot, input.sessionKey), {
      requestId: input.requestId,
      leaseId: input.leaseId,
    });
  }

  async submitHostedUserDialogAnswerForSdk(
    projectRoot: string,
    input: GatewayUserDialogResponseInput,
  ): Promise<boolean> {
    if (this.isEphemeralSession(input.sessionKey) || !hasLiveUserDialogStore(this.options.userDialogStore)) return false;
    const key = this.userDialogStoreKey(projectRoot, input.sessionKey);
    const dialog = (await this.options.userDialogStore.listLive!(key))
      .find((candidate) => candidate.request.requestId === input.requestId);
    if (!dialog) return false;
    if (input.result.behavior === "answered" && !acceptsRecoveredUserDialogAnswer(dialog.request, input.result.value)) {
      throw new DialogGatewayError(
        "INVALID_USER_DIALOG_RESPONSE",
        `answered ${dialog.request.dialogKind} dialog result does not match the pending dialog contract.`,
      );
    }
    return this.options.userDialogStore.submitLiveAnswer!(key, {
      requestId: input.requestId,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      result: structuredClone(input.result),
    });
  }

  /**
   * The original process cannot resume a tool promise after restart. Persist
   * the renderer's validated answer as a synthetic transcript turn instead,
   * so the next Gateway turn receives it as normal model context. The SDK
   * never manufactures a second session or run to simulate this behavior.
   */
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

  private async loadRecoveredUserDialogs(projectRoot: string, sessionKey: string): Promise<GatewayRecoveredUserDialog[]> {
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
    // The journal is the authority. Re-read it after every list so a normal
    // live-dialog settle (answer, abort, timeout, or turn end) cannot leave a
    // stale in-memory restart projection behind. Preserve the first observed
    // terminal timestamp while the same journal entry remains pending.
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

  /**
   * Stop and discard the per-session MCP runtime for `sessionKey`.
   * Called by the `SessionRouter.onSessionEvict` callback.
   */
  evictSessionMcp(sessionKey: string): void {
    // File-history state is an in-memory index over durable transcript and
    // backup files. Drop it with the AgentSession; a later resume rebuilds it.
    this.sessionFileHistories.delete(sessionKey);
    this.sessionLifecycles.delete(sessionKey);
    const mcp = this.sessionMcpRuntimes.get(sessionKey);
    if (mcp) {
      this.sessionMcpRuntimes.delete(sessionKey);
      mcp.stop().catch(() => {});
    }
    const sdkMcp = this.sdkSessionMcpRuntimes.get(sessionKey);
    if (sdkMcp) {
      this.sdkSessionMcpRuntimes.delete(sessionKey);
      sdkMcp.stop().catch(() => {});
    }
  }

  handleSessionEvict(
    sessionKey: string,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): void {
    this.evictSessionMcp(sessionKey);
    // A dirty recreation keeps the same in-memory transcript and temporary
    // artifacts. All other evictions make an ephemeral session unreachable.
    if (reason !== "dirty_recreate" && this.ephemeralSessions.has(sessionKey)) {
      void this.disposeEphemeralSession(sessionKey).catch(() => {});
    }
  }

  isEphemeralSession(sessionKey: string): boolean {
    return this.sdkSessionConfigs.get(sessionKey)?.persistSession === false;
  }

  getEphemeralModelSelection(sessionKey: string): SessionModelSelection | undefined {
    return this.ephemeralSessions.get(sessionKey)?.metadata.modelSelection ?? undefined;
  }

  async recordEphemeralSessionMetadata(
    sessionKey: string,
    turnId: string,
    metadata: EphemeralSessionMetadata,
  ): Promise<boolean> {
    const record = this.ephemeralSessions.get(sessionKey);
    if (!record) return false;
    record.metadata = { ...record.metadata, ...metadata };
    await record.storage.transcript.recordSessionMetadata(sessionKey, turnId, metadata);
    return true;
  }

  async recordEphemeralAgentStatus(
    sessionKey: string,
    turnId: string,
    status: Parameters<NonNullable<AgentProjectSessionStorage["transcript"]["recordAgentStatusMessage"]>>[2],
  ): Promise<boolean> {
    const record = this.ephemeralSessions.get(sessionKey);
    if (!record) return false;
    await record.storage.transcript.recordAgentStatusMessage(sessionKey, turnId, status);
    return true;
  }

  async deleteEphemeralSession(sessionKey: string): Promise<boolean> {
    if (!this.ephemeralSessions.has(sessionKey)) return false;
    await this.disposeEphemeralSession(sessionKey);
    return true;
  }

  private async getOrCreateEphemeralStorage(sessionKey: string): Promise<AgentProjectSessionStorage> {
    const existing = this.ephemeralSessions.get(sessionKey);
    if (existing) return existing.storage;

    const root = await mkdtemp(joinPath(tmpdir(), "pilotdeck-sdk-ephemeral-"));
    const subagentsDir = joinPath(root, "subagents");
    const transcript = new InMemoryTranscriptWriter();
    // `AgentProjectSessionStorage` currently names JsonlTranscriptWriter, but
    // all consumers use the transcript operations implemented by the memory
    // writer. Keeping this adapter inside the Gateway avoids widening the
    // native persistent-storage contract for an SDK-only lifecycle choice.
    const storage: AgentProjectSessionStorage = {
      chatDir: root,
      transcriptPath: "",
      toolResultsDir: joinPath(root, "tool-results"),
      fileHistoryDir: joinPath(root, "file-history"),
      subagentsDir,
      subagentTranscriptPath: (subagentId) => joinPath(subagentsDir, `${sanitizeSessionIdForPath(subagentId)}.jsonl`),
      transcript: transcript as unknown as AgentProjectSessionStorage["transcript"],
    };
    this.ephemeralSessions.set(sessionKey, { root, storage, metadata: {} });
    return storage;
  }

  private async disposeEphemeralSession(sessionKey: string): Promise<void> {
    const record = this.ephemeralSessions.get(sessionKey);
    if (!record) return;
    this.ephemeralSessions.delete(sessionKey);
    try {
      await rmAsync(record.root, { recursive: true, force: true });
    } finally {
      this.clearSdkSessionState(sessionKey);
    }
  }

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  dispatchHookForSession(sessionKey: string, event: string, payload: Record<string, unknown>): void {
    if (!isNativeHookEvent(event)) return;
    const entry = this.sessionLifecycles.get(sessionKey);
    if (!entry) return;
    void entry.lifecycle.dispatch({
      event,
      baseInput: { sessionId: sessionKey, transcriptPath: "", cwd: entry.cwd },
      payload,
      matchQuery: event,
    }).catch(() => {});
  }

  /**
   * Config reload is Gateway-owned rather than an AgentLoop event. Only SDK
   * sessions that explicitly opted into ConfigChange receive this observation.
   * Hook output is deliberately ignored: reload ordering and runtime
   * invalidation retain their native semantics.
   */
  dispatchSdkConfigChange(payload: { changedPaths: string[]; changeClasses: string[] }): void {
    for (const [sessionKey, entry] of this.sessionLifecycles) {
      if (!entry.sdkConfigChangeLifecycle) continue;
      void entry.sdkConfigChangeLifecycle.dispatch({
        event: "ConfigChange",
        baseInput: { sessionId: sessionKey, transcriptPath: "", cwd: entry.cwd },
        payload,
        matchQuery: "ConfigChange",
      }).catch(() => {});
    }
  }

  private emitBackgroundTaskCompletion(event: BackgroundTaskCompletionEvent): void {
    if (!event.sessionId || !this.gateway) {
      return;
    }
    const outputPreview = event.outputPreview.trimEnd();
    this.gateway.emitForSession(event.sessionId, {
      type: "agent_status",
      event: "background_task_completed",
      detail: {
        taskId: event.taskId,
        status: event.status,
        exitCode: event.exitCode ?? null,
        totalBytes: event.totalBytes,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        ...(outputPreview ? { outputPreview } : {}),
      },
    });
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
      // Materialize optional arrays on the shared override object.  A
      // session override may provide only allow/deny rules; using a fresh
      // `[]` for ask here would drop SDK-generated MCP rules immediately
      // after this call returns.
      explicit.allow ??= [];
      explicit.deny ??= [];
      explicit.ask ??= [];
      const rules = {
        allow: explicit.allow,
        deny: explicit.deny,
        ask: explicit.ask,
      };
      this.syncSdkMcpPermissionRules(sessionKey, rules.ask);
      return rules;
    }
    let auto = this.fallbackRuleSets.get(sessionKey);
    if (!auto) {
      auto = { allow: [], deny: [], ask: [] };
      this.fallbackRuleSets.set(sessionKey, auto);
    }
    this.syncSdkMcpPermissionRules(sessionKey, auto.ask);
    return auto;
  }

  private syncSdkMcpPermissionRules(sessionKey: string, askRules: PermissionRule[]): void {
    const generated = this.sdkMcpPermissionRules.get(sessionKey) ?? new Map<string, PermissionRule>();
    const active = this.sdkMcpPermissionOverrides.get(sessionKey) ?? new Map<string, "default" | "auto">();
    for (const [serverName, rule] of generated) {
      if (!active.has(serverName)) {
        const index = askRules.indexOf(rule);
        if (index >= 0) askRules.splice(index, 1);
        generated.delete(serverName);
      }
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
    for (const [, mcp] of this.sdkSessionMcpRuntimes) {
      mcp.stop().catch(() => {});
    }
    this.sdkSessionMcpRuntimes.clear();

    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime?.mcpRuntime) {
        runtime.mcpRuntime.stop().catch(() => {});
      }
      runtime?.backgroundSubagents.shutdown();
      runtime?.memoryService?.close();
      runtime?.router?.shutdown().catch(() => {});
      this.runtimes.delete(projectRoot);
    } else {
      for (const [, runtime] of this.runtimes) {
        if (runtime.mcpRuntime) {
          runtime.mcpRuntime.stop().catch(() => {});
        }
        runtime.backgroundSubagents.shutdown();
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
    const projectRoot = resolve(projectKey ?? this.options.fallbackProjectRoot);
    this.recoverNativeSessionStorage(projectRoot);
    this.options.onProjectActivated?.(projectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPilotConfig({ projectRoot, env: this.options.env });
    const rawModel = this.options.modelFactory
      ? this.options.modelFactory(snapshot)
      : createModelRuntime(snapshot.config.model);
    const model = this.options.organizationPolicy?.providers
      ? createOrganizationPolicyModelRuntime(rawModel, snapshot.config.model, this.options.organizationPolicy)
      : rawModel;
    const tokenAccounting = new TokenAccountingRuntime({
      modelConfig: snapshot.config.model,
    });
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinSkillsRoot: this.options.builtinSkillsRoot,
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
      ...(this.options.organizationPolicy?.models || this.options.organizationPolicy?.providers ? {
        isModelAllowed: ({ provider, model: modelId }) => isOrganizationModelAllowed(
          this.options.organizationPolicy,
          provider,
          modelId,
        ) && isOrganizationProviderAllowed(
          this.options.organizationPolicy,
          provider,
          snapshot.config.model.providers[provider],
        ),
      } : {}),
    });
    const backgroundTasks = new BackgroundTaskRuntime({
      now: this.options.now,
      onCompletion: (event) => this.emitBackgroundTaskCompletion(event),
    });
    const backgroundSubagents = new BackgroundSubagentRuntime();
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
      ...(webSearchConfig?.enabled === false
        ? { webSearch: false as const }
        : webSearchConfig
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
      tokenAccounting,
      router,
      pluginRuntime,
      tools,
      backgroundTasks,
      backgroundSubagents,
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

  private recoverNativeSessionStorage(projectRoot: string): void {
    if (!this.options.nativeSessionStorage) return;
    const chatDir = resolveGatewayNativeProjectChatDir({
      projectRoot,
      pilotHome: this.options.pilotHome,
    }, this.options.nativeSessionStorage);
    if (this.recoveredNativeStorageChatDirs.has(chatDir)) return;
    this.recoveredNativeStorageChatDirs.add(chatDir);
    reportReplacementRecovery(recoverPendingLastTurnReplacements(this.options.pilotHome, {
      chatDirs: [chatDir],
    }));
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
        const { servers: parsedServers } = parsePluginMcpServers(rawServers);
        const servers = parsedServers.map((server) => patchProjectScopedMcpSpec(
          server,
          runtime.projectRoot,
          this.options.pilotHome,
        ));
        if (servers.length === 0) return;

        const sharedServers = servers.filter((s) => s.transport !== "stdio" || !s.perSession);
        const perSessionServers = servers.filter((s) => s.transport === "stdio" && s.perSession);

        runtime.perSessionServerSpecs = perSessionServers.length > 0 ? perSessionServers : undefined;

        if (sharedServers.length > 0) {
          const mcp = new McpRuntime(sharedServers);
          runtime.mcpRuntime = mcp;
          const statuses = await mcp.start();
          for (const status of statuses) {
            if (status.status === "error") {
              // eslint-disable-next-line no-console
              console.warn(
                `[pilotdeck] ${status.serverId === "funasr" ? "ASR unavailable" : "MCP server unavailable"} ` +
                `(server=${status.serverId}): ${status.error ?? "unknown error"}`,
              );
            }
          }
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

  /** Public adapter for SDK read-only status queries. */
  async ensureMcpReadyForSdk(projectKey?: string): Promise<void> {
    const runtime = this.resolve(projectKey);
    await this.ensureMcpReady(runtime);
  }

  /**
   * Replace the SDK-owned MCP configuration for one session. This is an
   * atomic control-plane operation: malformed configs and names owned by
   * plugins/config files leave the previous SDK configuration untouched.
   */
  async setMcpServersForSdk(
    input: import("../gateway/protocol/types.js").GatewaySetMcpServersInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayMcpSetServersResult> {
    const runtime = this.resolve(input.projectKey);
    await this.ensureMcpReady(runtime);

    const current = this.sdkSessionMcpServers.get(input.sessionKey) ?? new Map();
    const next = new Map<string, { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean }>();
    const errors: Array<{ name: string; error: string }> = [];
    const reservedNames = new Set([
      ...(runtime.mcpRuntime?.servers ?? []).map((server) => server.id),
      ...(runtime.perSessionServerSpecs ?? []).map((server) => server.id),
      ...(this.sdkSessionPluginMcpServers.get(input.sessionKey)?.keys() ?? []),
    ]);

    if (!input.servers || typeof input.servers !== "object" || Array.isArray(input.servers)) {
      return { added: [], removed: [], errors: [{ name: "*", error: "servers must be an object keyed by MCP server name." }] };
    }

    for (const [name, rawConfig] of Object.entries(input.servers)) {
      if (!name.trim()) {
        errors.push({ name, error: "MCP server name must not be empty." });
        continue;
      }
      if (reservedNames.has(name)) {
        errors.push({ name, error: "This MCP server name is owned by project configuration or a plugin and cannot be replaced through the SDK." });
        continue;
      }
      try {
        const config = validateSdkMcpServerConfig(name, rawConfig);
        next.set(name, { config, enabled: current.get(name)?.enabled ?? true });
      } catch (error) {
        errors.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (errors.length > 0) {
      return { added: [], removed: [], errors };
    }

    const added = [...next.entries()]
      .filter(([name, value]) => !sameSdkMcpServer(current.get(name), value))
      .map(([name]) => name);
    const removed = [...current.keys()].filter((name) => !next.has(name));
    if (next.size === 0) this.sdkSessionMcpServers.delete(input.sessionKey);
    else this.sdkSessionMcpServers.set(input.sessionKey, next);
    this.evictSdkSessionMcp(input.sessionKey);
    return { added, removed, errors: [] };
  }

  async reconnectMcpServerForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerControlInput,
  ): Promise<void> {
    const server = this.sdkSessionMcpServers.get(input.sessionKey)?.get(input.serverName);
    if (!server) {
      throw new DialogGatewayError(
        "MCP_SERVER_NOT_FOUND",
        `SDK-owned MCP server ${input.serverName} is not configured for session ${input.sessionKey}.`,
      );
    }
    if (!server.enabled) {
      throw new DialogGatewayError(
        "MCP_SERVER_DISABLED",
        `SDK-owned MCP server ${input.serverName} is disabled; enable it before reconnecting.`,
      );
    }
    this.evictSdkSessionMcp(input.sessionKey);
  }

  async toggleMcpServerForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerToggleInput,
  ): Promise<void> {
    const server = this.sdkSessionMcpServers.get(input.sessionKey)?.get(input.serverName);
    if (!server) {
      throw new DialogGatewayError(
        "MCP_SERVER_NOT_FOUND",
        `SDK-owned MCP server ${input.serverName} is not configured for session ${input.sessionKey}.`,
      );
    }
    server.enabled = input.enabled;
    this.evictSdkSessionMcp(input.sessionKey);
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
      if (session && session.size === 0) this.sdkMcpPermissionOverrides.delete(input.sessionKey);
    } else {
      let session = this.sdkMcpPermissionOverrides.get(input.sessionKey);
      if (!session) {
        session = new Map();
        this.sdkMcpPermissionOverrides.set(input.sessionKey, session);
      }
      session.set(input.serverName, input.mode);
    }
    // Materialize/remove the generated rule on the live session rule array.
    this.getLiveRuleSet(input.sessionKey);
    return input.mode === "auto"
      ? { warning: "PilotDeck does not expose Claude's MCP safety classifier; auto uses conservative ask semantics for this server." }
      : {};
  }

  async mcpServerStatusForSdk(
    input: import("../gateway/protocol/types.js").GatewayMcpServerStatusInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayMcpServerStatusResult> {
    const runtime = this.resolve(input.projectKey);
    await this.ensureMcpReady(runtime);
    const servers: Array<{ name: string; status: string; error?: string }> = [
      ...(runtime.mcpRuntime?.statuses().map((status) => ({
        name: status.serverId,
        status: status.status,
        ...(status.error ? { error: status.error } : {}),
      })) ?? []),
    ];
    if (input.sessionKey) {
      const sessionMcp = this.sessionMcpRuntimes.get(input.sessionKey);
      servers.push(...(sessionMcp?.statuses().map((status) => ({
        name: status.serverId,
        status: status.status,
        ...(status.error ? { error: status.error } : {}),
      })) ?? []));

      const sdkMcp = this.sdkSessionMcpRuntimes.get(input.sessionKey);
      const sdkStatuses = new Map(sdkMcp?.statuses().map((status) => [status.serverId, status]) ?? []);
      for (const [name] of this.sdkSessionPluginMcpServers.get(input.sessionKey) ?? []) {
        const status = sdkStatuses.get(name);
        servers.push({
          name,
          status: status?.status ?? "configured",
          ...(status?.error ? { error: status.error } : {}),
        });
      }
      for (const [name, configured] of this.sdkSessionMcpServers.get(input.sessionKey) ?? []) {
        const status = sdkStatuses.get(name);
        servers.push({
          name,
          status: configured.enabled ? (status?.status ?? "configured") : "disabled",
          ...(status?.error ? { error: status.error } : {}),
        });
      }
    }
    return { servers };
  }

  private evictSdkSessionMcp(sessionKey: string): void {
    const mcp = this.sdkSessionMcpRuntimes.get(sessionKey);
    if (!mcp) return;
    this.sdkSessionMcpRuntimes.delete(sessionKey);
    mcp.stop().catch(() => {});
  }

  private async ensureSdkSessionMcpReady(
    context: GatewaySessionContext,
  ): Promise<McpRuntime | undefined> {
    const configured = this.sdkSessionMcpServers.get(context.sessionKey);
    const pluginServers = this.sdkSessionPluginMcpServers.get(context.sessionKey);
    if ((!configured || configured.size === 0) && (!pluginServers || pluginServers.size === 0)) return undefined;
    const existing = this.sdkSessionMcpRuntimes.get(context.sessionKey);
    if (existing) return existing;

    const specs = [
      ...(pluginServers?.values() ?? []),
      ...(configured ? [...configured.entries()]
      .filter(([, server]) => server.enabled)
      .map(([id, server]) => toSdkMcpServerSpec(id, server.config)) : []),
    ];
    if (specs.length === 0) return undefined;

    const mcp = new McpRuntime(specs);
    this.sdkSessionMcpRuntimes.set(context.sessionKey, mcp);
    const statuses = await mcp.start();
    for (const status of statuses) {
      if (status.status === "error") {
        // Startup errors stay observable via mcp_server_status and do not
        // take down native tools or the rest of the session.
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] SDK MCP server unavailable (server=${status.serverId}, session=${context.sessionKey}): ` +
          `${status.error ?? "unknown error"}`,
        );
      }
    }
    return mcp;
  }

  /** Called only after durable session deletion, not ordinary close/resume. */
  clearSdkSessionState(sessionKey: string): void {
    this.evictSessionMcp(sessionKey);
    this.sdkSessionMcpServers.delete(sessionKey);
    this.sdkSessionPlugins.delete(sessionKey);
    this.sdkSessionPluginMcpServers.delete(sessionKey);
    this.sdkThinkingOverrides.delete(sessionKey);
    const taskBudgetScope = sdkTaskBudgetScope(this.sdkSessionConfigs.get(sessionKey)?.taskBudget);
    this.sdkSessionConfigs.delete(sessionKey);
    const projectRoot = this.sdkSessionProjects.get(sessionKey);
    // A project budget intentionally survives deletion of any one of its
    // constituent sessions. A session budget retains the existing delete
    // semantics and is tombstoned with its owning session.
    if (projectRoot && taskBudgetScope === "session") this.clearTaskBudgetLedger(projectRoot, sessionKey);
    this.sdkSessionProjects.delete(sessionKey);
    this.sdkMcpPermissionOverrides.delete(sessionKey);
    this.sdkMcpPermissionRules.delete(sessionKey);
    this.sessionFileHistories.delete(sessionKey);
    this.fallbackRuleSets.delete(sessionKey);
  }

  setSessionThinkingForSdk(
    sessionKey: string,
    thinking: import("../gateway/protocol/types.js").GatewayThinkingConfig | null,
  ): void {
    if (thinking === null) {
      this.sdkThinkingOverrides.delete(sessionKey);
      return;
    }
    const cappedThinking = capOrganizationThinkingConfig(
      thinking,
      this.options.organizationPolicy?.settings?.maxThinkingTokens,
    );
    if (cappedThinking === undefined) {
      this.sdkThinkingOverrides.delete(sessionKey);
      return;
    }
    this.sdkThinkingOverrides.set(sessionKey, cappedThinking);
  }

  async applyFlagSettingsForSdk(
    input: import("../gateway/protocol/types.js").GatewayApplyFlagSettingsInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayApplyFlagSettingsResult> {
    const applied: string[] = [];
    const cleared: string[] = [];
    const settings = input.settings;

    if (Object.prototype.hasOwnProperty.call(settings, "effortLevel")) {
      const effort = settings.effortLevel;
      if (effort === null) {
        this.sdkThinkingOverrides.delete(input.sessionKey);
        cleared.push("effortLevel");
      } else {
        this.sdkThinkingOverrides.set(input.sessionKey, { enabled: true, mode: effort as "low" | "medium" | "high" });
        applied.push("effortLevel");
      }
    }

    if (Object.prototype.hasOwnProperty.call(settings, "permissions")) {
      const permissions = settings.permissions;
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
        this._sessionOverrides?.set(input.sessionKey, { ...existing, permissionMode: defaultMode as "default" | "plan" | "bypassPermissions" });
        applied.push("permissions.defaultMode");
      }
    }

    return { applied, cleared };
  }

  async setSdkSessionConfig(
    sessionKey: string,
    config: import("../gateway/protocol/types.js").GatewaySessionSdkConfig,
    projectKey?: string,
  ): Promise<{ changed: boolean }> {
    const next = cloneSdkSessionConfig(config);
    applyOrganizationTaskBudgetCap(next, this.options.organizationPolicy?.limits?.maxTaskBudgetUsd);
    validateSdkManagedPermissions(next.managedPermissions);
    validateSdkManagedTools(next.managedTools);
    validateSdkManagedModels(next.managedModels);
    validateSdkDeferredTools(next.deferredTools);
    validateSdkSandbox(next.sandbox);
    validatePilotSdkSettingSources(next.settingSources);
    assertOrganizationSettingSourcesAllowed(this.options.organizationPolicy, next.settingSources);
    const runtime = this.resolve(projectKey);
    // Validate the Gateway-owned settings sources before accepting config or
    // evicting a cached session. The resolved overlay is recomputed during
    // session construction so a changed source can take effect after normal
    // Gateway runtime invalidation without becoming SDK-owned state.
    const sessionSettings = resolveSdkSessionSettings(
      runtime.projectRoot,
      this.options.env,
      next,
      this.options.organizationPolicy?.settings?.sessionDefaults,
      this.options.organizationPolicy?.settings?.managedSessionSettings,
      this.options.organizationPolicy?.settings?.sessionDefaultSources,
      this.options.organizationPolicy?.settings?.enforcedSessionSettings,
    );
    const sessionModel = sessionSettings?.agent?.model;
    if (sessionModel !== undefined && sessionModel !== null) {
      const resolved = resolveSdkSessionAgentModel(sessionModel, runtime.projectRoot, this.options.env);
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolved.provider, resolved.model);
      assertManagedModelAllowed(next.managedModels, resolved.provider, resolved.model);
    }
    const sessionFallbackModel = sessionSettings?.agent?.fallbackModel;
    if (sessionFallbackModel !== undefined && sessionFallbackModel !== null) {
      const resolved = resolveSdkFallbackModel(sessionFallbackModel, runtime.projectRoot, this.options.env);
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolved.provider, resolved.model);
      assertManagedModelAllowed(next.managedModels, resolved.provider, resolved.model);
    }
    const subagentDefault = sessionSettings?.agent?.subagents?.default;
    if (subagentDefault !== undefined && subagentDefault !== null) {
      const resolved = resolveSdkSessionSubagentModel(subagentDefault, runtime.projectRoot, this.options.env);
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolved.provider, resolved.model);
      assertManagedModelAllowed(next.managedModels, resolved.provider, resolved.model);
    }
    if (next.sandbox?.type === "host" && !this.options.sandboxProfiles?.[next.sandbox.profile]) {
      throw new DialogGatewayError(
        "SDK_SANDBOX_PROFILE_UNAVAILABLE",
        `Gateway host sandbox profile is unavailable: ${next.sandbox.profile}`,
      );
    }
    await runtime.pluginRuntime.refresh();
    await this.ensureMcpReady(runtime);
    const pluginScope = await resolveSdkSessionPlugins(next.plugins, runtime, this.options.pilotHome);
    const extensionRuntime = pluginScope
      ? runtime.pluginRuntime.createView(pluginScope.plugins)
      : runtime.pluginRuntime;
    validateSdkSubagentModels(
      next.agents,
      runtime.projectRoot,
      this.options.env,
      (model) => {
        this.assertOrganizationModelAllowed(runtime.projectRoot, model.provider, model.model);
        assertManagedModelAllowed(next.managedModels, model.provider, model.model);
      },
    );
    if (next.fallbackModel) {
      const resolved = resolveSdkFallbackModel(next.fallbackModel, runtime.projectRoot, this.options.env);
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolved.provider, resolved.model);
      assertManagedModelAllowed(next.managedModels, resolved.provider, resolved.model);
    }
    if (Array.isArray(next.skills)) {
      next.skills = await resolveSdkSessionSkills(next.skills, extensionRuntime);
    }
    await resolveSdkSubagentScopes(
      next.agents,
      next.skills,
      extensionRuntime,
      this.sdkSessionMcpServers.get(sessionKey),
    );
    const reservedMcpNames = new Set([
      ...(runtime.mcpRuntime?.servers ?? []).map((server) => server.id),
      ...(runtime.perSessionServerSpecs ?? []).map((server) => server.id),
      ...(this.sdkSessionMcpServers.get(sessionKey)?.keys() ?? []),
    ]);
    for (const name of pluginScope?.mcpServers.keys() ?? []) {
      if (reservedMcpNames.has(name)) {
        throw new DialogGatewayError(
          "SDK_PLUGIN_MCP_NAME_CONFLICT",
          `Session plugin MCP server ${name} conflicts with an existing project or SDK server.`,
        );
      }
      reservedMcpNames.add(name);
    }
    await this.configureProjectTaskBudget(runtime.projectRoot, sessionKey, next.taskBudget);
    const previous = this.sdkSessionConfigs.get(sessionKey);
    const hasHostSessionDefaults = this.options.organizationPolicy?.settings?.sessionDefaults !== undefined
      || this.options.organizationPolicy?.settings?.managedSessionSettings !== undefined
      || this.options.organizationPolicy?.settings?.sessionDefaultSources !== undefined
      || this.options.organizationPolicy?.settings?.enforcedSessionSettings !== undefined
      || this.options.organizationPolicy?.limits?.maxTaskBudgetUsd !== undefined;
    // An empty SDK config normally has no observable state and remains a
    // no-op. With host defaults it is the explicit Gateway-owned marker that
    // distinguishes an SDK session from a direct native Gateway submission.
    if (sdkSessionConfigEquals(previous, next) && !(hasHostSessionDefaults && previous === undefined)) {
      return { changed: false };
    }
    this.evictSdkSessionMcp(sessionKey);
    if (pluginScope) {
      this.sdkSessionPlugins.set(sessionKey, pluginScope.plugins);
      if (pluginScope.mcpServers.size > 0) this.sdkSessionPluginMcpServers.set(sessionKey, pluginScope.mcpServers);
      else this.sdkSessionPluginMcpServers.delete(sessionKey);
    } else {
      this.sdkSessionPlugins.delete(sessionKey);
      this.sdkSessionPluginMcpServers.delete(sessionKey);
    }
    this.sdkSessionConfigs.set(sessionKey, next);
    this.sdkSessionProjects.set(sessionKey, runtime.projectRoot);
    return { changed: true };
  }

  async taskBudgetSnapshotForSdk(input: {
    sessionKey: string;
    projectKey?: string;
  }): Promise<{ totalUsd: number; spentUsd: number } | undefined> {
    const config = this.sdkSessionConfigs.get(input.sessionKey);
    const taskBudget = config?.taskBudget;
    const totalUsd = taskBudget?.total;
    if (totalUsd === undefined) return undefined;
    const runtime = this.resolve(input.projectKey ?? this.sdkSessionProjects.get(input.sessionKey));
    const scope = sdkTaskBudgetScope(taskBudget);
    await this.ensureTaskBudgetLedgerLoaded();
    const durableSpent = scope === "session"
      ? runtime.router.stats.sessionSnapshot(input.sessionKey)?.aggregate.totalCost ?? 0
      : 0;
    const ledger = this.sdkTaskBudgetLedgers.get(
      taskBudgetLedgerKey(runtime.projectRoot, scope, input.sessionKey),
    );
    const ledgerSpent = ledger?.spentUsd ?? 0;
    return {
      totalUsd: scope === "project" ? ledger?.totalUsd ?? totalUsd : totalUsd,
      spentUsd: Math.max(durableSpent, ledgerSpent),
    };
  }

  async recordTaskBudgetSpendForSdk(input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
    turnSpentUsd: number;
  }): Promise<void> {
    if (!Number.isFinite(input.turnSpentUsd) || input.turnSpentUsd < 0) return;
    const runtime = this.resolve(input.projectKey ?? this.sdkSessionProjects.get(input.sessionKey));
    const scope = sdkTaskBudgetScope(this.sdkSessionConfigs.get(input.sessionKey)?.taskBudget);
    await this.ensureTaskBudgetLedgerLoaded();
    const key = taskBudgetLedgerKey(runtime.projectRoot, scope, input.sessionKey);
    let ledger = this.sdkTaskBudgetLedgers.get(key);
    if (!ledger) {
      ledger = { spentUsd: 0, settledRunIds: new Set() };
      this.sdkTaskBudgetLedgers.set(key, ledger);
    }
    if (ledger.settledRunIds.has(input.runId)) return;
    ledger.settledRunIds.add(input.runId);
    ledger.spentUsd += input.turnSpentUsd;
    if (scope === "project" && ledger.projectRetentionMs !== undefined) {
      ledger.lastActivityAtMs = Date.now();
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
    taskBudget: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["taskBudget"],
  ): Promise<void> {
    if (!taskBudget || sdkTaskBudgetScope(taskBudget) !== "project") return;
    await this.ensureTaskBudgetLedgerLoaded();
    const key = taskBudgetLedgerKey(projectRoot, "project", sessionKey);
    let ledger = this.sdkTaskBudgetLedgers.get(key);
    if (ledger && this.expireProjectTaskBudgetLedgerIfInactive(key, ledger)) {
      ledger = undefined;
    }
    if (!ledger) {
      ledger = { spentUsd: 0, settledRunIds: new Set() };
      this.sdkTaskBudgetLedgers.set(key, ledger);
    }
    if (ledger.totalUsd !== undefined) {
      if (ledger.totalUsd !== taskBudget.total) {
        const hostCap = this.options.organizationPolicy?.limits?.maxTaskBudgetUsd;
        if (hostCap !== undefined && ledger.totalUsd > hostCap && taskBudget.total === hostCap) {
          // A newly imposed host policy may only lower an existing durable
          // project contract. Preserve the ledger ownership and retention
          // semantics instead of making the SDK client recreate it.
          ledger.totalUsd = hostCap;
          this.appendTaskBudgetLedgerRecord({
            version: 1,
            kind: "configured",
            projectRoot,
            sessionKey,
            scope: "project",
            totalUsd: hostCap,
            ...(ledger.projectRetentionMs !== undefined
              ? { projectRetentionMs: ledger.projectRetentionMs, lastActivityAtMs: ledger.lastActivityAtMs! }
              : {}),
          });
        } else {
          throw new DialogGatewayError(
            "SDK_PROJECT_TASK_BUDGET_TOTAL_CONFLICT",
            `Project taskBudget.total is fixed at $${ledger.totalUsd.toFixed(6)}; received $${taskBudget.total.toFixed(6)}.`,
          );
        }
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
    if (taskBudget.projectRetentionMs !== undefined) ledger.lastActivityAtMs = Date.now();
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

  /**
   * Retention is enforced before a native session is constructed. A new
   * configuration after the inactivity window starts a new durable budget
   * period; session budgets keep their existing deletion-driven lifetime.
   */
  private expireProjectTaskBudgetLedgerIfInactive(key: string, ledger: SdkTaskBudgetLedger): boolean {
    const retentionMs = ledger.projectRetentionMs;
    const lastActivityAtMs = ledger.lastActivityAtMs;
    if (retentionMs === undefined || lastActivityAtMs === undefined) return false;
    if (Date.now() - lastActivityAtMs < retentionMs) return false;
    const identity = taskBudgetLedgerIdentity(key);
    this.sdkTaskBudgetLedgers.delete(key);
    this.appendTaskBudgetLedgerRecord({
      version: 1,
      kind: "cleared",
      ...identity,
    });
    return true;
  }

  private async ensureTaskBudgetLedgerLoaded(): Promise<void> {
    if (this.taskBudgetLedgerLoad) return this.taskBudgetLedgerLoad;
    this.taskBudgetLedgerLoad = (async () => {
      const raw = await readFileAsync(this.taskBudgetLedgerPath(), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isSdkTaskBudgetLedgerRecord(record)) continue;
        this.taskBudgetLedgerRecordCount += 1;
        const scope = normalizeSdkTaskBudgetScope(record.scope);
        const key = taskBudgetLedgerKey(record.projectRoot, scope, record.sessionKey);
        if (record.kind === "cleared") {
          this.sdkTaskBudgetLedgers.delete(key);
          continue;
        }
        let ledger = this.sdkTaskBudgetLedgers.get(key);
        if (!ledger) {
          ledger = { spentUsd: 0, settledRunIds: new Set() };
          this.sdkTaskBudgetLedgers.set(key, ledger);
        }
        if (record.kind === "snapshot") {
          ledger.spentUsd = record.spentUsd;
          ledger.settledRunIds = new Set(record.settledRunIds);
          ledger.totalUsd = record.totalUsd;
          ledger.projectRetentionMs = record.projectRetentionMs;
          ledger.lastActivityAtMs = record.lastActivityAtMs;
          continue;
        }
        if (record.kind === "configured") {
          ledger.totalUsd ??= record.totalUsd;
          ledger.projectRetentionMs ??= record.projectRetentionMs;
          ledger.lastActivityAtMs ??= record.lastActivityAtMs;
          continue;
        }
        if (ledger.settledRunIds.has(record.runId)) continue;
        ledger.settledRunIds.add(record.runId);
        ledger.spentUsd += record.turnSpentUsd;
        if (record.lastActivityAtMs !== undefined) {
          ledger.lastActivityAtMs = Math.max(ledger.lastActivityAtMs ?? 0, record.lastActivityAtMs);
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
    mkdirSyncFs(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    this.taskBudgetLedgerRecordCount += 1;
    if (this.taskBudgetLedgerRecordCount >= this.taskBudgetLedgerCompactAfterRecords) {
      this.compactTaskBudgetLedger(filePath);
    }
  }

  /**
   * Rewrites the append-only journal as one exact snapshot per active ledger.
   * Run ids are deliberately retained so a retried terminal event remains
   * idempotent after a Gateway restart.
   */
  private compactTaskBudgetLedger(filePath: string): void {
    const snapshots = [...this.sdkTaskBudgetLedgers.entries()]
      .map(([key, ledger]) => {
        const identity = taskBudgetLedgerIdentity(key);
        return {
          version: 1 as const,
          kind: "snapshot" as const,
          ...identity,
          spentUsd: ledger.spentUsd,
          settledRunIds: [...ledger.settledRunIds].sort(),
          ...(ledger.totalUsd !== undefined ? { totalUsd: ledger.totalUsd } : {}),
          ...(ledger.projectRetentionMs !== undefined
            ? { projectRetentionMs: ledger.projectRetentionMs, lastActivityAtMs: ledger.lastActivityAtMs! }
            : {}),
        } satisfies SdkTaskBudgetLedgerRecord;
      })
      .sort((left, right) => {
        const leftKey = `${left.projectRoot}\u0000${left.scope}\u0000${left.sessionKey}`;
        const rightKey = `${right.projectRoot}\u0000${right.scope}\u0000${right.sessionKey}`;
        return leftKey.localeCompare(rightKey);
      });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, snapshots.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    renameSync(temporaryPath, filePath);
    this.taskBudgetLedgerRecordCount = snapshots.length;
  }

  private sdkSessionExtensionRuntime(
    sessionKey: string,
    runtime: ProjectRuntime,
  ): PluginRuntime | PluginRuntimeView {
    const plugins = this.sdkSessionPlugins.get(sessionKey);
    return plugins && plugins.length > 0
      ? runtime.pluginRuntime.createView(plugins)
      : runtime.pluginRuntime;
  }

  async outputStylesListForSdk(
    input: import("../gateway/protocol/types.js").GatewayOutputStylesListInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayOutputStylesListResult> {
    const runtime = this.resolve(input.projectKey);
    if (runtime.pluginRuntime.snapshot().length === 0) await runtime.pluginRuntime.refresh();
    const extensionRuntime = input.sessionKey
      ? this.sdkSessionExtensionRuntime(input.sessionKey, runtime)
      : runtime.pluginRuntime;
    const styles = extensionRuntime.listOutputStyles().map((style) => ({
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
    if (runtime.pluginRuntime.snapshot().length === 0) await runtime.pluginRuntime.refresh();
    const extensionRuntime = this.sdkSessionExtensionRuntime(input.sessionKey, runtime);
    if (input.name !== null && !extensionRuntime.getOutputStyle(input.name)) {
      throw new DialogGatewayError("OUTPUT_STYLE_NOT_FOUND", `Unknown output style: ${input.name}`);
    }
    const previous = this.sdkSessionConfigs.get(input.sessionKey) ?? {};
    const next = { ...previous, ...(input.name === null ? {} : { outputStyle: input.name }) };
    if (input.name === null) delete next.outputStyle;
    this.sdkSessionProjects.set(input.sessionKey, runtime.projectRoot);
    const changed = !sdkSessionConfigEquals(previous, next);
    if (changed) {
      this.sdkSessionConfigs.set(input.sessionKey, next);
      await this.gateway?.closeSession({ sessionKey: input.sessionKey, reason: "sdk_output_style_changed" });
    }
    return { applied: true, ...(input.name !== null ? { selected: input.name } : {}) };
  }

  async reloadOutputStylesForSdk(
    input: import("../gateway/protocol/types.js").GatewayReloadOutputStylesInput = {},
  ): Promise<import("../gateway/protocol/types.js").GatewayReloadOutputStylesResult> {
    const runtime = this.resolve(input.projectKey);
    const result = await runtime.pluginRuntime.reloadOutputStyles();
    for (const [sessionKey, projectKey] of this.sdkSessionProjects) {
      if (input.projectKey && projectKey !== runtime.projectRoot) continue;
      if (this.sdkSessionConfigs.has(sessionKey)) {
        await this.gateway?.closeSession({ sessionKey, reason: "sdk_output_styles_reloaded" });
      }
    }
    return { reloaded: true, changed: result.changed };
  }

  usageSnapshotForSdk(
    input: import("../gateway/protocol/types.js").GatewayUsageSnapshotInput,
  ): import("../gateway/protocol/types.js").GatewayUsageSnapshotResult {
    const runtime = this.resolve(input.projectKey);
    const session = input.sessionKey ? runtime.router.stats.sessionSnapshot(input.sessionKey) : undefined;
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
    const session = input.sessionKey ? runtime.router.stats.sessionSnapshot(input.sessionKey) : undefined;
    return {
      scope: session ? "session" : "project",
      ...(session ? { sessionId: session.sessionId } : {}),
      models: runtime.router.stats.modelUsageSnapshot(input.sessionKey).map((usage) => ({
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

  async rewindFilesForSdk(
    input: import("../gateway/protocol/types.js").GatewayRewindFilesInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayRewindFilesResult> {
    const history = this.sessionFileHistories.get(input.sessionKey)
      ?? await this.restoreFileHistoryForSdk(input);
    if (!history) {
      return {
        canRewind: false,
        error: "No persisted file checkpoint is available for this session.",
      };
    }
    try {
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
        return {
          canRewind: true,
          insertions: stats.insertions,
          deletions: stats.deletions,
        };
      }
      const result = await history.rewind(input.userMessageId);
      if (result.conflicts.length > 0) {
        return {
          canRewind: false,
          conflicts: result.conflicts,
          error: `Files changed outside PilotDeck since checkpoint: ${result.conflicts.join(", ")}`,
        };
      }
      return {
        canRewind: true,
        filesChanged: result.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        ...(result.missing.length > 0 ? { missing: result.missing } : {}),
      };
    } catch (error) {
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Rebuild the transient file-history index from the session transcript.
   *
   * The backups and snapshot records are durable session-owned data, while
   * `sessionFileHistories` is only a live Gateway cache.  Rehydrating here
   * lets an SDK rewind a completed session immediately after a Gateway
   * restart, without manufacturing an AgentSession or requiring a no-op turn.
   */
  private async restoreFileHistoryForSdk(
    input: import("../gateway/protocol/types.js").GatewayRewindFilesInput,
  ): Promise<FileHistoryStore | undefined> {
    const runtime = this.resolve(input.projectKey);
    const storage = this.createPersistentSessionStorage(
      runtime.projectRoot,
      input.sessionKey,
      this.options.now,
    );
    const transcript = await readAgentProjectSessionTranscript(storage);
    const snapshots = transcript.entries
      .filter((entry): entry is import("../session/index.js").AgentFileSnapshotRecordedTranscriptEntry =>
        entry.type === "file_snapshot_recorded",
      )
      .map((entry) => ({
        messageId: entry.messageId,
        trackedFileBackups: entry.trackedFileBackups,
        expectedFileStates: entry.expectedFileStates,
        timestamp: entry.snapshotTimestamp,
      }));
    if (snapshots.length === 0) return undefined;

    const history = new FileHistoryStore({
      backupDir: storage.fileHistoryDir,
      now: this.options.now,
      backupStorage: storage.fileHistoryBackupStorage,
    });
    history.replayFromTranscript(snapshots);
    this.sessionFileHistories.set(input.sessionKey, history);
    return history;
  }

  /** Stops only a task created by this SDK session in the current project runtime. */
  async stopBackgroundTaskForSdk(
    input: import("../gateway/protocol/types.js").GatewayStopBackgroundTaskInput,
  ): Promise<import("../gateway/protocol/types.js").GatewayStopBackgroundTaskResult> {
    const runtime = this.resolve(input.projectKey);
    const subagentTask = runtime.backgroundSubagents.get(input.taskId);
    if (subagentTask?.kind === "background" && subagentTask.sessionId === input.sessionKey) {
      const stopped = runtime.backgroundSubagents.stop(input.taskId);
      return { stopped, status: runtime.backgroundSubagents.get(input.taskId)?.status };
    }
    const task = runtime.backgroundTasks.get(input.taskId);
    if (!task || task.sessionId !== input.sessionKey) {
      throw new DialogGatewayError(
        "BACKGROUND_TASK_NOT_FOUND",
        `Background task ${input.taskId} is not owned by session ${input.sessionKey}.`,
      );
    }
    await runtime.backgroundTasks.stop(input.taskId);
    return { stopped: true, status: runtime.backgroundTasks.get(input.taskId)?.status };
  }

  /**
   * PilotDeck background tasks are detached when created. There is therefore
   * no native foreground task to transition through this Claude control
   * method; report that fact explicitly instead of stopping or cron-scheduling
   * unrelated work.
   */
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
    const running = runtime.backgroundTasks.list({ status: "running" })
      .filter((task) => task.sessionId === input.sessionKey);
    if (input.taskId && !running.some((task) => task.taskId === input.taskId)) {
      return { backgrounded: false, reason: "task_not_found" };
    }
    return running.length > 0
      ? { backgrounded: false, reason: "no_foreground_tasks" }
      : { backgrounded: false, reason: input.taskId ? "task_not_found" : "no_foreground_tasks" };
  }


  async createSession(context: GatewaySessionContext) {
    const prepared = await this.prepareSessionRuntime(context);
    if (this.isEphemeralSession(context.sessionKey)) {
      const storage = await this.getOrCreateEphemeralStorage(context.sessionKey);
      const extensionDependencies = await prepared.extendDependencies(storage, []);
      const { session } = createAgentSessionWithStorage({
        sessionId: context.sessionKey,
        config: this.createAgentConfig(prepared.runtime, context.sessionKey),
        dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
        storage,
        transcript: storage.transcript,
        sessionTitleGenerator: prepared.sessionTitleGenerator,
        promptSuggestionGenerator: this.sdkSessionConfigs.get(context.sessionKey)?.promptSuggestions === true
          ? prepared.promptSuggestionGenerator
          : undefined,
        collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
        __agentLoopFactory: this.options.agentLoopFactory,
      });
      return session;
    }
    const storage = this.createPersistentSessionStorage(
      prepared.runtime.projectRoot,
      context.sessionKey,
      prepared.baseDependencies.now,
    );
    const resumed = await resumeAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
      dependencies: prepared.baseDependencies,
      storage,
      extendDependencies: prepared.extendDependencies,
      sessionTitleGenerator: prepared.sessionTitleGenerator,
      promptSuggestionGenerator: this.sdkSessionConfigs.get(context.sessionKey)?.promptSuggestions === true
        ? prepared.promptSuggestionGenerator
        : undefined,
      collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
      __agentLoopFactory: this.options.agentLoopFactory,
    });
    return resumed.session;
  }

  async recreateSession(context: GatewaySessionContext, previousSession: AgentSession) {
    const prepared = await this.prepareSessionRuntime(context);
    const previous = previousSession.snapshotForRuntimeReload();
    if (this.isEphemeralSession(context.sessionKey)) {
      const storage = await this.getOrCreateEphemeralStorage(context.sessionKey);
      const extensionDependencies = await prepared.extendDependencies(storage, []);
      const { session } = createAgentSessionWithStorage({
        sessionId: context.sessionKey,
        config: this.createAgentConfig(prepared.runtime, context.sessionKey),
        dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
        storage,
        transcript: storage.transcript,
        initialState: previous.state,
        seedState: previous.fileState,
        initialMetadata: previous.metadata,
        sessionTitleGenerator: prepared.sessionTitleGenerator,
        promptSuggestionGenerator: this.sdkSessionConfigs.get(context.sessionKey)?.promptSuggestions === true
          ? prepared.promptSuggestionGenerator
          : undefined,
        collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
        __agentLoopFactory: this.options.agentLoopFactory,
      });
      return session;
    }
    const storage = this.createPersistentSessionStorage(
      prepared.runtime.projectRoot,
      context.sessionKey,
      prepared.baseDependencies.now,
    );
    if (previous.transcriptWriterState) {
      storage.transcript.restoreState(
        previous.transcriptWriterState.sequence,
        previous.transcriptWriterState.lastEntryId,
      );
    }
    const restoredEntries = (await readAgentProjectSessionTranscript(storage)).entries;
    const extensionDependencies = await prepared.extendDependencies(storage, restoredEntries);
    const { session } = createAgentSessionWithStorage({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(prepared.runtime, context.sessionKey),
      dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
      storage,
      transcript: storage.transcript,
      initialState: previous.state,
      seedState: previous.fileState,
      initialMetadata: previous.metadata,
      sessionTitleGenerator: prepared.sessionTitleGenerator,
      promptSuggestionGenerator: this.sdkSessionConfigs.get(context.sessionKey)?.promptSuggestions === true
        ? prepared.promptSuggestionGenerator
        : undefined,
      collectFileArtifacts: this.shouldCollectFileArtifacts(prepared.runtime),
      __agentLoopFactory: this.options.agentLoopFactory,
    });
    return session;
  }

  private shouldCollectFileArtifacts(runtime: ProjectRuntime): boolean {
    return resolve(runtime.projectRoot) !== resolve(this.options.pilotHome);
  }

  private async prepareSessionRuntime(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    await runtime.pluginRuntime.refresh();
    await this.ensureMcpReady(runtime);
    const extensionRuntime = this.sdkSessionExtensionRuntime(context.sessionKey, runtime);
    const contributions = extensionRuntime.snapshotContributions();
    const sdkConfig = this.sdkSessionConfigs.get(context.sessionKey);

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
          return {
            ...spec,
            cwd: outDir,
            args: buildBrowserUseArgs(spec.args ?? [], outDir, this.options.env, runtime.snapshot.config.proxy),
          };
        }
        return spec;
      });
      const sessionMcp = new McpRuntime(patchedPerSpecs);
      this.sessionMcpRuntimes.set(context.sessionKey, sessionMcp);
      try {
        const statuses = await sessionMcp.start();
        for (const status of statuses) {
          if (status.status === "error") {
            // eslint-disable-next-line no-console
            console.warn(
              `[pilotdeck] ${status.serverId === "funasr" ? "ASR unavailable" : "Per-session MCP unavailable"} ` +
              `(server=${status.serverId}, session=${context.sessionKey}): ${status.error ?? "unknown error"}`,
            );
          }
        }
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
        `Session ${context.sessionKey} will not start: ${perSpecs.map((spec) => spec.id).join(", ")}.`,
      );
    }

    // -- SDK-owned session MCP runtime ---------------------------------
    // The public SDK can replace only this collection. It is intentionally
    // not merged into plugin/config ownership and still produces ordinary
    // MCP ToolDefinitions consumed by the native registry and scheduler.
    const sdkMcp = await this.ensureSdkSessionMcpReady(context);
    if (sdkMcp) {
      try {
        const defs = await createMcpToolDefinitionsFromRuntime(sdkMcp);
        if (defs.length > 0) {
          if (sessionTools === runtime.tools) {
            sessionTools = runtime.tools.clone();
          }
          for (const def of defs) {
            if (sessionTools.has(def.name)) {
              sessionTools.replace(def);
            } else {
              sessionTools.register(def);
            }
          }
        }
      } catch (err) {
        // The McpRuntime keeps server-level connection errors in its status;
        // a failed SDK server must not prevent unrelated native tools running.
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] SDK MCP tool discovery failed for ${context.sessionKey}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Generic dialogs are Gateway-owned, SDK opt-in tools. Register them only
    // in explicitly configured sessions so ordinary AgentLoop schemas and
    // scheduling remain unchanged.
    const userDialogTools = [
      ...(sdkConfig?.userDialogKinds?.includes("input") ? [createRequestUserInputTool()] : []),
      ...(sdkConfig?.userDialogKinds?.includes("select") ? [createRequestUserChoiceTool()] : []),
      ...(sdkConfig?.userDialogKinds?.includes("confirm") ? [createRequestUserConfirmationTool()] : []),
      ...(sdkConfig?.userDialogKinds?.includes("form") ? [createRequestUserFormTool()] : []),
    ];
    if (userDialogTools.length > 0) {
      if (sessionTools === runtime.tools) sessionTools = runtime.tools.clone();
      for (const tool of userDialogTools) {
        if (sessionTools.has(tool.name)) {
          throw new DialogGatewayError(
            "SDK_USER_DIALOG_TOOL_CONFLICT",
            `${tool.name} is already owned by this session.`,
          );
        }
        sessionTools.register(tool);
      }
    }

    // A host sandbox is an execution boundary selected by name, never a
    // callback or executable supplied by the SDK. Keep the profile-specific
    // runner local to this AgentSession; normal sessions retain the shared
    // native Bash definition unchanged.
    const hostSandbox = sdkConfig?.sandbox?.type === "host"
      ? this.options.sandboxProfiles?.[sdkConfig.sandbox.profile]
      : undefined;
    if (sdkConfig?.sandbox?.type === "host" && sdkConfig.sandbox.process !== "deny") {
      if (!hostSandbox) {
        throw new DialogGatewayError(
          "SDK_SANDBOX_PROFILE_UNAVAILABLE",
          `Gateway host sandbox profile is unavailable: ${sdkConfig.sandbox.profile}`,
        );
      }
      const bash = sessionTools.get("bash");
      if (!bash || bash.kind !== "shell") {
        throw new DialogGatewayError(
          "SDK_SANDBOX_BASH_UNAVAILABLE",
          "A host sandbox requires the native bash tool to be available.",
        );
      }
      if (sessionTools === runtime.tools) sessionTools = runtime.tools.clone();
      const override = this._sessionOverrides?.get(context.sessionKey);
      const cwd = override?.cwd ?? runtime.projectRoot;
      const runner = await hostSandbox.createCommandRunner({
        profile: sdkConfig.sandbox.profile,
        sessionKey: context.sessionKey,
        projectRoot: runtime.projectRoot,
        cwd,
        sandbox: sdkConfig.sandbox,
      });
      if (!runner || typeof runner.run !== "function") {
        throw new DialogGatewayError(
          "SDK_SANDBOX_PROFILE_INVALID",
          `Gateway host sandbox profile ${sdkConfig.sandbox.profile} did not return a command runner.`,
        );
      }
      sessionTools.replace(createBashTool({ runner }));
      // execute_code normally starts Python directly and therefore is an
      // uncontrolled process bridge. A host profile may opt in to running it
      // through the exact runner it owns, but never while helper RPC calls
      // could bypass a filesystem/network restriction. Strict isolation is
      // allowed only after the profile explicitly opts in; that path creates
      // an execute_code module with no Gateway helpers at all.
      if (hostProfileRunsExecuteCode(sdkConfig.sandbox, hostSandbox)) {
        const executeCode = sessionTools.get("execute_code");
        if (executeCode) {
          sessionTools.replace(createExecuteCodeTool({
            runner,
            allowedTools: hostSandboxExecuteCodeAllowedTools(sdkConfig.sandbox, sessionTools.has("web_search")),
          }));
        }
      }
    }

    // A JSON-schema output option is scoped to the existing structured_output
    // tool. ToolRuntime continues to validate and execute it normally; this
    // adapter only narrows the tool's `value` schema for this SDK session.
    const outputFormat = this.sdkSessionConfigs.get(context.sessionKey)?.outputFormat;
    if (outputFormat) {
      const structuredOutput = sessionTools.get("structured_output");
      if (!structuredOutput) {
        throw new DialogGatewayError(
          "CAPABILITY_UNAVAILABLE",
          "structured_output is unavailable for this SDK session.",
        );
      }
      if (sessionTools === runtime.tools) {
        sessionTools = runtime.tools.clone();
      }
      sessionTools.replace({
        ...structuredOutput,
        inputSchema: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: {
            value: outputFormat.schema as import("../tool/protocol/schema.js").PilotDeckJsonSchema,
          },
        },
      });
    }

    // SDK skill scoping is a projection over the existing project runtime.
    // It neither reloads nor mutates PluginRuntime; the selected names were
    // resolved by the Gateway before this native session was created.
    const selectedSkills = this.sdkSessionConfigs.get(context.sessionKey)?.skills;
    if (Array.isArray(selectedSkills)) {
      const selectedSkillNames = new Set(selectedSkills);
      const readSkill = sessionTools.get("read_skill");
      if (!readSkill) {
        throw new DialogGatewayError(
          "CAPABILITY_UNAVAILABLE",
          "read_skill is unavailable for this SDK skill-scoped session.",
        );
      }
      if (sessionTools === runtime.tools) {
        sessionTools = runtime.tools.clone();
      }
      sessionTools.replace(createReadSkillTool({
        loader: async (name) => selectedSkillNames.has(name)
          ? extensionRuntime.loadSkillPrompt(name)
          : undefined,
        lister: () => extensionRuntime.getAllSkills()
          .filter((skill) => selectedSkillNames.has(skill.name)),
      }));
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

    // Gateway-owned model-visible tool policies are not a claim of OS
    // isolation. They run after all session-local contributions are known so
    // neither SDK MCP/plugin tools nor a custom tool can bypass either host
    // organization policy or a session-local sandbox restriction.
    const organizationHiddenTools = organizationHiddenToolNames(
      this.options.organizationPolicy,
      sessionTools.list(),
    );
    const managedHiddenTools = managedHiddenToolNames(
      sdkConfig?.managedTools,
      sessionTools.list(),
    );
    const sandboxHiddenTools = sandboxHiddenToolNames(sdkConfig?.sandbox, sessionTools.list(), hostSandbox);
    const hiddenTools = new Set([...organizationHiddenTools, ...managedHiddenTools, ...sandboxHiddenTools]);
    if (hiddenTools.size > 0) {
      if (sessionTools === runtime.tools) sessionTools = runtime.tools.clone();
      for (const name of hiddenTools) sessionTools.unregister(name);
    }

    const availability = await filterAvailableTools(sessionTools, {
      cwd: runtime.projectRoot,
      env: this.options.env,
    });
    sessionTools = availability.registry;
    // `allowedTools` and `disallowedTools` are a per-turn model-visible
    // restriction. Account for them while constructing the deferred catalog,
    // rather than adding a search entry that could only reveal a target which
    // the same turn control will remove later.
    const explicitlyHiddenTools = explicitHiddenToolNames(context, sessionTools.list());
    const deferredBlockedTools = new Set([...hiddenTools, ...explicitlyHiddenTools]);
    const canExposeDeferredSearch = !explicitlyHiddenTools.has("search_tools");
    const deferredSdkTools = mergeDeferredToolSearchEntries(
      deferredSdkNativeToolEntries(sdkConfig?.deferredTools, sessionTools, deferredBlockedTools),
      deferredSdkMcpToolEntries(
        this.sdkSessionMcpServers.get(context.sessionKey),
        sessionTools,
        deferredBlockedTools,
      ),
    );
    if (deferredSdkTools.length > 0) {
      for (const tool of deferredSdkTools) sessionTools.hide(tool.name);
      // An explicit deny of search_tools must not turn a deferred target into
      // an eager schema. Keep the target hidden; it simply cannot be loaded
      // for that turn.
      if (canExposeDeferredSearch) {
        if (sessionTools.has("search_tools")) {
        throw new DialogGatewayError(
          "SDK_DEFERRED_TOOL_SEARCH_CONFLICT",
          "Deferred SDK tools cannot use search_tools because that name is already owned by this session.",
        );
        }
        sessionTools.register(createDeferredToolSearchTool({
          registry: sessionTools,
          tools: deferredSdkTools,
        }));

        // `search_tools` is registered after the initial policy pass. Apply
        // the same model-visible restrictions a second time so a host deny
        // selector cannot be bypassed through this late SDK contribution.
        const lateOrganizationHiddenTools = organizationHiddenToolNames(
          this.options.organizationPolicy,
          sessionTools.list(),
        );
        const lateManagedHiddenTools = managedHiddenToolNames(
          sdkConfig?.managedTools,
          sessionTools.list(),
        );
        const lateSandboxHiddenTools = sandboxHiddenToolNames(sdkConfig?.sandbox, sessionTools.list(), hostSandbox);
        for (const name of new Set([...lateOrganizationHiddenTools, ...lateManagedHiddenTools, ...lateSandboxHiddenTools])) {
          sessionTools.unregister(name);
        }
      }
    }
    // An explicit empty allow-list means "expose no tools".  Undefined still
    // preserves the native tool surface for non-SDK callers.
    if (context.allowedTools !== undefined || context.disallowedTools !== undefined) {
      const allowed = new Set(context.allowedTools ?? []);
      const denied = new Set(context.disallowedTools ?? []);
      // filterAvailableTools() above creates a fresh session-local registry.
      // Do not clone after search_tools captured this registry for reveal:
      // otherwise the catalog would reveal a discarded copy while the native
      // scheduler keeps using the clone.
      for (const tool of sessionTools.list()) {
        if ((context.allowedTools !== undefined && !allowed.has(tool.name)) || denied.has(tool.name)) {
          sessionTools.unregister(tool.name);
        }
      }
    }
    runtime.unavailableTools = availability.unavailable;

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
    const sdkHookSettings = createSdkHookSettings(sdkConfig?.hooks);
    // ConfigChange originates in the Gateway config store, not AgentLoop.
    // Keep it out of the ordinary runtime to avoid accidental duplicate
    // dispatch should a future AgentLoop caller use dispatchHookForSession.
    const { ConfigChange: sdkConfigChangeHooks, ...sdkAgentLoopHookSettings } = sdkHookSettings;
    const hookSettings: typeof contributions.hooks = gw
      ? {
          ...contributions.hooks,
          ...mergeHookSettings(contributions.hooks, sdkAgentLoopHookSettings),
          PermissionRequest: [
            ...(contributions.hooks.PermissionRequest ?? []),
            ...(sdkAgentLoopHookSettings.PermissionRequest ?? []),
            {
              hooks: [
                { type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME },
              ],
            },
          ],
        }
      : mergeHookSettings(contributions.hooks, sdkAgentLoopHookSettings);
    const hookEventBus = sdkConfig?.includeHookEvents === true
      ? new HookExecutionEventBus()
      : undefined;
    const hookRuntime = new HookRuntime(
      hookSettings,
      undefined,
      hookEventBus,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (registration) => {
        if (!gw || !sdkConfig?.hooks) return;
        gw.registerAsyncHook({
          sessionKey: context.sessionKey,
          hookName: registration.hookName,
          hookEvent: registration.hookEvent,
          invocationId: registration.invocationId,
          ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
          includeHookEvents: sdkConfig.includeHookEvents === true,
        });
      },
    );
    if (hookEventBus && gw) {
      hookEventBus.subscribe((event) => {
        if (event.type === "started") {
          gw.emitForSession(context.sessionKey, {
            type: "hook_started",
            hookName: event.hookName,
            hookEvent: event.hookEvent,
          });
        } else {
          gw.emitForSession(context.sessionKey, {
            type: "hook_response",
            hookName: event.hookName,
            hookEvent: event.hookEvent,
            stdout: event.stdout,
            stderr: event.stderr,
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            outcome: event.outcome,
            ...(event.asyncInvocationId ? { asyncInvocationId: event.asyncInvocationId } : {}),
            ...(event.asyncTimeoutMs !== undefined ? { asyncTimeoutMs: event.asyncTimeoutMs } : {}),
          });
        }
      });
    }
    // FileChanged is a post-write notification. Keep it in a separate SDK-only
    // runtime: legacy project hooks have never received this event, so an SDK
    // opt-in must not activate or change their behavior.
    const sdkFileChangedLifecycle = sdkHookSettings.FileChanged?.length
      ? new LifecycleRuntime(new HookRuntime(
        { FileChanged: sdkHookSettings.FileChanged },
        undefined,
        hookEventBus,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (registration) => {
          if (!gw || !sdkConfig?.hooks) return;
          gw.registerAsyncHook({
            sessionKey: context.sessionKey,
            hookName: registration.hookName,
            hookEvent: registration.hookEvent,
            invocationId: registration.invocationId,
            ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
            includeHookEvents: sdkConfig.includeHookEvents === true,
          });
        },
      ))
      : undefined;
    // Config reload belongs to the Gateway config store. It is opt-in and
    // deliberately isolated from project hooks and AgentLoop effects. Do not
    // register deferred results: ConfigChange has no active-turn ownership.
    const sdkConfigChangeLifecycle = sdkConfigChangeHooks?.length
      ? new LifecycleRuntime(new HookRuntime(
        { ConfigChange: sdkConfigChangeHooks },
        undefined,
        hookEventBus,
      ))
      : undefined;
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
    this.sessionLifecycles.set(context.sessionKey, {
      lifecycle,
      sdkConfigChangeLifecycle,
      cwd: runtime.projectRoot,
    });
    const extension = createSdkSessionExtensionResolver(
      extensionRuntime,
      sdkConfig?.skills,
    );
    const projectRoot = runtime.projectRoot;
    const memoryResolver = runtime.memory;
    const now = this.options.now;
    const eventBuf = createAgentEventBuffer();
    const filterSubagentToolRegistry = (
      _definition: import("../agent/sub/builtinSubagentTypes.js").SubagentDefinition,
      registry: ToolRegistry,
    ) => {
      // AgentDefinition MCP tools are attached after the child inherited the
      // parent registry. Reapply the same host/session restrictions here so
      // an SDK-defined fork cannot reintroduce a denied tool surface.
      const organizationHiddenTools = organizationHiddenToolNames(
        this.options.organizationPolicy,
        registry.list(),
      );
      const managedHiddenTools = managedHiddenToolNames(
        sdkConfig?.managedTools,
        registry.list(),
      );
      const sandboxHiddenTools = sandboxHiddenToolNames(sdkConfig?.sandbox, registry.list(), hostSandbox);
      const hiddenTools = new Set([...organizationHiddenTools, ...managedHiddenTools, ...sandboxHiddenTools]);
      // Session-level allow/deny controls already shape the parent registry.
      // Dynamic AgentDefinition MCP arrives later, so it must be constrained
      // here before the child scheduler sees it.
      if (context.allowedTools !== undefined || context.disallowedTools !== undefined) {
        const allowed = new Set(context.allowedTools ?? []);
        const denied = new Set(context.disallowedTools ?? []);
        for (const tool of registry.list()) {
          if ((context.allowedTools !== undefined && !allowed.has(tool.name)) || denied.has(tool.name)) {
            hiddenTools.add(tool.name);
          }
        }
      }
      if (hiddenTools.size === 0) return undefined;
      const filtered = registry.clone();
      for (const name of hiddenTools) filtered.unregister(name);
      return filtered;
    };

    const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
      router: runtime.router,
      tools: { registry: sessionTools },
      lifecycle,
      now: this.options.now,
      eventEmitter: eventBuf.emitter,
      drainEvents: eventBuf.drain,
      filterSubagentToolRegistry,
      tokenAccounting: runtime.tokenAccounting,
      getModelMaxContextTokens: (provider, model) => capOrganizationTokenLimit(
        resolveRoutedModelMaxContextTokens({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
          agentMaxContextTokens: runtime.snapshot.config.agent.maxContextTokens,
          provider,
          model,
        }),
        this.options.organizationPolicy?.settings?.maxContextTokens,
      ),
      getModelMaxOutputTokens: (provider, model) => {
        try {
          return capOrganizationTokenLimit(
            runtime.model.getCapabilities(provider, model).maxOutputTokens,
            this.options.organizationPolicy?.settings?.maxOutputTokens,
          );
        } catch {
          return capOrganizationTokenLimit(
            undefined,
            this.options.organizationPolicy?.settings?.maxOutputTokens,
          );
        }
      },
      getModelTokenLimits: (provider, model) => {
        try {
          const caps = runtime.model.getCapabilities(provider, model);
          return {
            maxContextTokens: capOrganizationTokenLimit(
              caps.maxContextTokens,
              this.options.organizationPolicy?.settings?.maxContextTokens,
            ) ?? caps.maxContextTokens,
            maxOutputTokens: capOrganizationTokenLimit(
              caps.maxOutputTokens,
              this.options.organizationPolicy?.settings?.maxOutputTokens,
            ),
          };
        } catch {
          const maxContextTokens = this.options.organizationPolicy?.settings?.maxContextTokens;
          const maxOutputTokens = this.options.organizationPolicy?.settings?.maxOutputTokens;
          return maxContextTokens === undefined
            ? undefined
            : { maxContextTokens, maxOutputTokens };
        }
      },
      getModelProtocol: (provider) => runtime.model.getProviderProtocol(provider),
      getModelSupportsPromptCache: (provider, model) => {
        try {
          return runtime.model.getCapabilities(provider, model).supportsPromptCache;
        } catch {
          return undefined;
        }
      },
    };
    // These optional post-turn helpers call ModelRuntime.complete directly,
    // unlike AgentLoop/compaction which traverse RouterRuntime. Do not let an
    // auxiliary title or suggestion request bypass a host or SDK model
    // policy; omitting the helper retains the established best-effort behavior.
    const auxiliaryModelAllowed = isOrganizationModelAllowed(
      this.options.organizationPolicy,
      runtime.snapshot.config.agent.model.provider,
      runtime.snapshot.config.agent.model.model,
    ) && isOrganizationProviderAllowed(
      this.options.organizationPolicy,
      runtime.snapshot.config.agent.model.provider,
      runtime.snapshot.config.model.providers[runtime.snapshot.config.agent.model.provider],
    ) && isManagedModelAllowed(
      this.sdkSessionConfigs.get(context.sessionKey)?.managedModels,
      runtime.snapshot.config.agent.model.provider,
      runtime.snapshot.config.agent.model.model,
    );
    const sessionTitleGenerator = auxiliaryModelAllowed
      ? createSessionTitleGenerator({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
        })
      : undefined;
    const promptSuggestionGenerator = auxiliaryModelAllowed
      ? createPromptSuggestionGenerator({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
        })
      : undefined;
    const extendDependencies = async (
      storage: AgentProjectSessionStorage,
      transcriptEntries: import("../session/index.js").AgentTranscriptEntry[] = [],
    ) => {
      const toolResultBudget = new ToolResultBudget({
        toolResultsDir: storage.toolResultsDir,
        artifactStorage: storage.toolResultArtifactStorage,
      });
      await toolResultBudget.hydrateReferences(transcriptEntries.flatMap((entry) => {
        if (entry.type === "accepted_input") return entry.messages;
        if (
          entry.type === "assistant_message"
          || entry.type === "tool_result_message"
          || entry.type === "durable_message"
        ) {
          return [entry.message];
        }
        return [];
      }));
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
        tokenAccounting: runtime.tokenAccounting,
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
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
        now,
        eventEmitter: eventBuf.emitter,
      });
      const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
      const microCompaction = new MicroCompactionEngine({
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      });
      const snipEngine = new SnipEngine({
        protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      });
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
        microCompaction,
        snipEngine,
        overflowRecovery,
        maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
        now,
      });
      const createSubagentContext = (
        definition: import("../agent/sub/builtinSubagentTypes.js").SubagentDefinition,
      ) => {
        // The default remains the existing shared context runtime. A separate
        // projection is constructed only for an SDK AgentDefinition scope.
        if (definition.memory !== "disabled" && definition.skills === undefined) return undefined;
        return new DefaultContextRuntime({
          extension: createSdkSessionExtensionResolver(extensionRuntime, definition.skills),
          includeExtensionsWithCustomSystemPrompt: true,
          projectRoot,
          memoryResolver: definition.memory === "disabled" ? undefined : memoryResolver,
          memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
          instructionDiscovery,
          toolResultBudget,
          tokenBudget,
          compactionEngine,
          autoCompactionPolicy,
          microCompaction,
          snipEngine,
          overflowRecovery,
          maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
          now,
        });
      };
      const createSubagentToolRegistry = (
        definition: import("../agent/sub/builtinSubagentTypes.js").SubagentDefinition,
        registry: ToolRegistry,
      ) => {
        if (!Array.isArray(definition.skills)) return undefined;
        const selectedSkillNames = new Set(definition.skills);
        const readSkill = registry.get("read_skill");
        if (!readSkill) return registry;
        const scoped = registry.clone();
        scoped.replace(createReadSkillTool({
          loader: async (name) => selectedSkillNames.has(name)
            ? extensionRuntime.loadSkillPrompt(name)
            : undefined,
          lister: () => extensionRuntime.getAllSkills()
            .filter((skill) => selectedSkillNames.has(skill.name)),
        }));
        return scoped;
      };
      const fileHistory = new FileHistoryStore({
        backupDir: storage.fileHistoryDir,
        now: this.options.now,
        backupStorage: storage.fileHistoryBackupStorage,
        onSnapshotRecorded: (snapshot) => storage.transcript.recordFileSnapshot?.(
          context.sessionKey,
          snapshot.messageId,
          {
            messageId: snapshot.messageId,
            trackedFileBackups: snapshot.trackedFileBackups,
            expectedFileStates: snapshot.expectedFileStates,
            snapshotTimestamp: snapshot.timestamp,
          },
        ),
      });
      fileHistory.replayFromTranscript(
        transcriptEntries
          .filter((entry): entry is import("../session/index.js").AgentFileSnapshotRecordedTranscriptEntry => entry.type === "file_snapshot_recorded")
          .map((entry) => ({
            messageId: entry.messageId,
            trackedFileBackups: entry.trackedFileBackups,
            expectedFileStates: entry.expectedFileStates,
            timestamp: entry.snapshotTimestamp,
          })),
      );
      this.sessionFileHistories.set(context.sessionKey, fileHistory);
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
      const userDialog = sdkConfig?.userDialogKinds?.length && gw
        ? new GatewayUserDialogChannel({
            sessionKey: context.sessionKey,
            bus: gw.getUserDialogBus(),
            emit: (event) => gw.emitForSession(context.sessionKey, event),
            journal: createGatewayUserDialogJournal(storage),
            ...(this.options.userDialogStore ? {
              store: this.options.userDialogStore,
              storeKey: this.userDialogStoreKey(projectRoot, context.sessionKey),
              ...(hasLiveUserDialogStore(this.options.userDialogStore) ? {
                takeStoredAnswer: (requestId: string) => this.options.userDialogStore!.takeLiveAnswer!(
                  this.userDialogStoreKey(projectRoot, context.sessionKey),
                  requestId,
                ),
              } : {}),
              ...(hasLiveUserDialogOwnerStore(this.options.userDialogStore) ? {
                claimStoredOwner: async (requestId: string, ownerId: string) => {
                  const claim = await this.options.userDialogStore!.claimLiveOwner!(
                    this.userDialogStoreKey(projectRoot, context.sessionKey),
                    { requestId, ownerId, ttlMs: HOSTED_USER_DIALOG_OWNER_TTL_MS },
                  );
                  return claim.owned;
                },
                renewStoredOwner: (requestId: string, ownerId: string) => this.options.userDialogStore!.renewLiveOwner!(
                  this.userDialogStoreKey(projectRoot, context.sessionKey),
                  { requestId, ownerId, ttlMs: HOSTED_USER_DIALOG_OWNER_TTL_MS },
                ),
                releaseStoredOwner: (requestId: string, ownerId: string) => this.options.userDialogStore!.releaseLiveOwner!(
                  this.userDialogStoreKey(projectRoot, context.sessionKey),
                  { requestId, ownerId },
                ),
              } : {}),
            } : {}),
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
      const fileUpdateNotifier = sdkFileChangedLifecycle ? {
        didSave: async (update: PilotDeckFileUpdateNotification): Promise<void> => {
          // The write has already succeeded. FileChanged is observational and
          // cannot block or roll back the native file operation.
          await sdkFileChangedLifecycle.dispatch({
            event: "FileChanged",
            baseInput: {
              sessionId: context.sessionKey,
              transcriptPath: "",
              cwd: projectRoot,
            },
            payload: {
              filePath: update.relativePath,
              absolutePath: update.absolutePath,
              root: update.root,
              changeType: update.previousContent === null ? "created" : "updated",
            },
            matchQuery: update.relativePath,
          }).catch(() => {});
        },
      } : undefined;
      return {
        context: contextRuntime,
        createSubagentContext,
        createSubagentToolRegistry,
        backgroundSubagents: {
          launch: (input: {
            sessionId: string;
            turnId: string;
            subagentId: string;
            subagentType: string;
            run(signal: AbortSignal): Promise<unknown>;
          }) => runtime.backgroundSubagents.start({
            kind: "background",
            sessionId: input.sessionId,
            parentTurnId: input.turnId,
            subagentId: input.subagentId,
            subagentType: input.subagentType,
            run: input.run,
          }),
        },
        observerSubagents: {
          launch: (input: {
            sessionId: string;
            turnId: string;
            observedSubagentId: string;
            observerSubagentId: string;
            observerSubagentType: string;
            run(signal: AbortSignal): Promise<unknown>;
          }) => {
            runtime.backgroundSubagents.start({
              kind: "observer",
              sessionId: input.sessionId,
              parentTurnId: input.turnId,
              subagentId: input.observerSubagentId,
              subagentType: input.observerSubagentType,
              observedSubagentId: input.observedSubagentId,
              run: input.run,
            });
          },
        },
        fileHistory,
        fileUpdateNotifier,
        subagentTranscript,
        elicitation,
        userDialog,
        planFileManager,
        planTodoManager,
      };
    };
    return {
      runtime,
      baseDependencies,
      sessionTitleGenerator,
      promptSuggestionGenerator,
      extendDependencies,
    };
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const runtime = this.resolve(input.projectKey);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const sessions = this.options.nativeSessionStorage?.listSessions
      ? await this.options.nativeSessionStorage.listSessions({
          projectRoot: runtime.projectRoot,
          pilotHome: this.options.pilotHome,
          limit: input.limit,
          offset: safeOffset,
        })
      : await listProjectSessions({
          ...runtime.projectStorage,
          chatDir: resolveGatewayNativeProjectChatDir({
            projectRoot: runtime.projectRoot,
            pilotHome: this.options.pilotHome,
          }, this.options.nativeSessionStorage),
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
    const sdkConfig = this.sdkSessionConfigs.get(sessionKey);
    const organizationSettings = this.options.organizationPolicy?.settings;
    const sessionSettings = sdkConfig && (
      sdkConfig.settings
      || sdkConfig.settingSources
      || organizationSettings?.sessionDefaults
      || organizationSettings?.managedSessionSettings
      || organizationSettings?.sessionDefaultSources
      || organizationSettings?.enforcedSessionSettings
    )
      ? resolveSdkSessionSettings(
          runtime.projectRoot,
          this.options.env,
          sdkConfig,
          organizationSettings?.sessionDefaults,
          organizationSettings?.managedSessionSettings,
          organizationSettings?.sessionDefaultSources,
          organizationSettings?.enforcedSessionSettings,
        )
      : undefined;
    const sessionModel = sessionSettings?.agent?.model;
    const effectiveModel = sessionModel === undefined || sessionModel === null
      ? agent.model
      : resolveSdkSessionAgentModel(sessionModel, runtime.projectRoot, this.options.env);
    const hostEnforcedFallback = organizationSettings?.enforcedSessionSettings?.agent?.fallbackModel;
    const configuredFallbackModel = hostEnforcedFallback !== undefined
      ? (hostEnforcedFallback ?? undefined)
      : (sdkConfig?.fallbackModel
        ?? (sessionSettings?.agent?.fallbackModel === null
          ? undefined
          : sessionSettings?.agent?.fallbackModel));
    const sessionSubagents = sessionSettings?.agent?.subagents;
    const hasSessionSubagentDefault = sessionSubagents !== undefined
      && Object.prototype.hasOwnProperty.call(sessionSubagents, "default");
    let effectiveSubagents = agent.subagents ? { ...agent.subagents } : undefined;
    if (sessionSubagents !== undefined) {
      effectiveSubagents ??= {};
      if (hasSessionSubagentDefault) {
        if (sessionSubagents.default === null) delete effectiveSubagents.default;
        else if (sessionSubagents.default !== undefined) {
          effectiveSubagents.default = resolveSdkSessionSubagentModel(
            sessionSubagents.default,
            runtime.projectRoot,
            this.options.env,
          );
        }
      }
      if (sessionSubagents.timeoutMs !== undefined) {
        effectiveSubagents.timeoutMs = sessionSubagents.timeoutMs;
      }
    }
    const effectiveAgent = {
      ...agent,
      model: effectiveModel,
      ...(sessionSettings?.agent?.maxContextTokens !== undefined
        ? { maxContextTokens: sessionSettings.agent.maxContextTokens }
        : {}),
      ...(sessionSettings?.agent?.maxOutputTokens !== undefined
        ? { maxOutputTokens: sessionSettings.agent.maxOutputTokens }
        : {}),
      ...(sessionSettings?.agent?.thinking !== undefined
        ? { thinking: sessionSettings.agent.thinking }
        : {}),
      ...(effectiveSubagents ? { subagents: effectiveSubagents } : {}),
    };
    this.assertOrganizationModelAllowed(runtime.projectRoot, effectiveAgent.model.provider, effectiveAgent.model.model);
    // A Gateway session is constructed before submit_turn resolves a
    // per-turn model override. Do not reject the project default here: an
    // allowed explicit turn model must be able to run even when the default
    // falls outside the SDK's restrictive policy. RouterRuntime enforces the
    // policy immediately before every actual provider request, including the
    // un-overridden default path.
    const organizationPermissions = this.options.organizationPolicy?.permissions;
    // Host policy is evaluated before a session's SDK policy or any mutable
    // session override. The SDK can only add restrictions below this tier.
    const permissionMode = organizationPermissions?.defaultMode
      ?? sdkConfig?.managedPermissions?.defaultMode
      ?? override?.permissionMode
      ?? this.options.permissionMode;
    const cwd = override?.cwd ?? runtime.projectRoot;
    // Hand `PermissionContext` the same live rule-set reference the
    // gateway permission hook owns (see `getLiveRuleSet`). With this
    // shared reference, an "allow + remember" decision pushed by the
    // hook is visible to `PermissionRuntime.decide` on the very next
    // tool call inside the same turn — no roundtrip back to the client
    // needed, even when the client lives in a different process.
    const liveRuleSet = this.getLiveRuleSet(sessionKey);
    const organizationRules = toManagedPermissionRules(organizationPermissions);
    const managedRules = toManagedPermissionRules(sdkConfig?.managedPermissions);
    const resolvedFallbackModel = configuredFallbackModel
      ? resolveSdkFallbackModel(configuredFallbackModel, runtime.projectRoot, this.options.env)
      : undefined;
    if (resolvedFallbackModel) {
      this.assertOrganizationModelAllowed(runtime.projectRoot, resolvedFallbackModel.provider, resolvedFallbackModel.model);
      assertManagedModelAllowed(sdkConfig?.managedModels, resolvedFallbackModel.provider, resolvedFallbackModel.model);
    }
    let modelMultimodal: import("../model/index.js").MultimodalConstraints | undefined;
    try {
      modelMultimodal = runtime.model.getMultimodal(effectiveAgent.model.provider, effectiveAgent.model.model);
    } catch {
      // Model or provider not found — fall back to text-only.
    }
    let maxContextTokens: number | undefined;
    let maxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(effectiveAgent.model.provider, effectiveAgent.model.model);
      maxContextTokens = effectiveAgent.maxContextTokens ?? caps.maxContextTokens;
      maxOutputTokens = caps.maxOutputTokens;
    } catch {
      maxContextTokens = effectiveAgent.maxContextTokens;
    }
    maxOutputTokens = readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
      ?? effectiveAgent.maxOutputTokens
      ?? maxOutputTokens;
    maxContextTokens = capOrganizationTokenLimit(maxContextTokens, organizationSettings?.maxContextTokens);
    maxOutputTokens = capOrganizationTokenLimit(maxOutputTokens, organizationSettings?.maxOutputTokens);
    const subagentModel = effectiveAgent.subagents?.default;
    let subagentRuntimeModel: CreateAgentSessionOptions["config"]["subagentModel"];
    if (subagentModel) {
      this.assertOrganizationModelAllowed(runtime.projectRoot, subagentModel.provider, subagentModel.model);
      assertManagedModelAllowed(sdkConfig?.managedModels, subagentModel.provider, subagentModel.model);
      let subagentModelMultimodal: import("../model/index.js").MultimodalConstraints | undefined;
      try {
        subagentModelMultimodal = runtime.model.getMultimodal(
          subagentModel.provider,
          subagentModel.model,
        );
      } catch {
        // Model or provider not found — keep the override but fall back to inherited caps.
      }
      let subagentMaxContextTokens: number | undefined;
      let subagentMaxOutputTokens: number | undefined;
      try {
        const caps = runtime.model.getCapabilities(subagentModel.provider, subagentModel.model);
        subagentMaxContextTokens = caps.maxContextTokens;
        subagentMaxOutputTokens = caps.maxOutputTokens;
      } catch {
        // Keep the override even if capability lookup fails.
      }
      subagentRuntimeModel = {
        provider: subagentModel.provider,
        model: subagentModel.model,
        ...(subagentModelMultimodal ? { modelMultimodal: subagentModelMultimodal } : {}),
        ...(capOrganizationTokenLimit(
          subagentMaxContextTokens,
          organizationSettings?.maxContextTokens,
        ) !== undefined ? {
          maxContextTokens: capOrganizationTokenLimit(
            subagentMaxContextTokens,
            organizationSettings?.maxContextTokens,
          ),
        } : {}),
        ...(capOrganizationTokenLimit(
          subagentMaxOutputTokens === undefined
            ? undefined
            : readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
              ?? subagentMaxOutputTokens,
          organizationSettings?.maxOutputTokens,
        ) !== undefined
          ? {
              maxOutputTokens: capOrganizationTokenLimit(
                subagentMaxOutputTokens === undefined
                  ? undefined
                  : readPositiveIntegerEnv(this.options.env.PILOTDECK_MAX_OUTPUT_TOKENS)
                    ?? subagentMaxOutputTokens,
                organizationSettings?.maxOutputTokens,
              ),
            }
          : {}),
      };
    }
    const selectedOutputStyle = sdkConfig?.outputStyle
      ? this.sdkSessionExtensionRuntime(sessionKey, runtime).getOutputStyle(sdkConfig.outputStyle)
      : undefined;
    const styleAppend = selectedOutputStyle?.content?.trim();
    const appendSystemPrompt = [sdkConfig?.appendSystemPrompt, styleAppend]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join("\n\n");
    return {
      provider: effectiveAgent.model.provider,
      model: effectiveAgent.model.model,
      ...(sdkConfig?.managedModels ? {
        managedModelPolicy: {
          allow: [...sdkConfig.managedModels.allow],
          deny: [...sdkConfig.managedModels.deny],
        },
      } : {}),
      ...(resolvedFallbackModel ? {
        fallbackModels: [resolvedFallbackModel],
      } : {}),
      ...(sdkConfig?.agentProgressSummaries === true ? { includeToolProgress: true } : {}),
      modelMultimodal,
      cwd,
      permissionMode,
      ...(sdkConfig?.systemPrompt !== undefined ? { systemPrompt: sdkConfig.systemPrompt } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(sdkConfig?.planModeInstructions !== undefined ? { planModeInstructions: sdkConfig.planModeInstructions } : {}),
      ...(sdkConfig?.toolAliases ? { toolAliases: { ...sdkConfig.toolAliases } } : {}),
      ...(sdkConfig?.agents ? {
        subagentDefinitions: toSdkSubagentDefinitions(
          sdkConfig.agents,
          runtime.projectRoot,
          this.options.env,
          (model) => {
            this.assertOrganizationModelAllowed(runtime.projectRoot, model.provider, model.model);
            assertManagedModelAllowed(sdkConfig?.managedModels, model.provider, model.model);
          },
          this.options.organizationPolicy?.limits?.maxTurns,
        ),
      } : {}),
      ...(sdkConfig?.outputFormat ? { stopOnStructuredOutput: true } : {}),
      jsonSelfCorrect: true,
      ...(sessionSubagents?.maxDepth !== undefined
        || agent.subagents?.maxDepth !== undefined
        || this.options.organizationPolicy?.limits?.maxSubagentDepth !== undefined ? {
            maxSubagentDepth: capOrganizationSubagentDepth(
              sessionSubagents?.maxDepth ?? agent.subagents?.maxDepth,
              this.options.organizationPolicy?.limits?.maxSubagentDepth,
            ),
          }
        : {}),
      ...(subagentRuntimeModel ? { subagentModel: subagentRuntimeModel } : {}),
      subagentTimeoutMs: capOrganizationSubagentTimeout(
        effectiveAgent.subagents?.timeoutMs,
        organizationSettings?.maxSubagentTimeoutMs,
      ),
      maxContextTokens,
      maxOutputTokens,
      thinking: capOrganizationThinkingConfig(
        organizationSettings?.enforcedSessionSettings?.agent?.thinking
          ?? this.sdkThinkingOverrides.get(sessionKey)
          ?? effectiveAgent.thinking,
        organizationSettings?.maxThinkingTokens,
      ),
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        // Managed policy is a one-way restriction. A per-session override or
        // SDK permission adapter must never re-enable a policy-disabled prompt.
        canPrompt: organizationPermissions?.canPrompt === false || sdkConfig?.managedPermissions?.canPrompt === false
          ? false
          : (override?.canPrompt ?? (sdkConfig?.permissionMode === "dontAsk" ? false : true)),
        policyCanPrompt: organizationPermissions?.canPrompt === false || sdkConfig?.managedPermissions?.canPrompt === false
          ? false
          : undefined,
        acceptEdits: sdkConfig?.permissionMode === "acceptEdits",
        bypassAvailable: override?.bypassAvailable ?? true,
        additionalWorkingDirectories: mergeAdditionalWorkingDirectories(
          this.options.additionalWorkingDirectories,
          sdkConfig?.additionalWorkingDirectories,
        ),
        rules: {
          allow: liveRuleSet.allow,
          // Policy rules are copied into this runtime context rather than the
          // mutable session arrays, so a remembered SDK allow can never
          // overwrite a managed deny/ask entry.
          deny: [...organizationRules.deny, ...managedRules.deny, ...liveRuleSet.deny],
          ask: [...organizationRules.ask, ...managedRules.ask, ...liveRuleSet.ask],
        },
      }),
    };
  }
}

function cloneSdkSessionConfig(
  config: import("../gateway/protocol/types.js").GatewaySessionSdkConfig,
): import("../gateway/protocol/types.js").GatewaySessionSdkConfig {
  return {
    ...(config.persistSession === false ? { persistSession: false } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.appendSystemPrompt !== undefined ? { appendSystemPrompt: config.appendSystemPrompt } : {}),
    ...(config.outputStyle !== undefined ? { outputStyle: config.outputStyle } : {}),
    ...(config.fallbackModel !== undefined ? { fallbackModel: config.fallbackModel } : {}),
    ...(config.taskBudget ? {
      taskBudget: {
        total: config.taskBudget.total,
        ...(config.taskBudget.scope === "project" ? { scope: "project" as const } : {}),
        ...(config.taskBudget.projectRetentionMs !== undefined
          ? { projectRetentionMs: config.taskBudget.projectRetentionMs }
          : {}),
      },
    } : {}),
    ...(config.managedPermissions ? {
      managedPermissions: {
        deny: [...config.managedPermissions.deny],
        ask: [...config.managedPermissions.ask],
        ...(config.managedPermissions.defaultMode === "plan" ? { defaultMode: "plan" as const } : {}),
        ...(config.managedPermissions.canPrompt === false ? { canPrompt: false as const } : {}),
      },
    } : {}),
    ...(config.managedTools ? {
      managedTools: {
        allow: [...config.managedTools.allow],
        deny: [...config.managedTools.deny],
      },
    } : {}),
    ...(config.managedModels ? {
      managedModels: {
        allow: [...config.managedModels.allow],
        deny: [...config.managedModels.deny],
      },
    } : {}),
    ...(config.settings ? { settings: structuredClone(config.settings) } : {}),
    ...(config.settingSources ? { settingSources: [...config.settingSources] } : {}),
    ...(config.planModeInstructions !== undefined ? { planModeInstructions: config.planModeInstructions } : {}),
    ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
    ...(config.toolAliases ? { toolAliases: { ...config.toolAliases } } : {}),
    ...(config.deferredTools ? {
      deferredTools: config.deferredTools.map((tool) => ({
        name: tool.name,
        ...(tool.searchHint !== undefined ? { searchHint: tool.searchHint } : {}),
      })),
    } : {}),
    ...(config.additionalWorkingDirectories
      ? { additionalWorkingDirectories: [...config.additionalWorkingDirectories] }
      : {}),
    ...(config.outputFormat ? {
      outputFormat: { type: "json_schema" as const, schema: structuredClone(config.outputFormat.schema) },
    } : {}),
    ...(config.agents ? { agents: structuredClone(config.agents) } : {}),
    ...(config.skills !== undefined
      ? { skills: config.skills === "all" ? "all" : [...config.skills] }
      : {}),
    ...(config.plugins ? { plugins: config.plugins.map((plugin) => ({ type: "local" as const, path: plugin.path })) } : {}),
    ...(config.includeHookEvents !== undefined ? { includeHookEvents: config.includeHookEvents } : {}),
    ...(config.agentProgressSummaries !== undefined
      ? { agentProgressSummaries: config.agentProgressSummaries }
      : {}),
    ...(config.forwardSubagentText !== undefined
      ? { forwardSubagentText: config.forwardSubagentText }
      : {}),
    ...(config.promptSuggestions !== undefined ? { promptSuggestions: config.promptSuggestions } : {}),
    ...(config.userDialogKinds ? { userDialogKinds: [...config.userDialogKinds] } : {}),
    ...(config.sandbox ? { sandbox: cloneSdkSandbox(config.sandbox) } : {}),
    ...(config.hooks ? {
      hooks: {
        url: config.hooks.url,
        ...(config.hooks.headers ? { headers: { ...config.hooks.headers } } : {}),
        events: structuredClone(config.hooks.events),
      },
    } : {}),
  };
}

function resolveSdkSessionSettings(
  projectRoot: string,
  env: Record<string, string | undefined>,
  config: import("../gateway/protocol/types.js").GatewaySessionSdkConfig | undefined,
  hostDefaults?: PilotSdkSessionSettings,
  hostManagedSettings?: PilotSdkSessionSettings,
  hostSettingSources?: Array<"managed" | "user" | "project" | "local">,
  hostEnforcedSettings?: PilotSdkSessionSettings,
): import("../pilot/config/sdkSessionSettings.js").PilotSdkSessionSettings | undefined {
  try {
    return resolvePilotSdkSessionSettings({
      projectRoot,
      env,
      hostDefaults,
      hostManagedSettings,
      hostSettingSources,
      settings: config?.settings,
      settingSources: config?.settingSources,
      hostEnforcedSettings,
    });
  } catch (error) {
    if (error instanceof PilotSdkSessionSettingsError) {
      throw new DialogGatewayError(error.code, error.message);
    }
    throw error;
  }
}

function validateSdkManagedPermissions(
  value: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["managedPermissions"],
): void {
  if (!value) return;
  if (!Array.isArray(value.deny) || !Array.isArray(value.ask)) {
    throw new DialogGatewayError(
      "INVALID_SDK_MANAGED_SETTINGS",
      "managedPermissions.deny and managedPermissions.ask must be arrays.",
    );
  }
  if (value.defaultMode !== undefined && value.defaultMode !== "plan") {
    throw new DialogGatewayError(
      "UNSUPPORTED_SDK_MANAGED_SETTING",
      "managedPermissions.defaultMode may only force plan mode.",
    );
  }
  if (value.canPrompt !== undefined && value.canPrompt !== false) {
    throw new DialogGatewayError(
      "UNSUPPORTED_SDK_MANAGED_SETTING",
      "managedPermissions.canPrompt may only disable prompts.",
    );
  }
  for (const [label, entries] of [["deny", value.deny], ["ask", value.ask]] as const) {
    if (entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedPermissions.${label} must contain only non-empty strings.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedPermissions.${label} cannot contain duplicate entries.`,
      );
    }
  }
}

function validateSdkManagedTools(
  value: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["managedTools"],
): void {
  if (!value) return;
  for (const [label, entries] of [["allow", value.allow], ["deny", value.deny]] as const) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isOrganizationToolSelector(entry.trim()))) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedTools.${label} entries must be an exact tool name, prefix*, or * selector.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedTools.${label} cannot contain duplicate entries.`,
      );
    }
  }
}

function validateSdkDeferredTools(
  value: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["deferredTools"],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    throw new DialogGatewayError(
      "INVALID_SDK_DEFERRED_TOOLS",
      "deferredTools must be a non-empty array.",
    );
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new DialogGatewayError(
        "INVALID_SDK_DEFERRED_TOOLS",
        "deferredTools entries require non-empty names.",
      );
    }
    const name = entry.name.trim();
    if (name === "search_tools") {
      throw new DialogGatewayError(
        "INVALID_SDK_DEFERRED_TOOLS",
        "deferredTools cannot include the reserved search_tools name.",
      );
    }
    if (names.has(name)) {
      throw new DialogGatewayError(
        "INVALID_SDK_DEFERRED_TOOLS",
        `deferredTools cannot repeat ${name}.`,
      );
    }
    names.add(name);
    if (entry.searchHint !== undefined && (typeof entry.searchHint !== "string" || !entry.searchHint.trim())) {
      throw new DialogGatewayError(
        "INVALID_SDK_DEFERRED_TOOLS",
        `deferred tool ${name} searchHint must be a non-empty string.`,
      );
    }
  }
}

function validateSdkManagedModels(
  value: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["managedModels"],
): void {
  if (!value) return;
  for (const [label, entries] of [["allow", value.allow], ["deny", value.deny]] as const) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isOrganizationModelSelector(entry.trim()))) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedModels.${label} entries must be *, provider/*, or provider/model selectors.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_SDK_MANAGED_SETTINGS",
        `managedModels.${label} cannot contain duplicate entries.`,
      );
    }
  }
}

function normalizeGatewayOrganizationPolicy(
  value: GatewayOrganizationPolicy | undefined,
): ResolvedGatewayOrganizationPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy must be an object.",
    );
  }
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some((key) => key !== "permissions" && key !== "models" && key !== "providers" && key !== "tools" && key !== "settingSources" && key !== "limits" && key !== "settings")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy only supports restrictive permissions, model, provider, tool, setting-source, turn-limit, and settings-write policy.",
    );
  }
  const permissions = normalizeGatewayOrganizationPermissions(policy.permissions);
  const models = normalizeGatewayOrganizationModelPolicy(policy.models);
  const providers = normalizeGatewayOrganizationProviderPolicy(policy.providers);
  const tools = normalizeGatewayOrganizationToolPolicy(policy.tools);
  const settingSources = normalizeGatewayOrganizationSettingSourcePolicy(policy.settingSources);
  const limits = normalizeGatewayOrganizationTurnLimitPolicy(policy.limits);
  const settings = normalizeGatewayOrganizationSettingsPolicy(policy.settings);
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

function normalizeGatewayOrganizationPermissions(value: unknown): RestrictivePermissionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.permissions must be an object.",
    );
  }
  const permissions = value as Record<string, unknown>;
  if (Object.keys(permissions).some((key) => key !== "deny" && key !== "ask" && key !== "defaultMode" && key !== "canPrompt")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.permissions only supports deny, ask, defaultMode, and canPrompt.",
    );
  }
  const normalizeEntries = (label: "deny" | "ask"): string[] => {
    const entries = permissions[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.permissions.${label} must be an array of non-empty strings.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.permissions.${label} cannot contain duplicate entries.`,
      );
    }
    return normalized;
  };
  if (permissions.defaultMode !== undefined && permissions.defaultMode !== "plan") {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.permissions.defaultMode may only force plan mode.",
    );
  }
  if (permissions.canPrompt !== undefined && permissions.canPrompt !== false) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.permissions.canPrompt may only disable prompts.",
    );
  }
  const deny = normalizeEntries("deny");
  const ask = normalizeEntries("ask");
  if (deny.length === 0 && ask.length === 0 && permissions.defaultMode === undefined && permissions.canPrompt !== false) {
    return undefined;
  }
  return {
    deny,
    ask,
    ...(permissions.defaultMode === "plan" ? { defaultMode: "plan" as const } : {}),
    ...(permissions.canPrompt === false ? { canPrompt: false as const } : {}),
  };
}

function normalizeGatewayOrganizationModelPolicy(value: unknown): RestrictiveModelPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.models must be an object.",
    );
  }
  const models = value as Record<string, unknown>;
  if (Object.keys(models).some((key) => key !== "allow" && key !== "deny")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.models only supports allow and deny.",
    );
  }
  const normalizeEntries = (label: "allow" | "deny"): string[] => {
    const entries = models[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isOrganizationModelSelector(entry.trim()))) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.models.${label} entries must be *, provider/*, or provider/model selectors.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.models.${label} cannot contain duplicate entries.`,
      );
    }
    return normalized;
  };
  const allow = normalizeEntries("allow");
  const deny = normalizeEntries("deny");
  return allow.length === 0 && deny.length === 0 ? undefined : { allow, deny };
}

function normalizeGatewayOrganizationProviderPolicy(value: unknown): RestrictiveProviderPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.providers must be an object.",
    );
  }
  const providers = value as Record<string, unknown>;
  if (Object.keys(providers).some((key) => key !== "allow" && key !== "deny" && key !== "origins" && key !== "credentials")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.providers only supports allow, deny, origins, and credentials.",
    );
  }
  const normalizeProviderIds = (label: "allow" | "deny"): string[] => {
    const entries = providers[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isOrganizationProviderId(entry.trim()))) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.${label} must contain exact provider IDs.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.${label} cannot contain duplicate entries.`,
      );
    }
    return normalized;
  };
  const normalizeOriginEntries = (label: "allow" | "deny"): string[] => {
    const origins = providers.origins;
    if (origins === undefined) return [];
    if (!origins || typeof origins !== "object" || Array.isArray(origins)) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        "organizationPolicy.providers.origins must be an object.",
      );
    }
    const record = origins as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "allow" && key !== "deny")) {
      throw new DialogGatewayError(
        "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
        "organizationPolicy.providers.origins only supports allow and deny.",
      );
    }
    const entries = record[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.origins.${label} must be an array of HTTP(S) origins.`,
      );
    }
    const normalized = entries.map((entry) => normalizeOrganizationProviderOrigin(entry));
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.origins.${label} cannot contain duplicate origins.`,
      );
    }
    return normalized;
  };
  const normalizeCredentialEntries = (label: "allow" | "deny"): ProviderCredentialSource[] => {
    const credentials = providers.credentials;
    if (credentials === undefined) return [];
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        "organizationPolicy.providers.credentials must be an object.",
      );
    }
    const record = credentials as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "allow" && key !== "deny")) {
      throw new DialogGatewayError(
        "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
        "organizationPolicy.providers.credentials only supports allow and deny.",
      );
    }
    const entries = record[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => !isOrganizationCredentialSource(entry))) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.credentials.${label} must contain environment, literal, or provider_default.`,
      );
    }
    if (new Set(entries).size !== entries.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.providers.credentials.${label} cannot contain duplicate entries.`,
      );
    }
    return [...entries] as ProviderCredentialSource[];
  };
  const allow = normalizeProviderIds("allow");
  const deny = normalizeProviderIds("deny");
  const origins = { allow: normalizeOriginEntries("allow"), deny: normalizeOriginEntries("deny") };
  const credentials = { allow: normalizeCredentialEntries("allow"), deny: normalizeCredentialEntries("deny") };
  if (allow.length === 0 && deny.length === 0 && origins.allow.length === 0 && origins.deny.length === 0 && credentials.allow.length === 0 && credentials.deny.length === 0) {
    return undefined;
  }
  return { allow, deny, origins, credentials };
}

function normalizeGatewayOrganizationToolPolicy(value: unknown): RestrictiveToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.tools must be an object.",
    );
  }
  const tools = value as Record<string, unknown>;
  if (Object.keys(tools).some((key) => key !== "allow" && key !== "deny")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.tools only supports allow and deny.",
    );
  }
  const normalizeEntries = (label: "allow" | "deny"): string[] => {
    const entries = tools[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isOrganizationToolSelector(entry.trim()))) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.tools.${label} entries must be an exact tool name, prefix*, or * selector.`,
      );
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.tools.${label} cannot contain duplicate entries.`,
      );
    }
    return normalized;
  };
  const allow = normalizeEntries("allow");
  const deny = normalizeEntries("deny");
  return allow.length === 0 && deny.length === 0 ? undefined : { allow, deny };
}

function normalizeGatewayOrganizationSettingSourcePolicy(
  value: unknown,
): RestrictiveSettingSourcePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settingSources must be an object.",
    );
  }
  const sources = value as Record<string, unknown>;
  if (Object.keys(sources).some((key) => key !== "allow" && key !== "deny")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settingSources only supports allow and deny.",
    );
  }
  const normalizeEntries = (label: "allow" | "deny"): Array<"managed" | "user" | "project" | "local"> => {
    const entries = sources[label];
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => entry !== "managed" && entry !== "user" && entry !== "project" && entry !== "local")) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.settingSources.${label} must contain only managed, user, project, or local.`,
      );
    }
    if (new Set(entries).size !== entries.length) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.settingSources.${label} cannot contain duplicate entries.`,
      );
    }
    return [...entries] as Array<"managed" | "user" | "project" | "local">;
  };
  const allow = normalizeEntries("allow");
  const deny = normalizeEntries("deny");
  return allow.length === 0 && deny.length === 0 ? undefined : { allow, deny };
}

function normalizeGatewayOrganizationTurnLimitPolicy(
  value: unknown,
): RestrictiveTurnLimitPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits must be an object.",
    );
  }
  const limits = value as Record<string, unknown>;
  if (Object.keys(limits).some((key) => key !== "maxTurns" && key !== "maxBudgetUsd" && key !== "maxTaskBudgetUsd" && key !== "maxSubagentDepth")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits only supports maxTurns, maxBudgetUsd, maxTaskBudgetUsd, and maxSubagentDepth.",
    );
  }
  if (limits.maxTurns !== undefined && (
    typeof limits.maxTurns !== "number"
    || !Number.isSafeInteger(limits.maxTurns)
    || limits.maxTurns <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits.maxTurns must be a positive safe integer.",
    );
  }
  if (limits.maxBudgetUsd !== undefined && (
    typeof limits.maxBudgetUsd !== "number"
    || !Number.isFinite(limits.maxBudgetUsd)
    || limits.maxBudgetUsd <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits.maxBudgetUsd must be a positive finite number.",
    );
  }
  if (limits.maxTaskBudgetUsd !== undefined && (
    typeof limits.maxTaskBudgetUsd !== "number"
    || !Number.isFinite(limits.maxTaskBudgetUsd)
    || limits.maxTaskBudgetUsd <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits.maxTaskBudgetUsd must be a positive finite number.",
    );
  }
  if (limits.maxSubagentDepth !== undefined && (
    typeof limits.maxSubagentDepth !== "number"
    || !Number.isSafeInteger(limits.maxSubagentDepth)
    || limits.maxSubagentDepth < 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.limits.maxSubagentDepth must be a non-negative safe integer.",
    );
  }
  if (limits.maxTurns === undefined && limits.maxBudgetUsd === undefined && limits.maxTaskBudgetUsd === undefined && limits.maxSubagentDepth === undefined) return undefined;
  return {
    ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
    ...(limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: limits.maxBudgetUsd } : {}),
    ...(limits.maxTaskBudgetUsd !== undefined ? { maxTaskBudgetUsd: limits.maxTaskBudgetUsd } : {}),
    ...(limits.maxSubagentDepth !== undefined ? { maxSubagentDepth: limits.maxSubagentDepth } : {}),
  };
}

function normalizeGatewayOrganizationSettingsPolicy(value: unknown): RestrictiveSettingsPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settings must be an object.",
    );
  }
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => key !== "canUpdateLocalSettings" && key !== "maxContextTokens" && key !== "maxOutputTokens" && key !== "maxThinkingTokens" && key !== "maxSubagentTimeoutMs" && key !== "sessionDefaults" && key !== "managedSessionSettings" && key !== "sessionDefaultSources" && key !== "enforcedSessionSettings")) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settings only supports canUpdateLocalSettings, maxContextTokens, maxOutputTokens, maxThinkingTokens, maxSubagentTimeoutMs, sessionDefaults, managedSessionSettings, sessionDefaultSources, and enforcedSessionSettings.",
    );
  }
  if (settings.canUpdateLocalSettings !== undefined && settings.canUpdateLocalSettings !== false) {
    throw new DialogGatewayError(
      "UNSUPPORTED_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settings.canUpdateLocalSettings may only disable SDK settings updates.",
    );
  }
  for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
    const setting = settings[key];
    if (setting !== undefined && (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting <= 0)) {
      throw new DialogGatewayError(
        "INVALID_GATEWAY_ORGANIZATION_POLICY",
        `organizationPolicy.settings.${key} must be a positive safe integer.`,
      );
    }
  }
  if (settings.maxThinkingTokens !== undefined && (
    typeof settings.maxThinkingTokens !== "number"
    || !Number.isSafeInteger(settings.maxThinkingTokens)
    || settings.maxThinkingTokens < 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settings.maxThinkingTokens must be a non-negative safe integer.",
    );
  }
  if (settings.maxSubagentTimeoutMs !== undefined && (
    typeof settings.maxSubagentTimeoutMs !== "number"
    || !Number.isSafeInteger(settings.maxSubagentTimeoutMs)
    || settings.maxSubagentTimeoutMs <= 0
  )) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.settings.maxSubagentTimeoutMs must be a positive safe integer.",
    );
  }
  let sessionDefaults: PilotSdkSessionSettings | undefined;
  if (settings.sessionDefaults !== undefined) {
    try {
      validatePilotSdkSessionSettings(settings.sessionDefaults);
      // The validator constrains this to the non-secret SDK overlay schema.
      // Clone it at the host boundary so callers cannot mutate active policy.
      sessionDefaults = structuredClone(settings.sessionDefaults as PilotSdkSessionSettings);
    } catch (error) {
      if (error instanceof PilotSdkSessionSettingsError) {
        throw new DialogGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
  let managedSessionSettings: PilotSdkSessionSettings | undefined;
  if (settings.managedSessionSettings !== undefined) {
    try {
      validatePilotSdkSessionSettings(settings.managedSessionSettings);
      managedSessionSettings = structuredClone(settings.managedSessionSettings as PilotSdkSessionSettings);
    } catch (error) {
      if (error instanceof PilotSdkSessionSettingsError) {
        throw new DialogGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
  let sessionDefaultSources: Array<"managed" | "user" | "project" | "local"> | undefined;
  if (settings.sessionDefaultSources !== undefined) {
    try {
      validatePilotSdkSettingSources(settings.sessionDefaultSources);
      sessionDefaultSources = [...settings.sessionDefaultSources as Array<"managed" | "user" | "project" | "local">];
    } catch (error) {
      if (error instanceof PilotSdkSessionSettingsError) {
        throw new DialogGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
  let enforcedSessionSettings: PilotSdkSessionSettings | undefined;
  if (settings.enforcedSessionSettings !== undefined) {
    try {
      validatePilotSdkSessionSettings(settings.enforcedSessionSettings);
      // This has the same deliberately non-secret schema as sessionDefaults,
      // but its precedence is host-enforced rather than a fallback default.
      enforcedSessionSettings = structuredClone(settings.enforcedSessionSettings as PilotSdkSessionSettings);
    } catch (error) {
      if (error instanceof PilotSdkSessionSettingsError) {
        throw new DialogGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
  if (settings.canUpdateLocalSettings !== false
    && settings.maxContextTokens === undefined
    && settings.maxOutputTokens === undefined
    && settings.maxThinkingTokens === undefined
    && settings.maxSubagentTimeoutMs === undefined
    && sessionDefaults === undefined
    && managedSessionSettings === undefined
    && sessionDefaultSources === undefined
    && enforcedSessionSettings === undefined) return undefined;
  return {
    ...(settings.canUpdateLocalSettings === false ? { canUpdateLocalSettings: false as const } : {}),
    ...(settings.maxContextTokens !== undefined ? { maxContextTokens: settings.maxContextTokens as number } : {}),
    ...(settings.maxOutputTokens !== undefined ? { maxOutputTokens: settings.maxOutputTokens as number } : {}),
    ...(settings.maxThinkingTokens !== undefined ? { maxThinkingTokens: settings.maxThinkingTokens as number } : {}),
    ...(settings.maxSubagentTimeoutMs !== undefined ? { maxSubagentTimeoutMs: settings.maxSubagentTimeoutMs as number } : {}),
    ...(sessionDefaults !== undefined ? { sessionDefaults } : {}),
    ...(managedSessionSettings !== undefined ? { managedSessionSettings } : {}),
    ...(sessionDefaultSources !== undefined ? { sessionDefaultSources } : {}),
    ...(enforcedSessionSettings !== undefined ? { enforcedSessionSettings } : {}),
  };
}

function isOrganizationModelSelector(value: string): boolean {
  return value === "*" || /^[^/\s]+\/(?:[^/\s]+|\*)$/.test(value);
}

function isOrganizationProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}

function isOrganizationCredentialSource(value: unknown): value is ProviderCredentialSource {
  return value === "environment" || value === "literal" || value === "provider_default";
}

function normalizeOrganizationProviderOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.providers origin entries must be non-empty HTTP(S) origins.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      `organizationPolicy.providers origin is invalid: ${value}.`,
    );
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash) {
    throw new DialogGatewayError(
      "INVALID_GATEWAY_ORGANIZATION_POLICY",
      "organizationPolicy.providers origins must be credential-free HTTP(S) origins without a path, query, or fragment.",
    );
  }
  return parsed.origin;
}

type OrganizationProviderPolicyRejection = {
  code:
    | "GATEWAY_ORGANIZATION_PROVIDER_DENIED"
    | "GATEWAY_ORGANIZATION_PROVIDER_ORIGIN_DENIED"
    | "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED";
  message: string;
};

function organizationProviderPolicyRejection(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  providerId: string,
  provider: ProviderConfig | undefined,
): OrganizationProviderPolicyRejection | undefined {
  const providers = policy?.providers;
  if (!providers) return undefined;
  if (providers.deny.includes(providerId)
    || (providers.allow.length > 0 && !providers.allow.includes(providerId))) {
    return {
      code: "GATEWAY_ORGANIZATION_PROVIDER_DENIED",
      message: `Gateway organization policy denies provider ${providerId}.`,
    };
  }
  const origin = provider ? providerOrigin(provider.url) : undefined;
  if (providers.origins.deny.includes(origin ?? "")
    || (providers.origins.allow.length > 0 && !providers.origins.allow.includes(origin ?? ""))) {
    return {
      code: "GATEWAY_ORGANIZATION_PROVIDER_ORIGIN_DENIED",
      message: `Gateway organization policy denies provider origin ${origin ?? "<unknown>"} for ${providerId}.`,
    };
  }
  const credentialSource = provider?.credentialSource;
  if (credentialSource && (providers.credentials.deny.includes(credentialSource)
    || (providers.credentials.allow.length > 0 && !providers.credentials.allow.includes(credentialSource)))) {
    return {
      code: "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED",
      message: `Gateway organization policy denies ${credentialSource} credentials for provider ${providerId}.`,
    };
  }
  // A provider created programmatically has no provenance metadata. It keeps
  // legacy behavior unless the host declares an explicit credential allowlist.
  if (!credentialSource && providers.credentials.allow.length > 0) {
    return {
      code: "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED",
      message: `Gateway organization policy requires a known credential source for provider ${providerId}.`,
    };
  }
  return undefined;
}

function providerOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function isOrganizationToolSelector(value: string): boolean {
  return value === "*" || /^[A-Za-z0-9][A-Za-z0-9_.:-]*\*?$/.test(value);
}

function isOrganizationModelAllowed(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  provider: string,
  model: string,
): boolean {
  const models = policy?.models;
  if (!models) return true;
  const matches = (selector: string) => selector === "*"
    || selector === `${provider}/*`
    || selector === `${provider}/${model}`;
  if (models.deny.some(matches)) return false;
  return models.allow.length === 0 || models.allow.some(matches);
}

function isOrganizationProviderAllowed(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  providerId: string,
  provider: ProviderConfig | undefined,
): boolean {
  return organizationProviderPolicyRejection(policy, providerId, provider) === undefined;
}

/**
 * RouterRuntime is the normal model-request gate, but title generation and
 * other optional helpers may call ModelRuntime directly. Keep a second,
 * host-only check here so those paths cannot bypass a provider policy.
 */
function createOrganizationPolicyModelRuntime(
  runtime: ModelRuntime,
  modelConfig: ModelConfig,
  policy: ResolvedGatewayOrganizationPolicy,
): ModelRuntime {
  const assertProviderAllowed = (providerId: string) => {
    const rejection = organizationProviderPolicyRejection(
      policy,
      providerId,
      modelConfig.providers[providerId],
    );
    if (!rejection) return;
    throw new ModelRequestError(rejection.code, rejection.message);
  };
  return {
    stream(request, options) {
      assertProviderAllowed(request.provider);
      return runtime.stream(request, options);
    },
    async complete(request, options) {
      assertProviderAllowed(request.provider);
      return runtime.complete(request, options);
    },
    getCapabilities: (providerId, modelId) => runtime.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => runtime.getMultimodal(providerId, modelId),
    getProviderProtocol: (providerId) => runtime.getProviderProtocol(providerId),
    getProviderBaseUrl: (providerId) => runtime.getProviderBaseUrl(providerId),
  };
}

function assertManagedModelAllowed(
  policy: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["managedModels"],
  provider: string,
  model: string,
): void {
  if (isManagedModelAllowed(policy, provider, model)) return;
  throw new DialogGatewayError(
    "SDK_MANAGED_MODEL_DENIED",
    `SDK managedSettings.models denies model ${provider}/${model}.`,
  );
}

function isManagedModelAllowed(
  policy: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["managedModels"],
  provider: string,
  model: string,
): boolean {
  if (!policy) return true;
  const matches = (selector: string) => selector === "*"
    || selector === `${provider}/*`
    || selector === `${provider}/${model}`;
  return !policy.deny.some(matches) && (policy.allow.length === 0 || policy.allow.some(matches));
}

function assertOrganizationSettingSourcesAllowed(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  sources: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["settingSources"],
): void {
  const sourcePolicy = policy?.settingSources;
  if (!sourcePolicy || !sources) return;
  const denied = sources.find((source) => sourcePolicy.deny.includes(source)
    || (sourcePolicy.allow.length > 0 && !sourcePolicy.allow.includes(source)));
  if (!denied) return;
  throw new DialogGatewayError(
    "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED",
    `Gateway organization policy denies the ${denied} SDK settings source.`,
  );
}

/** A host policy is only allowed to lower a resolved token ceiling. */
function capOrganizationTokenLimit(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return value === undefined ? cap : Math.min(value, cap);
}

/** A host turn ceiling also supplies the default when an SDK agent omits it. */
function capOrganizationTurnLimit(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return value === undefined ? cap : Math.min(value, cap);
}

/** Task budgets are SDK-only Gateway state, so the host caps them at config ingress. */
function applyOrganizationTaskBudgetCap(
  config: import("../gateway/protocol/types.js").GatewaySessionSdkConfig,
  cap: number | undefined,
): void {
  if (cap === undefined) return;
  const taskBudget = config.taskBudget;
  config.taskBudget = {
    total: taskBudget === undefined ? cap : Math.min(taskBudget.total, cap),
    ...(taskBudget?.scope === "project" ? { scope: "project" as const } : {}),
    ...(taskBudget?.projectRetentionMs !== undefined
      ? { projectRetentionMs: taskBudget.projectRetentionMs }
      : {}),
  };
}

/** A host can cap explicit thinking without enabling it when it was absent. */
function capOrganizationThinkingConfig(
  value: AgentRuntimeConfig["thinking"] | undefined,
  cap: number | undefined,
): AgentRuntimeConfig["thinking"] | undefined {
  if (cap === undefined || value === undefined || value.enabled !== true) return value;
  if (cap === 0) return { enabled: false, mode: "off" };
  return {
    ...value,
    budgetTokens: value.budgetTokens === undefined ? cap : Math.min(value.budgetTokens, cap),
  };
}

/** A host cap also provides a default for native and SDK subagent timeouts. */
function capOrganizationSubagentTimeout(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  return value === undefined ? cap : Math.min(value, cap);
}

/**
 * AgentLoop defaults to one fork level. A host policy can only tighten that
 * default (for example zero disables the agent tool); it must never turn a
 * missing SDK/native setting into a deeper recursive runtime.
 */
function capOrganizationSubagentDepth(value: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return value;
  const defaultDepth = value ?? 1;
  return Math.min(defaultDepth, cap);
}

function organizationHiddenToolNames(
  policy: ResolvedGatewayOrganizationPolicy | undefined,
  tools: PilotDeckToolDefinition[],
): Set<string> {
  const policyTools = policy?.tools;
  if (!policyTools) return new Set();
  return new Set(tools.filter((tool) => {
    if (policyTools.deny.some((selector) => matchesOrganizationToolSelector(tool.name, selector))) return true;
    return policyTools.allow.length > 0
      && !policyTools.allow.some((selector) => matchesOrganizationToolSelector(tool.name, selector));
  }).map((tool) => tool.name));
}

function managedHiddenToolNames(
  policy: RestrictiveToolPolicy | undefined,
  tools: PilotDeckToolDefinition[],
): Set<string> {
  if (!policy) return new Set();
  return new Set(tools.filter((tool) => {
    if (policy.deny.some((selector) => matchesOrganizationToolSelector(tool.name, selector))) return true;
    return policy.allow.length > 0
      && !policy.allow.some((selector) => matchesOrganizationToolSelector(tool.name, selector));
  }).map((tool) => tool.name));
}

function matchesOrganizationToolSelector(name: string, selector: string): boolean {
  return selector === "*"
    || selector === name
    || (selector.endsWith("*") && name.startsWith(selector.slice(0, -1)));
}

function validateSdkSandbox(
  value: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"],
): void {
  if (!value) return;
  if ((value.type !== undefined && value.type !== "tool_policy" && value.type !== "host")
    || (value.type === "host" && value.toolIsolation !== undefined && value.toolIsolation !== "strict")
    || (value.filesystem !== undefined && value.filesystem !== "read_only" && value.filesystem !== "deny")
    || (value.network !== undefined && value.network !== "deny")
    || (value.process !== undefined && value.process !== "deny")) {
    throw new DialogGatewayError(
      "INVALID_SDK_SANDBOX",
      "sandbox must be tool_policy restrictions or a named host profile with optional restrictions.",
    );
  }
  if (value.type === "host") {
    if (typeof value.profile !== "string" || !value.profile.trim()) {
      throw new DialogGatewayError("INVALID_SDK_SANDBOX", "host sandbox requires a non-empty profile.");
    }
    return;
  }
  if ("profile" in value && value.profile !== undefined) {
    throw new DialogGatewayError("INVALID_SDK_SANDBOX", "tool_policy sandbox cannot specify a host profile.");
  }
  if ("toolIsolation" in value && value.toolIsolation !== undefined) {
    throw new DialogGatewayError("INVALID_SDK_SANDBOX", "tool_policy sandbox cannot specify host tool isolation.");
  }
  if (value.filesystem === undefined && value.network === undefined && value.process === undefined) {
    throw new DialogGatewayError("INVALID_SDK_SANDBOX", "tool_policy sandbox requires at least one restriction.");
  }
}

function cloneSdkSandbox(
  sandbox: NonNullable<import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"]>,
): NonNullable<import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"]> {
  const restrictions = {
    ...(sandbox.filesystem === "read_only" || sandbox.filesystem === "deny"
      ? { filesystem: sandbox.filesystem }
      : {}),
    ...(sandbox.network === "deny" ? { network: "deny" as const } : {}),
    ...(sandbox.process === "deny" ? { process: "deny" as const } : {}),
  };
  return sandbox.type === "host"
    ? {
        type: "host",
        profile: sandbox.profile,
        ...(sandbox.toolIsolation === "strict" ? { toolIsolation: "strict" as const } : {}),
        ...restrictions,
      }
    : restrictions;
}

function sandboxHiddenToolNames(
  sandbox: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"] | undefined,
  tools: PilotDeckToolDefinition[],
  hostProfile?: GatewayHostSandboxProfile,
): Set<string> {
  if (!sandbox) return new Set();
  const hidden = new Set<string>();
  const usesHostProfile = sandbox.type === "host";
  const strictHostIsolation = usesHostProfile && sandbox.toolIsolation === "strict";
  const sandboxedScratchBash = usesHostProfile
    && sandbox.filesystem === "deny"
    && hostProfile?.supportsFilesystemDeny === true;
  const sandboxedNetworkBash = usesHostProfile
    && sandbox.network === "deny"
    && hostProfile?.supportsNetworkDeny === true;
  const sandboxedExecuteCode = hostProfileRunsExecuteCode(sandbox, hostProfile);
  // These tools never execute a host command or access host files. `bash` is
  // safe only because it was replaced above with the profile-owned runner.
  const strictHostSafeTool = (tool: PilotDeckToolDefinition): boolean => tool.name === "bash"
    || (sandboxedExecuteCode && tool.name === "execute_code")
    || tool.name === "structured_output"
    || tool.name === "request_user_input"
    || tool.name === "request_user_choice"
    || tool.name === "request_user_confirmation"
    || tool.name === "request_user_form";
  const hostBridge = (tool: PilotDeckToolDefinition): boolean => tool.kind === "shell"
    || tool.kind === "mcp"
    || tool.kind === "custom"
    || tool.name === "execute_code"
    || tool.name === "agent"
    || tool.name.startsWith("task_");
  const profileOwnedHostBridge = (tool: PilotDeckToolDefinition): boolean => (
    (sandboxedScratchBash && tool.name === "bash")
    || (sandboxedExecuteCode && tool.name === "execute_code")
  );
  // Bash and a profile-approved execute_code Python process are the only
  // bridges routed through a selected host profile. All other process
  // bridges remain hidden to prevent bypassing that boundary.
  const uncontrolledHostBridge = (tool: PilotDeckToolDefinition): boolean => hostBridge(tool)
    && (!usesHostProfile
      || (tool.name !== "bash" && !(sandboxedExecuteCode && tool.name === "execute_code")));
  for (const tool of tools) {
    const denyStrictHostIsolation = strictHostIsolation && !strictHostSafeTool(tool);
    const denyHostBridge = sandbox.process === "deny"
      ? hostBridge(tool)
      : usesHostProfile && uncontrolledHostBridge(tool);
    const denyFilesystem = sandbox.filesystem === "deny"
      ? tool.kind === "filesystem" || (hostBridge(tool) && !profileOwnedHostBridge(tool))
      : sandbox.filesystem === "read_only" && (
        // The native filesystem tools run in the Gateway process, not inside
        // the selected host runner. Exposing even read-only tools here would
        // let a host-sandbox session read paths outside its OS boundary.
        // Keep them available for the legacy tool_policy mode, but a named
        // host profile must use its own Bash/Python process boundary instead.
        (usesHostProfile && tool.kind === "filesystem")
        || tool.name === "write_file"
        || tool.name === "edit_file"
        || tool.name === "edit_notebook"
        || uncontrolledHostBridge(tool)
      );
    const denyNetwork = sandbox.network === "deny" && (
      tool.kind === "network"
      || uncontrolledHostBridge(tool)
      || (usesHostProfile && tool.name === "bash" && !sandboxedNetworkBash)
    );
    if (denyStrictHostIsolation || denyHostBridge || denyFilesystem || denyNetwork) hidden.add(tool.name);
  }
  return hidden;
}

function hostProfileRunsExecuteCode(
  sandbox: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"] | undefined,
  hostProfile: GatewayHostSandboxProfile | undefined,
): boolean {
  if (!sandbox || sandbox.type !== "host" || !hostProfile?.supportsExecuteCode) return false;
  if (sandbox.process === "deny") return false;
  if (sandbox.toolIsolation === "strict" && hostProfile.supportsStrictExecuteCode !== true) return false;
  if (sandbox.filesystem === "read_only" && hostProfile.supportsFilesystemReadOnly !== true) return false;
  if (sandbox.filesystem === "deny" && hostProfile.supportsFilesystemDeny !== true) return false;
  if (sandbox.network === "deny" && hostProfile.supportsNetworkDeny !== true) return false;
  return true;
}

function hostSandboxExecuteCodeAllowedTools(
  sandbox: NonNullable<import("../gateway/protocol/types.js").GatewaySessionSdkConfig["sandbox"]>,
  webSearchAvailable: boolean,
): ExecuteCodeHelperToolName[] {
  // Strict profile execution is intentionally Python-only. Do not generate
  // or authorize any helper that could route back through the Gateway into
  // an unprofiled filesystem, network, MCP, or process surface.
  if (sandbox.type === "host" && sandbox.toolIsolation === "strict") return [];
  const allowed = new Set<ExecuteCodeHelperToolName>([
    "web_fetch",
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "glob",
    "bash",
    ...(webSearchAvailable ? ["web_search" as const] : []),
  ]);
  if (sandbox.filesystem === "read_only" || sandbox.filesystem === "deny") {
    // These helpers are dispatched by ToolRuntime in the Gateway process.
    // A host profile may mount its workspace read-only for Python, but that
    // does not make the helper RPC itself profile-owned. Python can still
    // read its mounted workspace directly; do not create an unconfined host
    // filesystem escape hatch through pilotdeck_tools.
    if (sandbox.type === "host") {
      allowed.delete("read_file");
      allowed.delete("grep");
      allowed.delete("glob");
    }
    allowed.delete("write_file");
    allowed.delete("edit_file");
  }
  if (sandbox.filesystem === "deny") {
    allowed.delete("read_file");
    allowed.delete("grep");
    allowed.delete("glob");
  }
  if (sandbox.network === "deny") {
    allowed.delete("web_fetch");
    allowed.delete("web_search");
  }
  return [...allowed];
}

function toManagedPermissionRules(
  value: RestrictivePermissionPolicy | undefined,
): { deny: PermissionRule[]; ask: PermissionRule[] } {
  if (!value) return { deny: [], ask: [] };
  const toRule = (entry: string, behavior: "deny" | "ask"): PermissionRule => {
    const parsed = permissionEntryToRule(entry, "deny", "policy");
    return { ...parsed, behavior };
  };
  return {
    deny: value.deny.map((entry) => toRule(entry, "deny")),
    ask: value.ask.map((entry) => toRule(entry, "ask")),
  };
}

function createSdkHookSettings(
  config: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["hooks"] | undefined,
): import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings {
  if (!config) return {};
  const settings: import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings = {};
  for (const [event, matchers] of Object.entries(config.events)) {
    if (!isNativeHookEvent(event)) continue;
    settings[event] = (matchers ?? []).map((matcher, index) => ({
      ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
      hooks: [{
        type: "http" as const,
        url: appendSdkHookSelector(config.url, event, index),
        ...(config.headers ? { headers: { ...config.headers } } : {}),
      }],
    }));
  }
  return settings;
}

function mergeHookSettings(
  base: import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings,
  extra: import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings,
): import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings {
  const merged: import("../extension/hooks/protocol/settings.js").PilotDeckHooksSettings = { ...base };
  for (const [event, matchers] of Object.entries(extra)) {
    const nativeEvent = event as import("../extension/hooks/protocol/events.js").PilotDeckHookEvent;
    merged[nativeEvent] = [...(base[nativeEvent] ?? []), ...(matchers ?? [])];
  }
  return merged;
}

function appendSdkHookSelector(url: string, event: string, matcher: number): string {
  const endpoint = new URL(url);
  endpoint.searchParams.set("event", event);
  endpoint.searchParams.set("matcher", String(matcher));
  return endpoint.toString();
}

function isNativeHookEvent(value: string): value is import("../extension/hooks/protocol/events.js").PilotDeckHookEvent {
  return ([
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit",
    "PreModelRequest", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart",
    "SubagentStop", "PreCompact", "PostCompact", "PermissionRequest", "PermissionDenied", "Setup",
    "ConfigChange", "InstructionsLoaded", "CwdChanged", "FileChanged", "WorktreeCreate",
    "WorktreeRemove", "Elicitation", "ElicitationResult",
  ] as readonly string[]).includes(value);
}

function sdkSessionConfigEquals(
  left: import("../gateway/protocol/types.js").GatewaySessionSdkConfig | undefined,
  right: import("../gateway/protocol/types.js").GatewaySessionSdkConfig,
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right);
}

function sdkTaskBudgetScope(
  taskBudget: { total: number; scope?: SdkTaskBudgetScope; projectRetentionMs?: number } | undefined,
): SdkTaskBudgetScope {
  return normalizeSdkTaskBudgetScope(taskBudget?.scope);
}

function normalizeSdkTaskBudgetScope(scope: unknown): SdkTaskBudgetScope {
  return scope === "project" ? "project" : "session";
}

function taskBudgetLedgerKey(
  projectRoot: string,
  scope: SdkTaskBudgetScope,
  sessionKey: string,
): string {
  return scope === "project"
    ? `${projectRoot}\u0000project`
    : `${projectRoot}\u0000session\u0000${sessionKey}`;
}

function taskBudgetLedgerIdentity(key: string): {
  projectRoot: string;
  sessionKey: string;
  scope: SdkTaskBudgetScope;
} {
  const projectMarker = "\u0000project";
  if (key.endsWith(projectMarker)) {
    return {
      projectRoot: key.slice(0, -projectMarker.length),
      sessionKey: "__project__",
      scope: "project",
    };
  }
  const sessionMarker = "\u0000session\u0000";
  const markerOffset = key.lastIndexOf(sessionMarker);
  if (markerOffset < 0) throw new Error("Invalid SDK task budget ledger key.");
  return {
    projectRoot: key.slice(0, markerOffset),
    sessionKey: key.slice(markerOffset + sessionMarker.length),
    scope: "session",
  };
}

function isSdkTaskBudgetLedgerRecord(value: unknown): value is SdkTaskBudgetLedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.projectRoot !== "string" || !record.projectRoot
    || typeof record.sessionKey !== "string" || !record.sessionKey) {
    return false;
  }
  if (record.scope !== undefined && record.scope !== "session" && record.scope !== "project") return false;
  if (record.kind === "cleared") return true;
  if (record.kind === "snapshot") {
    return typeof record.spentUsd === "number"
      && Number.isFinite(record.spentUsd)
      && record.spentUsd >= 0
      && Array.isArray(record.settledRunIds)
      && record.settledRunIds.every((runId) => typeof runId === "string" && runId.length > 0)
      && (record.totalUsd === undefined
        || (typeof record.totalUsd === "number" && Number.isFinite(record.totalUsd) && record.totalUsd > 0))
      && hasValidProjectTaskBudgetRetention(record);
  }
  if (record.kind === "configured") {
    return record.scope === "project"
      && typeof record.totalUsd === "number"
      && Number.isFinite(record.totalUsd)
      && record.totalUsd > 0
      && hasValidProjectTaskBudgetRetention(record);
  }
  return record.kind === "settled"
    && typeof record.runId === "string"
    && record.runId.length > 0
    && typeof record.turnSpentUsd === "number"
    && Number.isFinite(record.turnSpentUsd)
    && record.turnSpentUsd >= 0
    && hasValidProjectTaskBudgetActivity(record);
}

function hasValidProjectTaskBudgetRetention(record: Record<string, unknown>): boolean {
  if (record.projectRetentionMs === undefined && record.lastActivityAtMs === undefined) return true;
  return record.scope === "project"
    && typeof record.projectRetentionMs === "number"
    && Number.isSafeInteger(record.projectRetentionMs)
    && record.projectRetentionMs > 0
    && hasValidProjectTaskBudgetActivity(record);
}

function hasValidProjectTaskBudgetActivity(record: Record<string, unknown>): boolean {
  return record.lastActivityAtMs === undefined
    || (record.scope === "project"
      && typeof record.lastActivityAtMs === "number"
      && Number.isSafeInteger(record.lastActivityAtMs)
      && record.lastActivityAtMs >= 0);
}

function mergeAdditionalWorkingDirectories(
  base: string[] | undefined,
  sdk: string[] | undefined,
): string[] {
  return [...new Set([...(base ?? []), ...(sdk ?? [])])];
}

/**
 * Loads SDK-requested plugin directories into an isolated session scope.
 * Paths are resolved by the Gateway host, not the SDK process. A malformed
 * plugin or contribution conflict rejects configuration atomically instead of
 * changing the project's shared PluginRuntime state.
 */
async function resolveSdkSessionPlugins(
  requested: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["plugins"],
  runtime: ProjectRuntime,
  pilotHome: string,
): Promise<SdkSessionPluginScope | undefined> {
  if (!requested || requested.length === 0) return undefined;

  const basePluginNames = new Set(runtime.pluginRuntime.snapshot().map((plugin) => plugin.name));
  const canonicalPaths = new Set<string>();
  const loaded: PilotDeckLoadedPlugin[] = [];
  const rawMcpServers: Record<string, unknown> = {};

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
    const info = await statAsync(pluginPath).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new DialogGatewayError(
        "SDK_PLUGIN_NOT_DIRECTORY",
        `Gateway-local SDK plugin path is not a directory: ${descriptor.path}`,
      );
    }
    if (canonicalPaths.has(pluginPath)) {
      throw new DialogGatewayError(
        "SDK_PLUGIN_DUPLICATE_PATH",
        `Gateway-local SDK plugin path is listed more than once: ${descriptor.path}`,
      );
    }
    canonicalPaths.add(pluginPath);

    let plugin: PilotDeckLoadedPlugin;
    try {
      plugin = await loadPluginFromPath(pluginPath, "project");
    } catch (error) {
      throw new DialogGatewayError(
        "SDK_PLUGIN_LOAD_FAILED",
        `Could not load SDK plugin ${descriptor.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (basePluginNames.has(plugin.name)) {
      throw new DialogGatewayError(
        "SDK_PLUGIN_NAME_CONFLICT",
        `SDK plugin ${plugin.name} conflicts with an already discovered project plugin.`,
      );
    }
    basePluginNames.add(plugin.name);
    for (const [name, config] of Object.entries(plugin.mcpServers ?? {})) {
      if (Object.prototype.hasOwnProperty.call(rawMcpServers, name)) {
        throw new DialogGatewayError(
          "SDK_PLUGIN_MCP_NAME_CONFLICT",
          `Session plugins contribute the MCP server ${name} more than once.`,
        );
      }
      rawMcpServers[name] = config;
    }
    loaded.push(plugin);
  }

  const parsed = parsePluginMcpServers(rawMcpServers);
  if (parsed.diagnostics.length > 0) {
    const first = parsed.diagnostics[0]!;
    throw new DialogGatewayError(
      "SDK_PLUGIN_MCP_INVALID",
      `SDK plugin MCP server ${first.id} is invalid: ${first.message}`,
    );
  }
  const mcpServers = new Map(parsed.servers.map((server) => [
    server.id,
    patchProjectScopedMcpSpec(server, runtime.projectRoot, pilotHome),
  ]));
  return { plugins: loaded, mcpServers };
}

function createSdkSessionExtensionResolver(
  runtime: PluginRuntime | PluginRuntimeView,
  skills: readonly string[] | "all" | undefined,
): ExtensionResolver {
  const base = new PluginRuntimeExtensionResolver(runtime);
  if (!Array.isArray(skills)) return base;
  const visibleSkills = new Set(skills);
  return {
    listCommands: () => base.listCommands(),
    listSkills: () => base.listSkills().filter((skill) => visibleSkills.has(skill.name)),
    listMcpInstructions: () => base.listMcpInstructions(),
  };
}

async function resolveSdkSessionSkills(
  requested: string[],
  runtime: PluginRuntime | PluginRuntimeView,
): Promise<string[]> {
  const available = runtime.getAllSkills();
  const resolved: string[] = [];
  for (const requestedName of requested) {
    const exact = available.filter((skill) => skill.name === requestedName);
    const candidates = exact.length > 0
      ? exact
      : available.filter((skill) => skill.name.endsWith(`:${requestedName}`));
    if (candidates.length === 0) {
      throw new DialogGatewayError(
        "SDK_SKILL_NOT_FOUND",
        `SDK session skill is not available in this project: ${requestedName}`,
      );
    }
    if (candidates.length > 1) {
      throw new DialogGatewayError(
        "SDK_SKILL_AMBIGUOUS",
        `SDK session skill is ambiguous; use its fully-qualified name: ${requestedName}`,
      );
    }
    const canonicalName = candidates[0]!.name;
    if (!resolved.includes(canonicalName)) resolved.push(canonicalName);
  }
  return resolved;
}

function toSdkSubagentDefinitions(
  agents: NonNullable<import("../gateway/protocol/types.js").GatewaySessionSdkConfig["agents"]>,
  projectKey: string,
  env: NodeJS.ProcessEnv,
  assertModelAllowed?: (model: { provider: string; model: string }) => void,
  maxTurnsCap?: number,
): Record<string, import("../agent/sub/builtinSubagentTypes.js").SubagentDefinition> {
  return Object.fromEntries(Object.entries(agents).map(([id, agent]) => {
    const modelOverride = agent.model
      ? resolveSdkSubagentModel(agent.model, projectKey, env, id)
      : undefined;
    const maxTurns = capOrganizationTurnLimit(agent.maxTurns, maxTurnsCap);
    if (modelOverride) assertModelAllowed?.(modelOverride);
    // setSdkSessionConfig() resolves string MCP references into a cloned map
    // before this native definition is constructed.
    const mcpServers = agent.mcpServers as Record<string, import("../gateway/protocol/types.js").GatewayMcpServerConfig> | undefined;
    return [id, {
      id,
      description: agent.description,
      systemPromptSuffix: agent.prompt,
      allowedTools: agent.tools ? [...agent.tools] : ["*"],
      ...(agent.disallowedTools?.length ? { disallowedTools: [...agent.disallowedTools] } : {}),
      omitProjectInstructions: false,
      omitGitStatus: false,
      isReadOnly: agent.permissionMode === "plan",
      ...(modelOverride ? { modelOverride } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...(agent.permissionMode !== undefined ? { permissionMode: agent.permissionMode } : {}),
      ...(mcpServers ? { mcpServers: structuredClone(mcpServers) } : {}),
      ...(agent.skills !== undefined
        ? { skills: agent.skills === "all" ? "all" : [...agent.skills] }
        : {}),
      ...(agent.memory !== undefined ? { memory: agent.memory } : {}),
      ...(agent.initialPrompt !== undefined ? { initialPrompt: agent.initialPrompt } : {}),
      ...(agent.background === true ? { background: true } : {}),
      ...(agent.observer !== undefined ? { observer: agent.observer } : {}),
      ...(agent.observerMessage?.trim() ? { observerMessage: agent.observerMessage.trim() } : {}),
      ...(agent.criticalSystemReminder_EXPERIMENTAL !== undefined
        ? { criticalSystemReminder: agent.criticalSystemReminder_EXPERIMENTAL }
        : {}),
    }];
  }));
}

function resolveSdkSubagentModel(
  requested: string,
  projectKey: string,
  env: NodeJS.ProcessEnv,
  agentId: string,
): { provider: string; model: string } {
  const catalog = listModelCatalog({ projectKey }, env);
  const matches = catalog.items.filter((candidate) => candidate.available && (
    candidate.id === requested
    || `${candidate.provider}/${candidate.model}` === requested
    || candidate.model === requested
  ));
  if (matches.length !== 1 || !matches[0]) {
    throw new DialogGatewayError(
      "INVALID_SDK_AGENT_MODEL",
      `Agent ${agentId} model is not uniquely resolvable from the Gateway catalog: ${requested}`,
    );
  }
  validateExplicitModelSelection(projectKey, {
    mode: "model",
    provider: matches[0].provider,
    model: matches[0].model,
  }, env);
  return { provider: matches[0].provider, model: matches[0].model };
}

/** Resolves the static default selected by a Gateway-owned SDK settings source. */
function resolveSdkSessionSubagentModel(
  requested: string,
  projectKey: string,
  env: NodeJS.ProcessEnv,
): PilotAgentModelSelection {
  const model = resolveSdkSubagentModel(requested, projectKey, env, "settings.agent.subagents.default");
  return { id: `${model.provider}/${model.model}`, ...model };
}

/** Resolves the primary model selected by a Gateway-owned SDK settings source. */
function resolveSdkSessionAgentModel(
  requested: string,
  projectKey: string,
  env: NodeJS.ProcessEnv,
): PilotAgentModelSelection {
  const model = resolveSdkSubagentModel(requested, projectKey, env, "settings.agent.model");
  return { id: `${model.provider}/${model.model}`, ...model };
}

function validateSdkSubagentModels(
  agents: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["agents"],
  projectKey: string,
  env: NodeJS.ProcessEnv,
  assertModelAllowed?: (model: { provider: string; model: string }) => void,
): void {
  for (const [id, agent] of Object.entries(agents ?? {})) {
    if (agent.model) {
      const resolved = resolveSdkSubagentModel(agent.model, projectKey, env, id);
      assertModelAllowed?.(resolved);
    }
  }
}

function resolveSdkFallbackModel(
  requested: string,
  projectKey: string,
  env: NodeJS.ProcessEnv,
): { provider: string; model: string } {
  const catalog = listModelCatalog({ projectKey }, env);
  const matches = catalog.items.filter((candidate) => candidate.available && (
    candidate.id === requested
    || `${candidate.provider}/${candidate.model}` === requested
    || candidate.model === requested
  ));
  if (matches.length !== 1 || !matches[0]) {
    throw new DialogGatewayError(
      "INVALID_SDK_FALLBACK_MODEL",
      `fallbackModel is not uniquely resolvable from the Gateway catalog: ${requested}`,
    );
  }
  validateExplicitModelSelection(projectKey, {
    mode: "model",
    provider: matches[0].provider,
    model: matches[0].model,
  }, env);
  return { provider: matches[0].provider, model: matches[0].model };
}

function validateSdkFallbackModel(
  fallbackModel: string | undefined,
  projectKey: string,
  env: NodeJS.ProcessEnv,
): void {
  if (fallbackModel) resolveSdkFallbackModel(fallbackModel, projectKey, env);
}

/**
 * Resolve dynamic-agent extension scopes before native session creation. A
 * child may narrow its parent's selected skills, but can never expand them.
 * MCP validation uses the same Gateway-owned schema as session MCP servers.
 */
async function resolveSdkSubagentScopes(
  agents: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["agents"],
  parentSkills: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["skills"],
  runtime: PluginRuntime | PluginRuntimeView,
  sessionMcpServers: ReadonlyMap<string, {
    config: import("../gateway/protocol/types.js").GatewayMcpServerConfig;
    enabled: boolean;
  }> | undefined,
): Promise<void> {
  if (!agents) return;
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.memory !== undefined && agent.memory !== "inherit" && agent.memory !== "disabled") {
      throw new DialogGatewayError(
        "INVALID_SDK_AGENT_MEMORY",
        `Agent ${agentId} memory must be "inherit" or "disabled".`,
      );
    }
    if (agent.mcpServers !== undefined) {
      agent.mcpServers = resolveSdkSubagentMcpServers(
        agentId,
        agent.mcpServers,
        sessionMcpServers,
      );
    }
    if (Array.isArray(agent.skills)) {
      const resolved = await resolveSdkSessionSkills(agent.skills, runtime);
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
      // "all" means all skills visible to the parent, not all project skills.
      agent.skills = [...parentSkills];
    } else if (agent.skills === undefined && Array.isArray(parentSkills)) {
      // Preserve the parent session's narrowed extension surface by default.
      agent.skills = [...parentSkills];
    }
  }
}

/**
 * String AgentDefinition MCP specs clone an SDK-session endpoint into the
 * child definition. The child then owns a separate McpRuntime and connection,
 * so toggling or reconnecting the parent session endpoint cannot mutate an
 * active fork's execution surface.
 */
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
      const name = spec.trim();
      if (!name) {
        throw new DialogGatewayError("INVALID_MCP_SERVER", `Agent ${agentId} MCP server reference must not be empty.`);
      }
      if (resolved[name]) {
        throw new DialogGatewayError("INVALID_MCP_SERVER", `Agent ${agentId} repeats MCP server ${name}.`);
      }
      const configured = sessionMcpServers?.get(name);
      if (!configured) {
        throw new DialogGatewayError(
          "SDK_AGENT_MCP_REFERENCE_NOT_FOUND",
          `Agent ${agentId} references SDK-session MCP server ${name}, but it is not configured for this session.`,
        );
      }
      if (!configured.enabled) {
        throw new DialogGatewayError(
          "SDK_AGENT_MCP_REFERENCE_DISABLED",
          `Agent ${agentId} references SDK-session MCP server ${name}, but it is disabled.`,
        );
      }
      resolved[name] = structuredClone(configured.config);
      continue;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new DialogGatewayError(
        "INVALID_MCP_SERVER",
        `Agent ${agentId} MCP specs must be server-name maps or string references.`,
      );
    }
    for (const [name, config] of Object.entries(spec)) {
      const normalizedName = name.trim();
      if (!normalizedName) {
        throw new DialogGatewayError("INVALID_MCP_SERVER", `Agent ${agentId} MCP server name must not be empty.`);
      }
      if (resolved[normalizedName]) {
        throw new DialogGatewayError("INVALID_MCP_SERVER", `Agent ${agentId} repeats MCP server ${normalizedName}.`);
      }
      resolved[normalizedName] = validateSdkMcpServerConfig(normalizedName, config);
    }
  }
  return resolved;
}

function validateSdkMcpServerConfig(
  name: string,
  value: import("../gateway/protocol/types.js").GatewayMcpServerConfig,
): import("../gateway/protocol/types.js").GatewayMcpServerConfig {
  if (!value || typeof value !== "object") {
    throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} must be an object.`);
  }
  const deferredTools = validateSdkDeferredMcpTools(name, value.deferredTools);
  if (value.type === "stdio") {
    if (!value.command?.trim()) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} requires a stdio command.`);
    }
    if (value.args?.some((arg) => typeof arg !== "string")) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} args must be strings.`);
    }
    if (!isStringRecord(value.env)) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} env must be a string map.`);
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} cwd must be a string.`);
    }
    if (!isValidSdkMcpTimeout(value.timeout)) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} timeout must be a positive finite number.`);
    }
    return {
      type: "stdio",
      command: value.command,
      ...(value.args?.length ? { args: [...value.args] } : {}),
      ...(value.env ? { env: { ...value.env } } : {}),
      ...(value.cwd ? { cwd: value.cwd } : {}),
      ...(value.timeout !== undefined ? { timeout: value.timeout } : {}),
      ...(deferredTools.length > 0 ? { deferredTools } : {}),
    };
  }
  if (value.type === "streamable_http" || value.type === "sse") {
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} requires an absolute ${value.type} URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} URL must use http or https.`);
    }
    if (!isStringRecord(value.headers)) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} headers must be a string map.`);
    }
    if (!isValidSdkMcpTimeout(value.timeout)) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} timeout must be a positive finite number.`);
    }
    return {
      type: value.type,
      url: value.url,
      ...(value.headers ? { headers: { ...value.headers } } : {}),
      ...(value.timeout !== undefined ? { timeout: value.timeout } : {}),
      ...(deferredTools.length > 0 ? { deferredTools } : {}),
    };
  }
  throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${name} uses an unsupported transport.`);
}

function validateSdkDeferredMcpTools(
  serverName: string,
  value: import("../gateway/protocol/types.js").GatewayMcpDeferredTool[] | undefined,
): import("../gateway/protocol/types.js").GatewayMcpDeferredTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${serverName} deferredTools must be a non-empty array.`);
  }
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${serverName} deferredTools require non-empty names.`);
    }
    const name = entry.name.trim();
    if (name === "search_tools") {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${serverName} deferredTools cannot include the reserved search_tools name.`);
    }
    if (names.has(name)) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${serverName} deferredTools cannot repeat ${name}.`);
    }
    names.add(name);
    if (entry.searchHint !== undefined && (typeof entry.searchHint !== "string" || !entry.searchHint.trim())) {
      throw new DialogGatewayError("INVALID_MCP_SERVER", `MCP server ${serverName} deferred tool ${entry.name} searchHint must be a non-empty string.`);
    }
    return {
      name,
      ...(entry.searchHint ? { searchHint: entry.searchHint.trim() } : {}),
    };
  });
}

function toSdkMcpServerSpec(
  id: string,
  config: import("../gateway/protocol/types.js").GatewayMcpServerConfig,
): import("../mcp/protocol/types.js").PilotDeckMcpServerSpec {
  if (config.type === "stdio") {
    return {
      id,
      transport: "stdio",
      command: config.command,
      ...(config.args?.length ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
    };
  }
  if (config.type === "sse") {
    return {
      id,
      transport: "sse",
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
    };
  }
  return {
    id,
    transport: "streamable_http",
    url: config.url,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.timeout !== undefined ? { callTimeoutMs: config.timeout } : {}),
  };
}

function sameSdkMcpServer(
  left: { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean } | undefined,
  right: { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean },
): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function deferredSdkMcpToolEntries(
  servers: Map<string, { config: import("../gateway/protocol/types.js").GatewayMcpServerConfig; enabled: boolean }> | undefined,
  registry: ToolRegistry,
  intentionallyHiddenTools: ReadonlySet<string>,
): Array<{ name: string; description: string; searchHint?: string }> {
  if (!servers) return [];
  const entries: Array<{ name: string; description: string; searchHint?: string }> = [];
  for (const [serverName, server] of servers) {
    if (!server.enabled) continue;
    for (const deferred of server.config.deferredTools ?? []) {
      const name = buildMcpToolWireName(serverName, deferred.name);
      if (intentionallyHiddenTools.has(name)) continue;
      const tool = registry.get(name);
      if (!tool) {
        // Host organization policy and SDK sandbox restrictions are applied
        // before deferred discovery. A denied target must stay absent rather
        // than converting an otherwise valid MCP configuration into a
        // session-construction failure.
        if (intentionallyHiddenTools.has(name)) continue;
        throw new DialogGatewayError(
          "SDK_DEFERRED_MCP_TOOL_NOT_FOUND",
          `SDK MCP server ${serverName} did not advertise deferred tool ${deferred.name}.`,
        );
      }
      entries.push({
        name,
        description: tool.description,
        ...(deferred.searchHint ? { searchHint: deferred.searchHint } : {}),
      });
    }
  }
  return entries;
}

/**
 * Build catalog entries only from tools that survived Gateway policy and
 * availability filtering. An intentionally hidden target is silently absent
 * from the catalog; an unknown or unavailable requested name is a caller
 * configuration error rather than a fake search result.
 */
function deferredSdkNativeToolEntries(
  deferredTools: import("../gateway/protocol/types.js").GatewaySessionSdkConfig["deferredTools"],
  registry: ToolRegistry,
  intentionallyHiddenTools: ReadonlySet<string>,
): Array<{ name: string; description: string; searchHint?: string }> {
  if (!deferredTools) return [];
  const entries: Array<{ name: string; description: string; searchHint?: string }> = [];
  for (const deferred of deferredTools) {
    const name = deferred.name.trim();
    if (intentionallyHiddenTools.has(name)) continue;
    const tool = registry.get(name);
    if (!tool) {
      if (intentionallyHiddenTools.has(name)) continue;
      throw new DialogGatewayError(
        "SDK_DEFERRED_TOOL_NOT_FOUND",
        `SDK deferred tool ${name} is not available in this session.`,
      );
    }
    entries.push({
      name: tool.name,
      description: tool.description,
      ...(deferred.searchHint ? { searchHint: deferred.searchHint } : {}),
    });
  }
  return entries;
}

function mergeDeferredToolSearchEntries(
  ...sources: Array<Array<{ name: string; description: string; searchHint?: string }>>
): Array<{ name: string; description: string; searchHint?: string }> {
  const byName = new Map<string, { name: string; description: string; searchHint?: string }>();
  for (const source of sources) {
    for (const entry of source) {
      // An explicit session entry takes precedence over MCP metadata only by
      // source order. Either way, the actual registry definition is shared.
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function explicitHiddenToolNames(
  context: Pick<GatewaySessionContext, "allowedTools" | "disallowedTools">,
  tools: readonly PilotDeckToolDefinition[],
): Set<string> {
  if (context.allowedTools === undefined && context.disallowedTools === undefined) return new Set();
  const allowed = new Set(context.allowedTools ?? []);
  const denied = new Set(context.disallowedTools ?? []);
  return new Set(tools
    .filter((tool) => (context.allowedTools !== undefined && !allowed.has(tool.name)) || denied.has(tool.name))
    .map((tool) => tool.name));
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isValidSdkMcpTimeout(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function mergeSessionDependencies(
  base: CreateAgentSessionOptions["dependencies"],
  extension: Partial<
    Pick<
      AgentRuntimeDependencies,
      "context" | "createSubagentContext" | "createSubagentToolRegistry" | "backgroundSubagents" | "observerSubagents" | "fileHistory" | "fileUpdateNotifier" | "subagentTranscript" | "elicitation" | "userDialog" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager"
    >
  >,
): CreateAgentSessionOptions["dependencies"] {
  return {
    ...base,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.createSubagentContext ? { createSubagentContext: extension.createSubagentContext } : {}),
    ...(extension.createSubagentToolRegistry ? { createSubagentToolRegistry: extension.createSubagentToolRegistry } : {}),
    ...(extension.backgroundSubagents ? { backgroundSubagents: extension.backgroundSubagents } : {}),
    ...(extension.observerSubagents ? { observerSubagents: extension.observerSubagents } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.fileUpdateNotifier ? { fileUpdateNotifier: extension.fileUpdateNotifier } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.userDialog ? { userDialog: extension.userDialog } : {}),
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
  if (router?.enabled === false) {
    return { enabled: false };
  }
  if (router) {
    // Scenarios is optional at the parse boundary (see schema.ts) — the UI
    // can persist a partial `router:` block, e.g. user toggled `enabled`
    // and seeded `tokenSaver.*` without ever opening the Scenarios editor.
    // Fill `scenarios.default` from `agent.model` so RouterRuntime always
    // sees a valid map.
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

function readPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
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

function normalizeMcpPermissionSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return normalized || value;
}

function recoveredUserDialogPurpose(requestId: string): string {
  return `gateway_user_dialog_recovery:${requestId}`;
}

const HOSTED_USER_DIALOG_OWNER_TTL_MS = 5_000;

/** Cross-Gateway live rendering is opt-in and requires the whole atomic host protocol. */
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

/** Optional owner heartbeat lets a host recover after the owning Gateway dies. */
function hasLiveUserDialogOwnerStore(
  store: GatewayUserDialogStore | undefined,
): store is GatewayUserDialogStore & Required<Pick<
  GatewayUserDialogStore,
  "claimLiveOwner" | "renewLiveOwner" | "releaseLiveOwner"
>> {
  return Boolean(
    store?.claimLiveOwner
    && store.renewLiveOwner
    && store.releaseLiveOwner,
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
