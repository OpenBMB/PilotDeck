import type { DreamTraceRecord } from "../types.js";
import type { HeartbeatStats } from "../pipeline/heartbeat.js";
import { LlmMemoryExtractor } from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
type LoggerLike = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
interface DreamReviewRunnerOptions {
    logger?: LoggerLike;
}
export interface DreamRewriteOutcome {
    reviewedFiles: number;
    rewrittenProjects: number;
    deletedProjects: number;
    deletedFiles: number;
    profileUpdated: boolean;
    duplicateTopicCount: number;
    conflictTopicCount: number;
    summary: string;
}
export interface DreamRunResult extends DreamRewriteOutcome {
    prepFlush: HeartbeatStats;
    trigger?: "manual" | "scheduled";
    status?: "success" | "skipped";
    skipReason?: string;
}
export interface DreamExecutionResult extends DreamRewriteOutcome {
    finishedAt: string;
    isNoOp: boolean;
    trace: DreamTraceRecord;
}
export declare class DreamRewriteRunner {
    private readonly repository;
    private readonly extractor;
    private readonly logger?;
    constructor(repository: MemoryRepository, extractor: LlmMemoryExtractor, options?: DreamReviewRunnerOptions);
    private runCategoryDream;
    private mergeGeneralProjectMetas;
    private runProjectMetaReview;
    run(trigger?: DreamTraceRecord["trigger"]): Promise<DreamExecutionResult>;
}
export {};
