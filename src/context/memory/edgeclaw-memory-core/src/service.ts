import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CaseTraceRecord,
  type ClearMemoryScope,
  type ClearMemoryResult,
  type DreamRunResult,
  type DreamRollbackResult,
  type DreamRuntimeStateSnapshot,
  DreamRewriteRunner,
  type HeartbeatStats,
  HeartbeatIndexer,
  type IndexingSettings,
  type LastDreamSnapshotMetadata,
  type LastDreamSnapshotSourceAction,
  LlmMemoryExtractor,
  type MemoryActionRequest,
  type MemoryActionResult,
  type MemoryExportBundle,
  type MemoryImportResult,
  type MemoryImportableBundle,
  type MemoryMessage,
  type MemoryRecordType,
  type MemoryTransferCounts,
  type MemoryUiSnapshot,
  MemoryRepository,
  type RetrievalResult,
  ReasoningRetriever,
  hashText,
  nowIso,
} from "./core/index.js";
import {
  normalizeMessages,
  type TranscriptMessageInfo,
  inspectTranscriptMessage,
} from "./message-utils.js";

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type EdgeClawMemoryApiType =
  | "openai-responses"
  | "responses"
  | "openai-completions";

export interface EdgeClawMemoryLlmOptions {
  provider?: string;
  model?: string;
  modelRef?: string;
  apiType?: EdgeClawMemoryApiType;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface EdgeClawMemoryServiceOptions {
  workspaceDir: string;
  rootDir?: string;
  dbPath?: string;
  memoryDir?: string;
  captureStrategy?: "last_turn" | "full_session";
  includeAssistant?: boolean;
  maxMessageChars?: number;
  heartbeatBatchSize?: number;
  defaultIndexingSettings?: Partial<IndexingSettings>;
  source?: string;
  llm?: EdgeClawMemoryLlmOptions;
  runtime?: Record<string, unknown>;
  logger?: LoggerLike;
}

export interface CaptureTurnResult {
  captured: boolean;
  normalizedMessages: MemoryMessage[];
  sessionKey: string;
}

export interface RetrieveContextResult extends RetrievalResult {
  systemContext: string;
}

export interface MemoryListOptions {
  kinds?: MemoryRecordType[];
  query?: string;
  limit?: number;
  offset?: number;
  scope?: "global" | "project";
  includeDeprecated?: boolean;
}

const AUTO_INDEX_ANCHOR_AT_STATE_KEY = "autoIndexAnchorAt" as const;
const AUTO_DREAM_ANCHOR_AT_STATE_KEY = "autoDreamAnchorAt" as const;
const AUTO_INDEX_PENDING_DIALOGUE_TURN_THRESHOLD = 20;

type JsonRecord = Record<string, unknown>;

interface OpenClawResolvedModelConfig {
  provider: string;
  model: string;
  apiType?: EdgeClawMemoryApiType;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
let cachedOpenClawModelConfig: OpenClawResolvedModelConfig | null | undefined;

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function getString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const child = value[key];
  return typeof child === "string" ? child.trim() : "";
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, entryValue]) => {
    if (typeof entryValue !== "string") return [];
    const normalizedEntryValue = entryValue.trim();
    return normalizedEntryValue ? [[key, normalizedEntryValue] as const] : [];
  });
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function parseModelRef(value: string | undefined): {
  provider?: string;
  model?: string;
} {
  const normalized = normalizeText(value);
  if (!normalized) return {};
  if (!normalized.includes("/")) {
    return { model: normalized };
  }
  const [provider, ...rest] = normalized.split("/");
  const model = rest.join("/").trim();
  return {
    provider: normalizeText(provider),
    model,
  };
}

function withEnvFallback(value: string | undefined, envKey: string): string {
  const explicit = normalizeText(value);
  if (explicit) return explicit;
  return normalizeText(process.env[envKey]);
}

function resolveDefaultRootDir(rootDir: string | undefined): string {
  return resolve(rootDir ? rootDir : join(homedir(), ".edgeclaw", "memory"));
}

function resolveWorkspaceDataDir(workspaceDir: string, rootDir: string): string {
  const seed = resolve(workspaceDir);
  const slug = hashText(seed);
  return join(rootDir, "workspaces", slug);
}

