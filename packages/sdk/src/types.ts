import type { SessionStore, SessionStoreFlush } from "./session-store.js";

export type PilotDeckPermissionMode = "default" | "plan" | "bypassPermissions" | "acceptEdits" | "dontAsk" | "auto";

export type PilotDeckTextMessage = {
  type: "text";
  text: string;
};

/**
 * Text-oriented input accepted by the SDK. The `user` shape mirrors Claude's
 * streaming SDK messages while the compact `text` shape remains convenient
 * for PilotDeck-native callers and steer() input.
 */
export type PilotDeckUserMessage = PilotDeckTextMessage | {
  type: "user";
  message: {
    role: "user";
    content: string | Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id?: string | null;
};

/** User input accepted by a run/steer handle. Includes Claude-shaped messages. */
export type PilotDeckInput = PilotDeckUserMessage;

export type PilotDeckConnectionOptions = {
  gatewayUrl: string;
  authToken: string;
  clientVersion?: string;
  reconnect?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
  };
};

/** Connection-only options for the Gateway-hosted `resolveSettings()` query. */
export type PilotDeckResolveSettingsOptions = PilotDeckConnectionOptions & {
  timeoutMs?: number;
};

/**
 * Gateway-owned, non-secret portion of `pilotdeck.yaml` accepted by
 * `Query.updateSettings("localSettings", ...)`. A `null` leaf removes the
 * corresponding local override. Provider credentials, arbitrary plugin
 * paths, and all settings sources other than the Gateway host remain outside
 * this API.
 */
export type PilotDeckLocalSettingsUpdate = {
  agent?: {
    maxContextTokens?: number | null;
    maxOutputTokens?: number | null;
    thinking?: { enabled: boolean; budgetTokens?: number } | null;
    subagents?: {
      /** A native `provider/model` reference or `"inherit"`; null clears it. */
      default?: string | null;
      timeoutMs?: number | null;
      /** Maximum nested `agent` fork depth; zero disables forks, null clears it. */
      maxDepth?: number | null;
    } | null;
  };
  extension?: {
    includeHookEvents?: boolean | null;
    /** Enable/disable known built-in plugins; custom plugin paths are never writable here. */
    builtinPluginsEnabled?: Record<string, boolean> | null;
  };
  tools?: {
    /** Controls an existing host web-search configuration without touching its credentials. */
    webSearch?: { enabled?: boolean | null };
  };
};

/**
 * Restrictive, session-scoped policy controls for an embedding host. This is
 * deliberately narrower than Claude's Settings object: it can only deny or
 * require approval for tool patterns, hide model-visible tools, force native
 * plan mode, or disable permission prompts. It cannot grant permissions,
 * select a model, write configuration files, or expose credentials.
 */
export type PilotDeckManagedSettings = {
  permissions?: {
    /** PilotDeck/Claude-style tool entries, for example `Bash(git push *)`. */
    deny?: string[];
    /** Tool entries that must remain interactive even in bypassPermissions mode. */
    ask?: string[];
    /** The only managed mode override because it is stricter than a normal run. */
    defaultMode?: "plan";
    /** Policy may disable prompts but cannot re-enable them. */
    canPrompt?: false;
  };
  /**
   * Restrictive model-visible tool selectors. An entry is an exact tool name,
   * a `prefix*` selector, or `*`; deny wins over allow. Gateway applies this
   * after native/extension/MCP discovery, so it cannot register a tool or
   * bypass host policy.
   */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  /**
   * Restrictive model selectors. Entries are `provider/model`, `provider/*`,
   * or `*`; deny wins over allow. This only validates the Gateway's eventual
   * primary, fallback, and subagent selections and never carries provider
   * configuration or credentials.
   */
  models?: {
    allow?: string[];
    deny?: string[];
  };
};

/**
 * Non-secret session settings overlaid by the Gateway while it constructs one
 * native AgentSession. This is intentionally not a general YAML/config API:
 * provider/model credentials, plugins, paths, tools, and permission grants
 * remain owned by the Gateway host.
 */
export type PilotDeckSessionSettings = {
  agent?: {
    /** Session-local primary model; null retains the Gateway host's default model. */
    model?: string | null;
    /** Session-local fallback model; null disables a fallback inherited from a source. */
    fallbackModel?: string | null;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    thinking?: { enabled: boolean; budgetTokens?: number };
    /** Session-local fork model; use null or "inherit" to inherit the parent model. */
    subagents?: {
      default?: string | null;
      timeoutMs?: number;
      /** Maximum nested `agent` fork depth; zero disables subagent forks. */
      maxDepth?: number;
    };
  };
};

/** Gateway-hosted source layers that may contribute supported session settings. */
export type PilotDeckSettingSource = "managed" | "user" | "project" | "local";

/**
 * A session-local tool withheld from the initial model schema. The name is
 * the canonical Gateway tool name, including native, plugin, or MCP names.
 * `search_tools` is reserved and cannot itself be deferred.
 */
export type PilotDeckDeferredTool = { name: string; searchHint?: string };

