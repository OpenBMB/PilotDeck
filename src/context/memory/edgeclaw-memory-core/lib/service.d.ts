import { type CaseTraceRecord, type ClearMemoryScope, type ClearMemoryResult, type DreamRunResult, type DreamRollbackResult, type HeartbeatStats, HeartbeatIndexer, type IndexingSettings, LlmMemoryExtractor, type MemoryActionRequest, type MemoryActionResult, type MemoryExportBundle, type MemoryImportResult, type MemoryImportableBundle, type MemoryMessage, type MemoryRecordType, type MemoryUiSnapshot, MemoryRepository, type RetrievalResult, ReasoningRetriever } from "./core/index.js";
import { type TranscriptMessageInfo } from "./message-utils.js";
type LoggerLike = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
export type EdgeClawMemoryApiType = "openai-responses" | "responses" | "openai-completions";
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
export declare function buildMemoryRecallSystemContext(evidenceBlock: string): string;
export declare function buildEdgeClawMemoryPromptSection(options?: {
    availableTools?: Iterable<string>;
    citationsMode?: "off" | "on";
}): string | null;
export declare class EdgeClawMemoryService {
    readonly workspaceDir: string;
    readonly dataDir: string;
    readonly dbPath: string;
    readonly memoryDir: string;
    readonly defaultIndexingSettings: IndexingSettings;
    readonly repository: MemoryRepository;
    readonly extractor: LlmMemoryExtractor;
    readonly indexer: HeartbeatIndexer;
    readonly retriever: ReasoningRetriever;
    private readonly logger?;
    private readonly captureStrategy;
    private readonly includeAssistant;
    private readonly maxMessageChars;
    private readonly source;
    constructor(options: EdgeClawMemoryServiceOptions);
    close(): void;
    getSettings(): IndexingSettings;
    saveSettings(partial: Partial<IndexingSettings>): IndexingSettings;
    overview(): import("./core/types.js").DashboardOverview;
    private getPipelineTimestamp;
    private setPipelineTimestamp;
    private reconcileAutoIndexAnchor;
    private reconcileAutoDreamAnchor;
    snapshot(limit?: number): MemoryUiSnapshot;
    captureTurn(rawMessages: readonly unknown[], input: {
        sessionKey: string;
        timestamp?: string;
        source?: string;
    }): CaptureTurnResult;
    flush(options?: {
        batchSize?: number;
        sessionKeys?: string[];
        reason?: string;
    }): Promise<HeartbeatStats>;
    dream(trigger?: "manual" | "scheduled"): Promise<DreamRunResult>;
    rollbackLastDream(): DreamRollbackResult;
    retrieve(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
        retrievalMode?: "auto" | "explicit";
    }): Promise<RetrievalResult>;
    retrieveContext(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
        retrievalMode?: "auto" | "explicit";
    }): Promise<RetrieveContextResult>;
    runDueScheduledMaintenance(reason?: string): Promise<{
        indexRan: boolean;
        dreamRan: boolean;
        indexStats?: HeartbeatStats;
        dreamResult?: DreamRunResult;
    }>;
    search(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
    }): Promise<RetrievalResult>;
    list(options?: MemoryListOptions): import("./core/types.js").MemoryManifestEntry[];
    get(ids: string[], maxLines?: number): import("./core/types.js").MemoryFileRecord[];
    getUserSummary(): import("./core/types.js").MemoryUserSummary;
    getProjectMeta(): import("./core/types.js").ProjectMetaRecord | undefined;
    getWorkspaceMode(): import("./core/types.js").WorkspaceMemoryMode;
    listReadableProjectCatalog(): import("./core/types.js").ReadableProjectCatalogEntry[];
    getReadableProject(logicalProjectId: string): import("./core/types.js").ReadableProjectCatalogEntry | undefined;
    listReadableProjectEntries(logicalProjectId: string, options?: {
        kinds?: Array<"project" | "feedback">;
        includeDeprecated?: boolean;
        query?: string;
        includeExternal?: boolean;
    }): import("./core/types.js").MemoryManifestEntry[];
    updateProjectMeta(input: {
        projectId?: string;
        projectName: string;
        description: string;
        status: string;
    }): import("./core/types.js").ProjectMetaRecord;
    getSnapshotVersion(): string;
    listCaseTraces(limit?: number): CaseTraceRecord[];
    saveCaseTrace(record: Omit<CaseTraceRecord, "caseId"> & {
        caseId?: string;
    }): void;
    getCaseTrace(caseId: string): CaseTraceRecord | undefined;
    listIndexTraces(limit?: number): import("./core/types.js").IndexTraceRecord[];
    getIndexTrace(indexTraceId: string): import("./core/types.js").IndexTraceRecord | undefined;
    listDreamTraces(limit?: number): import("./core/types.js").DreamTraceRecord[];
    getDreamTrace(dreamTraceId: string): import("./core/types.js").DreamTraceRecord | undefined;
    exportBundle(): MemoryExportBundle;
    importBundle(bundle: MemoryImportableBundle): MemoryImportResult;
    clear(scope?: ClearMemoryScope): ClearMemoryResult;
    act(input: MemoryActionRequest): MemoryActionResult;
}
export declare function summarizeTranscriptMessage(raw: unknown): TranscriptMessageInfo;
export {};