function resolveOpenClawModelConfig(): OpenClawResolvedModelConfig | null {
  if (cachedOpenClawModelConfig !== undefined) {
    return cachedOpenClawModelConfig;
  }

  try {
    if (!existsSync(OPENCLAW_CONFIG_PATH)) {
      cachedOpenClawModelConfig = null;
      return cachedOpenClawModelConfig;
    }

    const parsed = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf8")) as unknown;
    const providers = getRecord(getRecord(parsed, "models"), "providers");
    if (!providers) {
      cachedOpenClawModelConfig = null;
      return cachedOpenClawModelConfig;
    }

    const primaryModelRef = getString(
      getRecord(getRecord(getRecord(parsed, "agents"), "defaults"), "model"),
      "primary",
    );
    const parsedPrimary = parseModelRef(primaryModelRef);

    const availableProviders = Object.entries(providers).flatMap(([providerName, providerValue]) =>
      isRecord(providerValue) ? [[providerName, providerValue] as const] : []);
    if (availableProviders.length === 0) {
      cachedOpenClawModelConfig = null;
      return cachedOpenClawModelConfig;
    }

    const providerEntry = (
      parsedPrimary.provider
        ? availableProviders.find(([providerName]) => providerName === parsedPrimary.provider)
        : undefined
    ) ?? availableProviders[0];
    if (!providerEntry) {
      cachedOpenClawModelConfig = null;
      return cachedOpenClawModelConfig;
    }

    const [provider, providerConfig] = providerEntry;
    const providerModels = Array.isArray(providerConfig["models"])
      ? providerConfig["models"].filter(isRecord)
      : [];
    const selectedModel = (
      parsedPrimary.model
        ? providerModels.find(modelEntry =>
            getString(modelEntry, "id") === parsedPrimary.model
            || getString(modelEntry, "name") === parsedPrimary.model)
        : undefined
    ) ?? providerModels[0];

    const model = parsedPrimary.model
      || getString(selectedModel, "id")
      || getString(selectedModel, "name");
    if (!model) {
      cachedOpenClawModelConfig = null;
      return cachedOpenClawModelConfig;
    }

    const headers = {
      ...(toStringRecord(providerConfig["headers"]) ?? {}),
      ...(toStringRecord(selectedModel?.["headers"]) ?? {}),
    };

    cachedOpenClawModelConfig = {
      provider,
      model,
      apiType: (getString(selectedModel, "api") || getString(providerConfig, "api") || undefined) as
        | EdgeClawMemoryApiType
        | undefined,
      baseUrl: getString(selectedModel, "baseUrl") || getString(providerConfig, "baseUrl") || undefined,
      apiKey: getString(providerConfig, "apiKey") || undefined,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } catch {
    cachedOpenClawModelConfig = null;
  }

  return cachedOpenClawModelConfig;
}

function buildLlmConfig(options: EdgeClawMemoryLlmOptions | undefined): Record<string, unknown> {
  const openClawModel = resolveOpenClawModelConfig();
  const parsedModelRef = parseModelRef(
    normalizeText(options?.modelRef) || normalizeText(process.env.EDGECLAW_MEMORY_MODEL),
  );
  const provider = normalizeText(options?.provider)
    || normalizeText(process.env.EDGECLAW_MEMORY_PROVIDER)
    || parsedModelRef.provider
    || openClawModel?.provider
    || "edgeclaw_memory";
  const model = normalizeText(options?.model)
    || parsedModelRef.model
    || openClawModel?.model
    || normalizeText(process.env.OPENAI_MODEL);
  const usingOpenClawSelection = Boolean(
    openClawModel
    && provider === openClawModel.provider
    && model === openClawModel.model,
  );
  const baseUrl = normalizeText(options?.baseUrl)
    || normalizeText(process.env.EDGECLAW_MEMORY_BASE_URL)
    || (usingOpenClawSelection ? normalizeText(openClawModel?.baseUrl) : "")
    || normalizeText(process.env.OPENAI_BASE_URL);
  const apiKey = normalizeText(options?.apiKey)
    || normalizeText(process.env.EDGECLAW_MEMORY_API_KEY)
    || (usingOpenClawSelection ? normalizeText(openClawModel?.apiKey) : "")
    || normalizeText(process.env.OPENAI_API_KEY);
  const apiType = (
    normalizeText(options?.apiType)
    || normalizeText(process.env.EDGECLAW_MEMORY_API_TYPE)
    || (usingOpenClawSelection ? normalizeText(openClawModel?.apiType) : "")
    || "openai-responses"
  ) as EdgeClawMemoryApiType;
  const headers = {
    ...(usingOpenClawSelection ? openClawModel?.headers ?? {} : {}),
    ...(options?.headers ?? {}),
  };

  return {
    agents: {
      defaults: {
        model: {
          primary: model ? `${provider}/${model}` : "",
        },
      },
    },
    models: {
      providers: {
        [provider]: {
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          api: apiType,
          models: model
            ? [
                {
                  id: model,
                  api: apiType,
                  ...(baseUrl ? { baseUrl } : {}),
                  ...(Object.keys(headers).length > 0 ? { headers } : {}),
                },
              ]
            : [],
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      },
    },
  };
}

function mergeIndexingSettings(
  partial: Partial<IndexingSettings> | undefined,
): IndexingSettings {
  return {
    reasoningMode: partial?.reasoningMode === "accuracy_first" ? "accuracy_first" : "answer_first",
    autoIndexIntervalMinutes: typeof partial?.autoIndexIntervalMinutes === "number"
      ? Math.max(0, Math.floor(partial.autoIndexIntervalMinutes))
      : 30,
    autoDreamIntervalMinutes: typeof partial?.autoDreamIntervalMinutes === "number"
      ? Math.max(0, Math.floor(partial.autoDreamIntervalMinutes))
      : 60,
  };
}

function resolveConfiguredDataDir(options: EdgeClawMemoryServiceOptions, fallbackDir: string): string {
  if (options.dbPath) {
    return resolve(dirname(resolve(options.dbPath)));
  }
  if (options.memoryDir) {
    return resolve(dirname(resolve(options.memoryDir)));
  }
  return fallbackDir;
}

function parseTimestamp(value: string | undefined): number | null {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function hasElapsedMinutes(
  anchorAt: string | undefined,
  intervalMinutes: number,
  nowMs: number,
): boolean {
  if (intervalMinutes <= 0) return false;
  const anchorMs = parseTimestamp(anchorAt);
  if (anchorMs === null) return false;
  return nowMs - anchorMs >= intervalMinutes * 60_000;
}

function buildLastDreamSnapshotMetadata(input: {
  sourceAction: LastDreamSnapshotSourceAction;
  workspaceDir: string;
  capturedAt: string;
  before: {
    workspaceVersion: string;
    globalVersion: string;
    counts: MemoryTransferCounts;
    runtimeState: DreamRuntimeStateSnapshot;
  };
  after: {
    workspaceVersion: string;
    globalVersion: string;
    counts: MemoryTransferCounts;
    runtimeState: DreamRuntimeStateSnapshot;
  };
  trigger?: "manual" | "scheduled";
  dreamTraceId?: string;
  summary?: string;
}): LastDreamSnapshotMetadata {
  return {
    version: 1,
    capturedAt: input.capturedAt,
    sourceAction: input.sourceAction,
    sourceWorkspaceDir: input.workspaceDir,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.dreamTraceId ? { dreamTraceId: input.dreamTraceId } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    before: {
      workspaceVersion: input.before.workspaceVersion,
      globalVersion: input.before.globalVersion,
      counts: input.before.counts,
      runtimeState: input.before.runtimeState,
    },
    after: {
      workspaceVersion: input.after.workspaceVersion,
      globalVersion: input.after.globalVersion,
      counts: input.after.counts,
      runtimeState: input.after.runtimeState,
    },
  };
}

function toMessages(rawMessages: readonly unknown[], options: {
  includeAssistant: boolean;
  maxMessageChars: number;
  captureStrategy: "last_turn" | "full_session";
}): MemoryMessage[] {
  return normalizeMessages([...rawMessages], options);
}

type CleanedRecallSections = {
  userProfile: string[];
  projectMeta: string[];
  projectMemory: string[];
  feedbackMemory: string[];
};

function parseRawRecallSections(value: string): CleanedRecallSections {
  const sections: CleanedRecallSections = {
    userProfile: [],
    projectMeta: [],
    projectMemory: [],
    feedbackMemory: [],
  };
  let currentSection: keyof CleanedRecallSections | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentSection) {
      buffer = [];
      return;
    }
    const content = buffer.join("\n").trim();
    if (content) sections[currentSection].push(content);
    buffer = [];
  };

  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^### \[user\]/u.test(line)) {
      flush();
      currentSection = "userProfile";
      continue;
    }
    if (/^### \[project_meta\]/u.test(line)) {
      flush();
      currentSection = "projectMeta";
      continue;
    }
    if (/^### \[project\]/u.test(line)) {
      flush();
      currentSection = "projectMemory";
      continue;
    }
    if (/^### \[feedback\]/u.test(line)) {
      flush();
      currentSection = "feedbackMemory";
      continue;
    }
    if (!currentSection) continue;
    if (!line) {
      buffer.push("");
      continue;
    }
    if (line === "## ClawXMemory Recall") continue;
    if (/^route=/u.test(line)) continue;
    if (line === "Treat these file memories as the authoritative long-term memory for this turn when relevant.") {
      continue;
    }
    buffer.push(rawLine);
  }

  flush();
  return sections;
}