export type PilotDeckOptions = {
  /** Connection fields are optional when supplied through createPilotDeckClient/query defaults. */
  gatewayUrl?: string;
  authToken?: string;
  clientVersion?: string;
  projectKey?: string;
  sessionId?: string;
  channelKey?: string;
  cwd?: string;
  /** Claude-compatible option shape; PilotDeck has no CLI subprocess agent selector. */
  agent?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: PilotDeckThinkingConfig;
  maxThinkingTokens?: number | null;
  enableFileCheckpointing?: boolean;
  outputFormat?: PilotDeckOutputFormat;
  systemPrompt?: string | string[] | {
    type: "preset";
    preset: "claude_code";
    append?: string;
    excludeDynamicSections?: boolean;
    snapshot?: boolean;
  } | {
    type: "custom";
    prompt: string | string[];
    snapshot?: boolean;
  };
  appendSystemPrompt?: string;
  /** Gateway-owned output-style name; applied when the next session turn is built. */
  outputStyle?: string;
  additionalDirectories?: string[];
  toolAliases?: Record<string, string>;
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  /** Claude option compatibility fields. Unsupported fields are rejected explicitly. */
  env?: Record<string, string | undefined>;
  executable?: "bun" | "deno" | "node";
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  fallbackModel?: string;
  betas?: string[];
  toolConfig?: PilotDeckToolConfig;
  /**
   * Tools withheld from the initial schema until the Gateway-owned
   * `search_tools` catalog matches them. This only changes model visibility;
   * the existing ToolRuntime, permission, scheduler, and handler ownership
   * remain unchanged.
   */
  deferredTools?: PilotDeckDeferredTool[];
  maxTurns?: number;
  /** Gateway-owned USD budget for the lifetime of this SDK session. */
  maxBudgetUsd?: number;
  /**
   * Gateway-owned USD budget. `session` (the default) applies to one SDK
   * session; `project` shares one Gateway-owned ceiling across every SDK
   * session for the same Gateway project. For a project budget,
   * `projectRetentionMs` optionally starts a new Gateway-owned ledger after
   * that much inactivity. The SDK never accumulates streamed events to
   * enforce either form.
   */
  taskBudget?: {
    total: number;
    scope?: "session" | "project";
    /** Positive millisecond inactivity window; only valid with `scope: "project"`. */
    projectRetentionMs?: number;
  };
  loadTimeoutMs?: number;
  pathToClaudeCodeExecutable?: string;
  planModeInstructions?: string;
  allowDangerouslySkipPermissions?: boolean;
  permissionPromptToolName?: string;
  permissionPrompts?: "host" | "none";
  plugins?: PilotDeckPluginConfig[];
  pluginDelivery?: "argv" | "initialize";
  promptSuggestions?: boolean;
  /**
   * Opt in to transient `tool.progress` messages for native tools that expose
   * progress. This does not create generic dialog/progress semantics.
   */
  agentProgressSummaries?: boolean;
  /**
   * Opt in to typed text deltas emitted by child agents. These are exposed as
   * `subagent.message`, never folded into the parent assistant output or
   * persisted as a parent transcript message.
   */
  forwardSubagentText?: boolean;
  resumeSessionAt?: string;
  resumeDropsTurn?: string;
  sandbox?: PilotDeckSandboxSettings;
  /** Gateway-owned, non-persistent session overlay for supported agent settings. */
  settings?: PilotDeckSessionSettings;
  managedSettings?: PilotDeckManagedSettings;
  /** Select Gateway-owned managed/user/project/local sources for the supported overlay. */
  settingSources?: PilotDeckSettingSource[];
  /**
   * Session-scoped skill visibility. "all" and an omitted value preserve the
   * project's native skill surface; an array is resolved by the Gateway.
   */
  skills?: string[] | "all";
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
  strictMcpConfig?: boolean;
  title?: string;
  /** Claude's process-spawn escape hatch has no Gateway equivalent. */
  spawnClaudeCodeProcess?: unknown;
  timeoutMs?: number;
  reconnect?: PilotDeckConnectionOptions["reconnect"];
  permissionMode?: PilotDeckPermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  onElicitation?: OnElicitation;
  onUserDialog?: OnUserDialog;
  /**
   * Surface opted-in generic dialog events to the caller without invoking an
   * SDK callback. The caller must answer through `Query.respondUserDialog()`
   * or `client.dialogs.respond()` before the Gateway-owned turn can continue.
   */
  userDialogMode?: "manual";
  supportedDialogKinds?: PilotDeckUserDialogKind[];
  /**
   * Emit streamed assistant text/thinking deltas. Defaults to false, matching
   * Claude's SDK contract; `result()` still aggregates the final text.
   */
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  mcpServers?: Record<string, PilotDeckMcpServerConfig>;
  agents?: Record<string, PilotDeckAgentDefinition>;
  hooks?: PilotDeckHooks;
  /** Bind/public endpoint settings for SDK-hosted hook callbacks. */
  hookServer?: PilotDeckHookServerStartOptions;
  abortController?: AbortController;
  /** Optional append-only mirror. Gateway remains the source of truth. */
  sessionStore?: SessionStore;
  sessionStoreFlush?: SessionStoreFlush;
};

/** Narrow compatibility shape for Claude's per-tool configuration option. */
export type PilotDeckToolConfig = {
  askUserQuestion?: { previewFormat?: "markdown" | "html" };
};

/**
 * A plugin directory resolved by the Gateway host. The path is never read by
 * the SDK client, so remote callers must use a path visible to that Gateway.
 */
export type PilotDeckPluginConfig = {
  type: "local";
  path: string;
};

/** Gateway-owned, restrictive model-visible tool policy. */
export type PilotDeckToolPolicySandboxSettings = {
  /** Optional explicit marker for the default tool-surface policy. */
  type?: "tool_policy";
  /**
   * `read_only` removes write/edit tools; `deny` removes every native
   * filesystem tool. Both modes also remove host/custom bridges that could
   * bypass the model-visible filesystem policy.
   */
  filesystem?: "read_only" | "deny";
  /** Removes known network tools and host/custom bridges that could issue requests. */
  network?: "deny";
  /** Removes shell/code/task execution and MCP/custom/subagent host bridges. */
  process?: "deny";
};

/**
 * A profile installed by the Gateway host. The SDK only names the profile;
 * the host owns the executable, filesystem mounts, environment, process and
 * network boundary. Uncontrolled process bridges are removed for this
 * session, so a model cannot bypass the selected command runner.
 */
export type PilotDeckHostSandboxSettings = {
  type: "host";
  profile: string;
  /**
   * `strict` hides every host-facing tool except the profile-owned `bash`
   * runner and Gateway-local output/dialog tools. Use this when callers need
   * to ensure native file, MCP, custom, network, and subagent tools cannot
   * bypass the host profile's OS boundary.
   */
  toolIsolation?: "strict";
  /** Makes both host file tools and the selected runner workspace read-only. */
  filesystem?: "read_only" | "deny";
  /** Requests the selected host profile's network-deny boundary. */
  network?: "deny";
  /** Removes all process tools, including the selected host runner. */
  process?: "deny";
};

export type PilotDeckSandboxSettings =
  | PilotDeckToolPolicySandboxSettings
  | PilotDeckHostSandboxSettings;

export type PilotDeckThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };
export type PilotDeckOutputFormat = { type: "json_schema"; schema: Record<string, unknown> };
export type PilotDeckElicitationRequest = {
  requestId: string;
  sessionId: string;
  runId?: string;
  questions: unknown[];
  metadata?: Record<string, unknown>;
  /** Claude MCP elicitation fields when provided by the native server. */
  mode?: string;
  message?: string;
  requestedSchema?: unknown;
};
export type PilotDeckElicitationResult = { action: "accept" | "decline" | "cancel"; content?: unknown };
export type OnElicitation = (request: PilotDeckElicitationRequest, context: { signal: AbortSignal }) => Promise<PilotDeckElicitationResult> | PilotDeckElicitationResult;
export type PilotDeckUserDialogStringFormat = "email" | "uri" | "uuid" | "date" | "time" | "date-time";
export type PilotDeckUserDialogFormFieldSchema = {
  /** A reusable root definition reference in the form `#/$defs/<name>`. */
  $ref?: `#/$defs/${string}`;
  type?: string | string[];
  title?: string;
  description?: string;
  /** Gateway validates this format when the answer is a string. */
  format?: PilotDeckUserDialogStringFormat;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, PilotDeckUserDialogFormFieldSchema>;
  patternProperties?: Record<string, PilotDeckUserDialogFormFieldSchema>;
  required?: string[];
  additionalProperties?: boolean | PilotDeckUserDialogFormFieldSchema;
  items?: PilotDeckUserDialogFormFieldSchema;
  prefixItems?: PilotDeckUserDialogFormFieldSchema[];
  contains?: PilotDeckUserDialogFormFieldSchema;
  minContains?: number;
  maxContains?: number;
  propertyNames?: PilotDeckUserDialogFormFieldSchema;
  /** Gateway validates bounded JSON Schema composition branches. */
  allOf?: PilotDeckUserDialogFormFieldSchema[];
  anyOf?: PilotDeckUserDialogFormFieldSchema[];
  oneOf?: PilotDeckUserDialogFormFieldSchema[];
  not?: PilotDeckUserDialogFormFieldSchema;
  /** Gateway validates this bounded conditional schema; it is not full JSON Schema. */
  if?: PilotDeckUserDialogFormFieldSchema;
  then?: PilotDeckUserDialogFormFieldSchema;
  else?: PilotDeckUserDialogFormFieldSchema;
  /** When the trigger property is present, every listed declared property is required. */
  dependentRequired?: Record<string, string[]>;
  /** When the trigger property is present, Gateway validates the whole object against this schema. */
  dependentSchemas?: Record<string, PilotDeckUserDialogFormFieldSchema>;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  [key: string]: unknown;
};

/**
 * Gateway-validated portable form-schema subset. It supports typed object,
 * string, number, array, nested-object and bounded composition constraints.
 * It supports only root-local `$defs` and `#/$defs/<name>` references, not
 * arbitrary JSON Pointer or external references, and is not full JSON Schema.
 */
