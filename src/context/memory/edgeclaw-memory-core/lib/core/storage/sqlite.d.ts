import { type CaseTraceRecord, type ClearMemoryScope, type DashboardOverview, type DreamRollbackResult, type DreamRuntimeStateSnapshot, type DreamTraceRecord, type IndexTraceRecord, type IndexingSettings, type LastDreamSnapshotMetadata, type LastDreamSnapshotOverview, type L0SessionRecord, type MemoryExportBundle, type MemoryEntryEditFields, type MemoryFileRecord, type MemoryImportResult, type MemoryImportableBundle, type MemoryManifestEntry, type MemoryMessage, type MemorySnapshotFileRecord, type ProjectMetaRecord, type MemoryTransferCounts, type MemoryUiSnapshot, type ReadableProjectCatalogEntry, type WorkspaceMemoryMode } from "../types.js";
import { FileMemoryStore } from "../file-memory.js";
export interface LiveMemorySnapshot {
    workspaceFiles: MemorySnapshotFileRecord[];
    globalFiles: MemorySnapshotFileRecord[];
    counts: MemoryTransferCounts;
    workspaceVersion: string;
    globalVersion: string;
    runtimeState: DreamRuntimeStateSnapshot;
}
export interface MemoryRepositoryStage {
    repository: MemoryRepository;
    snapshot: LiveMemorySnapshot;
    stagedWorkspaceRoot: string;
    stagedGlobalRoot: string;
    stagedDbPath: string;
    dispose: () => void;
}
export declare class MemoryBundleValidationError extends Error {
    constructor(message: string);
}
export interface ClearMemoryResult {
    scope: ClearMemoryScope;
    cleared: {
        l0Sessions: number;
        pipelineState: number;
        memoryFiles: number;
        projectMetas: number;
    };
    clearedAt: string;
}
export interface RepairMemoryResult {
    inspected: number;
    updated: number;
    removed: number;
    rebuilt: boolean;
}
export declare class MemoryRepository {
    private readonly dbPath;
    private readonly db;
    private readonly workspaceDir;
    private readonly workspaceMode;
    private readonly memoryDir;
    private readonly workspacesRoot;
    private readonly globalRootDir;
    private readonly workspaceMemory;
    private readonly globalUserMemory;
    private externalWorkspaceCache;
    constructor(dbPath: string, options?: {
        memoryDir?: string;
        globalRootDir?: string;
        workspaceDir?: string;
    });
    private init;
    private migratePipelineStateTable;
    close(): void;
    getFileMemoryStore(): FileMemoryStore;
    getGlobalUserStore(): FileMemoryStore;
    getWorkspaceMode(): WorkspaceMemoryMode;
    private currentWorkspacePath;
    private readWorkspaceDirFromDb;
    private getExternalWorkspaceSnapshots;
    private buildProjectSummary;
    listReadableProjectCatalog(): ReadableProjectCatalogEntry[];
    getReadableProject(logicalProjectId: string): ReadableProjectCatalogEntry | undefined;
    private mapExternalManifestEntry;
    private mapExternalFileRecord;
    listReadableProjectEntries(logicalProjectId: string, options?: {
        kinds?: Array<"project" | "feedback">;
        includeDeprecated?: boolean;
        query?: string;
        includeExternal?: boolean;
    }): MemoryManifestEntry[];
    repairWorkspaceManifest(): {
        changed: number;
        summary: string;
        memoryFileCount: number;
    };
    getUserSummary(): ReturnType<FileMemoryStore["getUserSummary"]>;
    private mapGlobalManifestEntry;
    private mapGlobalFileRecord;
    private listGlobalMemoryEntries;
    private readPipelineState;
    getPipelineState<T = unknown>(key: string): T | undefined;
    setPipelineState(key: string, value: unknown): void;
    deletePipelineState(key: string): void;
    insertL0Session(record: L0SessionRecord): void;
    listPendingSessionKeys(limit?: number, preferredSessionKeys?: string[]): string[];
    countPendingDialogueTurns(preferredSessionKeys?: string[]): number;
    getEarliestPendingTimestamp(preferredSessionKeys?: string[]): string | undefined;
    listUnindexedL0BySession(sessionKey: string): L0SessionRecord[];
    getLatestL0Before(sessionKey: string, timestamp: string, createdAt: string): L0SessionRecord | undefined;
    markL0Indexed(ids: string[]): void;
    getL0ByIds(ids: string[]): L0SessionRecord[];
    listRecentL0(limit?: number, offset?: number): L0SessionRecord[];
    listAllL0(): L0SessionRecord[];
    repairL0Sessions(transform: (record: L0SessionRecord) => MemoryMessage[]): RepairMemoryResult;
    saveCaseTrace(record: CaseTraceRecord, limit?: number): void;
    listRecentCaseTraces(limit?: number): CaseTraceRecord[];
    getCaseTrace(caseId: string): CaseTraceRecord | undefined;
    saveIndexTrace(record: IndexTraceRecord, limit?: number): void;
    listRecentIndexTraces(limit?: number): IndexTraceRecord[];
    getIndexTrace(indexTraceId: string): IndexTraceRecord | undefined;
    saveDreamTrace(record: DreamTraceRecord, limit?: number): void;
    listRecentDreamTraces(limit?: number): DreamTraceRecord[];
    getDreamTrace(dreamTraceId: string): DreamTraceRecord | undefined;
    getIndexingSettings(defaults: IndexingSettings): IndexingSettings;
    saveIndexingSettings(partial: Partial<IndexingSettings>, defaults: IndexingSettings): IndexingSettings;
    private workspaceStoreOptions;
    private globalStoreOptions;
    private captureDreamRuntimeState;
    private getWorkspaceDir;
    private restoreDreamRuntimeState;
    private captureLiveMemorySnapshot;
    captureCurrentMemorySnapshot(): LiveMemorySnapshot;
    private lastDreamSnapshotRoot;
    private lastDreamSnapshotWorkspaceRoot;
    private lastDreamSnapshotGlobalRoot;
    private lastDreamSnapshotMetadataPath;
    private replaceDirectoryWithStaged;
    private stageLastDreamSnapshot;
    private loadLastDreamSnapshotRecord;
    clearLastDreamSnapshot(): void;
    getLastDreamSnapshotOverview(): LastDreamSnapshotOverview | undefined;
    createDreamStage(label?: string): MemoryRepositoryStage;
    private createStagedRepositoryFromSnapshot;
    replaceLiveRootsWithStage(stage: MemoryRepositoryStage, fallbackSnapshot: LiveMemorySnapshot): void;
    installLastDreamSnapshot(snapshot: LiveMemorySnapshot, metadata: LastDreamSnapshotMetadata): void;
    rollbackLastDreamSnapshot(): DreamRollbackResult;
    private buildTransferCounts;
    private materializeSnapshotBundle;
    private writeSnapshotFilesToRoot;
    private stageImportBundle;
    private resetImportedRuntimeState;
    exportMemoryBundle(): MemoryExportBundle;
    importMemoryBundle(bundle: MemoryImportableBundle): MemoryImportResult;
    getOverview(): DashboardOverview;
    getUiSnapshot(limit?: number): MemoryUiSnapshot;
    listMemoryEntries(options?: {
        kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
        query?: string;
        limit?: number;
        offset?: number;
        scope?: "global" | "project";
        projectId?: string;
        includeTmp?: boolean;
        includeDeprecated?: boolean;
    }): MemoryManifestEntry[];
    countMemoryEntries(options?: {
        kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
        query?: string;
        scope?: "global" | "project";
        projectId?: string;
        includeTmp?: boolean;
        includeDeprecated?: boolean;
    }): number;
    getMemoryRecordsByIds(ids: string[], maxLines?: number): MemoryFileRecord[];
    editProjectMeta(input: {
        projectId?: string;
        projectName: string;
        description: string;
        status: string;
    }): ProjectMetaRecord;
    ensureProjectMeta(input?: {
        projectName?: string;
        description?: string;
        status?: string;
    }): ProjectMetaRecord;
    getProjectMeta(): ProjectMetaRecord | undefined;
    editMemoryEntry(input: {
        id: string;
        name: string;
        description: string;
        fields?: MemoryEntryEditFields;
    }): MemoryFileRecord;
    deleteMemoryEntries(ids: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    deprecateMemoryEntries(ids: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    restoreMemoryEntries(ids: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    archiveTmpEntries(input: {
        ids: string[];
        targetProjectId?: string;
        newProjectName?: string;
    }): {
        mutatedIds: string[];
        targetProjectId?: string;
        createdProjectId?: string;
    };
    getSnapshotVersion(): string;
    clearAllMemoryData(): ClearMemoryResult;
    clearCurrentWorkspaceMemoryData(): ClearMemoryResult;
}