function joinRecallBodies(bodies: string[]): string | null {
  const normalizedBodies = bodies.map((body) => body.trim()).filter(Boolean);
  if (normalizedBodies.length === 0) return null;
  return normalizedBodies.join("\n\n---\n\n");
}

function looksLikeRawRecallContext(value: string | undefined): boolean {
  const normalized = (value ?? "").trim();
  if (!normalized) return false;
  return /^route=/mu.test(normalized)
    || /^### \[(user|project_meta|project|feedback)\]/mu.test(normalized);
}

export function buildMemoryRecallSystemContext(evidenceBlock: string): string {
  const sections = parseRawRecallSections(evidenceBlock.trim());
  const blocks = [
    sections.userProfile.length > 0
      ? ["## User Profile", joinRecallBodies(sections.userProfile)].filter(Boolean).join("\n\n")
      : null,
    sections.projectMeta.length > 0
      ? ["## Project Meta", joinRecallBodies(sections.projectMeta)].filter(Boolean).join("\n\n")
      : null,
    sections.projectMemory.length > 0
      ? ["## Project Memory", joinRecallBodies(sections.projectMemory)].filter(Boolean).join("\n\n")
      : null,
    sections.feedbackMemory.length > 0
      ? ["## Feedback Memory", joinRecallBodies(sections.feedbackMemory)].filter(Boolean).join("\n\n")
      : null,
  ].filter((block): block is string => Boolean(block));

  if (blocks.length === 0) return "";

  return [
    "## ClawXMemory Recall",
    "These are retrieved long-term memory references for the current turn.",
    "Some content may be relevant while some may not be directly useful.",
    "Use only the parts that are relevant to the current question.",
    "If retrieved memory conflicts with explicit new user instructions in the current turn, follow the current-turn user instructions.",
    ...blocks,
  ].join("\n\n");
}