export type PilotDeckUserDialogFormSchema = PilotDeckUserDialogFormFieldSchema & {
  type: "object";
  /** Reusable root-local schema definitions for the restricted `$ref` subset. */
  $defs?: Record<string, PilotDeckUserDialogFormFieldSchema>;
};

export type PilotDeckUserDialogKind = "elicitation" | "input" | "select" | "confirm" | "form";
export type PilotDeckUserDialogRequest =
  | {
      requestId: string;
      dialogKind: "elicitation";
      payload: {
        sessionId: string;
        runId?: string;
        toolCallId?: string;
        toolName?: string;
        previewFormat?: "html" | "markdown";
        questions: unknown[];
        metadata?: Record<string, unknown>;
      };
    }
  | {
      requestId: string;
      dialogKind: "input";
      payload: {
        sessionId: string;
        runId?: string;
        toolCallId: string;
        toolName: string;
        prompt: string;
        placeholder?: string;
        allowEmpty?: boolean;
      };
    }
  | {
      requestId: string;
      dialogKind: "select";
      payload: {
        sessionId: string;
        runId?: string;
        toolCallId: string;
        toolName: string;
        prompt: string;
        choices: Array<{ value: string; label?: string; description?: string }>;
        defaultValue?: string;
      };
    }
  | {
      requestId: string;
      dialogKind: "confirm";
      payload: {
        sessionId: string;
        runId?: string;
        toolCallId: string;
        toolName: string;
        prompt: string;
        confirmLabel?: string;
        cancelLabel?: string;
        defaultValue?: boolean;
      };
    }
  | {
      requestId: string;
      dialogKind: "form";
      payload: {
        sessionId: string;
        runId?: string;
        toolCallId: string;
        toolName: string;
        prompt: string;
        schema: PilotDeckUserDialogFormSchema;
      };
    };
export type PilotDeckUserDialogResult =
  | { behavior: "answered"; value?: unknown }
  | { behavior: "cancelled"; reason?: string };
export type OnUserDialog = (request: PilotDeckUserDialogRequest, context: { signal: AbortSignal }) => Promise<PilotDeckUserDialogResult> | PilotDeckUserDialogResult;
/**
 * Terminal context for a dialog that was pending when its Gateway process
 * stopped. The original AgentLoop promise is gone and never resumes. A
 * renderer may answer this record once; Gateway validates and persists the
 * answer as context for the next newly submitted turn.
 */
export type PilotDeckRecoveredUserDialog = {
  type: "user_dialog_terminated";
  request: PilotDeckUserDialogRequest;
  reason: "gateway_restarted";
  terminatedAt: string;
  /** A valid response is written as context for a later newly submitted turn. */
  recovery?: "next_turn_context";
};
/** Observable metadata for a live renderer lease. The bearer id is never listed. */
export type PilotDeckUserDialogLeaseStatus = { expiresAt: string };
export type PilotDeckPendingUserDialog = PilotDeckUserDialogRequest & {
  lease?: PilotDeckUserDialogLeaseStatus;
};
export type PilotDeckUserDialogRecord = PilotDeckPendingUserDialog | PilotDeckRecoveredUserDialog;
export type PilotDeckUserDialogResourceInput = { sessionId: string; projectKey?: string };
export type PilotDeckUserDialogResponseInput = PilotDeckUserDialogResourceInput & {
  requestId: string;
  result: PilotDeckUserDialogResult;
  /** Opaque bearer id returned by dialogs.claim(); required while a live dialog is claimed. */
  leaseId?: string;
};
export type PilotDeckUserDialogResponseReceipt = {
  delivered: boolean;
  /** Gateway durably stored a restart-recovery answer for the next new turn. */
  recovered?: true;
  /** The response targeted a dialog left by a prior Gateway process. */
  reason?: "gateway_restarted";
};
/** Atomically reserves a live dialog for one renderer, or renews a matching lease. */
export type PilotDeckUserDialogClaimInput = PilotDeckUserDialogResourceInput & {
  requestId: string;
  /** 1,000 through 300,000 milliseconds; omitted uses the Gateway default. */
  ttlMs?: number;
  /** Pass the current id to renew its expiry without opening a second claim. */
  leaseId?: string;
};
export type PilotDeckUserDialogClaimResult =
  | { claimed: true; leaseId: string; expiresAt: string }
  | { claimed: false; reason: "claimed" | "not_pending"; expiresAt?: string };
/**
 * A best-effort change hint for a Gateway-owned generic dialog. It is not a
 * durable event log: after reconnect or missed delivery, call dialogs.list()
 * before rendering or responding.
 */
export type PilotDeckUserDialogChange =
  | {
      type: "requested";
      sessionId: string;
      projectKey?: string;
      request: PilotDeckPendingUserDialog;
    }
  | {
      type: "lease_changed";
      sessionId: string;
      projectKey?: string;
      requestId: string;
      action: "claimed" | "released" | "expired";
      expiresAt?: string;
    }
  | {
      type: "settled";
      sessionId: string;
      projectKey?: string;
      requestId: string;
      reason: string;
    };
export type PilotDeckUserDialogReleaseInput = PilotDeckUserDialogResourceInput & {
  requestId: string;
  leaseId: string;
};

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionRequestContext,
) => Promise<PermissionDecision> | PermissionDecision;

export type PermissionRequestContext = {
  requestId: string;
  sessionId: string;
  runId?: string;
  signal: AbortSignal;
  /** Claude-compatible optional presentation/policy metadata when supplied by the Gateway. */
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  agentID?: string;
};

export type PermissionDecision =
  | { behavior: "allow"; remember?: boolean; reason?: string; message?: string }
  | { behavior: "deny"; remember?: boolean; message?: string; reason?: string };

/** Claude Agent SDK hook event names. Only events emitted by the native PilotDeck lifecycle are accepted at runtime. */
export type PilotDeckHookEvent =
  | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch"
  | "Notification" | "UserPromptSubmit" | "UserPromptExpansion"
  | "SessionStart" | "SessionEnd" | "Stop" | "StopFailure"
  | "SubagentStart" | "SubagentStop" | "PreCompact" | "PostCompact"
  | "PreModelSwitch" | "PostModelSwitch" | "PermissionRequest" | "PermissionDenied"
  | "Setup" | "TeammateIdle" | "TaskCreated" | "TaskCompleted"
  | "Elicitation" | "ElicitationResult" | "ConfigChange"
  | "WorktreeCreate" | "WorktreeRemove" | "InstructionsLoaded"
  | "CwdChanged" | "FileChanged" | "DirectoryAdded" | "MessageDisplay"
  /** PilotDeck's native pre-model lifecycle event. */
  | "PreModelRequest";

/**
 * Claude-compatible hook payload shape. The SDK projects PilotDeck's native
 * camelCase lifecycle payload at the process boundary; nested tool input is
 * deliberately opaque and keeps its tool-defined schema.
 */
export type PilotDeckHookInput = Record<string, unknown> & {
  hook_event_name: PilotDeckHookEvent;
  session_id: string;
  cwd: string;
  transcript_path: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
};

export type PilotDeckHookPermissionRequestResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

export type PilotDeckHookSpecificOutput = {
  hookEventName: PilotDeckHookEvent;
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  /** Claude's `defer` is projected to PilotDeck's native `passthrough`. */
  permissionDecision?: "allow" | "deny" | "ask" | "defer";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  decision?: PilotDeckHookPermissionRequestResult;
  retry?: boolean;
  worktreePath?: string;
};

