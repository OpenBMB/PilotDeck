import type { MemoryCandidate, MemoryMessage, MemoryRoute, MemoryUserSummary, ProjectIdentityHint, ProjectMetaRecord, ProjectShortlistCandidate, RecallHeaderEntry, RetrievalPromptDebug } from "../types.js";
type LoggerLike = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
type PromptDebugSink = (debug: RetrievalPromptDebug) => void;
export interface FileMemoryExtractionDiscardedCandidate {
    reason: string;
    candidateType?: "user" | "feedback" | "project";
    candidateName?: string;
    summary?: string;
}
export interface FileMemoryExtractionDebug {
    parsedItems: unknown[];
    normalizedCandidates: MemoryCandidate[];
    discarded: FileMemoryExtractionDiscardedCandidate[];
    finalCandidates: MemoryCandidate[];
    fallbackApplied?: string;
}
type MemoryCreateKind = "user" | "project" | "feedback";
export interface MemoryClassificationLabel {
    type: MemoryCreateKind;
    reason: string;
    evidence: string;
}
export interface FileMemoryClassificationResult {
    shouldStore: boolean;
    labels: MemoryClassificationLabel[];
}
export interface LlmDreamFileProjectMetaInput {
    projectId: string;
    projectName: string;
    description: string;
    status: string;
    updatedAt: string;
    dreamUpdatedAt?: string;
    sourceKind?: string;
    sourceWorkspacePath?: string;
    sourceProjectId?: string;
}
export interface LlmDreamFileRecordInput {
    entryId: string;
    relativePath: string;
    type: "project" | "feedback";
    scope: "project";
    projectId?: string;
    isTmp: boolean;
    name: string;
    description: string;
    updatedAt: string;
    capturedAt?: string;
    sourceSessionKey?: string;
    content: string;
    project?: {
        stage: string;
        decisions: string[];
        constraints: string[];
        nextSteps: string[];
        blockers: string[];
        timeline: string[];
        notes: string[];
    };
    feedback?: {
        rule: string;
        why: string;
        howToApply: string;
        notes: string[];
    };
}
export interface LlmDreamFileGlobalPlanInput {
    currentProjects: LlmDreamFileProjectMetaInput[];
    records: LlmDreamFileRecordInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmDreamFileGlobalPlanProject {
    planKey: string;
    targetProjectId?: string;
    projectName: string;
    description: string;
    status: string;
    mergeReason?: "rename" | "alias_equivalence" | "duplicate_formal_project";
    evidenceEntryIds: string[];
    retainedEntryIds: string[];
}
export interface LlmDreamFileGlobalPlanOutput {
    summary: string;
    duplicateTopicCount: number;
    conflictTopicCount: number;
    projects: LlmDreamFileGlobalPlanProject[];
    deletedProjectIds: string[];
    deletedEntryIds: string[];
}
export interface LlmDreamFileProjectRewriteInput {
    project: LlmDreamFileGlobalPlanProject & {
        projectId: string;
    };
    currentMeta: LlmDreamFileProjectMetaInput | null;
    records: LlmDreamFileRecordInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmDreamFileProjectRewriteOutputFile {
    type: "project" | "feedback";
    name: string;
    description: string;
    sourceEntryIds: string[];
    stage?: string;
    decisions?: string[];
    constraints?: string[];
    nextSteps?: string[];
    blockers?: string[];
    timeline?: string[];
    notes?: string[];
    rule?: string;
    why?: string;
    howToApply?: string;
}
export interface LlmDreamFileProjectRewriteOutput {
    summary: string;
    projectMeta: {
        projectName: string;
        description: string;
        status: string;
    };
    files: LlmDreamFileProjectRewriteOutputFile[];
    deletedEntryIds: string[];
}
export interface LlmGeneralProjectMetaMergeInput {
    projectMetas: LlmDreamFileProjectMetaInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmGeneralProjectMetaMergeGroup {
    keeperProjectId: string;
    duplicateProjectIds: string[];
    reason: string;
}
export interface LlmGeneralProjectMetaMergeOutput {
    summary: string;
    mergeGroups: LlmGeneralProjectMetaMergeGroup[];
}
export interface LlmDreamClusterHeaderInput {
    relativePath: string;
    name: string;
    description: string;
    updatedAt: string;
}
export interface LlmDreamCluster {
    memberRelativePaths: string[];
    reason: string;
}
export interface LlmDreamClusterPlanInput {
    kind: "project" | "feedback";
    headers: LlmDreamClusterHeaderInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmDreamClusterPlanOutput {
    summary: string;
    clusters: LlmDreamCluster[];
}
export interface LlmDreamClusterRefineInput {
    kind: "project" | "feedback";
    records: LlmDreamFileRecordInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmDreamClusterRefineOutput {
    summary: string;
    file: {
        name: string;
        description: string;
        markdown: string;
    } | null;
}
export interface LlmDreamProjectMetaReviewInput {
    currentMeta: LlmDreamFileProjectMetaInput;
    recentProjectRecords: LlmDreamFileRecordInput[];
    recentFeedbackRecords: LlmDreamFileRecordInput[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
}
export interface LlmDreamProjectMetaReviewOutput {
    shouldUpdate: boolean;
    reason: string;
    projectMeta: {
        projectName: string;
        description: string;
        status: string;
    };
}
export declare class LlmMemoryExtractor {
    private readonly config;
    private readonly runtime;
    private readonly logger?;
    constructor(config: Record<string, unknown>, runtime: Record<string, unknown> | undefined, logger?: LoggerLike | undefined);
    private resolveSelection;
    private resolveApiKey;
    private callStructuredJson;
    private callStructuredJsonWithDebug;
    rewriteUserProfile(input: {
        existingProfile: MemoryUserSummary | null;
        candidates: MemoryCandidate[];
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<MemoryCandidate | null>;
    classifyMemoryTurn(input: {
        timestamp: string;
        sessionKey?: string;
        focusUserTurn: MemoryMessage;
        batchContextMessages: MemoryMessage[];
        currentProjectMeta?: ProjectMetaRecord | null;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<FileMemoryClassificationResult>;
    private createMemoryNote;
    createUserMemoryNote(input: {
        timestamp: string;
        sessionKey?: string;
        focusUserTurn: MemoryMessage;
        batchContextMessages: MemoryMessage[];
        currentProjectMeta?: ProjectMetaRecord | null;
        classification: MemoryClassificationLabel;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<MemoryCandidate | null>;
    createProjectMemoryNote(input: {
        timestamp: string;
        sessionKey?: string;
        focusUserTurn: MemoryMessage;
        batchContextMessages: MemoryMessage[];
        currentProjectMeta?: ProjectMetaRecord | null;
        classification: MemoryClassificationLabel;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<MemoryCandidate | null>;
    createFeedbackMemoryNote(input: {
        timestamp: string;
        sessionKey?: string;
        focusUserTurn: MemoryMessage;
        batchContextMessages: MemoryMessage[];
        currentProjectMeta?: ProjectMetaRecord | null;
        classification: MemoryClassificationLabel;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<MemoryCandidate | null>;
    planDreamClusters(input: LlmDreamClusterPlanInput): Promise<LlmDreamClusterPlanOutput>;
    refineDreamCluster(input: LlmDreamClusterRefineInput): Promise<LlmDreamClusterRefineOutput>;
    planGeneralProjectMetaMerges(input: LlmGeneralProjectMetaMergeInput): Promise<LlmGeneralProjectMetaMergeOutput>;
    reviewDreamProjectMeta(input: LlmDreamProjectMetaReviewInput): Promise<LlmDreamProjectMetaReviewOutput>;
    planDreamFileMemory(input: LlmDreamFileGlobalPlanInput): Promise<LlmDreamFileGlobalPlanOutput>;
    rewriteDreamFileProject(input: LlmDreamFileProjectRewriteInput): Promise<LlmDreamFileProjectRewriteOutput>;
    decideFileMemoryRoute(input: {
        query: string;
        recentMessages?: MemoryMessage[];
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<MemoryRoute>;
    selectRecallProject(input: {
        query: string;
        recentUserMessages?: MemoryMessage[];
        shortlist: ProjectShortlistCandidate[];
        allowEmpty?: boolean;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<{
        projectId?: string;
        reason?: string;
    }>;
    selectIndexProject(input: {
        candidate: MemoryCandidate;
        candidatePreview: string;
        focusTurn: MemoryMessage;
        recentUserMessages?: MemoryMessage[];
        shortlist: ProjectShortlistCandidate[];
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<{
        decision: "attach_existing" | "create_new";
        projectId?: string;
        reason?: string;
    }>;
    selectFileManifestEntries(input: {
        query: string;
        route: MemoryRoute;
        recentUserMessages?: MemoryMessage[];
        projectMeta?: ProjectMetaRecord;
        manifest: RecallHeaderEntry[];
        limit?: number;
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
    }): Promise<string[]>;
    extractFileMemoryCandidates(input: {
        timestamp: string;
        sessionKey?: string;
        messages: MemoryMessage[];
        batchContextMessages?: MemoryMessage[];
        knownProjects?: ProjectIdentityHint[];
        agentId?: string;
        timeoutMs?: number;
        debugTrace?: PromptDebugSink;
        decisionTrace?: (debug: FileMemoryExtractionDebug) => void;
    }): Promise<MemoryCandidate[]>;
}
export {};
