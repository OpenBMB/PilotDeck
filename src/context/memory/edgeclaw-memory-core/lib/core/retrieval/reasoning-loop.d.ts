import type { IndexingSettings, MemoryMessage, RetrievalResult, RecallMode } from "../types.js";
import { LlmMemoryExtractor } from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
export interface RetrievalOptions {
    retrievalMode?: "auto" | "explicit";
    recentMessages?: MemoryMessage[];
    workspaceHint?: string;
}
export interface RetrievalRuntimeOptions {
    getSettings?: () => IndexingSettings;
    isBackgroundBusy?: () => boolean;
}
export interface RetrievalRuntimeStats {
    lastRecallMs: number;
    recallTimeouts: number;
    lastRecallMode: RecallMode;
    lastRecallPath: "auto" | "explicit" | "shadow";
    lastRecallInjected: boolean;
    lastRecallCacheHit: boolean;
}
export declare class ReasoningRetriever {
    private readonly repository;
    private readonly extractor;
    private readonly options;
    private readonly recallCache;
    private runtimeStats;
    constructor(repository: MemoryRepository, extractor: LlmMemoryExtractor, options?: RetrievalRuntimeOptions);
    getRuntimeStats(): RetrievalRuntimeStats;
    resetTransientState(): void;
    retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult>;
}