/** JSON result shape intentionally mirrors Claude's synchronous hook output. */
export type PilotDeckHookSyncJSONOutput = {
  async?: false;
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: PilotDeckHookSpecificOutput;
};

/**
 * Defers a hook result. `asyncTimeout` is measured in seconds, matching the
 * hook matcher timeout. The callback receives `asyncHookId`; submit one
 * `PilotDeckHookSyncJSONOutput` through `Query.submitAsyncHookResult()`
 * before that deadline.
 */
export type PilotDeckHookAsyncJSONOutput = {
  async: true;
  asyncTimeout?: number;
};

export type PilotDeckHookJSONOutput = PilotDeckHookSyncJSONOutput | PilotDeckHookAsyncJSONOutput;

export type PilotDeckHookCallback = (
  input: PilotDeckHookInput,
  toolUseId: string | undefined,
  options: {
    signal: AbortSignal;
    /** Stable only for this callback invocation when it returns `{ async: true }`. */
    asyncHookId: string;
  },
) => Promise<PilotDeckHookJSONOutput | void> | PilotDeckHookJSONOutput | void;

/** Result of submitting a deferred hook output to the Gateway-owned registry. */
export type PilotDeckAsyncHookResult = {
  invocationId: string;
  /** `delivered` means the context was accepted by the active turn's steer mailbox. */
  status: "delivered" | "duplicate" | "expired" | "unknown";
};

export type PilotDeckHookCallbackMatcher = {
  matcher?: string;
  hooks: PilotDeckHookCallback[];
  /** Timeout in seconds for this matcher callback group. */
  timeout?: number;
};

export type PilotDeckHooks = Partial<Record<PilotDeckHookEvent, PilotDeckHookCallbackMatcher[]>>;

export type PilotDeckHookServerStartOptions = {
  host?: string;
  port?: number;
  path?: string;
  /** Public full endpoint URL required when a remote Gateway cannot reach the bound host. */
  publicUrl?: string;
};

/** A deferred MCP tool is omitted from the initial model schema until `search_tools` matches it. */
export type PilotDeckMcpDeferredTool = PilotDeckDeferredTool;

export type PilotDeckMcpTransportConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; timeout?: number; deferredTools?: PilotDeckMcpDeferredTool[] }
  /** Claude's HTTP descriptor is a compatibility alias for streamable HTTP. */
  | { type: "http"; url: string; headers?: Record<string, string>; timeout?: number; deferredTools?: PilotDeckMcpDeferredTool[] }
  | { type: "streamable_http"; url: string; headers?: Record<string, string>; timeout?: number; deferredTools?: PilotDeckMcpDeferredTool[] }
  /** Legacy MCP SSE transport. New integrations should prefer streamable_http. */
  | { type: "sse"; url: string; headers?: Record<string, string>; timeout?: number; deferredTools?: PilotDeckMcpDeferredTool[] }
  /** In-process Claude SDK server descriptors have no remote Gateway equivalent. */
  | { type: "sdk"; instance: unknown; timeout?: number }
  /** Claude AI proxy servers are provider-specific and not owned by PilotDeck. */
  | { type: "claude_ai_proxy"; url?: string; headers?: Record<string, string>; timeout?: number };

/**
 * PilotDeck-native memory visibility for one dynamic AgentDefinition.
 * `inherit` uses the Gateway project's configured memory resolver; `disabled`
 * suppresses retrieval and turn capture for that fork only.
 */
export type PilotDeckAgentMemoryMode = "inherit" | "disabled";

/** Configuration for a MCP endpoint hosted by the SDK caller's Node.js process. */
export type PilotDeckMcpServerStartOptions = {
  /** Bind address. Defaults to loopback (127.0.0.1). */
  host?: string;
  /** TCP port. Defaults to an ephemeral port. */
  port?: number;
  /** HTTP path serving the MCP endpoint. Defaults to /mcp. */
  path?: string;
  /**
   * Externally reachable base URL. Required when the Gateway cannot reach
   * the bound address directly (for example, a remote Gateway behind a tunnel).
   */
  publicUrl?: string;
};

/** Options for `createPilotDeckMcpServer` / `createSdkMcpServer`. */
export type PilotDeckMcpServerOptions = {
  name: string;
  version?: string;
  /** MCP initialize instructions surfaced to the connected PilotDeck runtime. */
  instructions?: string;
  tools?: PilotDeckToolDefinition[];
  /**
   * Claude-compatible server-level loading hint. `false` keeps its tools out
   * of the first model schema and exposes session-local `search_tools`.
   */
  alwaysLoad?: boolean;
  /** Per-tool-call wall-clock timeout, in milliseconds. */
  timeout?: number;
};

/**
 * Session-scoped definition consumed by PilotDeck's existing `agent` tool.
 * The host retains scheduling, session, transcript and permission ownership.
 */
export type PilotDeckAgentDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  /** Native subagent reasoning effort override, when supported by the host. */
  effort?: "low" | "medium" | "high";
  permissionMode?: Extract<PilotDeckPermissionMode, "default" | "plan" | "bypassPermissions">;
  /**
   * Gateway-resolved model catalog reference for this subagent. It may be a
   * unique model id or a `provider/model` pair; the SDK does not resolve it
   * locally.
   */
  model?: string;
  /**
   * Fork-local MCP endpoints, or references to already configured SDK-session
   * MCP endpoints. String references are resolved by the Gateway before the
   * native child session is constructed.
   */
  mcpServers?: Record<string, PilotDeckMcpServerConfig> | PilotDeckAgentMcpServerSpec[];
  skills?: string[] | "all";
  initialPrompt?: string;
  background?: boolean;
  memory?: PilotDeckAgentMemoryMode;
  /**
   * Agent-definition name that observes this child run. The observer receives
   * a bounded, read-only activity digest after the observed child finishes;
   * its report is kept out of the parent agent's model context.
   */
  observer?: string;
  /** Optional postamble appended to the observer activity digest. */
  observerMessage?: string;
  criticalSystemReminder_EXPERIMENTAL?: string;
};

export type PilotDeckToolExtras = {
  annotations?: { readOnly?: boolean; destructive?: boolean };
  searchHint?: string;
  alwaysLoad?: boolean;
};

export type PilotDeckToolHandler<T = unknown> = (
  input: T,
  context: { signal: AbortSignal; toolUseId?: string },
) => Promise<PilotDeckToolResult>;

