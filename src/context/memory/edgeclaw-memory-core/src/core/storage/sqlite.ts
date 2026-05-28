import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CaseTraceRecord,
  type ClearMemoryScope,
  type DashboardOverview,
  type DreamRollbackResult,
  type DreamRuntimeStateSnapshot,
  type DreamPipelineStatus,
  type DreamTraceRecord,
  type GeneralProjectSourceKind,
  type IndexTraceRecord,
  type IndexingSettings,
  type LastDreamSnapshotMetadata,
  type LastDreamSnapshotOverview,
  type LastDreamSnapshotSourceAction,
  type L0SessionRecord,
  MEMORY_EXPORT_FORMAT_VERSION,
  type MemoryExportBundle,
  type MemoryEntryEditFields,
  type MemoryFileRecord,
  type MemoryImportResult,
  type MemoryImportableBundle,
  type MemoryManifestEntry,
  type MemoryMessage,
  type MemorySnapshotFileRecord,
  type ProjectMetaRecord,
  type MemoryTransferCounts,
  type MemoryUiSnapshot,
  type ReadableProjectCatalogEntry,
  type ReadableProjectSourceKind,
  type WorkspaceMemoryMode,
} from "../types.js";
import { FileMemoryStore, type FileMemoryStoreOptions } from "../file-memory.js";
import {
  buildExternalProjectLogicalId,
  buildExternalRecordId,
  getWorkspaceMemoryMode,
  isExternalRecordId,
  parseExternalRecordId,
} from "../general-projects.js";
import { hashText, nowIso } from "../utils/id.js";

interface SqlStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

type DbRow = Record<string, unknown>;

const INDEXING_SETTINGS_STATE_KEY = "indexingSettings" as const;
const LAST_INDEXED_AT_STATE_KEY = "lastIndexedAt" as const;
const LAST_DREAM_AT_STATE_KEY = "lastDreamAt" as const;
const LAST_DREAM_STATUS_STATE_KEY = "lastDreamStatus" as const;
const LAST_DREAM_SUMMARY_STATE_KEY = "lastDreamSummary" as const;
const RECENT_CASE_TRACES_STATE_KEY = "recentCaseTraces" as const;
const RECENT_INDEX_TRACES_STATE_KEY = "recentIndexTraces" as const;
const RECENT_DREAM_TRACES_STATE_KEY = "recentDreamTraces" as const;
const GLOBAL_MEMORY_PREFIX = "global/";
const GLOBAL_USER_PROFILE_RELATIVE_PATH = "UserIdentity/user-profile.md";
const GLOBAL_USER_NOTES_RELATIVE_DIR = "UserIdentityNotes";
const LAST_DREAM_SNAPSHOT_DIR = "last_dream";
const LAST_DREAM_SNAPSHOT_METADATA_FILE = "metadata.json";

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

interface LastDreamSnapshotRecord {
  metadata: LastDreamSnapshotMetadata;
  workspaceFiles: MemorySnapshotFileRecord[];
  globalFiles: MemorySnapshotFileRecord[];
}

interface ExternalWorkspaceSnapshot {
  workspacePath: string;
  workspaceName: string;
  workspaceMode: WorkspaceMemoryMode;
  workspaceKey: string;
  store: FileMemoryStore;
}

export class MemoryBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryBundleValidationError";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeMessages(value: unknown): MemoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      ...(typeof item.msgId === "string" && item.msgId.trim() ? { msgId: item.msgId } : {}),
      role: typeof item.role === "string" && item.role.trim() ? item.role : "user",
      content: typeof item.content === "string" ? item.content : "",
    }));
}

function normalizeL0Row(row: DbRow): L0SessionRecord {
  return {
    l0IndexId: String(row.l0_index_id),
    sessionKey: String(row.session_key),
    timestamp: String(row.timestamp),
    messages: normalizeMessages(parseJson(String(row.messages_json ?? "[]"), [])),
    source: String(row.source ?? ""),
    indexed: Boolean(row.indexed),
    createdAt: String(row.created_at),
  };
}

function sanitizeTraceArray<T extends object>(
  value: unknown,
  key: keyof T & string,
  sortKey: keyof T & string,
): T[] {
  if (!Array.isArray(value)) return [];
  const sorted = value
    .filter((item): item is T => {
      if (!isRecord(item)) return false;
      const keyed = item as Record<string, unknown>;
      return typeof keyed[key] === "string" && typeof keyed[sortKey] === "string";
    })
    .sort((left, right) => {
      const rightValue = (right as Record<string, unknown>)[sortKey];
      const leftValue = (left as Record<string, unknown>)[sortKey];
      return String(rightValue).localeCompare(String(leftValue));
    });
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of sorted) {
    const id = String((item as Record<string, unknown>)[key]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(item);
  }
  return next;
}

function normalizeIndexTraceRecord(record: IndexTraceRecord): IndexTraceRecord {
  const isNoOp = typeof record.isNoOp === "boolean"
    ? record.isNoOp
    : record.status === "completed" && record.storedResults.length === 0;
  const displayStatus = typeof record.displayStatus === "string" && record.displayStatus.trim()
    ? record.displayStatus
    : record.status === "error"
      ? "Error"
      : isNoOp
        ? "No-op"
        : record.status === "running"
          ? "Running"
          : "Completed";
  return {
    ...record,
    isNoOp,
    displayStatus,
  };
}

function normalizeDreamTraceRecord(record: DreamTraceRecord): DreamTraceRecord {
  const isNoOp = typeof record.isNoOp === "boolean"
    ? record.isNoOp
    : record.status !== "error"
      && record.outcome.deletedFiles === 0
      && record.outcome.rewrittenProjects === 0
      && !record.outcome.profileUpdated;
  const displayStatus = typeof record.displayStatus === "string" && record.displayStatus.trim()
    ? record.displayStatus
    : record.status === "error"
      ? "Error"
      : isNoOp
        ? "No-op"
        : record.status === "running"
          ? "Running"
          : "Completed";
  return {
    ...record,
    isNoOp,
    displayStatus,
  };
}

function sanitizeDreamStatus(value: unknown): DreamPipelineStatus | undefined {
  return value === "running" || value === "success" || value === "skipped" || value === "failed"
    ? value
    : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function sanitizeIndexingSettings(input: unknown, defaults: IndexingSettings): IndexingSettings {
  const record = isRecord(input) ? input : {};
  return {
    reasoningMode: record.reasoningMode === "accuracy_first" ? "accuracy_first" : defaults.reasoningMode,
    autoIndexIntervalMinutes: clampInt(record.autoIndexIntervalMinutes, defaults.autoIndexIntervalMinutes, 0, 10_080),
    autoDreamIntervalMinutes: clampInt(record.autoDreamIntervalMinutes, defaults.autoDreamIntervalMinutes, 0, 10_080),
  };
}

function normalizeSnapshotRelativePath(value: unknown, index: number): string {
  const raw = normalizeString(value).trim().replace(/\\/g, "/");
  if (!raw) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  if (isAbsolute(raw)) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  const segments = raw.split("/").filter(Boolean);
  if (
    segments.length === 0
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new MemoryBundleValidationError(`Invalid files[${index}].relativePath`);
  }
  return segments.join("/");
}

function normalizeSnapshotFileRecord(value: unknown, index: number): MemorySnapshotFileRecord {
  if (!isRecord(value)) throw new MemoryBundleValidationError(`Invalid files[${index}]`);
  if (typeof value.content !== "string") {
    throw new MemoryBundleValidationError(`Invalid files[${index}].content`);
  }
  return {
    relativePath: normalizeSnapshotRelativePath(value.relativePath, index),
    content: value.content,
  };
}

function hasLegacyMultiProjectPath(relativePath: string): boolean {
  return relativePath.startsWith("projects/")
    || relativePath.includes("/project.meta.md");
}

function normalizeMemoryBundle(value: unknown): MemoryImportableBundle {
  if (!isRecord(value)) throw new MemoryBundleValidationError("Invalid memory bundle");
  const scope = normalizeString(
    typeof value.scope === "string" ? value.scope : undefined,
  );
  if (scope && scope !== "current_project") {
    throw new MemoryBundleValidationError(
      "Unsupported memory bundle scope. Expected current_project.",
    );
  }
  const metadata = {
    exportedAt: normalizeString(value.exportedAt).trim() || nowIso(),
    ...(typeof value.lastIndexedAt === "string" && value.lastIndexedAt.trim() ? { lastIndexedAt: value.lastIndexedAt.trim() } : {}),
    ...(typeof value.lastDreamAt === "string" && value.lastDreamAt.trim() ? { lastDreamAt: value.lastDreamAt.trim() } : {}),
    ...(sanitizeDreamStatus(value.lastDreamStatus) ? { lastDreamStatus: sanitizeDreamStatus(value.lastDreamStatus)! } : {}),
    ...(typeof value.lastDreamSummary === "string" && value.lastDreamSummary.trim()
      ? { lastDreamSummary: value.lastDreamSummary.trim() }
      : {}),
    ...(sanitizeTraceArray<CaseTraceRecord>(value.recentCaseTraces, "caseId", "startedAt").length > 0
      ? { recentCaseTraces: sanitizeTraceArray<CaseTraceRecord>(value.recentCaseTraces, "caseId", "startedAt") }
      : {}),
    ...(sanitizeTraceArray<IndexTraceRecord>(value.recentIndexTraces, "indexTraceId", "startedAt").length > 0
      ? { recentIndexTraces: sanitizeTraceArray<IndexTraceRecord>(value.recentIndexTraces, "indexTraceId", "startedAt") }
      : {}),
    ...(sanitizeTraceArray<DreamTraceRecord>(value.recentDreamTraces, "dreamTraceId", "startedAt").length > 0
      ? { recentDreamTraces: sanitizeTraceArray<DreamTraceRecord>(value.recentDreamTraces, "dreamTraceId", "startedAt") }
      : {}),
  };
  if (value.formatVersion === MEMORY_EXPORT_FORMAT_VERSION) {
    if (!Array.isArray(value.files)) {
      throw new MemoryBundleValidationError("Invalid memory snapshot bundle files");
    }
    const files = value.files.map((item, index) => normalizeSnapshotFileRecord(item, index));
    const seenPaths = new Set<string>();
    for (const record of files) {
      if (seenPaths.has(record.relativePath)) {
        throw new MemoryBundleValidationError(`Duplicate imported snapshot file path: ${record.relativePath}`);
      }
      seenPaths.add(record.relativePath);
      if (hasLegacyMultiProjectPath(record.relativePath)) {
        throw new MemoryBundleValidationError(
          "Legacy multi-project memory bundles are not supported in current-project memory mode",
        );
      }
    }
    return {
      formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
      scope: "current_project",
      ...metadata,
      files,
    };
  }
  throw new MemoryBundleValidationError(
    `Unsupported memory bundle formatVersion. Expected ${MEMORY_EXPORT_FORMAT_VERSION}.`,
  );
}

function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function isGlobalRelativePath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath).startsWith(GLOBAL_MEMORY_PREFIX);
}