function normalizeCaseTraceContextPreview(record: CaseTraceRecord): CaseTraceRecord {
  const retrieval = record.retrieval;
  const preview = retrieval?.contextPreview;
  if (!preview || !retrieval || !looksLikeRawRecallContext(preview)) return record;
  return {
    ...record,
    retrieval: {
      ...retrieval,
      contextPreview: buildMemoryRecallSystemContext(preview),
    },
  };
}

export function buildEdgeClawMemoryPromptSection(options: {
  availableTools?: Iterable<string>;
  citationsMode?: "off" | "on";
} = {}): string | null {
  const availableTools = new Set(options.availableTools ?? []);
  const citationsMode = options.citationsMode ?? "off";
  const hasMemoryOverview = availableTools.has("memory_overview");
  const hasMemoryList = availableTools.has("memory_list");
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasMemoryFlush = availableTools.has("memory_flush");
  const hasMemoryDream = availableTools.has("memory_dream");

  if (
    !hasMemoryOverview
    && !hasMemoryList
    && !hasMemorySearch
    && !hasMemoryGet
    && !hasMemoryFlush
    && !hasMemoryDream
  ) {
    return null;
  }

  const lines = [
    "## ClawXMemory",
    hasMemoryOverview
      ? "Use memory_overview for memory status, freshness, indexing backlog, and runtime health questions."
      : undefined,
    hasMemoryList
      ? "Use memory_list to browse file-based user, feedback, and project memory indexes."
      : undefined,
    hasMemorySearch && hasMemoryGet
      ? "For durable preferences, collaboration rules, or project progress across sessions: run memory_search first, then use memory_get only for the exact file ids you need to verify."
      : hasMemorySearch
        ? "For durable preferences, collaboration rules, or project progress across sessions: run memory_search before answering."
        : hasMemoryGet
          ? "Use memory_get only when the user already gave you specific memory file ids to inspect."
          : undefined,
    hasMemoryFlush
      ? "If the user wants recent memory extracted now or asks why a just-finished conversation is not visible yet, run memory_flush."
      : undefined,
    hasMemoryDream
      ? "If the user wants memory cleanup, duplicate merge, or manifest repair, run memory_dream."
      : undefined,
    "Treat injected ClawXMemory recall context and memory file tools as the authoritative long-term memory source for the current turn.",
    "ClawXMemory uses file-based memory manifests and memory files as its durable memory source.",
    "Do not create or maintain long-term memory in workspace files such as memory/*.md, USER.md, or MEMORY.md, and do not write directly into ClawXMemory's managed memory directory. Use ClawXMemory's managed memory flow instead.",
    "Never call write, edit, move, rename, or delete tools on workspace memory files or ClawXMemory-managed memory paths. Those paths are reserved for ClawXMemory runtime ownership.",
    citationsMode === "off"
      ? "Citations are disabled: do not mention file paths or line numbers unless the user explicitly asks."
      : "When verification matters, cite the exact ClawXMemory records you used.",
  ].filter((line): line is string => Boolean(line));

  return `${lines.join("\n")}\n`;
}