export type PilotDeckToolResult = {
  content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

export type PilotDeckToolDefinition<Input = unknown, Schema = unknown> = {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: PilotDeckToolHandler<Input>;
  extras?: PilotDeckToolExtras;
};

/** Structural adapter accepted by createLocalGateway({ extraTools }). */
export type PilotDeckEmbeddedToolDefinition<Input = unknown, Schema = unknown> = {
  name: string;
  description: string;
  kind: "custom";
  inputSchema: Schema;
  alwaysLoad?: boolean;
  searchHint?: string;
  isReadOnly(input: unknown): boolean;
  isConcurrencySafe(input: unknown): boolean;
  isDestructive?(input: unknown): boolean;
  execute(input: unknown, context: any): Promise<any>;
};

export type PilotDeckMcpServer = {
  name: string;
  version?: string;
  instructions?: string;
  alwaysLoad?: boolean;
  /** Deferred hosted-tool metadata sent to the Gateway with the endpoint. */
  readonly deferredTools: PilotDeckMcpDeferredTool[];
  tools: PilotDeckToolDefinition[];
  /** Starts the hosted MCP endpoint and returns its Gateway configuration. Idempotent. */
  start(options?: PilotDeckMcpServerStartOptions): Promise<Extract<PilotDeckMcpTransportConfig, { type: "streamable_http" }>>;
  /** Stops the endpoint and aborts any active handler invocations. Idempotent. */
  close(): Promise<void>;
  /** The endpoint configuration after start(), otherwise undefined. */
  readonly config?: Extract<PilotDeckMcpTransportConfig, { type: "streamable_http" }>;
};

/** A configured external MCP server or an SDK-hosted createPilotDeckMcpServer(). */
export type PilotDeckMcpServerConfig = PilotDeckMcpTransportConfig | PilotDeckMcpServer;

/**
 * Claude-shaped per-agent MCP specification. A string references an enabled
 * endpoint already configured for the owning SDK session; object entries
 * remain fork-local endpoint definitions.
 */
export type PilotDeckAgentMcpServerSpec = string | Record<string, PilotDeckMcpServerConfig>;

export type PilotDeckMcpServerStatus = PilotDeckMcpStatus;

export type PilotDeckWarmQuery = {
  query(prompt: string | AsyncIterable<PilotDeckUserMessage>): PilotDeckQuery;
  close(): void;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

export type PilotDeckServerInfo = {
  mode: "in_process" | "remote";
  protocolVersion?: string;
  serverVersion?: string;
  projectKey?: string;
  capabilities?: string[];
};

export type PilotDeckSessionInfo = Record<string, unknown> & {
  sessionId?: string;
  sessionKey?: string;
};

export type PilotDeckModel = Record<string, unknown> & { id?: string; name?: string };
export type PilotDeckCommand = Record<string, unknown> & { name?: string; description?: string };
export type PilotDeckMcpStatus = Record<string, unknown> & { name?: string; status?: string };
/** Gateway-owned local-tokenizer classification of a prepared model request. */
export type PilotDeckContextUsageBreakdown = {
  source: "local_estimate";
  total: number;
  /** System prompt tokens excluding the separately reported MCP/memory blocks. */
  system: number;
  tools: number;
  messages: number;
  mcp: number;
  memory: number;
};

/** Gateway-owned context budget snapshot. */
export type PilotDeckContextUsage = Record<string, unknown> & {
  used?: number;
  total?: number;
  displayUsed?: number;
  budgetUsed?: number;
  localEstimateTokens?: number;
  displayTokens?: number;
  estimateSource?: "estimator" | "usage";
  usageTokens?: number;
  calibrationActualInputTokens?: number;
  calibrationEstimatedInputTokens?: number;
  totalContextTokens?: number;
  maxContextTokens?: number;
  effectiveTotal?: number;
  effectiveContextTokens?: number;
  maxOutputTokens?: number;
  reservedOutputTokens?: number;
  warningRatio?: number;
  blockingRatio?: number;
  ratio?: number;
  state?: "ok" | "warning" | "blocking";
  source?: "provider" | "calibrated" | "local";
  exact?: boolean;
  estimatorError?: string;
  detail?: "summary" | "full";
  /** Present for `detail: "full"` when the Gateway owns a breakdown. */
  breakdown?: PilotDeckContextUsageBreakdown;
  breakdownAvailable?: boolean;
};
export type PilotDeckFileRead = { path: string; content: string; encoding?: string };
export type PilotDeckReloadResult = Record<string, unknown>;
export type PilotDeckOutputStyle = {
  name: string;
  description?: string;
  plugin?: string;
  source?: "builtin" | "global" | "project";
};
export type PilotDeckOutputStyleSelection = { applied: boolean; selected?: string };
export type PilotDeckMcpSetResult = Record<string, unknown>;
export type ReadFileOptions = { maxBytes?: number; encoding?: "utf-8" | "base64" };
export type SessionMutationOptions = { projectKey?: string };
export type ListSessionsOptions = { projectKey?: string; limit?: number; cursor?: string };
export type GetSessionMessagesOptions = { projectKey?: string; limit?: number; cursor?: string };
export type GetSessionInfoOptions = { projectKey?: string };
export type ForkSessionOptions = {
  projectKey?: string;
  fromEntryId?: string;
  upToMessageId?: string;
  title?: string;
  /** Preserve the selected chain entry when used as a truncating resume. */
  resumeAt?: boolean;
  /** Guard that all discarded entries belong to one accepted-input turn. */
  resumeDropsTurn?: string;
};

/** Identifies the Gateway session that owns an SDK MCP configuration. */
export type PilotDeckMcpSessionInput = {
  sessionId: string;
  projectKey?: string;
};

/** Replaces the SDK-owned MCP server collection for one Gateway session. */
export type PilotDeckSetMcpServersInput = PilotDeckMcpSessionInput & {
  servers: Record<string, PilotDeckMcpServerConfig>;
  /** Reject the operation when the Gateway reports any server-level error. */
  strict?: boolean;
};

export type PilotDeckToggleMcpServerInput = PilotDeckMcpSessionInput & {
  serverName: string;
  enabled: boolean;
};

export type PilotDeckMcpPermissionModeOverrideInput = PilotDeckMcpSessionInput & {
  serverName: string;
  mode: "default" | "auto" | null;
};

/** Selects the transcript turn that a Gateway-owned replacement transaction removes. */
export type PrepareLastTurnReplacementOptions = {
  projectKey?: string;
  /** The accepted-input turn that must still be the transcript tail. */
  expectedTurnId: string;
};

/**
 * Per-run settings accepted after a last-turn replacement has been prepared.
 * Connection and session identity stay fixed to the prepared transaction so a
 * replacement run cannot be redirected to another Gateway or session.
 */
export type PilotDeckLastTurnReplacementRunOptions = Omit<
  PilotDeckOptions,
  "gatewayUrl" | "authToken" | "clientVersion" | "projectKey" | "sessionId" | "resume" | "continue" | "forkSession" | "resumeSessionAt" | "resumeDropsTurn"
>;

/**
 * A Gateway-owned replacement transaction for the latest transcript turn.
 *
 * `start()` can allocate exactly one run. Its run id is the transaction's
 * replacement id, allowing the Gateway to commit when it accepts input.
 * Before the run starts, `rollback()` restores the previous transcript tail.
 * The SDK never commits the transaction itself.
 */
export type PilotDeckLastTurnReplacement = {
  readonly sessionId: string;
  readonly runId: string;
  readonly replacedTurnId: string;
  readonly removedEntryCount: number;
  start(input: PilotDeckInput, options?: PilotDeckLastTurnReplacementRunOptions): PilotDeckRunHandle;
  rollback(): Promise<void>;
};

export type PilotDeckEventBase = {
  type: string;
  sessionId?: string;
  runId?: string;
  sequence?: number;
  timestamp?: string;
};

export type PilotDeckMessage = PilotDeckEventBase & Record<string, unknown>;

export type PilotDeckSDKMessage = PilotDeckMessage;
export type PilotDeckSystemMessage = PilotDeckMessage & { type: "system" | `pilotdeck.${string}` };
export type PilotDeckAssistantMessage = PilotDeckMessage & { type: "assistant.message" | "assistant.thinking" };
export type PilotDeckUserMessageReplay = PilotDeckUserMessage & { parentToolUseId?: string; replay?: true };
export type PilotDeckUserEventMessage = PilotDeckMessage & { type: "user.accepted" };
export type PilotDeckToolProgressMessage = PilotDeckMessage & { type: "tool.started" | "tool.progress" | "tool.completed" | "tool.failed" | "tool.result_detail" };
export type PilotDeckPermissionMessage = PilotDeckMessage & { type: "permission.requested" | "permission.denied" };
export type PilotDeckHookMessage = PilotDeckMessage & { type: "hook.started" | "hook.progress" | "hook.response" | "hook.async_result" };
export type PilotDeckSubagentTextMessage = PilotDeckMessage & {
  type: "subagent.message";
  subagentId: string;
  subagentType: string;
  text: string;
};
export type PilotDeckSubagentMessage = PilotDeckMessage & {
  type: "subagent.started" | "subagent.progress" | "subagent.completed" | "subagent.message";
};
export type PilotDeckResultMessage = PilotDeckMessage & { type: "result"; status: PilotDeckResult["status"] };

export type PilotDeckResult =
  | { status: "completed"; output?: unknown; usage?: Record<string, unknown>; artifacts?: unknown[]; finishReason?: string }
  | { status: "failed"; error: PilotDeckError; usage?: Record<string, unknown> }
  | { status: "aborted"; reason?: string; usage?: Record<string, unknown> }
  | { status: "result_unknown"; recovery?: { sessionId?: string; runId?: string } };

export type PilotDeckErrorCode =
  | "authentication_error"
  | "protocol_version_error"
  | "validation_error"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "timeout"
  | "aborted"
  | "permission_callback_error"
  | "elicitation_callback_error"
  | "user_dialog_callback_error"
  | "transport_error"
  | "server_error"
  | "unsupported_capability"
  | "result_unknown"
  | (string & {});

export type PilotDeckErrorInit = {
  code: PilotDeckErrorCode;
  message: string;
  requestId?: string;
  details?: unknown;
  retryable?: boolean;
  cause?: unknown;
};

export class PilotDeckError extends Error {
  readonly code: PilotDeckErrorCode;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(init: PilotDeckErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "PilotDeckError";
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryable = init.retryable ?? false;
  }
}

/**
 * Claude Agent SDK-compatible abort error type for callers that need to
 * distinguish a cancelled observation from an ordinary transport failure.
 * Gateway-owned runs still report their terminal state through PilotDeckResult.
 */
export class AbortError extends PilotDeckError {
  constructor(message = "The operation was aborted.", cause?: unknown) {
    super({ code: "aborted", message, cause });
    this.name = "AbortError";
  }
}

export type PilotDeckQuery = AsyncIterableIterator<PilotDeckMessage> & {
  /**
   * Releases this query's SDK transport without changing the Gateway-owned
   * session or a terminal turn result. Call after consuming a completed run
   * when the process keeps a long-lived client connection open.
   */
  close(): void;
  result(): Promise<PilotDeckResult>;
  interrupt(): Promise<PilotDeckInterruptReceipt | undefined>;
  /** Sends one user message to the Gateway-owned active-turn steer mailbox. */
  steer(input: PilotDeckInput): Promise<PilotDeckSteerReceipt>;
  /** Cancels the most recently submitted (or explicitly identified) steer item. */
  cancelSteer(itemId?: string): Promise<PilotDeckCancelSteerReceipt>;
  /**
   * Delivers the `additionalContext` from one callback that returned
   * `{ async: true }`. The Gateway rejects expired ids and never changes an
   * already-completed turn.
   */
  submitAsyncHookResult(invocationId: string, output: PilotDeckHookSyncJSONOutput): Promise<PilotDeckAsyncHookResult>;
  /** Resolves one pending manual generic dialog for this query's Gateway session. */
  respondUserDialog(
    requestId: string,
    result: PilotDeckUserDialogResult,
    options?: { leaseId?: string },
  ): Promise<PilotDeckUserDialogResponseReceipt>;
  /** Gateway-owned abort. Unlike close(), this requests that the active turn stops. */
  abort(reason?: string): Promise<void>;
  setPermissionMode(mode: PilotDeckPermissionMode): Promise<void>;
  setMcpPermissionModeOverride(serverName: string, mode: "default" | "auto" | null): Promise<{ warning?: string }>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: "summarized" | "omitted" | null): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  updateSettings(source: "localSettings", settings: PilotDeckLocalSettingsUpdate): Promise<void>;
  initializationResult(): Promise<PilotDeckInitializationResult>;
  reinitialize(): Promise<PilotDeckInitializationResult>;
  supportedCommands(): Promise<PilotDeckCommand[]>;
  supportedModels(): Promise<PilotDeckModel[]>;
  supportedAgents(): Promise<PilotDeckAgentInfo[]>;
  mcpServerStatus(): Promise<PilotDeckMcpStatus[]>;
  getContextUsage(options?: { detail?: "summary" | "full" }): Promise<PilotDeckContextUsage>;
  usage(options?: { skipBehaviors?: boolean }): Promise<PilotDeckUsage>;
  /** Gateway-owned per-provider/model usage. No client-side event accounting is performed. */
  modelUsage(): Promise<PilotDeckModelUsageSnapshot>;
  /** Claude-compatible experimental alias. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<PilotDeckUsage>;
  readFile(path: string, options?: ReadFileOptions): Promise<PilotDeckFileRead | null>;
  reloadPlugins(): Promise<PilotDeckReloadResult>;
  reloadSkills(): Promise<PilotDeckReloadResult>;
  outputStyles(): Promise<PilotDeckOutputStyle[]>;
  setOutputStyle(name: string | null): Promise<PilotDeckOutputStyleSelection>;
  reloadOutputStyles(): Promise<PilotDeckReloadResult>;
  accountInfo(): Promise<PilotDeckAccountInfo>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<PilotDeckRewindResult>;
  seedReadState(path: string, mtime: number): Promise<void>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, PilotDeckMcpServerConfig>): Promise<PilotDeckMcpSetResult>;
  streamInput(stream: AsyncIterable<PilotDeckUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  close(): void;
};

export type PilotDeckInterruptReceipt = { stillQueued?: string[] };
export type PilotDeckSteerReceipt = { itemId: string };
export type PilotDeckCancelSteerReceipt = { itemId: string; cancelled: boolean; reason?: string };
export type PilotDeckInitializationResult = { server: PilotDeckServerInfo; commands: PilotDeckCommand[]; models: PilotDeckModel[]; agents?: PilotDeckAgentInfo[]; capabilities?: string[] };
export type PilotDeckAgentInfo = Record<string, unknown> & { name?: string; description?: string };
export type PilotDeckUsage = Record<string, unknown> & {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  totalRequests?: number;
  totalCost?: number;
  totalBaselineCost?: number;
  totalSavedCost?: number;
  perModel?: Record<string, number>;
  perProvider?: Record<string, number>;
  perRole?: Record<string, number>;
  /** Request count by cost provenance; estimates must not be treated as provider invoices. */
  costSources?: Partial<Record<"provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown", number>>;
  scope?: "session" | "project";
};
export type PilotDeckModelUsageRole = {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  /** Request count by cost provenance for this model or role aggregate. */
  costSources: Partial<Record<"provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown", number>>;
};
export type PilotDeckModelUsage = PilotDeckModelUsageRole & {
  provider: string;
  model: string;
  roles: Partial<Record<"main" | "subagent", PilotDeckModelUsageRole>>;
};
export type PilotDeckModelUsageSnapshot = {
  scope: "session" | "project";
  sessionId?: string;
  models: PilotDeckModelUsage[];
};
export type PilotDeckAccountInfo = Record<string, unknown> & { email?: string; organization?: string };
export type PilotDeckRewindResult = { canRewind: boolean; error?: string; conflicts?: string[]; filesChanged?: string[]; insertions?: number; deletions?: number; missing?: string[]; skippedLinks?: number };
export type PilotDeckResolvedSettingsSource = {
  kind: "default" | "project" | "env";
  priority: number;
  loadedAt: string;
  path?: string;
  contentHash?: string;
  phase?: "bootstrap" | "merge";
};
export type PilotDeckResolvedSettingsDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error" | "fatal";
  message: string;
  path?: string;
  source?: Pick<PilotDeckResolvedSettingsSource, "kind" | "path" | "phase">;
  hint?: string;
  redactedValue?: string;
  recoverable?: boolean;
};
/**
 * A redacted, Gateway-owned `PilotConfigStore` snapshot. `config` is not a
 * writable local settings file and should be treated as diagnostics/provenance
 * data; use `Query.updateSettings("localSettings", ...)` for its narrow
 * mutable subset.
 */
