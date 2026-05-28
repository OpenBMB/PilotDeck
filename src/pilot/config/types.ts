import type { AlwaysOnConfig } from "../../always-on/config/parseAlwaysOnConfig.js";
import type { CronConfig } from "../../cron/config/parseCronConfig.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import type { RouterConfig } from "../../router/config/schema.js";

export type PilotConfigSourceKind = "default" | "project" | "env";
export type PilotConfigSourcePhase = "bootstrap" | "merge";
export type PilotConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type PilotConfigChangeClass =
  | "runtime-live"
  | "next-request"
  | "next-runtime"
  | "restart-required"
  | "invalid";

export type PilotConfigSource = {
  kind: PilotConfigSourceKind;
  priority: number;
  loadedAt: Date;
  path?: string;
  contentHash?: string;
  phase?: PilotConfigSourcePhase;
};

export type PilotConfigDiagnostic = {
  code: string;
  severity: PilotConfigDiagnosticSeverity;
  message: string;
  path?: string;
  source?: Pick<PilotConfigSource, "kind" | "path" | "phase">;
  hint?: string;
  redactedValue?: string;
  recoverable?: boolean;
};

export type PilotRawConfig = {
  schemaVersion?: unknown;
  agent?: unknown;
  model?: unknown;
  extension?: unknown;
  memory?: unknown;
  gateway?: unknown;
  adapters?: unknown;
  router?: unknown;
  alwaysOn?: unknown;
  cron?: unknown;
  tools?: unknown;
};

export type PilotExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type PilotAgentModelSelection = {
  id: string;
  provider: string;
  model: string;
};

export type PilotAgentConfig = {
  model: PilotAgentModelSelection;
  /**
   * Override the model catalog's context window size (tokens). When set,
   * auto-compaction thresholds (80% warn / 95% block) are computed against
   * this value instead of the catalog default. Useful for proxy providers
   * or when you want compaction to kick in earlier.
   */
  maxContextTokens?: number;
  subagents?: {
    timeoutMs?: number;
  };
};

/**
 * Re-export of the router's structured config so callers that already depend
 * on `PilotConfig` keep a single import path. The actual definition lives in
 * `src/router/config/schema.ts`.
 */
export type PilotRouterConfig = RouterConfig;

export type PilotMemoryApiType = "openai-responses" | "responses" | "openai-completions";
export type PilotMemoryReasoningMode = "answer_first" | "accuracy_first";

export type PilotMemoryScheduleConfig = {
  reasoningMode?: PilotMemoryReasoningMode;
  autoIndexIntervalMinutes?: number;
  autoDreamIntervalMinutes?: number;
};

export type PilotMemoryConfig = {
  enabled: boolean;
  provider: "edgeclaw";
  rootDir?: string;
  captureStrategy: "last_turn" | "full_session";
  includeAssistant: boolean;
  maxMessageChars?: number;
  retrievalTimeoutMs?: number;
  /** "provider/model" string referencing model.providers, e.g. "openai/gpt-4.1-mini" */
  model?: string;
  apiType?: PilotMemoryApiType;
  schedule?: PilotMemoryScheduleConfig;
  heartbeatBatchSize?: number;
};

export type PilotGatewayConfig = {
  port: number;
  bindAddress: "127.0.0.1";
  idleSessionTimeoutMinutes: number;
  staticAssetsPath?: string;
  /**
   * Maximum number of concurrent per-session MCP instances (e.g. browser-use
   * browser processes).  When the limit is reached, new sessions fall back
   * to the shared project-level MCP runtime.  Default 5.
   */
  maxPerSessionMcpInstances?: number;
};

export type PilotWebSearchProvider = "glm" | "tavily" | "custom";
export type PilotWebSearchCustomAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
export type PilotWebSearchCustomMethod = "GET" | "POST";

export type PilotWebSearchCustomProviderConfig = {
  name?: string;
  auth?: PilotWebSearchCustomAuth;
  method?: PilotWebSearchCustomMethod;
  queryParam?: string;
  apiKeyParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

/**
 * Per-tool runtime config for `web_search`. Exactly one provider is active at
 * runtime; `apiKey` and `endpoint` apply to the selected provider.
 */
export type PilotWebSearchConfig = {
  provider?: PilotWebSearchProvider;
  apiKey?: string;
  endpoint?: string;
  customProvider?: PilotWebSearchCustomProviderConfig;
};

export type PilotToolsConfig = {
  webSearch?: PilotWebSearchConfig;
};

export type PilotPlatformAdapterConfig = {
  enabled: boolean;
  token?: string;
  apiKey?: string;
  webhookUrl?: string;
  extra?: Record<string, unknown>;
};

export type PilotAdaptersConfig = {
  cli?: {
    autoConnectServer: boolean;
  };
  tui?: {
    autoConnectServer: boolean;
  };
  feishu?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
    verifyToken?: string;
    defaultSessionLabel: string;
    connectionMode?: "stream" | "webhook";
    domainName?: "feishu" | "lark";
  };
  weixin?: { enabled: boolean };
  telegram?: PilotPlatformAdapterConfig;
  discord?: PilotPlatformAdapterConfig;
  slack?: PilotPlatformAdapterConfig;
  matrix?: PilotPlatformAdapterConfig;
  mattermost?: PilotPlatformAdapterConfig;
  signal?: PilotPlatformAdapterConfig;
  whatsapp?: PilotPlatformAdapterConfig;
  bluebubbles?: PilotPlatformAdapterConfig;
  dingtalk?: PilotPlatformAdapterConfig;
  wecom?: PilotPlatformAdapterConfig;
  wecomCallback?: PilotPlatformAdapterConfig;
  email?: PilotPlatformAdapterConfig;
  sms?: PilotPlatformAdapterConfig;
  homeassistant?: PilotPlatformAdapterConfig;
  apiServer?: PilotPlatformAdapterConfig;
  webhook?: PilotPlatformAdapterConfig;
};

export type PilotConfig = {
  agent: PilotAgentConfig;
  model: ModelConfig;
  extension: PilotExtensionConfig;
  memory?: PilotMemoryConfig;
  gateway?: PilotGatewayConfig;
  adapters?: PilotAdaptersConfig;
  router?: RouterConfig;
  alwaysOn?: AlwaysOnConfig;
  cron?: CronConfig;
  tools?: PilotToolsConfig;
};

export type PilotConfigSnapshot = {
  version: number;
  schemaVersion: number;
  loadedAt: Date;
  contentHash: string;
  sources: PilotConfigSource[];
  diagnostics: PilotConfigDiagnostic[];
  config: PilotConfig;
};

export type PilotConfigLoadOptions = {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  version?: number;
};

export type PilotConfigReloadEvent = {
  previousSnapshot: PilotConfigSnapshot;
  nextSnapshot: PilotConfigSnapshot;
  changedPaths: string[];
  changeClasses: PilotConfigChangeClass[];
};

export class PilotConfigError extends Error {
  readonly name = "PilotConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: PilotConfigDiagnostic[] = [],
  ) {
    super(message);
  }
}