export class EdgeClawMemoryService {
  readonly workspaceDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly memoryDir: string;
  readonly defaultIndexingSettings: IndexingSettings;
  readonly repository: MemoryRepository;
  readonly extractor: LlmMemoryExtractor;
  readonly indexer: HeartbeatIndexer;
  readonly retriever: ReasoningRetriever;

  private readonly logger?: LoggerLike;
  private readonly captureStrategy: "last_turn" | "full_session";
  private readonly includeAssistant: boolean;
  private readonly maxMessageChars: number;
  private readonly source: string;

  constructor(options: EdgeClawMemoryServiceOptions) {
    this.workspaceDir = resolve(options.workspaceDir);
    const rootDir = resolveDefaultRootDir(options.rootDir);
    this.dataDir = resolveConfiguredDataDir(
      options,
      resolveWorkspaceDataDir(this.workspaceDir, rootDir),
    );
    this.dbPath = resolve(options.dbPath ?? join(this.dataDir, "control.sqlite"));
    this.memoryDir = resolve(options.memoryDir ?? join(this.dataDir, "memory"));
    this.defaultIndexingSettings = mergeIndexingSettings(options.defaultIndexingSettings);
    this.logger = options.logger;
    this.captureStrategy = options.captureStrategy ?? "last_turn";
    this.includeAssistant = options.includeAssistant ?? true;
    this.maxMessageChars = options.maxMessageChars ?? 6000;
    this.source = options.source ?? "edgeclaw";

    this.repository = new MemoryRepository(this.dbPath, {
      memoryDir: this.memoryDir,
      globalRootDir: join(rootDir, "global"),
      workspaceDir: this.workspaceDir,
    });
    this.repository.setPipelineState("workspaceDir", this.workspaceDir);
    this.extractor = new LlmMemoryExtractor(
      buildLlmConfig(options.llm),
      options.runtime,
      this.logger,
    );
    this.indexer = new HeartbeatIndexer(this.repository, this.extractor, {
      settings: this.repository.getIndexingSettings(this.defaultIndexingSettings),
      batchSize: options.heartbeatBatchSize ?? 30,
      source: this.source,
      logger: this.logger,
    });
    this.retriever = new ReasoningRetriever(this.repository, this.extractor, {
      getSettings: () => this.getSettings(),
    });
  }

  close(): void {
    this.repository.close();
  }

  getSettings(): IndexingSettings {
    return this.repository.getIndexingSettings(this.defaultIndexingSettings);
  }

  saveSettings(partial: Partial<IndexingSettings>): IndexingSettings {
    const settings = this.repository.saveIndexingSettings(partial, this.defaultIndexingSettings);
    this.indexer.setSettings(settings);
    this.retriever.resetTransientState();
    return settings;
  }

  overview() {
    return this.repository.getOverview();
  }