export type PilotDeckResolvedSettings = {
  schemaVersion: number;
  version: number;
  loadedAt: string;
  contentHash: string;
  config: Record<string, unknown>;
  sources: PilotDeckResolvedSettingsSource[];
  diagnostics: PilotDeckResolvedSettingsDiagnostic[];
};

export type PilotDeckSession = PilotDeckSessionInfo & {
  /** Stable Gateway session identity. `id` is an SDK alias for `sessionId`. */
  id: string;
  sessionId: string;
  sessionKey: string;
  projectKey?: string;
  channelKey?: string;
};

/**
 * Gateway-produced portable session history. This is not a raw native
 * transcript: files, artifacts, sidechains, checkpoint state and active runs
 * remain owned by the original Gateway.
 */
export type PilotDeckSessionTranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

export type PilotDeckSessionTranscript = {
  schemaVersion: 1;
  format: "portable_text_messages";
  messages: PilotDeckSessionTranscriptMessage[];
  title?: string;
};

export type RestoreSessionTranscriptOptions = {
  projectKey?: string;
  channelKey?: string;
};

export type CreatePilotDeckSessionInput = {
  projectKey?: string;
  channelKey?: string;
  hint?: string;
};

export type PilotDeckRunInput = {
  sessionId: string;
  input: PilotDeckInput;
  options?: Omit<PilotDeckOptions, "gatewayUrl" | "authToken" | "clientVersion" | "sessionId" | "resume" | "continue" | "forkSession">;
};

