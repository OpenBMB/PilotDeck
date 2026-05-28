import type { GeneralProjectSourceKind, MemoryCandidate, MemoryEntryEditFields, MemoryFileExportRecord, MemoryFileRecord, MemoryManifestEntry, MemorySnapshotFileRecord, MemoryUserSummary, ProjectIdentityHint, ProjectMetaExportRecord, ProjectMetaRecord, WorkspaceMemoryMode } from "./types.js";
export declare const TMP_PROJECT_ID = "_tmp";
export declare const CURRENT_PROJECT_ID = "current_project";
export interface FileMemoryStoreOptions {
    workspaceMode?: WorkspaceMemoryMode;
    manageProjectMeta?: boolean;
    manageProjectFiles?: boolean;
    manageUserProfile?: boolean;
    userProfileRelativePath?: string | null;
    userNotesRelativeDir?: string | null;
    appendOnlyUserEntries?: boolean;
    enableManifest?: boolean;
    manifestUserEntriesProvider?: () => MemoryManifestEntry[];
}
export interface FileMemoryOverview {
    totalFiles: number;
    projectMemories: number;
    feedbackMemories: number;
    userProfiles: number;
    changedFilesSinceLastDream: number;
    tmpTotalFiles: number;
    tmpFeedbackMemories: number;
    tmpProjectMemories: number;
    projectMetaCount: number;
    generalProjectMetaCount?: number;
    latestMemoryAt?: string;
}
export declare class FileMemoryStore {
    private readonly rootDir;
    private readonly workspaceMode;
    private readonly manageProjectMeta;
    private readonly manageProjectFiles;
    private readonly manageUserProfile;
    private readonly userProfileRelativePath;
    private readonly userNotesRelativeDir;
    private readonly appendOnlyUserEntries;
    private readonly enableManifest;
    private readonly manifestUserEntriesProvider?;
    constructor(rootDir: string, options?: FileMemoryStoreOptions);
    getRootDir(): string;
    getWorkspaceMode(): WorkspaceMemoryMode;
    isGeneralMode(): boolean;
    getUserProfileRelativePath(): string | null;
    private projectMetaPath;
    private requireUserProfileRelativePath;
    private ensureLayout;
    private resolveRelativePath;
    private isPathWithinRoot;
    private readMarkdownFile;
    private buildManifestEntry;
    private writeRecord;
    private collectDirectoryRecords;
    private collectAllEntries;
    private readProjectMetaFile;
    private buildProjectMetaSeed;
    private generalProjectMetaRelativePath;
    private toGeneralProjectMetaRecord;
    private listGeneralProjectMetaEntries;
    upsertGeneralProjectMeta(input: {
        projectId?: string;
        projectName: string;
        description?: string;
        status?: string;
        sourceKind?: GeneralProjectSourceKind;
        sourceWorkspacePath?: string;
        sourceProjectId?: string;
        dreamUpdatedAt?: string;
    }): ProjectMetaRecord;
    upsertProjectMeta(input?: {
        projectId?: string;
        projectName?: string;
        description?: string;
        status?: string;
        sourceKind?: GeneralProjectSourceKind;
        sourceWorkspacePath?: string;
        sourceProjectId?: string;
        dreamUpdatedAt?: string;
    }): ProjectMetaRecord;
    ensureProjectMeta(input?: {
        projectId?: string;
        projectName?: string;
        description?: string;
        status?: string;
        sourceKind?: GeneralProjectSourceKind;
        sourceWorkspacePath?: string;
        sourceProjectId?: string;
    }): ProjectMetaRecord;
    private findExistingRecordForCandidate;
    private nextRecordRelativePath;
    private resolveManifestLinkPath;
    private buildManifest;
    repairManifests(): {
        changed: number;
        summary: string;
        memoryFileCount: number;
    };
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
    getUserSummary(): MemoryUserSummary;
    upsertUserProfile(candidate: MemoryCandidate): MemoryFileRecord;
    upsertCandidate(candidate: MemoryCandidate): MemoryFileRecord;
    toCandidate(record: MemoryFileRecord): MemoryCandidate;
    editEntry(input: {
        relativePath: string;
        name: string;
        description: string;
        fields?: MemoryEntryEditFields;
    }): MemoryFileRecord;
    markEntriesDeprecated(relativePaths: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    restoreEntries(relativePaths: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    deleteEntries(relativePaths: string[]): {
        mutatedIds: string[];
        deletedProjectIds: string[];
    };
    reassignProjectEntries(input: {
        fromProjectId: string;
        toProjectId: string;
    }): {
        mutatedIds: string[];
    };
    archiveTmpEntries(_: {
        relativePaths: string[];
        targetProjectId?: string;
        newProjectName?: string;
    }): {
        mutatedIds: string[];
        targetProjectId?: string;
        createdProjectId?: string;
    };
    listProjectMetas(_options?: {
        includeTmp?: boolean;
    }): ProjectMetaRecord[];
    listProjectIdentityHints(_options?: {
        includeTmp?: boolean;
        limit?: number;
    }): ProjectIdentityHint[];
    getProjectMeta(projectId?: string): ProjectMetaRecord | undefined;
    hasVisibleProjectMemory(projectId?: string): boolean;
    listTmpEntries(_limit?: number): MemoryManifestEntry[];
    editProjectMeta(input: {
        projectId?: string;
        projectName: string;
        description: string;
        status: string;
    }): ProjectMetaRecord;
    exportBundleRecords(_options?: {
        includeTmp?: boolean;
    }): {
        memoryFiles: MemoryFileExportRecord[];
        projectMetas: ProjectMetaExportRecord[];
    };
    exportSnapshotFiles(): MemorySnapshotFileRecord[];
    clearAllData(options?: {
        rebuildManifest?: boolean;
    }): void;
    getOverview(lastDreamAt?: string): FileMemoryOverview;
    getSnapshotVersion(lastDreamAt?: string): string;
    mergeDuplicateEntries(entries: MemoryManifestEntry[]): {
        merged: number;
        changedFiles: string[];
        deletedFiles: string[];
    };
}