  private getPipelineTimestamp(key: string): string | undefined {
    const value = this.repository.getPipelineState<string>(key);
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private setPipelineTimestamp(key: string, value: string | undefined): void {
    if (typeof value === "string" && value.trim()) {
      this.repository.setPipelineState(key, value);
      return;
    }
    this.repository.deletePipelineState(key);
  }

  private reconcileAutoIndexAnchor(options: {
    manualResetAt?: string;
    sessionKeys?: string[];
  } = {}): string | undefined {
    if (options.manualResetAt) {
      this.setPipelineTimestamp(AUTO_INDEX_ANCHOR_AT_STATE_KEY, options.manualResetAt);
      return options.manualResetAt;
    }

    const firstPendingAt = this.repository.getEarliestPendingTimestamp(options.sessionKeys);
    if (!firstPendingAt) {
      this.setPipelineTimestamp(AUTO_INDEX_ANCHOR_AT_STATE_KEY, undefined);
      return undefined;
    }

    const existing = this.getPipelineTimestamp(AUTO_INDEX_ANCHOR_AT_STATE_KEY);
    if (existing) return existing;
    this.setPipelineTimestamp(AUTO_INDEX_ANCHOR_AT_STATE_KEY, firstPendingAt);
    return firstPendingAt;
  }

  private reconcileAutoDreamAnchor(options: {
    manualResetAt?: string;
    fallbackAt?: string;
  } = {}): string | undefined {
    const lastDreamAt = this.getPipelineTimestamp("lastDreamAt");
    const lastIndexedAt = this.getPipelineTimestamp("lastIndexedAt");
    const changedFilesSinceLastDream = this.repository
      .getFileMemoryStore()
      .getOverview(lastDreamAt)
      .changedFilesSinceLastDream;

    if (!lastIndexedAt || changedFilesSinceLastDream <= 0) {
      this.setPipelineTimestamp(AUTO_DREAM_ANCHOR_AT_STATE_KEY, undefined);
      return undefined;
    }

    if (options.manualResetAt) {
      this.setPipelineTimestamp(AUTO_DREAM_ANCHOR_AT_STATE_KEY, options.manualResetAt);
      return options.manualResetAt;
    }

    const existing = this.getPipelineTimestamp(AUTO_DREAM_ANCHOR_AT_STATE_KEY);
    if (existing) return existing;

    const nextAnchor = options.fallbackAt ?? lastIndexedAt;
    this.setPipelineTimestamp(AUTO_DREAM_ANCHOR_AT_STATE_KEY, nextAnchor);
    return nextAnchor;
  }

  snapshot(limit = 50): MemoryUiSnapshot {
    return this.repository.getUiSnapshot(limit);
  }

  captureTurn(
    rawMessages: readonly unknown[],
    input: {
      sessionKey: string;
      timestamp?: string;
      source?: string;
    },
  ): CaptureTurnResult {
    const normalizedMessages = toMessages(rawMessages, {
      includeAssistant: this.includeAssistant,
      maxMessageChars: this.maxMessageChars,
      captureStrategy: this.captureStrategy,
    });
    if (normalizedMessages.length === 0) {
      return {
        captured: false,
        normalizedMessages,
        sessionKey: input.sessionKey,
      };
    }

    this.indexer.captureL0Session({
      sessionKey: input.sessionKey,
      timestamp: input.timestamp ?? nowIso(),
      messages: normalizedMessages,
      source: input.source ?? this.source,
    });

    return {
      captured: true,
      normalizedMessages,
      sessionKey: input.sessionKey,
    };
  }

  async flush(options: {
    batchSize?: number;
    sessionKeys?: string[];
    reason?: string;
  } = {}): Promise<HeartbeatStats> {
    const manualResetAt = options.reason === "manual" ? nowIso() : undefined;
    if (manualResetAt) {
      this.reconcileAutoIndexAnchor({
        manualResetAt,
        ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
      });
    }
    const stats = await this.indexer.runHeartbeat(options);
    this.reconcileAutoIndexAnchor(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {});
    if (stats.writtenFiles > 0) {
      this.reconcileAutoDreamAnchor({ fallbackAt: nowIso() });
    } else {
      this.reconcileAutoDreamAnchor();
    }
    this.retriever.resetTransientState();
    return stats;
  }

  async dream(trigger: "manual" | "scheduled" = "manual"): Promise<DreamRunResult> {
    if (trigger === "manual") {
      this.reconcileAutoDreamAnchor({ manualResetAt: nowIso() });
    }
    const prepFlush = await this.flush({
      reason: trigger === "manual" ? "manual_dream_prep" : "scheduled_dream_prep",
    });
    const stage = this.repository.createDreamStage("dream");
    let outcome;
    let stagedSnapshot;
    try {
      const stagedRunner = new DreamRewriteRunner(stage.repository, this.extractor, {
        logger: this.logger,
      });
      outcome = await stagedRunner.run(trigger);
      stagedSnapshot = stage.repository.captureCurrentMemorySnapshot();
      stage.repository.close();
    } catch (error) {
      stage.dispose();
      throw error;
    }

    if (!outcome || !stagedSnapshot) {
      stage.dispose();
      throw new Error("Dream staging failed before a valid outcome was produced.");
    }

    try {
      if (!outcome.isNoOp) {
        const lastDreamSnapshotMetadata = buildLastDreamSnapshotMetadata({
          sourceAction: "dream",
          workspaceDir: this.workspaceDir,
          capturedAt: outcome.finishedAt,
          before: {
            workspaceVersion: stage.snapshot.workspaceVersion,
            globalVersion: stage.snapshot.globalVersion,
            counts: stage.snapshot.counts,
            runtimeState: stage.snapshot.runtimeState,
          },
          after: {
            workspaceVersion: stagedSnapshot.workspaceVersion,
            globalVersion: stagedSnapshot.globalVersion,
            counts: stagedSnapshot.counts,
            runtimeState: {
              lastDreamAt: outcome.finishedAt,
              lastDreamStatus: "success",
              lastDreamSummary: outcome.summary,
            },
          },
          trigger,
          dreamTraceId: outcome.trace.dreamTraceId,
          summary: outcome.summary,
        });
        this.repository.installLastDreamSnapshot(stage.snapshot, lastDreamSnapshotMetadata);
        this.repository.replaceLiveRootsWithStage(stage, stage.snapshot);
      }
    } finally {
      stage.dispose();
    }

    this.repository.setPipelineState("lastDreamAt", outcome.finishedAt);
    this.repository.setPipelineState("lastDreamStatus", "success");
    this.repository.setPipelineState("lastDreamSummary", outcome.summary);
    this.repository.saveDreamTrace(outcome.trace);
    this.reconcileAutoDreamAnchor();
    this.repository.getFileMemoryStore().repairManifests();
    this.retriever.resetTransientState();
    return {
      prepFlush,
      reviewedFiles: outcome.reviewedFiles,
      rewrittenProjects: outcome.rewrittenProjects,
      deletedProjects: outcome.deletedProjects,
      deletedFiles: outcome.deletedFiles,
      profileUpdated: outcome.profileUpdated,
      duplicateTopicCount: outcome.duplicateTopicCount,
      conflictTopicCount: outcome.conflictTopicCount,
      summary: outcome.summary,
      trigger,
      status: "success",
    };
  }

  rollbackLastDream(): DreamRollbackResult {
    const result = this.repository.rollbackLastDreamSnapshot();
    this.reconcileAutoDreamAnchor({ manualResetAt: result.rolledBackAt });
    this.repository.getFileMemoryStore().repairManifests();
    this.retriever.resetTransientState();
    return result;
  }

  async retrieve(
    query: string,
    options: {
      recentMessages?: MemoryMessage[];
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
    } = {},
  ): Promise<RetrievalResult> {
    return this.retriever.retrieve(query, options);
  }

  async retrieveContext(
    query: string,
    options: {
      recentMessages?: MemoryMessage[];
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
    } = {},
  ): Promise<RetrieveContextResult> {
    const result = await this.retrieve(query, options);
    return {
      ...result,
      systemContext: result.context ? buildMemoryRecallSystemContext(result.context) : "",
    };
  }

  async runDueScheduledMaintenance(reason = "scheduled"): Promise<{
    indexRan: boolean;
    dreamRan: boolean;
    indexStats?: HeartbeatStats;
    dreamResult?: DreamRunResult;
  }> {
    const settings = this.getSettings();
    const nowMs = Date.now();
    let overview = this.overview();
    let indexStats: HeartbeatStats | undefined;
    let dreamResult: DreamRunResult | undefined;
    const indexAnchorAt = this.reconcileAutoIndexAnchor();
    const pendingDialogueTurns = this.repository.countPendingDialogueTurns();
    const shouldIndexByBacklog = pendingDialogueTurns >= AUTO_INDEX_PENDING_DIALOGUE_TURN_THRESHOLD;
    const shouldIndexByInterval = overview.pendingSessions > 0
      && hasElapsedMinutes(
        indexAnchorAt,
        settings.autoIndexIntervalMinutes,
        nowMs,
      );

    if (shouldIndexByBacklog || shouldIndexByInterval) {
      const scheduledReason = reason.startsWith("scheduled") ? reason : `scheduled:${reason}`;
      indexStats = await this.flush({
        reason: shouldIndexByBacklog
          ? `${scheduledReason}:pending_threshold`
          : scheduledReason,
      });
      overview = this.overview();
    }

    const changedFilesSinceLastDream = this.repository
      .getFileMemoryStore()
      .getOverview(overview.lastDreamAt)
      .changedFilesSinceLastDream;
    const dreamAnchorAt = this.reconcileAutoDreamAnchor();

    if (
      changedFilesSinceLastDream > 0
      && hasElapsedMinutes(
        dreamAnchorAt,
        settings.autoDreamIntervalMinutes,
        nowMs,
      )
    ) {
      dreamResult = await this.dream("scheduled");
    }

    return {
      indexRan: Boolean(indexStats),
      dreamRan: Boolean(dreamResult),
      ...(indexStats ? { indexStats } : {}),
      ...(dreamResult ? { dreamResult } : {}),
    };
  }

  async search(query: string, options: {
    recentMessages?: MemoryMessage[];
    workspaceHint?: string;
  } = {}): Promise<RetrievalResult> {
    return this.retrieve(query, {
      ...options,
      retrievalMode: "explicit",
    });
  }

  list(options: MemoryListOptions = {}) {
    return this.repository.listMemoryEntries(options);
  }

  get(ids: string[], maxLines = 80) {
    return this.repository.getMemoryRecordsByIds(ids, maxLines);
  }

  getUserSummary() {
    return this.repository.getUserSummary();
  }

  getProjectMeta() {
    return this.repository.getProjectMeta();
  }

  getWorkspaceMode() {
    return this.repository.getWorkspaceMode();
  }

  listReadableProjectCatalog() {
    return this.repository.listReadableProjectCatalog();
  }

  getReadableProject(logicalProjectId: string) {
    return this.repository.getReadableProject(logicalProjectId);
  }

  listReadableProjectEntries(
    logicalProjectId: string,
    options: {
      kinds?: Array<"project" | "feedback">;
      includeDeprecated?: boolean;
      query?: string;
      includeExternal?: boolean;
    } = {},
  ) {
    return this.repository.listReadableProjectEntries(logicalProjectId, options);
  }

  updateProjectMeta(input: {
    projectId?: string;
    projectName: string;
    description: string;
    status: string;
  }) {
    return this.repository.editProjectMeta(input);
  }

  getSnapshotVersion() {
    return this.repository.getSnapshotVersion();
  }

  listCaseTraces(limit = 30) {
    return this.repository.listRecentCaseTraces(limit).map((record) => normalizeCaseTraceContextPreview(record));
  }

  saveCaseTrace(record: Omit<CaseTraceRecord, "caseId"> & { caseId?: string }) {
    const startedAt = record.startedAt || nowIso();
    this.repository.saveCaseTrace({
      caseId: record.caseId?.trim() || `case_trace_${hashText(`${record.sessionKey}:${record.query}:${startedAt}:${Math.random().toString(36).slice(2, 10)}`)}`,
      sessionKey: record.sessionKey,
      query: record.query,
      startedAt,
      finishedAt: record.finishedAt,
      status: record.status,
      retrieval: record.retrieval,
      toolEvents: record.toolEvents,
      assistantReply: record.assistantReply,
    });
  }

  getCaseTrace(caseId: string) {
    const record = this.repository.getCaseTrace(caseId);
    return record ? normalizeCaseTraceContextPreview(record) : undefined;
  }

  listIndexTraces(limit = 30) {
    return this.repository.listRecentIndexTraces(limit);
  }

  getIndexTrace(indexTraceId: string) {
    return this.repository.getIndexTrace(indexTraceId);
  }

  listDreamTraces(limit = 30) {
    return this.repository.listRecentDreamTraces(limit);
  }

  getDreamTrace(dreamTraceId: string) {
    return this.repository.getDreamTrace(dreamTraceId);
  }

  exportBundle(): MemoryExportBundle {
    return this.repository.exportMemoryBundle();
  }

  importBundle(bundle: MemoryImportableBundle): MemoryImportResult {
    const result = this.repository.importMemoryBundle(bundle);
    this.indexer.setSettings(this.getSettings());
    this.retriever.resetTransientState();
    return result;
  }

  clear(scope: ClearMemoryScope = "current_project"): ClearMemoryResult {
    const result = scope === "all_memory"
      ? this.repository.clearAllMemoryData()
      : this.repository.clearCurrentWorkspaceMemoryData();
    this.retriever.resetTransientState();
    return result;
  }

  act(input: MemoryActionRequest): MemoryActionResult {
    const messages: string[] = [];
    let mutatedIds: string[] = [];
    let deletedProjectIds: string[] = [];

    if (input.action === "edit_project_meta") {
      const meta = this.repository.editProjectMeta({
        projectName: input.projectName,
        description: input.description,
        status: input.status,
      });
      mutatedIds = [meta.relativePath];
      messages.push(`Updated current project metadata for ${meta.projectName}.`);
    } else if (input.action === "edit_entry") {
      const record = this.repository.editMemoryEntry({
        id: input.id,
        name: input.name,
        description: input.description,
        ...(input.fields ? { fields: input.fields } : {}),
      });
      mutatedIds = [record.relativePath];
      messages.push(`Updated memory entry ${record.name}.`);
    } else if (input.action === "delete_entries") {
      const result = this.repository.deleteMemoryEntries(input.ids);
      mutatedIds = result.mutatedIds;
      deletedProjectIds = result.deletedProjectIds;
      messages.push(`Deleted ${result.mutatedIds.length} memory file${result.mutatedIds.length === 1 ? "" : "s"}.`);
      if (deletedProjectIds.length > 0) {
        messages.push(`Removed ${deletedProjectIds.length} empty project${deletedProjectIds.length === 1 ? "" : "s"}.`);
      }
    } else if (input.action === "deprecate_entries") {
      const result = this.repository.deprecateMemoryEntries(input.ids);
      mutatedIds = result.mutatedIds;
      deletedProjectIds = result.deletedProjectIds;
      messages.push(`Deprecated ${result.mutatedIds.length} memory file${result.mutatedIds.length === 1 ? "" : "s"}.`);
    } else if (input.action === "restore_entries") {
      const result = this.repository.restoreMemoryEntries(input.ids);
      mutatedIds = result.mutatedIds;
      deletedProjectIds = result.deletedProjectIds;
      messages.push(`Restored ${result.mutatedIds.length} memory file${result.mutatedIds.length === 1 ? "" : "s"}.`);
    }

    this.retriever.resetTransientState();
    return {
      ok: true,
      action: input.action,
      updatedOverview: this.overview(),
      mutatedIds,
      deletedProjectIds,
      messages,
    };
  }
}

export function summarizeTranscriptMessage(raw: unknown): TranscriptMessageInfo {
  return inspectTranscriptMessage(raw);
}