function toExposedGlobalRelativePath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith(GLOBAL_MEMORY_PREFIX)
    ? normalized
    : `${GLOBAL_MEMORY_PREFIX}${normalized}`;
}

function toInternalGlobalRelativePath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith(GLOBAL_MEMORY_PREFIX)
    ? normalized.slice(GLOBAL_MEMORY_PREFIX.length)
    : normalized;
}

function sortManifestEntries(entries: MemoryManifestEntry[]): MemoryManifestEntry[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.relativePath.localeCompare(right.relativePath);
  });
}

async function loadSqlDatabaseFactory(): Promise<(dbPath: string) => SqlDatabase> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const bunSqliteModuleName = "bun:sqlite";
    const bunSqlite = await import(bunSqliteModuleName) as {
      Database: new (path: string, options?: { create?: boolean }) => {
        exec(sql: string): void;
        query(sql: string): SqlStatement;
        close(): void;
      };
    };
    return (dbPath: string) => {
      const db = new bunSqlite.Database(dbPath, { create: true });
      return {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => db.query(sql),
        close: () => db.close(),
      };
    };
  }

  const nodeSqlite = await import("node:sqlite");
  return (dbPath: string) => {
    const db = new nodeSqlite.DatabaseSync(dbPath);
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    };
  };
}

const createSqlDatabase = await loadSqlDatabaseFactory();

