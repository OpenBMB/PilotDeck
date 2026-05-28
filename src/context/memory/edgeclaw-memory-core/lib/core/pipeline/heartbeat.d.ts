import type { IndexingSettings, L0SessionRecord, MemoryMessage } from "../types.js";
import { LlmMemoryExtractor } from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
export interface HeartbeatOptions {
    batchSize?: number;
    source?: string;
    settings: IndexingSettings;
    logger?: {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
    };
}
export interface HeartbeatRunOptions {
    batchSize?: number;
    sessionKeys?: string[];
    reason?: string;
}
export interface HeartbeatStats {
    capturedSessions: number;
    writtenFiles: number;
    writtenUserFiles: number;
    writtenProjectFiles: number;
    writtenFeedbackFiles: number;
    userProfilesUpdated: number;
    failedSessions: number;
}
export declare class HeartbeatIndexer {
    private readonly repository;
    private readonly extractor;
    private readonly batchSize;
    private readonly source;
    private readonly logger;
    private settings;
    constructor(repository: MemoryRepository, extractor: LlmMemoryExtractor, options: HeartbeatOptions);
    getSettings(): IndexingSettings;
    setSettings(settings: IndexingSettings): void;
    private routeGeneralCandidate;
    captureL0Session(input: {
        sessionKey: string;
        timestamp?: string;
        messages: MemoryMessage[];
        source?: string;
    }): L0SessionRecord | undefined;
    runHeartbeat(options?: HeartbeatRunOptions): Promise<HeartbeatStats>;
}
