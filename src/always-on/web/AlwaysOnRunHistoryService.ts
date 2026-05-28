/**
 * Always-On run history: event merging, session recovery, and
 * history querying.
 *
 * Extracted from `ui/server/services/always-on-run-history.js`.
 * All filesystem paths are resolved through the injected `paths`
 * helper so the module stays decoupled from ui/server specifics.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_HISTORY_FILE_NAME = "run-history.jsonl";
const RUN_HISTORY_MAX_ITEMS = 500;
const OUTPUT_LOG_MAX_CHARS = 60_000;
const RECOVERY_MATCH_WINDOW_MS = 5 * 60 * 1000;
const VALID_KINDS = new Set(["plan", "cron"]);
const VALID_STATUSES = new Set(["queued", "running", "completed", "failed", "unknown"]);
const TASK_NOTIFICATION_REGEX =
  /<task-notification>\s*<task-id>([\s\S]*?)<\/task-id>\s*<output-file>([\s\S]*?)<\/output-file>\s*<status>([\s\S]*?)<\/status>\s*<summary>([\s\S]*?)<\/summary>\s*<\/task-notification>/i;
const CRON_TRANSCRIPT_FILENAME_REGEX = /^agent-cron[^/]*\.jsonl$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunEvent = {
  runId: string;
  projectRoot?: string;
  kind: string;
  sourceId: string;
  title: string;
  status: string;
  timestamp: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  transcriptKey?: string;
  output?: string;
  error?: string;
  metadata: Record<string, unknown>;
};

type RunRecord = RunEvent & {
  createdAt: string;
  updatedAt: string;
  outputLog: string;
};

export type RunHistoryEntry = {
  runId: string;
  title: string;
  kind: string;
  status: string;
  startedAt?: string;
  sourceId: string;
  session: {
    sessionId?: string;
    parentSessionId?: string;
    relativeTranscriptPath?: string;
  };
};

export type RunHistoryDetailEntry = RunHistoryEntry & {
  outputLog: string;
  metadata: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type RunHistoryPaths = {
  getAlwaysOnRoot(projectRoot: string): string;
};

export type RunLogReader = {
  getAlwaysOnRunLog(
    projectRoot: string,
    runId: string,
  ): Promise<{ content: string; truncated: boolean; updatedAt?: string; size: number }>;
};

export type SessionMessageReader = {
  getSessionMessages(
    projectName: string,
    sessionId: string,
    options: {
      limit: number | null;
      offset: number;
      sessionKind: string | null;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
    },
  ): Promise<{ messages?: Array<Record<string, unknown>> }>;
};

export type AlwaysOnRunHistoryServiceDeps = {
  paths: RunHistoryPaths;
  logs: RunLogReader;
  sessionMessages?: SessionMessageReader;
};

// ---------------------------------------------------------------------------
// Shared string helpers
// ---------------------------------------------------------------------------

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" && (value as string).trim() ? (value as string).trim() : fallback;
}

function toIsoTimestamp(value: unknown): string {
  const timestamp = value ? Date.parse(value as string) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

async function readJsonlEntries(filePath: string): Promise<Array<Record<string, unknown>>> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

// ---------------------------------------------------------------------------
// Normalization & merging
// ---------------------------------------------------------------------------

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeRunEvent(event: Record<string, unknown> | null | undefined): RunEvent | null {
  const runId = normalizeString(event?.runId);
  const kind = normalizeString(event?.kind);
  const status = normalizeString(event?.status);
  const sourceId = normalizeString(event?.sourceId);
  if (!runId || !VALID_KINDS.has(kind) || !VALID_STATUSES.has(status) || !sourceId) return null;

  return {
    runId,
    projectRoot: normalizeString(event?.projectRoot),
    kind,
    sourceId,
    title: normalizeString(event?.title, sourceId),
    status,
    timestamp: toIsoTimestamp(event?.timestamp) || new Date().toISOString(),
    startedAt: toIsoTimestamp(event?.startedAt) || undefined,
    finishedAt: toIsoTimestamp(event?.finishedAt) || undefined,
    sessionId: normalizeString(event?.sessionId) || undefined,
    parentSessionId: normalizeString(event?.parentSessionId) || undefined,
    relativeTranscriptPath: normalizeString(event?.relativeTranscriptPath) || undefined,
    transcriptKey: normalizeString(event?.transcriptKey) || undefined,
    output: normalizeString(event?.output) || undefined,
    error: normalizeString(event?.error) || undefined,
    metadata: sanitizeMetadata(event?.metadata),
  };
}

function mergeRunEvent(record: RunRecord, event: RunEvent): RunRecord {
  const metadata = { ...(record.metadata || {}), ...(event.metadata || {}) };
  const next: RunRecord = {
    ...record,
    title: event.title || record.title,
    status: event.status || record.status,
    updatedAt: event.timestamp || record.updatedAt,
    startedAt: event.startedAt || record.startedAt || event.timestamp,
    finishedAt: event.finishedAt || record.finishedAt,
    sessionId: event.sessionId || record.sessionId,
    parentSessionId: event.parentSessionId || record.parentSessionId,
    relativeTranscriptPath: event.relativeTranscriptPath || record.relativeTranscriptPath,
    transcriptKey: event.transcriptKey || record.transcriptKey,
    metadata,
    outputLog: record.outputLog,
    createdAt: record.createdAt,
  };
  const outputParts = [record.outputLog, event.output, event.error ? `Error: ${event.error}` : ""].filter(
    Boolean,
  );
  next.outputLog = outputParts.join("\n\n").slice(-OUTPUT_LOG_MAX_CHARS);
  if (event.error) next.error = event.error;
  return next;
}

function createRecordFromEvent(event: RunEvent): RunRecord {
  return mergeRunEvent(
    {
      ...event,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      startedAt: event.startedAt || event.timestamp,
      outputLog: "",
    },
    event,
  );
}

// ---------------------------------------------------------------------------
// Transcript path / session ID helpers
// ---------------------------------------------------------------------------

function normalizeTranscriptFilename(value: unknown): string {
  const rawName = basename(normalizeString(value));
  if (!rawName) return "";
  const withoutJsonl = rawName.replace(/\.jsonl$/i, "");
  const withAgentPrefix = withoutJsonl.startsWith("agent-") ? withoutJsonl : `agent-${withoutJsonl}`;
  return `${withAgentPrefix}.jsonl`;
}

function getRecordParentSessionId(record: RunRecord): string | undefined {
  return (
    (record.parentSessionId as string) ||
    normalizeString((record.metadata as Record<string, unknown>)?.originSessionId) ||
    undefined
  );
}

function getRecordRelativeTranscriptPath(record: RunRecord): string | undefined {
  const parentSessionId = getRecordParentSessionId(record);
  const relPath = normalizeString(record.relativeTranscriptPath);
  const transcriptKey =
    (record.transcriptKey as string) || normalizeString((record.metadata as Record<string, unknown>)?.transcriptKey);

  if (!parentSessionId) return relPath || undefined;

  if (relPath) {
    const dir = dirname(relPath);
    const normalizedFilename = normalizeTranscriptFilename(basename(relPath));
    if (normalizedFilename) {
      return join(dir === "." ? parentSessionId : dir, normalizedFilename);
    }
    return relPath;
  }

  const transcriptFilename = normalizeTranscriptFilename(transcriptKey);
  if (!transcriptFilename) return undefined;
  return join(parentSessionId, "subagents", transcriptFilename);
}

function createBackgroundSessionId(parentSessionId: string | undefined, relativeTranscriptPath: string | undefined): string | undefined {
  const safeParent = normalizeString(parentSessionId).replace(/[^a-zA-Z0-9._-]/g, "-");
  const transcriptName = basename(normalizeString(relativeTranscriptPath));
  const safeTranscript = transcriptName.replace(/\.jsonl$/i, "").replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safeParent || !safeTranscript) return undefined;
  return `background-${safeParent}-${safeTranscript}`;
}

function getRecordSessionId(record: RunRecord): string | undefined {
  return (
    (record.sessionId as string) ||
    createBackgroundSessionId(getRecordParentSessionId(record), getRecordRelativeTranscriptPath(record))
  );
}

// ---------------------------------------------------------------------------
// Recovery: task-notification XML from parent transcript
// ---------------------------------------------------------------------------

function getProjectStoreDir(projectName: string): string {
  return projectName ? join(homedir(), ".pilotdeck", "projects", projectName) : "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof (content as Record<string, unknown>)?.text === "string") {
    return (content as Record<string, string>).text;
  }
  return "";
}

function getTaskNotificationContent(entry: Record<string, unknown>): string {
  if (typeof entry?.content === "string" && (entry.content as string).trim()) {
    return entry.content as string;
  }
  return extractContentText((entry?.message as Record<string, unknown>)?.content);
}

function parseTaskNotificationContent(content: string): { taskId: string; outputFile: string; status: string; summary: string } | null {
  if (!content?.trim()) return null;
  const match = content.match(TASK_NOTIFICATION_REGEX);
  if (!match) return null;
  return {
    taskId: (match[1] ?? "").trim(),
    outputFile: (match[2] ?? "").trim(),
    status: (match[3] ?? "").trim(),
    summary: (match[4] ?? "").trim(),
  };
}

function isRunTaskNotification(
  record: RunRecord,
  notification: { taskId: string; outputFile: string; summary: string },
): boolean {
  const sourceId = normalizeString(record.sourceId);
  const taskId = normalizeString((record.metadata as Record<string, unknown>)?.taskId, sourceId);
  const haystack = [notification.taskId, notification.outputFile, notification.summary].join("\n");
  return Boolean((sourceId && haystack.includes(sourceId)) || (taskId && haystack.includes(taskId)));
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return Boolean(rel) && !rel.startsWith("..") && !resolve(rel).startsWith("/");
}

function getTranscriptInfoFromPath(projectDir: string, transcriptPath: string) {
  const relativeTranscriptPath = relative(projectDir, transcriptPath).split(/[\\/]/).join("/");
  const parts = relativeTranscriptPath.split("/");
  if (parts.length < 3 || parts[1] !== "subagents") return null;
  const parentSessionId = parts[0]!;
  const transcriptFilename = parts[parts.length - 1] || "";
  if (!parentSessionId || !CRON_TRANSCRIPT_FILENAME_REGEX.test(transcriptFilename)) return null;
  return {
    parentSessionId,
    relativeTranscriptPath,
    transcriptKey: transcriptFilename,
    sessionId: createBackgroundSessionId(parentSessionId, relativeTranscriptPath),
  };
}

async function recoverFromTaskNotification(record: RunRecord, projectName: string) {
  const parentSessionId = getRecordParentSessionId(record);
  const projectDir = getProjectStoreDir(projectName);
  if (!parentSessionId || !projectDir) return null;

  const parentTranscriptPath = join(projectDir, `${parentSessionId}.jsonl`);
  const entries = await readJsonlEntries(parentTranscriptPath);

  for (const entry of entries) {
    if (entry?.sessionId !== parentSessionId) continue;
    const notification = parseTaskNotificationContent(getTaskNotificationContent(entry));
    if (!notification || !isRunTaskNotification(record, notification) || !notification.outputFile) {
      continue;
    }
    const outputPath = resolve(notification.outputFile);
    let realOutputPath = outputPath;
    try {
      realOutputPath = await fs.realpath(outputPath);
    } catch {
      // symlink target may be cleaned up
    }
    const transcriptPath = realOutputPath.endsWith(".output")
      ? realOutputPath.replace(/\.output$/i, ".jsonl")
      : realOutputPath;
    const realTranscriptPath = await fs.realpath(transcriptPath).catch(() => transcriptPath);
    if (!isWithinDirectory(projectDir, realTranscriptPath)) continue;
    const info = getTranscriptInfoFromPath(projectDir, realTranscriptPath);
    if (info) {
      return {
        ...info,
        taskId: notification.taskId,
        taskStatus: notification.status,
        outputFile: notification.outputFile,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recovery: timestamp-proximity scan of subagent transcripts
// ---------------------------------------------------------------------------

function isTimestampNearRun(record: RunRecord, timestamps: number[]): boolean {
  const runStart = Date.parse(record.startedAt || "");
  const runFinish = Date.parse(record.finishedAt || record.updatedAt || "");
  const anchors = [runStart, runFinish].filter(Number.isFinite);
  if (anchors.length === 0) return false;
  return timestamps.some((ts) => anchors.some((anchor) => Math.abs(ts - anchor) <= RECOVERY_MATCH_WINDOW_MS));
}

async function recoverFromSubagents(record: RunRecord, projectName: string) {
  const parentSessionId = getRecordParentSessionId(record);
  const projectDir = getProjectStoreDir(projectName);
  if (!parentSessionId || !projectDir) return null;

  const subagentsDir = join(projectDir, parentSessionId, "subagents");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: Array<{ distance: number; parentSessionId: string; relativeTranscriptPath: string; transcriptKey: string; sessionId: string | undefined }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !CRON_TRANSCRIPT_FILENAME_REGEX.test(entry.name)) continue;
    const transcriptPath = join(subagentsDir, entry.name);
    const transcriptEntries = await readJsonlEntries(transcriptPath);
    const timestamps = transcriptEntries
      .map((item) => Date.parse((item?.timestamp as string) || ""))
      .filter(Number.isFinite);
    if (!isTimestampNearRun(record, timestamps)) continue;
    const info = getTranscriptInfoFromPath(projectDir, transcriptPath);
    if (info) {
      candidates.push({
        ...info,
        distance: Math.min(
          ...timestamps.map((ts) => Math.abs(ts - (Date.parse(record.startedAt || "") || ts))),
        ),
      });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] || null;
}

async function recoverRecordSessionInfo(record: RunRecord, projectName: string) {
  if (getRecordSessionId(record) && getRecordRelativeTranscriptPath(record)) {
    return {
      sessionId: getRecordSessionId(record),
      parentSessionId: getRecordParentSessionId(record),
      relativeTranscriptPath: getRecordRelativeTranscriptPath(record),
      transcriptKey: (record.transcriptKey as string) || normalizeString((record.metadata as Record<string, unknown>)?.transcriptKey) || undefined,
    };
  }
  return (
    (await recoverFromTaskNotification(record, projectName)) ||
    (await recoverFromSubagents(record, projectName)) || {
      sessionId: undefined,
      parentSessionId: getRecordParentSessionId(record),
      relativeTranscriptPath: getRecordRelativeTranscriptPath(record),
      transcriptKey: (record.transcriptKey as string) || normalizeString((record.metadata as Record<string, unknown>)?.transcriptKey) || undefined,
    }
  );
}

// ---------------------------------------------------------------------------
// Session output log
// ---------------------------------------------------------------------------

function formatMessageForLog(entry: Record<string, unknown>): string {
  const role = normalizeString(
    (entry?.message as Record<string, unknown>)?.role || entry?.type || entry?.role,
    "message",
  );
  const content = extractContentText(
    (entry?.message as Record<string, unknown>)?.content ?? entry?.content,
  ).trim();
  if (!content) return "";
  const timestamp = toIsoTimestamp(entry?.timestamp as string);
  const prefix = timestamp ? `[${timestamp}] ${role}` : role;
  return `${prefix}\n${content}`;
}

async function buildSessionOutputLog(
  projectName: string,
  record: RunRecord,
  sessionInfo: Record<string, unknown> | null,
  sessionMessages?: SessionMessageReader,
): Promise<string> {
  const sessionId = (sessionInfo?.sessionId as string) || getRecordSessionId(record);
  const parentSessionId = (sessionInfo?.parentSessionId as string) || getRecordParentSessionId(record);
  const relativeTranscriptPath =
    (sessionInfo?.relativeTranscriptPath as string) || getRecordRelativeTranscriptPath(record);

  if (!projectName || !sessionId || !sessionMessages) return "";

  try {
    const result = await sessionMessages.getSessionMessages(projectName, sessionId, {
      limit: null,
      offset: 0,
      sessionKind: parentSessionId && relativeTranscriptPath ? "background_task" : null,
      parentSessionId,
      relativeTranscriptPath,
    });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages.map(formatMessageForLog).filter(Boolean).join("\n\n").slice(-OUTPUT_LOG_MAX_CHARS);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// History entry builders
// ---------------------------------------------------------------------------

function toHistoryEntry(record: RunRecord, sessionInfo: Record<string, unknown> | null = null): RunHistoryEntry {
  const sessionId = (sessionInfo?.sessionId as string) || getRecordSessionId(record);
  const parentSessionId = (sessionInfo?.parentSessionId as string) || getRecordParentSessionId(record);
  const relativeTranscriptPath =
    (sessionInfo?.relativeTranscriptPath as string) || getRecordRelativeTranscriptPath(record);
  return {
    runId: record.runId,
    title: record.title,
    kind: record.kind,
    status: record.status,
    startedAt: record.startedAt,
    sourceId: record.sourceId,
    session: { sessionId, parentSessionId, relativeTranscriptPath },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class AlwaysOnRunHistoryService {
  private readonly deps: AlwaysOnRunHistoryServiceDeps;

  constructor(deps: AlwaysOnRunHistoryServiceDeps) {
    this.deps = deps;
  }

  private runHistoryPath(projectRoot: string): string {
    return join(this.deps.paths.getAlwaysOnRoot(projectRoot), RUN_HISTORY_FILE_NAME);
  }

  private async readRecords(projectRoot: string): Promise<RunRecord[]> {
    let raw = "";
    try {
      raw = await fs.readFile(this.runHistoryPath(projectRoot), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
    const recordsById = new Map<string, RunRecord>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = normalizeRunEvent(JSON.parse(line));
        if (!event) continue;
        const existing = recordsById.get(event.runId);
        recordsById.set(
          event.runId,
          existing ? mergeRunEvent(existing, event) : createRecordFromEvent(event),
        );
      } catch {
        // corrupt line
      }
    }
    return Array.from(recordsById.values()).sort((a, b) => {
      const aTime = Date.parse(a.startedAt || a.updatedAt || a.createdAt || "") || 0;
      const bTime = Date.parse(b.startedAt || b.updatedAt || b.createdAt || "") || 0;
      return bTime - aTime;
    });
  }

  async appendRunEvent(projectRoot: string, event: Record<string, unknown>): Promise<RunEvent | null> {
    const normalized = normalizeRunEvent({ ...event, projectRoot });
    if (!normalized) return null;
    const root = this.deps.paths.getAlwaysOnRoot(projectRoot);
    await fs.mkdir(root, { recursive: true });
    await fs.appendFile(this.runHistoryPath(projectRoot), `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async getRunHistory(
    projectRoot: string,
    options: { limit?: number; projectName?: string } = {},
  ): Promise<{ runs: RunHistoryEntry[] }> {
    const records = (await this.readRecords(projectRoot)).filter((r) => r.status !== "unknown");
    const safeLimit =
      Number.isFinite(options.limit) && (options.limit as number) > 0
        ? (options.limit as number)
        : RUN_HISTORY_MAX_ITEMS;
    const sliced = records.slice(0, safeLimit);
    const entries = await Promise.all(
      sliced.map(async (record) =>
        toHistoryEntry(
          record,
          options.projectName ? await recoverRecordSessionInfo(record, options.projectName) : null,
        ),
      ),
    );
    return { runs: entries };
  }

  async getRunHistoryDetail(
    projectRoot: string,
    runId: string,
    options: { projectName?: string } = {},
  ): Promise<RunHistoryDetailEntry> {
    const records = await this.readRecords(projectRoot);
    const record = records.find((r) => r.runId === runId);
    if (!record) {
      const error = new Error("Run history entry not found") as Error & { code: string };
      error.code = "NOT_FOUND";
      throw error;
    }

    const sessionInfo = await recoverRecordSessionInfo(record, options.projectName ?? "");
    const sessionOutput = await buildSessionOutputLog(
      options.projectName ?? "",
      record,
      sessionInfo as Record<string, unknown>,
      this.deps.sessionMessages,
    );
    const fileLog = await this.deps.logs.getAlwaysOnRunLog(projectRoot, runId);
    const outputLog = fileLog.content || sessionOutput || record.outputLog || record.error || "";
    const logSource = fileLog.content ? "log-file" : sessionOutput ? "session" : "history";

    const sessionId = (sessionInfo?.sessionId as string) || getRecordSessionId(record);
    const parentSessionId = (sessionInfo?.parentSessionId as string) || getRecordParentSessionId(record);
    const relativeTranscriptPath =
      (sessionInfo?.relativeTranscriptPath as string) || getRecordRelativeTranscriptPath(record);

    return {
      ...toHistoryEntry(record, sessionInfo as Record<string, unknown>),
      outputLog,
      metadata: {
        ...record.metadata,
        runId: record.runId,
        sourceId: record.sourceId,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        sessionId: sessionId ?? null,
        parentSessionId,
        relativeTranscriptPath,
        transcriptKey:
          (sessionInfo?.transcriptKey as string) ||
          (record.transcriptKey as string) ||
          normalizeString((record.metadata as Record<string, unknown>)?.transcriptKey) ||
          undefined,
        taskId: (record.metadata as Record<string, unknown>)?.taskId,
        runtimeTaskId: (sessionInfo as Record<string, unknown>)?.taskId,
        taskStatus: (sessionInfo as Record<string, unknown>)?.taskStatus,
        outputFile: (sessionInfo as Record<string, unknown>)?.outputFile,
        logSource,
        logUpdatedAt: fileLog.updatedAt,
        logSize: fileLog.size,
        logTruncated: fileLog.truncated,
      },
    };
  }
}