function createSiblingTempPath(targetDir: string, label: string): string {
  const parentDir = dirname(targetDir);
  return join(
    parentDir,
    `.${basename(targetDir)}.${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function sortSnapshotFiles(files: readonly MemorySnapshotFileRecord[]): MemorySnapshotFileRecord[] {
  return [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function snapshotVersionFromFiles(files: readonly MemorySnapshotFileRecord[]): string {
  return hashText(JSON.stringify(sortSnapshotFiles(
    files.filter((file) => file.relativePath !== "MEMORY.md"),
  )));
}

function readSnapshotFiles(rootDir: string): MemorySnapshotFileRecord[] {
  if (!existsSync(rootDir)) return [];
  const files: MemorySnapshotFileRecord[] = [];
  const walk = (currentDir: string) => {
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        relativePath: relative(rootDir, absolutePath).replace(/\\/g, "/"),
        content: readFileSync(absolutePath, "utf8"),
      });
    }
  };
  walk(rootDir);
  return files;
}

function sameDreamRuntimeState(
  left: DreamRuntimeStateSnapshot,
  right: DreamRuntimeStateSnapshot,
): boolean {
  return (left.lastDreamAt ?? "") === (right.lastDreamAt ?? "")
    && (left.lastDreamStatus ?? "") === (right.lastDreamStatus ?? "")
    && (left.lastDreamSummary ?? "") === (right.lastDreamSummary ?? "");
}

export class MemoryRepository {
  private readonly dbPath: string;
  private readonly db: SqlDatabase;
  private readonly workspaceDir: string;
  private readonly workspaceMode: WorkspaceMemoryMode;
  private readonly memoryDir: string;
  private readonly workspacesRoot: string;
  private readonly globalRootDir: string;
  private readonly workspaceMemory: FileMemoryStore;
  private readonly globalUserMemory: FileMemoryStore;
  private externalWorkspaceCache = new Map<string, ExternalWorkspaceSnapshot>();

  constructor(
    dbPath: string,
    options: {
      memoryDir?: string;
      globalRootDir?: string;
      workspaceDir?: string;
    } = {},
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = resolve(dbPath);
    this.memoryDir = resolve(options.memoryDir ?? join(dirname(dbPath), "memory"));
    this.workspacesRoot = dirname(dirname(this.memoryDir));
    this.globalRootDir = resolve(options.globalRootDir ?? join(dirname(this.workspacesRoot), "global"));
    this.workspaceDir = resolve(
      options.workspaceDir
      ?? dirname(dirname(this.memoryDir)),
    );
    this.workspaceMode = getWorkspaceMemoryMode(this.workspaceDir);
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.globalRootDir, { recursive: true });
    this.db = createSqlDatabase(dbPath);
    this.globalUserMemory = new FileMemoryStore(this.globalRootDir, {
      manageProjectMeta: false,
      manageProjectFiles: false,
      manageUserProfile: true,
      userProfileRelativePath: GLOBAL_USER_PROFILE_RELATIVE_PATH,
      userNotesRelativeDir: GLOBAL_USER_NOTES_RELATIVE_DIR,
      appendOnlyUserEntries: true,
      enableManifest: false,
    });
    this.workspaceMemory = new FileMemoryStore(this.memoryDir, {
      workspaceMode: this.workspaceMode,
      manageProjectMeta: true,
      manageProjectFiles: true,
      manageUserProfile: false,
      enableManifest: true,
      manifestUserEntriesProvider: () => this.listGlobalMemoryEntries(),
    });
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS l0_sessions (
        l0_index_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        source TEXT NOT NULL,
        indexed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_l0_sessions_session ON l0_sessions(session_key);
      CREATE INDEX IF NOT EXISTS idx_l0_sessions_pending ON l0_sessions(indexed, timestamp);
      CREATE TABLE IF NOT EXISTS pipeline_state (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migratePipelineStateTable();
  }

  private migratePipelineStateTable(): void {
    const columns = this.db.prepare("PRAGMA table_info(pipeline_state)").all() as DbRow[];
    const columnNames = new Set(
      columns
        .map((column) => String(column.name ?? "").trim())
        .filter(Boolean),
    );
    if (columnNames.has("state_json") && !columnNames.has("state_value")) return;
    if (!columnNames.has("state_json") && !columnNames.has("state_value")) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_state_v2 (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pipeline_state_v2 (state_key, state_json, updated_at)
      SELECT
        state_key,
        COALESCE(state_json, state_value),
        updated_at
      FROM pipeline_state;
      DROP TABLE pipeline_state;
      ALTER TABLE pipeline_state_v2 RENAME TO pipeline_state;
    `);
  }

  close(): void {
    this.externalWorkspaceCache.clear();
    this.db.close();
  }

  getFileMemoryStore(): FileMemoryStore {
    return this.workspaceMemory;
  }

  getGlobalUserStore(): FileMemoryStore {
    return this.globalUserMemory;
  }

  getWorkspaceMode(): WorkspaceMemoryMode {
    return this.workspaceMode;
  }

  private currentWorkspacePath(): string {
    return this.getWorkspaceDir() || this.workspaceDir;
  }

  private readWorkspaceDirFromDb(dbPath: string): string | null {
    try {
      const db = createSqlDatabase(dbPath);
      try {
        const row = db.prepare(
          "SELECT state_json FROM pipeline_state WHERE state_key = ?",
        ).get("workspaceDir") as DbRow | undefined;
        if (!row || typeof row.state_json !== "string") return null;
        const parsed = parseJson<string | undefined>(row.state_json, undefined);
        return typeof parsed === "string" && parsed.trim() ? resolve(parsed.trim()) : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  private getExternalWorkspaceSnapshots(): ExternalWorkspaceSnapshot[] {
    if (this.workspaceMode !== "general") return [];
    const currentWorkspacePath = this.currentWorkspacePath();
    const currentMemoryDir = this.workspaceMemory.getRootDir();
    const nextCache = new Map<string, ExternalWorkspaceSnapshot>();
    const snapshots: ExternalWorkspaceSnapshot[] = [];
    const entries = existsSync(this.workspacesRoot)
      ? readdirSync(this.workspacesRoot, { withFileTypes: true })
      : [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dataDir = join(this.workspacesRoot, entry.name);
      const memoryDir = join(dataDir, "memory");
      const dbPath = join(dataDir, "control.sqlite");
      if (!existsSync(memoryDir) || !existsSync(dbPath) || resolve(memoryDir) === resolve(currentMemoryDir)) {
        continue;
      }
      const workspacePath = this.readWorkspaceDirFromDb(dbPath);
      if (!workspacePath || resolve(workspacePath) === resolve(currentWorkspacePath)) continue;
      const workspaceMode = getWorkspaceMemoryMode(workspacePath);
      if (workspaceMode !== "single") continue;
      const workspaceKey = hashText(resolve(workspacePath)).slice(0, 16);
      const cached = this.externalWorkspaceCache.get(workspaceKey);
      const snapshot = cached && cached.workspacePath === workspacePath
        ? cached
        : {
            workspacePath,
            workspaceName: basename(workspacePath),
            workspaceMode,
            workspaceKey,
            store: new FileMemoryStore(memoryDir, {
              workspaceMode,
              manageProjectMeta: true,
              manageProjectFiles: true,
              manageUserProfile: false,
              enableManifest: true,
            }),
          };
      nextCache.set(workspaceKey, snapshot);
      snapshots.push(snapshot);
    }
    this.externalWorkspaceCache = nextCache;
    return snapshots;
  }

  private buildProjectSummary(store: FileMemoryStore, projectId: string): ReadableProjectCatalogEntry["summary"] {
    const entries = store.listMemoryEntries({
      kinds: ["project", "feedback"],
      scope: "project",
      projectId,
      includeDeprecated: false,
      limit: 5000,
      offset: 0,
    });
    const projectEntries = entries.filter((entry) => entry.type === "project");
    const feedbackEntries = entries.filter((entry) => entry.type === "feedback");
    return {
      totalEntries: entries.length,
      projectEntries: projectEntries.length,
      feedbackEntries: feedbackEntries.length,
      ...(entries[0]?.updatedAt ? { latestMemoryAt: entries[0].updatedAt } : {}),
    };
  }

  listReadableProjectCatalog(): ReadableProjectCatalogEntry[] {
    if (this.workspaceMode !== "general") {
      const meta = this.workspaceMemory.getProjectMeta();
      if (!meta) return [];
      return [{
        ...meta,
        workspaceMode: this.workspaceMode,
        workspacePath: this.currentWorkspacePath(),
        workspaceName: basename(this.currentWorkspacePath()),
        sourceType: "general_local",
        logicalProjectId: meta.projectId,
        readOnly: false,
        hasLocalMirror: false,
        summary: this.buildProjectSummary(this.workspaceMemory, meta.projectId),
      }];
    }

    const localMetas = this.workspaceMemory.listProjectMetas();
    const localByExternalKey = new Map<string, ProjectMetaRecord>();
    const catalog: ReadableProjectCatalogEntry[] = [];
    for (const meta of localMetas) {
      if (meta.sourceKind === "workspace_external_mirror" && meta.sourceWorkspacePath && meta.sourceProjectId) {
        localByExternalKey.set(`${resolve(meta.sourceWorkspacePath)}::${meta.sourceProjectId}`, meta);
      }
    }

    const externalSnapshots = this.getExternalWorkspaceSnapshots();
    for (const snapshot of externalSnapshots) {
      const meta = snapshot.store.getProjectMeta();
      if (!meta) continue;
      const summary = this.buildProjectSummary(snapshot.store, meta.projectId);
      const externalLogicalProjectId = buildExternalProjectLogicalId(snapshot.workspacePath, meta.projectId);
      const mirror = localByExternalKey.get(`${resolve(snapshot.workspacePath)}::${meta.projectId}`);
      if (!mirror) {
        catalog.push({
          ...meta,
          workspaceMode: snapshot.workspaceMode,
          workspacePath: snapshot.workspacePath,
          workspaceName: snapshot.workspaceName,
          sourceType: "workspace_external",
          logicalProjectId: externalLogicalProjectId,
          readOnly: true,
          hasLocalMirror: false,
          externalLogicalProjectId,
          summary,
        });
        continue;
      }
      catalog.push({
        ...mirror,
        workspaceMode: "general",
        workspacePath: this.currentWorkspacePath(),
        workspaceName: basename(this.currentWorkspacePath()),
        sourceType: "workspace_external_mirror",
        logicalProjectId: mirror.projectId,
        readOnly: false,
        hasLocalMirror: true,
        localMirrorProjectId: mirror.projectId,
        externalLogicalProjectId,
        summary: {
          totalEntries: summary.totalEntries + this.buildProjectSummary(this.workspaceMemory, mirror.projectId).totalEntries,
          projectEntries: summary.projectEntries + this.buildProjectSummary(this.workspaceMemory, mirror.projectId).projectEntries,
          feedbackEntries: summary.feedbackEntries + this.buildProjectSummary(this.workspaceMemory, mirror.projectId).feedbackEntries,
          latestMemoryAt: [summary.latestMemoryAt, this.buildProjectSummary(this.workspaceMemory, mirror.projectId).latestMemoryAt]
            .filter(Boolean)
            .sort()
            .at(-1),
        },
      });
    }

    for (const meta of localMetas.filter((entry) => entry.sourceKind !== "workspace_external_mirror")) {
      catalog.push({
        ...meta,
        workspaceMode: "general",
        workspacePath: this.currentWorkspacePath(),
        workspaceName: basename(this.currentWorkspacePath()),
        sourceType: "general_local",
        logicalProjectId: meta.projectId,
        readOnly: false,
        hasLocalMirror: false,
        summary: this.buildProjectSummary(this.workspaceMemory, meta.projectId),
      });
    }

    return catalog.sort((left, right) => {
      if ((right.summary.latestMemoryAt || "") !== (left.summary.latestMemoryAt || "")) {
        return (right.summary.latestMemoryAt || "").localeCompare(left.summary.latestMemoryAt || "");
      }
      return left.projectName.localeCompare(right.projectName);
    });
  }

  getReadableProject(logicalProjectId: string): ReadableProjectCatalogEntry | undefined {
    return this.listReadableProjectCatalog().find((entry) => entry.logicalProjectId === logicalProjectId);
  }

  private mapExternalManifestEntry(
    snapshot: ExternalWorkspaceSnapshot,
    entry: MemoryManifestEntry,
  ): MemoryManifestEntry {
    return {
      ...entry,
      relativePath: buildExternalRecordId(snapshot.workspacePath, entry.relativePath),
    };
  }

  private mapExternalFileRecord(
    snapshot: ExternalWorkspaceSnapshot,
    record: MemoryFileRecord,
  ): MemoryFileRecord {
    return {
      ...record,
      relativePath: buildExternalRecordId(snapshot.workspacePath, record.relativePath),
    };
  }

  listReadableProjectEntries(
    logicalProjectId: string,
    options: {
      kinds?: Array<"project" | "feedback">;
      includeDeprecated?: boolean;
      query?: string;
      includeExternal?: boolean;
    } = {},
  ): MemoryManifestEntry[] {
    const project = this.getReadableProject(logicalProjectId);
    if (!project) return [];
    const kinds = options.kinds ?? ["project", "feedback"];
    const includeExternal = options.includeExternal ?? true;
    const entries: MemoryManifestEntry[] = [];
    if (project.sourceType === "general_local" || project.sourceType === "workspace_external_mirror") {
      entries.push(...this.workspaceMemory.listMemoryEntries({
        kinds,
        scope: "project",
        projectId: project.projectId,
        includeDeprecated: options.includeDeprecated,
        ...(options.query ? { query: options.query } : {}),
        limit: 5000,
        offset: 0,
      }));
    }
    if (includeExternal && (project.sourceType === "workspace_external" || project.sourceType === "workspace_external_mirror")) {
      const snapshot = this.getExternalWorkspaceSnapshots().find(
        (item) => resolve(item.workspacePath) === resolve(project.sourceWorkspacePath || project.workspacePath),
      );
      if (snapshot) {
        const sourceProjectId = project.sourceProjectId || project.projectId;
        entries.push(...snapshot.store.listMemoryEntries({
          kinds,
          scope: "project",
          projectId: sourceProjectId,
          includeDeprecated: options.includeDeprecated,
          ...(options.query ? { query: options.query } : {}),
          limit: 5000,
          offset: 0,
        }).map((entry) => this.mapExternalManifestEntry(snapshot, entry)));
      }
    }
    return sortManifestEntries(entries);
  }

  repairWorkspaceManifest() {
    return this.workspaceMemory.repairManifests();
  }

  getUserSummary(): ReturnType<FileMemoryStore["getUserSummary"]> {
    const summary = this.globalUserMemory.getUserSummary();
    return {
      ...summary,
      files: summary.files.map((entry) => this.mapGlobalFileRecord(entry)),
    };
  }

  private mapGlobalManifestEntry(entry: MemoryManifestEntry): MemoryManifestEntry {
    return {
      ...entry,
      relativePath: toExposedGlobalRelativePath(entry.relativePath),
    };
  }

  private mapGlobalFileRecord(record: MemoryFileRecord): MemoryFileRecord {
    return {
      ...record,
      relativePath: toExposedGlobalRelativePath(record.relativePath),
    };
  }

  private listGlobalMemoryEntries(options: {
    kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
    query?: string;
    limit?: number;
    offset?: number;
    scope?: "global" | "project";
    includeDeprecated?: boolean;
  } = {}): MemoryManifestEntry[] {
    const kinds = options.kinds?.filter((kind) => kind === "user");
    if (options.scope === "project") return [];
    if (options.kinds && (!kinds || kinds.length === 0)) return [];
    return this.globalUserMemory.listMemoryEntries({
      ...(kinds ? { kinds } : { kinds: ["user"] }),
      ...(options.query ? { query: options.query } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
      scope: "global",
      includeDeprecated: options.includeDeprecated,
    }).map((entry) => this.mapGlobalManifestEntry(entry));
  }

  private readPipelineState<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT state_json FROM pipeline_state WHERE state_key = ?").get(key) as DbRow | undefined;
    if (!row || typeof row.state_json !== "string") return fallback;
    return parseJson(row.state_json, fallback);
  }

  getPipelineState<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare("SELECT state_json FROM pipeline_state WHERE state_key = ?").get(key) as DbRow | undefined;
    if (!row || typeof row.state_json !== "string") return undefined;
    return parseJson<T | undefined>(row.state_json, undefined);
  }

  setPipelineState(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO pipeline_state (state_key, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), nowIso());
  }

  deletePipelineState(key: string): void {
    this.db.prepare("DELETE FROM pipeline_state WHERE state_key = ?").run(key);
  }

  insertL0Session(record: L0SessionRecord): void {
    const createdAt = record.createdAt || nowIso();
    this.db.prepare(`
      INSERT INTO l0_sessions (
        l0_index_id,
        session_key,
        timestamp,
        messages_json,
        source,
        indexed,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(l0_index_id) DO UPDATE SET
        session_key = excluded.session_key,
        timestamp = excluded.timestamp,
        messages_json = excluded.messages_json,
        source = excluded.source,
        indexed = excluded.indexed,
        created_at = excluded.created_at
    `).run(
      record.l0IndexId,
      record.sessionKey,
      record.timestamp,
      JSON.stringify(record.messages),
      record.source || "openclaw",
      record.indexed ? 1 : 0,
      createdAt,
    );
  }

  listPendingSessionKeys(limit = 50, preferredSessionKeys?: string[]): string[] {
    const normalizedPreferred = Array.isArray(preferredSessionKeys)
      ? preferredSessionKeys.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (normalizedPreferred.length > 0) {
      const placeholders = normalizedPreferred.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT DISTINCT session_key, MIN(timestamp) AS first_timestamp
        FROM l0_sessions
        WHERE indexed = 0 AND session_key IN (${placeholders})
        GROUP BY session_key
        ORDER BY first_timestamp ASC
      `).all(...normalizedPreferred) as DbRow[];
      return rows.map((row) => String(row.session_key)).slice(0, Math.max(1, limit));
    }
    const rows = this.db.prepare(`
      SELECT DISTINCT session_key, MIN(timestamp) AS first_timestamp
      FROM l0_sessions
      WHERE indexed = 0
      GROUP BY session_key
      ORDER BY first_timestamp ASC
      LIMIT ?
    `).all(Math.max(1, limit)) as DbRow[];
    return rows.map((row) => String(row.session_key));
  }

  countPendingDialogueTurns(preferredSessionKeys?: string[]): number {
    const normalizedPreferred = Array.isArray(preferredSessionKeys)
      ? preferredSessionKeys.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (normalizedPreferred.length > 0) {
      const placeholders = normalizedPreferred.map(() => "?").join(", ");
      return Number(
        (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM l0_sessions
          WHERE indexed = 0 AND session_key IN (${placeholders})
        `).get(...normalizedPreferred) as DbRow | undefined)?.count ?? 0,
      );
    }
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS count FROM l0_sessions WHERE indexed = 0").get() as DbRow | undefined)?.count ?? 0,
    );
  }

  getEarliestPendingTimestamp(preferredSessionKeys?: string[]): string | undefined {
    const normalizedPreferred = Array.isArray(preferredSessionKeys)
      ? preferredSessionKeys.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (normalizedPreferred.length > 0) {
      const placeholders = normalizedPreferred.map(() => "?").join(", ");
      const row = this.db.prepare(`
        SELECT MIN(timestamp) AS first_timestamp
        FROM l0_sessions
        WHERE indexed = 0 AND session_key IN (${placeholders})
      `).get(...normalizedPreferred) as DbRow | undefined;
      return typeof row?.first_timestamp === "string" && row.first_timestamp.trim()
        ? row.first_timestamp
        : undefined;
    }
    const row = this.db.prepare(`
      SELECT MIN(timestamp) AS first_timestamp
      FROM l0_sessions
      WHERE indexed = 0
    `).get() as DbRow | undefined;
    return typeof row?.first_timestamp === "string" && row.first_timestamp.trim()
      ? row.first_timestamp
      : undefined;
  }

  listUnindexedL0BySession(sessionKey: string): L0SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM l0_sessions
      WHERE session_key = ? AND indexed = 0
      ORDER BY timestamp ASC, created_at ASC
    `).all(sessionKey) as DbRow[];
    return rows.map((row) => normalizeL0Row(row));
  }

  getLatestL0Before(sessionKey: string, timestamp: string, createdAt: string): L0SessionRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM l0_sessions
      WHERE session_key = ?
        AND (timestamp < ? OR (timestamp = ? AND created_at < ?))
      ORDER BY timestamp DESC, created_at DESC
      LIMIT 1
    `).get(sessionKey, timestamp, timestamp, createdAt) as DbRow | undefined;
    return row ? normalizeL0Row(row) : undefined;
  }

  markL0Indexed(ids: string[]): void {
    const uniqueIds = Array.from(new Set(ids.filter((item) => typeof item === "string" && item.trim().length > 0)));
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db.prepare(`UPDATE l0_sessions SET indexed = 1 WHERE l0_index_id IN (${placeholders})`).run(...uniqueIds);
  }

  getL0ByIds(ids: string[]): L0SessionRecord[] {
    const uniqueIds = Array.from(new Set(ids.filter((item) => typeof item === "string" && item.trim().length > 0)));
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT * FROM l0_sessions
      WHERE l0_index_id IN (${placeholders})
      ORDER BY timestamp DESC, created_at DESC
    `).all(...uniqueIds) as DbRow[];
    return rows.map((row) => normalizeL0Row(row));
  }

  listRecentL0(limit = 20, offset = 0): L0SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM l0_sessions
      ORDER BY timestamp DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(Math.max(1, limit), Math.max(0, offset)) as DbRow[];
    return rows.map((row) => normalizeL0Row(row));
  }

  listAllL0(): L0SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM l0_sessions ORDER BY timestamp ASC, created_at ASC").all() as DbRow[];
    return rows.map((row) => normalizeL0Row(row));
  }

  repairL0Sessions(transform: (record: L0SessionRecord) => MemoryMessage[]): RepairMemoryResult {
    const rows = this.listAllL0();
    let updated = 0;
    let removed = 0;
    for (const row of rows) {
      const nextMessages = transform(row);
      if (nextMessages.length === 0) {
        this.db.prepare("DELETE FROM l0_sessions WHERE l0_index_id = ?").run(row.l0IndexId);
        removed += 1;
        continue;
      }
      if (JSON.stringify(nextMessages) === JSON.stringify(row.messages)) continue;
      this.db.prepare("UPDATE l0_sessions SET messages_json = ?, indexed = 0 WHERE l0_index_id = ?")
        .run(JSON.stringify(nextMessages), row.l0IndexId);
      updated += 1;
    }
    return {
      inspected: rows.length,
      updated,
      removed,
      rebuilt: updated > 0 || removed > 0,
    };
  }

  saveCaseTrace(record: CaseTraceRecord, limit = 30): void {
    const next = sanitizeTraceArray<CaseTraceRecord>(
      [record, ...this.readPipelineState<unknown[]>(RECENT_CASE_TRACES_STATE_KEY, [])],
      "caseId",
      "startedAt",
    ).slice(0, Math.max(1, limit));
    this.setPipelineState(RECENT_CASE_TRACES_STATE_KEY, next);
  }

  listRecentCaseTraces(limit = 30): CaseTraceRecord[] {
    return sanitizeTraceArray<CaseTraceRecord>(
      this.readPipelineState<unknown[]>(RECENT_CASE_TRACES_STATE_KEY, []),
      "caseId",
      "startedAt",
    ).slice(0, Math.max(1, limit));
  }

  getCaseTrace(caseId: string): CaseTraceRecord | undefined {
    return this.listRecentCaseTraces(200).find((item) => item.caseId === caseId);
  }

  saveIndexTrace(record: IndexTraceRecord, limit = 30): void {
    const next = sanitizeTraceArray<IndexTraceRecord>(
      [record, ...this.readPipelineState<unknown[]>(RECENT_INDEX_TRACES_STATE_KEY, [])],
      "indexTraceId",
      "startedAt",
    ).map((item) => normalizeIndexTraceRecord(item)).slice(0, Math.max(1, limit));
    this.setPipelineState(RECENT_INDEX_TRACES_STATE_KEY, next);
  }

  listRecentIndexTraces(limit = 30): IndexTraceRecord[] {
    return sanitizeTraceArray<IndexTraceRecord>(
      this.readPipelineState<unknown[]>(RECENT_INDEX_TRACES_STATE_KEY, []),
      "indexTraceId",
      "startedAt",
    ).map((item) => normalizeIndexTraceRecord(item)).slice(0, Math.max(1, limit));
  }

  getIndexTrace(indexTraceId: string): IndexTraceRecord | undefined {
    return this.listRecentIndexTraces(200).find((item) => item.indexTraceId === indexTraceId);
  }

  saveDreamTrace(record: DreamTraceRecord, limit = 30): void {
    const next = sanitizeTraceArray<DreamTraceRecord>(
      [record, ...this.readPipelineState<unknown[]>(RECENT_DREAM_TRACES_STATE_KEY, [])],
      "dreamTraceId",
      "startedAt",
    ).map((item) => normalizeDreamTraceRecord(item)).slice(0, Math.max(1, limit));
    this.setPipelineState(RECENT_DREAM_TRACES_STATE_KEY, next);
  }

  listRecentDreamTraces(limit = 30): DreamTraceRecord[] {
    return sanitizeTraceArray<DreamTraceRecord>(
      this.readPipelineState<unknown[]>(RECENT_DREAM_TRACES_STATE_KEY, []),
      "dreamTraceId",
      "startedAt",
    ).map((item) => normalizeDreamTraceRecord(item)).slice(0, Math.max(1, limit));
  }

  getDreamTrace(dreamTraceId: string): DreamTraceRecord | undefined {
    return this.listRecentDreamTraces(200).find((item) => item.dreamTraceId === dreamTraceId);
  }

  getIndexingSettings(defaults: IndexingSettings): IndexingSettings {
    return sanitizeIndexingSettings(this.getPipelineState(INDEXING_SETTINGS_STATE_KEY), defaults);
  }

  saveIndexingSettings(partial: Partial<IndexingSettings>, defaults: IndexingSettings): IndexingSettings {
    const current = this.getIndexingSettings(defaults);
    const next = sanitizeIndexingSettings({ ...current, ...partial }, defaults);
    this.setPipelineState(INDEXING_SETTINGS_STATE_KEY, next);
    return next;
  }

  private workspaceStoreOptions(): FileMemoryStoreOptions {
    return {
      workspaceMode: this.workspaceMode,
      manageProjectMeta: true,
      manageProjectFiles: true,
      manageUserProfile: false,
      enableManifest: true,
    };
  }

  private globalStoreOptions(): FileMemoryStoreOptions {
    return {
      manageProjectMeta: false,
      manageProjectFiles: false,
      manageUserProfile: true,
      userProfileRelativePath: GLOBAL_USER_PROFILE_RELATIVE_PATH,
      userNotesRelativeDir: GLOBAL_USER_NOTES_RELATIVE_DIR,
      appendOnlyUserEntries: true,
      enableManifest: false,
    };
  }

  private captureDreamRuntimeState(): DreamRuntimeStateSnapshot {
    const runtimeState: DreamRuntimeStateSnapshot = {};
    const lastDreamAt = this.getPipelineState<string>(LAST_DREAM_AT_STATE_KEY);
    const lastDreamStatus = sanitizeDreamStatus(this.getPipelineState(LAST_DREAM_STATUS_STATE_KEY));
    const lastDreamSummary = this.getPipelineState<string>(LAST_DREAM_SUMMARY_STATE_KEY);
    if (typeof lastDreamAt === "string" && lastDreamAt.trim()) runtimeState.lastDreamAt = lastDreamAt;
    if (lastDreamStatus) runtimeState.lastDreamStatus = lastDreamStatus;
    if (typeof lastDreamSummary === "string" && lastDreamSummary.trim()) runtimeState.lastDreamSummary = lastDreamSummary;
    return runtimeState;
  }

  private getWorkspaceDir(): string {
    const workspaceDir = this.getPipelineState<string>("workspaceDir");
    return typeof workspaceDir === "string" && workspaceDir.trim()
      ? workspaceDir
      : "";
  }

  private restoreDreamRuntimeState(runtimeState: DreamRuntimeStateSnapshot): void {
    for (const key of [
      LAST_DREAM_AT_STATE_KEY,
      LAST_DREAM_STATUS_STATE_KEY,
      LAST_DREAM_SUMMARY_STATE_KEY,
    ]) {
      this.deletePipelineState(key);
    }
    if (runtimeState.lastDreamAt) this.setPipelineState(LAST_DREAM_AT_STATE_KEY, runtimeState.lastDreamAt);
    if (runtimeState.lastDreamStatus) this.setPipelineState(LAST_DREAM_STATUS_STATE_KEY, runtimeState.lastDreamStatus);
    if (runtimeState.lastDreamSummary) this.setPipelineState(LAST_DREAM_SUMMARY_STATE_KEY, runtimeState.lastDreamSummary);
  }

  private captureLiveMemorySnapshot(): LiveMemorySnapshot {
    const workspaceFiles = this.workspaceMemory.exportSnapshotFiles();
    const globalFiles = this.globalUserMemory.exportSnapshotFiles();
    return {
      workspaceFiles,
      globalFiles,
      counts: this.buildTransferCounts(this.workspaceMemory, this.globalUserMemory),
      workspaceVersion: snapshotVersionFromFiles(workspaceFiles),
      globalVersion: snapshotVersionFromFiles(globalFiles),
      runtimeState: this.captureDreamRuntimeState(),
    };
  }

  captureCurrentMemorySnapshot(): LiveMemorySnapshot {
    return this.captureLiveMemorySnapshot();
  }

  private lastDreamSnapshotRoot(): string {
    return join(dirname(this.dbPath), LAST_DREAM_SNAPSHOT_DIR);
  }

  private lastDreamSnapshotWorkspaceRoot(rootDir = this.lastDreamSnapshotRoot()): string {
    return join(rootDir, "workspace");
  }

  private lastDreamSnapshotGlobalRoot(rootDir = this.lastDreamSnapshotRoot()): string {
    return join(rootDir, "global");
  }

  private lastDreamSnapshotMetadataPath(rootDir = this.lastDreamSnapshotRoot()): string {
    return join(rootDir, LAST_DREAM_SNAPSHOT_METADATA_FILE);
  }

  private replaceDirectoryWithStaged(liveRoot: string, stagedRoot: string): void {
    const backupRoot = createSiblingTempPath(liveRoot, "backup");
    let movedLiveRoot = false;
    try {
      if (existsSync(liveRoot)) {
        renameSync(liveRoot, backupRoot);
        movedLiveRoot = true;
      }
      renameSync(stagedRoot, liveRoot);
    } catch (error) {
      if (existsSync(stagedRoot)) {
        rmSync(stagedRoot, { recursive: true, force: true });
      }
      if (movedLiveRoot && !existsSync(liveRoot) && existsSync(backupRoot)) {
        renameSync(backupRoot, liveRoot);
      }
      throw error;
    }
    if (movedLiveRoot && existsSync(backupRoot)) {
      try {
        rmSync(backupRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the live directory has already been swapped in.
      }
    }
  }

  private stageLastDreamSnapshot(snapshot: LiveMemorySnapshot, metadata: LastDreamSnapshotMetadata): string {
    const snapshotRoot = this.lastDreamSnapshotRoot();
    const stagedSnapshotRoot = createSiblingTempPath(snapshotRoot, "snapshot");
    mkdirSync(stagedSnapshotRoot, { recursive: true });
    try {
      this.writeSnapshotFilesToRoot(this.lastDreamSnapshotWorkspaceRoot(stagedSnapshotRoot), snapshot.workspaceFiles);
      this.writeSnapshotFilesToRoot(this.lastDreamSnapshotGlobalRoot(stagedSnapshotRoot), snapshot.globalFiles);
      writeFileSync(
        this.lastDreamSnapshotMetadataPath(stagedSnapshotRoot),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
      );
      return stagedSnapshotRoot;
    } catch (error) {
      rmSync(stagedSnapshotRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private loadLastDreamSnapshotRecord(): LastDreamSnapshotRecord | undefined {
    const snapshotRoot = this.lastDreamSnapshotRoot();
    const metadataPath = this.lastDreamSnapshotMetadataPath(snapshotRoot);
    if (!existsSync(metadataPath)) return undefined;
    const parsed = parseJson<LastDreamSnapshotMetadata | null>(readFileSync(metadataPath, "utf8"), null);
    if (!parsed || parsed.version !== 1) return undefined;
    const workspaceRoot = this.lastDreamSnapshotWorkspaceRoot(snapshotRoot);
    const globalRoot = this.lastDreamSnapshotGlobalRoot(snapshotRoot);
    if (!existsSync(workspaceRoot) || !existsSync(globalRoot)) return undefined;
    return {
      metadata: parsed,
      workspaceFiles: readSnapshotFiles(workspaceRoot),
      globalFiles: readSnapshotFiles(globalRoot),
    };
  }

  clearLastDreamSnapshot(): void {
    rmSync(this.lastDreamSnapshotRoot(), { recursive: true, force: true });
  }

  getLastDreamSnapshotOverview(): LastDreamSnapshotOverview | undefined {
    const snapshot = this.loadLastDreamSnapshotRecord();
    if (!snapshot) return undefined;
    const currentSnapshot = this.captureLiveMemorySnapshot();
    const rollbackReady = snapshot.metadata.after.workspaceVersion === currentSnapshot.workspaceVersion
      && snapshot.metadata.after.globalVersion === currentSnapshot.globalVersion;
    const warning = rollbackReady
      ? undefined
      : "Current memory state no longer matches the last Dream snapshot, so rollback is unavailable.";
    return {
      capturedAt: snapshot.metadata.capturedAt,
      sourceAction: snapshot.metadata.sourceAction,
      sourceWorkspaceDir: snapshot.metadata.sourceWorkspaceDir,
      ...(snapshot.metadata.trigger ? { trigger: snapshot.metadata.trigger } : {}),
      ...(snapshot.metadata.dreamTraceId ? { dreamTraceId: snapshot.metadata.dreamTraceId } : {}),
      ...(snapshot.metadata.summary ? { summary: snapshot.metadata.summary } : {}),
      rollbackReady,
      ...(warning ? { warning } : {}),
    };
  }

  createDreamStage(label = "dream"): MemoryRepositoryStage {
    return this.createStagedRepositoryFromSnapshot(this.captureLiveMemorySnapshot(), label);
  }

  private createStagedRepositoryFromSnapshot(snapshot: LiveMemorySnapshot, label: string): MemoryRepositoryStage {
    const liveWorkspaceRoot = this.workspaceMemory.getRootDir();
    const liveGlobalRoot = this.globalUserMemory.getRootDir();
    const stagedWorkspaceRoot = createSiblingTempPath(liveWorkspaceRoot, label);
    const stagedGlobalRoot = createSiblingTempPath(liveGlobalRoot, label);
    const stagedDbPath = createSiblingTempPath(this.dbPath, label);
    mkdirSync(stagedWorkspaceRoot, { recursive: true });
    mkdirSync(stagedGlobalRoot, { recursive: true });
    let stageRepository: MemoryRepository | null = null;
    try {
      this.writeSnapshotFilesToRoot(stagedWorkspaceRoot, snapshot.workspaceFiles);
      this.writeSnapshotFilesToRoot(stagedGlobalRoot, snapshot.globalFiles);
      stageRepository = new MemoryRepository(stagedDbPath, {
        memoryDir: stagedWorkspaceRoot,
        globalRootDir: stagedGlobalRoot,
        workspaceDir: this.currentWorkspacePath(),
      });
      stageRepository.repairWorkspaceManifest();
      return {
        repository: stageRepository,
        snapshot,
        stagedWorkspaceRoot,
        stagedGlobalRoot,
        stagedDbPath,
        dispose: () => {
          try {
            stageRepository?.close();
          } catch {
            // ignore close failures during temp-stage cleanup
          }
          rmSync(stagedWorkspaceRoot, { recursive: true, force: true });
          rmSync(stagedGlobalRoot, { recursive: true, force: true });
          rmSync(stagedDbPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      try {
        stageRepository?.close();
      } catch {
        // ignore close failures during temp-stage cleanup
      }
      rmSync(stagedWorkspaceRoot, { recursive: true, force: true });
      rmSync(stagedGlobalRoot, { recursive: true, force: true });
      rmSync(stagedDbPath, { recursive: true, force: true });
      throw error;
    }
  }

  replaceLiveRootsWithStage(stage: MemoryRepositoryStage, fallbackSnapshot: LiveMemorySnapshot): void {
    let workspaceSwapped = false;
    try {
      this.replaceDirectoryWithStaged(this.workspaceMemory.getRootDir(), stage.stagedWorkspaceRoot);
      workspaceSwapped = true;
      this.replaceDirectoryWithStaged(this.globalUserMemory.getRootDir(), stage.stagedGlobalRoot);
    } catch (error) {
      if (workspaceSwapped) {
        const restoreStage = this.createStagedRepositoryFromSnapshot(fallbackSnapshot, "restore");
        try {
          restoreStage.repository.close();
          this.replaceDirectoryWithStaged(this.workspaceMemory.getRootDir(), restoreStage.stagedWorkspaceRoot);
        } finally {
          restoreStage.dispose();
        }
      }
      throw error;
    }
  }

  installLastDreamSnapshot(snapshot: LiveMemorySnapshot, metadata: LastDreamSnapshotMetadata): void {
    const stagedSnapshotRoot = this.stageLastDreamSnapshot(snapshot, metadata);
    this.replaceDirectoryWithStaged(this.lastDreamSnapshotRoot(), stagedSnapshotRoot);
  }

  rollbackLastDreamSnapshot(): DreamRollbackResult {
    const snapshot = this.loadLastDreamSnapshotRecord();
    if (!snapshot) {
      throw new Error("No last Dream snapshot is available for rollback.");
    }
    const currentSnapshot = this.captureLiveMemorySnapshot();
    const rollbackReady = snapshot.metadata.after.workspaceVersion === currentSnapshot.workspaceVersion
      && snapshot.metadata.after.globalVersion === currentSnapshot.globalVersion;
    if (!rollbackReady) {
      throw new Error("Current memory state no longer matches the last Dream snapshot, so rollback is unavailable.");
    }

    const rolledBackAt = nowIso();
    const nextSnapshotMetadata: LastDreamSnapshotMetadata = {
      version: 1,
      capturedAt: rolledBackAt,
      sourceAction: "rollback",
      sourceWorkspaceDir: this.getWorkspaceDir(),
      summary: currentSnapshot.runtimeState.lastDreamSummary,
      before: {
        workspaceVersion: currentSnapshot.workspaceVersion,
        globalVersion: currentSnapshot.globalVersion,
        counts: currentSnapshot.counts,
        runtimeState: currentSnapshot.runtimeState,
      },
      after: {
        workspaceVersion: snapshot.metadata.before.workspaceVersion,
        globalVersion: snapshot.metadata.before.globalVersion,
        counts: snapshot.metadata.before.counts,
        runtimeState: snapshot.metadata.before.runtimeState,
      },
    };

    this.installLastDreamSnapshot(currentSnapshot, nextSnapshotMetadata);
    const rollbackStage = this.createStagedRepositoryFromSnapshot({
      workspaceFiles: snapshot.workspaceFiles,
      globalFiles: snapshot.globalFiles,
      counts: snapshot.metadata.before.counts,
      workspaceVersion: snapshot.metadata.before.workspaceVersion,
      globalVersion: snapshot.metadata.before.globalVersion,
      runtimeState: snapshot.metadata.before.runtimeState,
    }, "rollback");
    try {
      rollbackStage.repository.close();
      this.replaceLiveRootsWithStage(rollbackStage, currentSnapshot);
    } finally {
      rollbackStage.dispose();
    }

    this.restoreDreamRuntimeState(snapshot.metadata.before.runtimeState);
    return {
      rolledBackAt,
      snapshotCapturedAt: snapshot.metadata.capturedAt,
      restored: snapshot.metadata.before.counts,
      ...(snapshot.metadata.before.runtimeState.lastDreamAt
        ? { lastDreamAt: snapshot.metadata.before.runtimeState.lastDreamAt }
        : {}),
      ...(snapshot.metadata.before.runtimeState.lastDreamStatus
        ? { lastDreamStatus: snapshot.metadata.before.runtimeState.lastDreamStatus }
        : {}),
      ...(snapshot.metadata.before.runtimeState.lastDreamSummary
        ? { lastDreamSummary: snapshot.metadata.before.runtimeState.lastDreamSummary }
        : {}),
    };
  }

  private buildTransferCounts(workspaceStore: FileMemoryStore, globalStore: FileMemoryStore): MemoryTransferCounts {
    const workspaceImported = workspaceStore.exportBundleRecords({ includeTmp: true });
    const globalImported = globalStore.exportBundleRecords({ includeTmp: true });
    const memoryFiles = [...workspaceImported.memoryFiles, ...globalImported.memoryFiles];
    return {
      managedFiles: workspaceStore.exportSnapshotFiles().length + globalStore.exportSnapshotFiles().length,
      memoryFiles: memoryFiles.length,
      project: memoryFiles.filter((item) => item.type === "project").length,
      feedback: memoryFiles.filter((item) => item.type === "feedback").length,
      user: memoryFiles.filter((item) => item.type === "user").length,
      tmp: 0,
      projectMetas: workspaceImported.projectMetas.length,
    };
  }

  private materializeSnapshotBundle(
    rootDir: string,
    files: MemorySnapshotFileRecord[],
    options: FileMemoryStoreOptions,
  ): FileMemoryStore {
    this.writeSnapshotFilesToRoot(rootDir, files);
    const store = new FileMemoryStore(rootDir, options);
    store.repairManifests();
    return store;
  }

  private writeSnapshotFilesToRoot(rootDir: string, files: MemorySnapshotFileRecord[]): void {
    mkdirSync(rootDir, { recursive: true });
    for (const record of files) {
      const absolutePath = resolve(rootDir, record.relativePath);
      if (!isPathWithinRoot(rootDir, absolutePath) || absolutePath === resolve(rootDir)) {
        throw new MemoryBundleValidationError(`Invalid imported snapshot file path: ${record.relativePath}`);
      }
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, record.content, "utf-8");
    }
  }

  private stageImportBundle(bundle: MemoryImportableBundle): {
    stagedWorkspaceRoot: string;
    stagedGlobalRoot: string;
    counts: MemoryTransferCounts;
  } & {
    ignoredGlobalFileCount: number;
  } {
    const workspaceFiles = bundle.files.filter((record) => !isGlobalRelativePath(record.relativePath));
    const globalFiles = bundle.files
      .filter((record) => isGlobalRelativePath(record.relativePath))
      .map((record) => ({
        ...record,
        relativePath: toInternalGlobalRelativePath(record.relativePath),
      }));
    const liveWorkspaceRoot = this.workspaceMemory.getRootDir();
    const liveGlobalRoot = this.globalUserMemory.getRootDir();
    const stagedWorkspaceRoot = createSiblingTempPath(liveWorkspaceRoot, "import");
    const stagedGlobalRoot = createSiblingTempPath(liveGlobalRoot, "import");
    mkdirSync(stagedWorkspaceRoot, { recursive: true });
    mkdirSync(stagedGlobalRoot, { recursive: true });
    try {
      const stagedWorkspaceStore = this.materializeSnapshotBundle(
        stagedWorkspaceRoot,
        workspaceFiles,
        this.workspaceStoreOptions(),
      );
      const stagedGlobalStore = this.materializeSnapshotBundle(
        stagedGlobalRoot,
        globalFiles,
        this.globalStoreOptions(),
      );
      return {
        stagedWorkspaceRoot,
        stagedGlobalRoot,
        counts: this.buildTransferCounts(stagedWorkspaceStore, stagedGlobalStore),
        ignoredGlobalFileCount: globalFiles.length,
      };
    } catch (error) {
      rmSync(stagedWorkspaceRoot, { recursive: true, force: true });
      rmSync(stagedGlobalRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private resetImportedRuntimeState(bundle: MemoryImportableBundle): void {
    this.db.exec("DELETE FROM l0_sessions;");
    for (const key of [
      RECENT_CASE_TRACES_STATE_KEY,
      RECENT_INDEX_TRACES_STATE_KEY,
      RECENT_DREAM_TRACES_STATE_KEY,
      LAST_INDEXED_AT_STATE_KEY,
      LAST_DREAM_AT_STATE_KEY,
      LAST_DREAM_STATUS_STATE_KEY,
      LAST_DREAM_SUMMARY_STATE_KEY,
    ]) {
      this.deletePipelineState(key);
    }
    if (bundle.lastIndexedAt) this.setPipelineState(LAST_INDEXED_AT_STATE_KEY, bundle.lastIndexedAt);
    if (bundle.lastDreamAt) this.setPipelineState(LAST_DREAM_AT_STATE_KEY, bundle.lastDreamAt);
    if (bundle.lastDreamStatus) this.setPipelineState(LAST_DREAM_STATUS_STATE_KEY, bundle.lastDreamStatus);
    if (bundle.lastDreamSummary) this.setPipelineState(LAST_DREAM_SUMMARY_STATE_KEY, bundle.lastDreamSummary);
    if (bundle.recentCaseTraces) this.setPipelineState(RECENT_CASE_TRACES_STATE_KEY, bundle.recentCaseTraces);
    if (bundle.recentIndexTraces) this.setPipelineState(RECENT_INDEX_TRACES_STATE_KEY, bundle.recentIndexTraces);
    if (bundle.recentDreamTraces) this.setPipelineState(RECENT_DREAM_TRACES_STATE_KEY, bundle.recentDreamTraces);
  }

  exportMemoryBundle(): MemoryExportBundle {
    return {
      formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
      scope: "current_project",
      exportedAt: nowIso(),
      ...(typeof this.getPipelineState<string>(LAST_INDEXED_AT_STATE_KEY) === "string"
        ? { lastIndexedAt: this.getPipelineState<string>(LAST_INDEXED_AT_STATE_KEY)! }
        : {}),
      ...(typeof this.getPipelineState<string>(LAST_DREAM_AT_STATE_KEY) === "string"
        ? { lastDreamAt: this.getPipelineState<string>(LAST_DREAM_AT_STATE_KEY)! }
        : {}),
      ...(sanitizeDreamStatus(this.getPipelineState(LAST_DREAM_STATUS_STATE_KEY))
        ? { lastDreamStatus: sanitizeDreamStatus(this.getPipelineState(LAST_DREAM_STATUS_STATE_KEY))! }
        : {}),
      ...(typeof this.getPipelineState<string>(LAST_DREAM_SUMMARY_STATE_KEY) === "string"
        ? { lastDreamSummary: this.getPipelineState<string>(LAST_DREAM_SUMMARY_STATE_KEY)! }
        : {}),
      ...(this.listRecentCaseTraces(200).length > 0 ? { recentCaseTraces: this.listRecentCaseTraces(200) } : {}),
      ...(this.listRecentIndexTraces(200).length > 0 ? { recentIndexTraces: this.listRecentIndexTraces(200) } : {}),
      ...(this.listRecentDreamTraces(200).length > 0 ? { recentDreamTraces: this.listRecentDreamTraces(200) } : {}),
      // MEMORY.md is a derived manifest that is regenerated on import. Excluding it keeps
      // current-project bundles free of cross-project/global references.
      files: this.workspaceMemory
        .exportSnapshotFiles()
        .filter((record) => record.relativePath !== "MEMORY.md"),
    };
  }

  importMemoryBundle(bundle: MemoryImportableBundle): MemoryImportResult {
    const normalized = normalizeMemoryBundle(bundle);
    const staged = this.stageImportBundle(normalized);
    try {
      this.replaceDirectoryWithStaged(this.workspaceMemory.getRootDir(), staged.stagedWorkspaceRoot);
      this.workspaceMemory.repairManifests();
      this.clearLastDreamSnapshot();
      this.resetImportedRuntimeState(normalized);
      return {
        formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
        scope: "current_project",
        imported: staged.counts,
        importedAt: nowIso(),
        ...(staged.ignoredGlobalFileCount > 0
          ? {
              warnings: [
                `Ignored ${staged.ignoredGlobalFileCount} global user memory file(s) from a legacy current-project bundle.`,
              ],
            }
          : {}),
        ...(normalized.lastIndexedAt ? { lastIndexedAt: normalized.lastIndexedAt } : {}),
        ...(normalized.lastDreamAt ? { lastDreamAt: normalized.lastDreamAt } : {}),
        ...(normalized.lastDreamStatus ? { lastDreamStatus: normalized.lastDreamStatus } : {}),
        ...(normalized.lastDreamSummary ? { lastDreamSummary: normalized.lastDreamSummary } : {}),
        ...(normalized.recentCaseTraces ? { recentCaseTraces: normalized.recentCaseTraces } : {}),
        ...(normalized.recentIndexTraces ? { recentIndexTraces: normalized.recentIndexTraces } : {}),
        ...(normalized.recentDreamTraces ? { recentDreamTraces: normalized.recentDreamTraces } : {}),
      };
    } finally {
      rmSync(staged.stagedGlobalRoot, { recursive: true, force: true });
    }
  }

  getOverview(): DashboardOverview {
    const pendingSessions = Number(
      (this.db.prepare("SELECT COUNT(DISTINCT session_key) AS count FROM l0_sessions WHERE indexed = 0").get() as DbRow | undefined)?.count ?? 0,
    );
    const lastDreamAt = this.getPipelineState<string>(LAST_DREAM_AT_STATE_KEY);
    const fileOverview = this.workspaceMemory.getOverview(typeof lastDreamAt === "string" ? lastDreamAt : undefined);
    const readableProjects = this.workspaceMode === "general"
      ? this.listReadableProjectCatalog().filter((entry) => entry.sourceType !== "workspace_external")
      : [];
    const recentRecallTraceCount = this.listRecentCaseTraces(12).length;
    const recentIndexTraceCount = this.listRecentIndexTraces(30).length;
    const recentDreamTraceCount = this.listRecentDreamTraces(30).length;
    const lastDreamSnapshot = this.getLastDreamSnapshotOverview();
    const workspaceHasProjectMemory = fileOverview.projectMemories + fileOverview.feedbackMemories > 0;
    const userProfileCount = this.listGlobalMemoryEntries({
      kinds: ["user"],
      scope: "global",
      limit: 10,
    }).some((entry) => entry.relativePath === toExposedGlobalRelativePath(GLOBAL_USER_PROFILE_RELATIVE_PATH))
      ? 1
      : 0;
    return {
      pendingSessions,
      workspaceMode: this.workspaceMode,
      currentProjectCount: this.workspaceMode === "general"
        ? readableProjects.length
        : workspaceHasProjectMemory || fileOverview.projectMetaCount > 0 ? 1 : 0,
      projectMetaPresent: fileOverview.projectMetaCount > 0,
      projectMemoryCount: fileOverview.projectMemories,
      feedbackMemoryCount: fileOverview.feedbackMemories,
      userProfileCount,
      recentRecallTraceCount,
      recentIndexTraceCount,
      recentDreamTraceCount,
      ...(typeof this.getPipelineState<string>(LAST_INDEXED_AT_STATE_KEY) === "string"
        ? { lastIndexedAt: this.getPipelineState<string>(LAST_INDEXED_AT_STATE_KEY)! }
        : {}),
      ...(typeof lastDreamAt === "string" ? { lastDreamAt } : {}),
      ...(sanitizeDreamStatus(this.getPipelineState(LAST_DREAM_STATUS_STATE_KEY))
        ? { lastDreamStatus: sanitizeDreamStatus(this.getPipelineState(LAST_DREAM_STATUS_STATE_KEY))! }
        : {}),
      ...(typeof this.getPipelineState<string>(LAST_DREAM_SUMMARY_STATE_KEY) === "string"
        ? { lastDreamSummary: this.getPipelineState<string>(LAST_DREAM_SUMMARY_STATE_KEY)! }
        : {}),
      ...(lastDreamSnapshot ? { lastDreamSnapshot } : {}),
    };
  }

  getUiSnapshot(limit = 50): MemoryUiSnapshot {
    return {
      overview: this.getOverview(),
      settings: this.getIndexingSettings({
        reasoningMode: "answer_first",
        autoIndexIntervalMinutes: 30,
        autoDreamIntervalMinutes: 60,
      }),
      recentMemoryFiles: this.listMemoryEntries({ limit }),
    };
  }

  listMemoryEntries(options: {
    kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
    query?: string;
    limit?: number;
    offset?: number;
    scope?: "global" | "project";
    projectId?: string;
    includeTmp?: boolean;
    includeDeprecated?: boolean;
  } = {}): MemoryManifestEntry[] {
    const includeWorkspace = options.scope !== "global";
    const includeGlobal = options.scope !== "project";
    const workspaceEntries = includeWorkspace
      ? this.workspaceMemory.listMemoryEntries({
        ...options,
        limit: 5000,
        offset: 0,
      })
      : [];
    const globalEntries = includeGlobal
      ? this.listGlobalMemoryEntries({
        ...options,
        limit: 5000,
        offset: 0,
      })
      : [];
    const filtered = sortManifestEntries([...workspaceEntries, ...globalEntries]);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? (filtered.length || 1));
    return filtered.slice(offset, offset + limit);
  }

  countMemoryEntries(options: {
    kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
    query?: string;
    scope?: "global" | "project";
    projectId?: string;
    includeTmp?: boolean;
    includeDeprecated?: boolean;
  } = {}): number {
    const workspaceEntries = options.scope === "global"
      ? []
      : this.workspaceMemory.listMemoryEntries({
        ...options,
        limit: 5000,
        offset: 0,
      });
    const globalEntries = options.scope === "project"
      ? []
      : this.listGlobalMemoryEntries({
        ...options,
        limit: 5000,
        offset: 0,
      });
    return [...workspaceEntries, ...globalEntries].length;
  }

  getMemoryRecordsByIds(ids: string[], maxLines = 80): MemoryFileRecord[] {
    const uniqueIds = Array.from(new Set(ids.filter((item) => typeof item === "string" && item.trim().length > 0)));
    const externalIds = uniqueIds.filter((id) => isExternalRecordId(id));
    const workspaceIds = uniqueIds.filter((id) => !isGlobalRelativePath(id) && !isExternalRecordId(id));
    const globalIds = uniqueIds
      .filter((id) => isGlobalRelativePath(id))
      .map((id) => toInternalGlobalRelativePath(id));
    const workspaceRecords = this.workspaceMemory.getMemoryRecordsByIds(workspaceIds, maxLines);
    const globalRecords = this.globalUserMemory
      .getMemoryRecordsByIds(globalIds, maxLines)
      .map((record) => this.mapGlobalFileRecord(record));
    const externalGroups = new Map<string, string[]>();
    for (const id of externalIds) {
      const parsed = parseExternalRecordId(id);
      if (!parsed) continue;
      const bucket = externalGroups.get(parsed.workspaceKey) ?? [];
      bucket.push(parsed.relativePath);
      externalGroups.set(parsed.workspaceKey, bucket);
    }
    const externalRecords: MemoryFileRecord[] = [];
    if (externalGroups.size > 0) {
      const snapshots = this.getExternalWorkspaceSnapshots();
      for (const [workspaceKey, relativePaths] of externalGroups.entries()) {
        const snapshot = snapshots.find((item) => item.workspaceKey === workspaceKey);
        if (!snapshot) continue;
        externalRecords.push(
          ...snapshot.store.getMemoryRecordsByIds(relativePaths, maxLines)
            .map((record) => this.mapExternalFileRecord(snapshot, record)),
        );
      }
    }
    const byId = new Map<string, MemoryFileRecord>([
      ...workspaceRecords.map((record) => [record.relativePath, record] as const),
      ...globalRecords.map((record) => [record.relativePath, record] as const),
      ...externalRecords.map((record) => [record.relativePath, record] as const),
    ]);
    return ids
      .map((id) => byId.get(id))
      .filter((record): record is MemoryFileRecord => Boolean(record));
  }

  editProjectMeta(input: {
    projectId?: string;
    projectName: string;
    description: string;
    status: string;
  }) {
    return this.workspaceMemory.editProjectMeta(input);
  }

  ensureProjectMeta(input: {
    projectName?: string;
    description?: string;
    status?: string;
  } = {}) {
    return this.workspaceMemory.ensureProjectMeta(input);
  }

  getProjectMeta() {
    return this.workspaceMemory.getProjectMeta();
  }

  editMemoryEntry(input: {
    id: string;
    name: string;
    description: string;
    fields?: MemoryEntryEditFields;
  }) {
    const store = isGlobalRelativePath(input.id) ? this.globalUserMemory : this.workspaceMemory;
    const relativePath = isGlobalRelativePath(input.id)
      ? toInternalGlobalRelativePath(input.id)
      : input.id;
    const record = store.editEntry({
      relativePath,
      name: input.name,
      description: input.description,
      ...(input.fields ? { fields: input.fields } : {}),
    });
    return isGlobalRelativePath(input.id) ? this.mapGlobalFileRecord(record) : record;
  }

  deleteMemoryEntries(ids: string[]) {
    const workspaceIds = ids.filter((id) => !isGlobalRelativePath(id));
    const globalIds = ids
      .filter((id) => isGlobalRelativePath(id))
      .map((id) => toInternalGlobalRelativePath(id));
    const workspaceResult = this.workspaceMemory.deleteEntries(workspaceIds);
    const globalResult = this.globalUserMemory.deleteEntries(globalIds);
    this.workspaceMemory.repairManifests();
    return {
      mutatedIds: [
        ...workspaceResult.mutatedIds,
        ...globalResult.mutatedIds.map((id) => toExposedGlobalRelativePath(id)),
      ],
      deletedProjectIds: [...workspaceResult.deletedProjectIds, ...globalResult.deletedProjectIds],
    };
  }

  deprecateMemoryEntries(ids: string[]) {
    const workspaceIds = ids.filter((id) => !isGlobalRelativePath(id));
    const globalIds = ids
      .filter((id) => isGlobalRelativePath(id))
      .map((id) => toInternalGlobalRelativePath(id));
    const workspaceResult = this.workspaceMemory.markEntriesDeprecated(workspaceIds);
    const globalResult = this.globalUserMemory.markEntriesDeprecated(globalIds);
    this.workspaceMemory.repairManifests();
    return {
      mutatedIds: [
        ...workspaceResult.mutatedIds,
        ...globalResult.mutatedIds.map((id) => toExposedGlobalRelativePath(id)),
      ],
      deletedProjectIds: [...workspaceResult.deletedProjectIds, ...globalResult.deletedProjectIds],
    };
  }

  restoreMemoryEntries(ids: string[]) {
    const workspaceIds = ids.filter((id) => !isGlobalRelativePath(id));
    const globalIds = ids
      .filter((id) => isGlobalRelativePath(id))
      .map((id) => toInternalGlobalRelativePath(id));
    const workspaceResult = this.workspaceMemory.restoreEntries(workspaceIds);
    const globalResult = this.globalUserMemory.restoreEntries(globalIds);
    this.workspaceMemory.repairManifests();
    return {
      mutatedIds: [
        ...workspaceResult.mutatedIds,
        ...globalResult.mutatedIds.map((id) => toExposedGlobalRelativePath(id)),
      ],
      deletedProjectIds: [...workspaceResult.deletedProjectIds, ...globalResult.deletedProjectIds],
    };
  }

  archiveTmpEntries(input: {
    ids: string[];
    targetProjectId?: string;
    newProjectName?: string;
  }) {
    return this.workspaceMemory.archiveTmpEntries({
      relativePaths: input.ids,
      ...(input.targetProjectId ? { targetProjectId: input.targetProjectId } : {}),
      ...(input.newProjectName ? { newProjectName: input.newProjectName } : {}),
    });
  }

  getSnapshotVersion(): string {
    const payload = JSON.stringify({
      lastDreamAt: this.getPipelineState<string>(LAST_DREAM_AT_STATE_KEY) ?? "",
      files: this.exportMemoryBundle().files,
    });
    return hashText(payload);
  }

  clearAllMemoryData(): ClearMemoryResult {
    const l0Sessions = Number((this.db.prepare("SELECT COUNT(*) AS count FROM l0_sessions").get() as DbRow | undefined)?.count ?? 0);
    const pipelineState = Number((this.db.prepare("SELECT COUNT(*) AS count FROM pipeline_state").get() as DbRow | undefined)?.count ?? 0);
    const beforeWorkspace = this.workspaceMemory.exportBundleRecords({ includeTmp: true });
    const beforeGlobal = this.globalUserMemory.exportBundleRecords({ includeTmp: true });
    this.db.exec(`
      DELETE FROM l0_sessions;
      DELETE FROM pipeline_state;
    `);
    this.workspaceMemory.clearAllData({ rebuildManifest: false });
    this.globalUserMemory.clearAllData({ rebuildManifest: false });
    this.clearLastDreamSnapshot();
    return {
      scope: "all_memory",
      cleared: {
        l0Sessions,
        pipelineState,
        memoryFiles: beforeWorkspace.memoryFiles.length + beforeGlobal.memoryFiles.length,
        projectMetas: beforeWorkspace.projectMetas.length,
      },
      clearedAt: nowIso(),
    };
  }

  clearCurrentWorkspaceMemoryData(): ClearMemoryResult {
    const l0Sessions = Number((this.db.prepare("SELECT COUNT(*) AS count FROM l0_sessions").get() as DbRow | undefined)?.count ?? 0);
    const pipelineState = Number((this.db.prepare("SELECT COUNT(*) AS count FROM pipeline_state").get() as DbRow | undefined)?.count ?? 0);
    const beforeWorkspace = this.workspaceMemory.exportBundleRecords({ includeTmp: true });
    const preservedIndexingSettings = this.getPipelineState(INDEXING_SETTINGS_STATE_KEY);
    const preservedWorkspaceDir = this.getPipelineState("workspaceDir");

    this.db.exec(`
      DELETE FROM l0_sessions;
      DELETE FROM pipeline_state;
    `);
    if (preservedIndexingSettings !== undefined) {
      this.setPipelineState(INDEXING_SETTINGS_STATE_KEY, preservedIndexingSettings);
    }
    if (preservedWorkspaceDir !== undefined) {
      this.setPipelineState("workspaceDir", preservedWorkspaceDir);
    }
    this.workspaceMemory.clearAllData({ rebuildManifest: false });
    this.clearLastDreamSnapshot();

    return {
      scope: "current_project",
      cleared: {
        l0Sessions,
        pipelineState,
        memoryFiles: beforeWorkspace.memoryFiles.length,
        projectMetas: beforeWorkspace.projectMetas.length,
      },
      clearedAt: nowIso(),
    };
  }
}