export type PilotDeckRunHandle = {
  /** Gateway run identity supplied with the submit request. */
  readonly id: string;
  readonly sessionId: string;
  events(options?: { signal?: AbortSignal }): AsyncIterable<PilotDeckMessage>;
  result(options?: { signal?: AbortSignal }): Promise<PilotDeckResult>;
  steer(input: PilotDeckInput): Promise<PilotDeckSteerReceipt>;
  cancelSteer(itemId?: string): Promise<PilotDeckCancelSteerReceipt>;
  abort(reason?: string): Promise<void>;
};

export type PilotDeckProject = Record<string, unknown> & { projectKey?: string; id?: string; name?: string };
export type PilotDeckFileEntry = Record<string, unknown> & { id?: string; name?: string; relativePath?: string; kind?: "file" | "directory" };
export type PilotDeckPage<T> = { items: T[]; nextCursor?: string };
export type PilotDeckSkill = Record<string, unknown> & { id?: string; name?: string; content?: string };

/** PilotDeck-native scheduled task schedule. This is not a Claude background-tool task. */
export type PilotDeckCronTaskSchedule =
  | { type: "once"; runAt: string }
  | { type: "cron"; expression: string; timezone?: string };
export type PilotDeckCronCreateSchedule = PilotDeckCronTaskSchedule | {
  type: "delay";
  amount: number;
  unit: "second" | "minute" | "hour" | "day";
};
export type PilotDeckCronTaskStatus = "scheduled" | "running";
export type PilotDeckCronRunOutcome = "completed" | "failed" | "aborted" | "stopped";
export type PilotDeckCronTask = {
  schemaVersion: 1;
  taskId: string;
  message: string;
  schedule: PilotDeckCronTaskSchedule;
  status: PilotDeckCronTaskStatus;
  sessionKey: string;
  channelKey: string;
  projectKey?: string;
  mode?: "default" | "plan" | "bypassPermissions";
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunId?: string;
  revision?: number;
  scheduleComputationVersion?: 2;
  originSessionKey?: string;
  originChannelKey?: string;
};
export type PilotDeckCronRun = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sessionKey: string;
  projectKey?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: PilotDeckCronRunOutcome;
  error?: { code: string; message: string };
};
export type CreatePilotDeckCronTaskInput = {
  message: string;
  schedule: PilotDeckCronCreateSchedule;
  /** SDK spelling; sent to Gateway as `sessionKey`. */
  sessionId?: string;
  channelKey?: string;
  projectKey?: string;
  mode?: "default" | "plan" | "bypassPermissions";
  timezone?: string;
};
export type UpdatePilotDeckCronTaskInput = {
  taskId: string;
  projectKey: string;
  expectedRevision: number;
  message: string;
  schedule: PilotDeckCronTaskSchedule;
  timezone?: string;
};
export type DeletePilotDeckCronTaskInput = { taskId: string; projectKey?: string; stopRunning?: boolean };
export type StopPilotDeckCronTaskInput = { taskId?: string; runId?: string; projectKey?: string };
export type PilotDeckCronListResult = { tasks: PilotDeckCronTask[]; recentRuns?: PilotDeckCronRun[] };
export type PilotDeckCronDeleteResult = { deleted: boolean; stoppedRunId?: string };
export type PilotDeckCronStopResult = { stopped: boolean; taskId?: string; runId?: string; deletedOneTimeTask?: boolean };
export type PilotDeckCronRunNowResult = { started: boolean; reason?: "not_found" | "already_running"; taskId?: string };

export type PilotDeckClient = {
  /** Establishes a Gateway handshake. Repeated calls reuse the same control connection. */
  connect(): Promise<PilotDeckServerInfo>;
  describeServer(): Promise<PilotDeckServerInfo>;
  /** Closes the SDK-owned control connection. It does not abort Gateway-owned runs. */
  close(): Promise<void>;
  query(prompt: string | AsyncIterable<PilotDeckUserMessage>, options?: PilotDeckOptions): PilotDeckQuery;
  startup(options?: { initializeTimeoutMs?: number }): Promise<PilotDeckWarmQuery>;
  sessions: {
    create(input?: CreatePilotDeckSessionInput): Promise<PilotDeckSession>;
    get(sessionId: string, options?: GetSessionInfoOptions): Promise<PilotDeckSession>;
    resume(sessionId: string, options?: GetSessionInfoOptions): Promise<PilotDeckSession>;
    list(options?: ListSessionsOptions): Promise<PilotDeckSessionInfo[]>;
    messages(sessionId: string, options?: GetSessionMessagesOptions): Promise<PilotDeckMessage[]>;
    info(sessionId: string, options?: GetSessionInfoOptions): Promise<PilotDeckSessionInfo | undefined>;
    /** Exports the Gateway-owned completed conversation as a portable text archive. */
    exportTranscript(sessionId: string, options?: GetSessionInfoOptions): Promise<PilotDeckSessionTranscript>;
    /** Restores a portable archive into a freshly allocated Gateway session. */
    restoreTranscript(archive: PilotDeckSessionTranscript, options?: RestoreSessionTranscriptOptions): Promise<PilotDeckSession>;
    fork(sessionId: string, options?: ForkSessionOptions): Promise<PilotDeckSessionInfo>;
    /** Prepares one Gateway-owned replacement of the latest accepted transcript turn. */
    prepareLastTurnReplacement(
      sessionId: string,
      options: PrepareLastTurnReplacementOptions,
    ): Promise<PilotDeckLastTurnReplacement>;
    close(sessionId: string, options?: { reason?: string }): Promise<void>;
    rename(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void>;
    tag(sessionId: string, tag: string | null, options?: SessionMutationOptions): Promise<void>;
    delete(sessionId: string, options?: SessionMutationOptions): Promise<void>;
  };
  runs: {
    start(input: PilotDeckRunInput): PilotDeckRunHandle;
  };
  projects: {
    list(): Promise<PilotDeckProject[]>;
    get(projectKey: string): Promise<PilotDeckProject>;
  };
  files: {
    list(input: { projectKey: string; query?: string; cursor?: string; limit?: number; includeDirs?: boolean }): Promise<PilotDeckPage<PilotDeckFileEntry>>;
    read(input: { projectKey: string; path: string; maxBytes?: number; encoding?: "utf-8" | "base64" }): Promise<PilotDeckFileRead | null>;
  };
  models: {
    list(input: { projectKey: string; query?: string; provider?: string; includeAuto?: boolean }): Promise<PilotDeckModel[]>;
    get(input: { sessionId: string; projectKey: string }): Promise<Record<string, unknown>>;
    set(input: { sessionId: string; projectKey: string; selection: Record<string, unknown> }): Promise<Record<string, unknown>>;
    clear(input: { sessionId: string; projectKey: string }): Promise<void>;
  };
  commands: {
    list(input: { projectKey: string; query?: string; cursor?: string; limit?: number }): Promise<PilotDeckPage<PilotDeckCommand>>;
  };
  skills: {
    list(input?: Record<string, unknown>): Promise<PilotDeckSkill[]>;
    read(input: Record<string, unknown>): Promise<PilotDeckSkill>;
  };
  /** Controls SDK-owned MCP servers without creating or consuming a Query. */
  mcp: {
    status(input?: Partial<PilotDeckMcpSessionInput>): Promise<PilotDeckMcpStatus[]>;
    setServers(input: PilotDeckSetMcpServersInput): Promise<PilotDeckMcpSetResult>;
    reconnect(input: PilotDeckMcpSessionInput & { serverName: string }): Promise<void>;
    toggle(input: PilotDeckToggleMcpServerInput): Promise<void>;
    setPermissionModeOverride(input: PilotDeckMcpPermissionModeOverrideInput): Promise<{ warning?: string }>;
  };
  /** Gateway-owned pending generic dialogs, including optional multi-renderer leases. */
  dialogs: {
    list(input: PilotDeckUserDialogResourceInput): Promise<PilotDeckUserDialogRecord[]>;
    /**
     * Observes live Gateway dialog changes for one session. The callback is a
     * hint only; callers must list again after reconnect or before acting.
     */
    watch(input: PilotDeckUserDialogResourceInput, listener: (change: PilotDeckUserDialogChange) => void): Promise<() => void>;
    claim(input: PilotDeckUserDialogClaimInput): Promise<PilotDeckUserDialogClaimResult>;
    release(input: PilotDeckUserDialogReleaseInput): Promise<{ released: boolean }>;
    respond(input: PilotDeckUserDialogResponseInput): Promise<PilotDeckUserDialogResponseReceipt>;
  };
  /** PilotDeck-native scheduled work; deliberately separate from Claude background tool tasks. */
  cron: {
    create(input: CreatePilotDeckCronTaskInput): Promise<PilotDeckCronTask>;
    list(input?: { projectKey?: string; includeHistory?: boolean; limit?: number }): Promise<PilotDeckCronListResult>;
    update(input: UpdatePilotDeckCronTaskInput): Promise<{ updated: true; task: PilotDeckCronTask } | { updated: false; reason: "not_found" | "running" | "conflict" }>;
    delete(input: DeletePilotDeckCronTaskInput): Promise<PilotDeckCronDeleteResult>;
    stop(input: StopPilotDeckCronTaskInput): Promise<PilotDeckCronStopResult>;
    runNow(input: { taskId: string; projectKey?: string }): Promise<PilotDeckCronRunNowResult>;
  };
  config: { reload(): Promise<PilotDeckReloadResult> };
  extensions: { reload(input?: { projectKey?: string; changedPaths?: string[] }): Promise<PilotDeckReloadResult> };
};

/*
 * Claude Agent SDK spelling aliases.
 *
 * These aliases deliberately point at PilotDeck-owned contracts rather than
 * re-exporting Claude's private wire types. They make common Claude-shaped
 * imports type-check while preserving PilotDeck event/result semantics.
 */
export type Options = PilotDeckOptions;
export type Query = PilotDeckQuery;
export type WarmQuery = PilotDeckWarmQuery;
export type SDKMessage = PilotDeckSDKMessage;
export type SDKSystemMessage = PilotDeckSystemMessage;
export type SDKAssistantMessage = PilotDeckAssistantMessage;
export type SDKPartialAssistantMessage = PilotDeckAssistantMessage;
export type SDKUserMessage = PilotDeckUserMessage;
export type SDKUserMessageReplay = PilotDeckUserMessageReplay;
export type SDKResultMessage = PilotDeckResultMessage;
export type SDKControlInterruptResponse = PilotDeckInterruptReceipt;
export type SDKControlInitializeResponse = PilotDeckInitializationResult;
export type SDKControlGetContextUsageResponse = PilotDeckContextUsage;
export type SDKControlReadFileResponse = PilotDeckFileRead;
export type SDKControlReloadSkillsResponse = PilotDeckReloadResult;
export type SDKControlReloadPluginsResponse = PilotDeckReloadResult;
export type SDKControlReloadOutputStylesResponse = PilotDeckReloadResult;
export type AccountInfo = PilotDeckAccountInfo;
export type AgentDefinition = PilotDeckAgentDefinition;
export type AgentInfo = PilotDeckAgentInfo;
export type ModelInfo = PilotDeckModel;
export type SlashCommand = PilotDeckCommand;
export type SessionMessage = PilotDeckMessage;
export type SDKSessionInfo = PilotDeckSessionInfo;
export type PermissionMode = PilotDeckPermissionMode;
export type ThinkingConfig = PilotDeckThinkingConfig;
export type OutputFormat = PilotDeckOutputFormat;
export type McpServerConfig = PilotDeckMcpServerConfig;
export type McpServerConfigForProcessTransport = PilotDeckMcpTransportConfig;
export type McpServerStatus = PilotDeckMcpStatus;
export type McpSetServersResult = PilotDeckMcpSetResult;
export type SdkMcpToolDefinition<Input = unknown, Schema = unknown> = PilotDeckToolDefinition<Input, Schema>;
export type CreateSdkMcpServerOptions = PilotDeckMcpServerOptions;
export type HookEvent = PilotDeckHookEvent;
export type HookCallback = PilotDeckHookCallback;
export type HookCallbackMatcher = PilotDeckHookCallbackMatcher;
export type HookInput = PilotDeckHookInput;
export type HookJSONOutput = PilotDeckHookJSONOutput;
export type HookPermissionDecision = PilotDeckHookSpecificOutput["permissionDecision"];
export type ElicitationRequest = PilotDeckElicitationRequest;
export type ElicitationResult = PilotDeckElicitationResult;
export type UserDialogRequest = PilotDeckUserDialogRequest;
export type UserDialogResult = PilotDeckUserDialogResult;
export type ResolvedSettings = PilotDeckResolvedSettings;
export type RewindFilesResult = PilotDeckRewindResult;
