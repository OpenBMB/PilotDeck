import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { mergeMetadata } from "../metadata/SessionMetadataStore.js";
import { readSessionLite, SESSION_LITE_READ_BYTES, type SessionLiteFile } from "./SessionLiteReader.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;
const SESSION_METADATA_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_METADATA_LINE_BYTES = 128 * 1024;

function isInternalSession(sessionId: string): boolean {
  return ALWAYS_ON_AUXILIARY_PATTERN.test(sessionId);
}

export type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  parentSessionId?: string;
  forkedFromTurnId?: string;
};

export type ListProjectSessionsOptions = {
  projectRoot: string;
  pilotHome: string;
  limit?: number;
  offset?: number;
  includeInternal?: boolean;
};

export async function listProjectSessions(options: ListProjectSessionsOptions): Promise<SessionInfo[]> {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  let names: string[];
  try {
    names = await readdir(chatDir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const sessionId = name.slice(0, -".jsonl".length);
    if (!options.includeInternal && isInternalSession(sessionId)) {
      continue;
    }
    const info = await readSessionInfo(join(chatDir, name), sessionId, options.projectRoot);
    if (info) {
      sessions.push(info);
    }
  }

  sessions.sort((left, right) => right.lastModified - left.lastModified);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? sessions.length;
  return sessions.slice(offset, limit === 0 ? undefined : offset + limit);
}

export async function readSessionInfo(
  path: string,
  sessionId: string,
  projectRoot?: string,
): Promise<SessionInfo | null> {
  const lite = await readSessionLite(path);
  if (!lite) return null;

  const fastInfo = parseSessionInfoFromLite(sessionId, lite, projectRoot);
  if (fastInfo && lite.size <= SESSION_LITE_READ_BYTES) return fastInfo;
  const tailSnapshot = readLatestTailSnapshot(lite);
  if (tailSnapshot) {
    const snapshotInfo = parseSessionInfoFromMetadata(sessionId, lite, tailSnapshot, projectRoot);
    if (snapshotInfo) return mergeSessionInfo(fastInfo, snapshotInfo);
  }

  // Large inline media can make the first JSONL record exceed the 64 KiB
  // preview. Fall back unless the preview includes a complete latest metadata
  // record; an older head title must not hide a newer oversized tail record.
  const metadata = await readLastSessionMetadata(path);
  const metadataInfo = metadata
    ? parseSessionInfoFromMetadata(sessionId, lite, metadata, projectRoot)
    : null;
  return mergeSessionInfo(fastInfo, metadataInfo);
}

function mergeSessionInfo(
  fastInfo: SessionInfo | null,
  metadataInfo: SessionInfo | null,
): SessionInfo | null {
  if (!metadataInfo) return fastInfo;
  if (!fastInfo) return metadataInfo;
  return {
    ...fastInfo,
    ...metadataInfo,
    firstPrompt: metadataInfo.firstPrompt ?? fastInfo.firstPrompt,
    createdAt: metadataInfo.createdAt ?? fastInfo.createdAt,
  };
}

function readLatestTailSnapshot(lite: SessionLiteFile): SessionMetadataValue | undefined {
  if (lite.size <= SESSION_LITE_READ_BYTES) {
    return undefined;
  }

  // The tail starts at an arbitrary byte offset, so its first line can be
  // partial. Any complete metadata record after it is necessarily newer.
  let latestMetadata: SessionMetadataValue | undefined;
  const lines = lite.tail.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.includes('"type":"session_metadata"')) continue;
    const metadata = parseSessionMetadataLine(line);
    if (!metadata) return undefined;
    latestMetadata = metadata;
  }
  // Metadata records are patches. Only `reappendTail()` writes an explicit
  // full snapshot, so ordinary trailing patches cannot skip title recovery.
  if (
    latestMetadata?.isSnapshot === true
    && (
      latestMetadata.title?.trim()
      || latestMetadata.aiTitle?.trim()
      || latestMetadata.lastPrompt?.trim()
      || latestMetadata.firstPrompt?.trim()
    )
  ) {
    return latestMetadata;
  }
  return undefined;
}

export function parseSessionInfoFromLite(
  sessionId: string,
  lite: SessionLiteFile,
  projectRoot?: string,
): SessionInfo | null {
  const source = `${lite.head}\n${lite.tail}`;
  const customTitle = lastMetadataStringField(source, "title");
  const aiTitle = lastMetadataStringField(source, "aiTitle");
  const tag = lastMetadataStringField(source, "tag");
  const parentSessionId = lastMetadataStringField(source, "parentSessionId");
  const forkedFromTurnId = lastMetadataStringField(source, "forkedFromTurnId");
  const firstPrompt = firstAcceptedInputText(lite.head);
  const lastPrompt = lastAcceptedInputText(lite.tail) ?? firstPrompt;
  const summary = customTitle ?? aiTitle ?? lastPrompt;
  if (!summary) {
    return null;
  }

  const firstCreatedAt = firstJsonStringField(lite.head, "createdAt");
  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    customTitle,
    aiTitle,
    firstPrompt,
    cwd: projectRoot,
    tag,
    createdAt: firstCreatedAt ? Date.parse(firstCreatedAt) : undefined,
    parentSessionId,
    forkedFromTurnId,
  };
}

function firstAcceptedInputText(head: string): string | undefined {
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const text = entry.messages?.flatMap((message) => message.content ?? []).find((block) => block.type === "text")?.text;
      if (text?.trim()) {
        return text.trim();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lastAcceptedInputText(tail: string): string | undefined {
  let last: string | undefined;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const text = entry.messages?.flatMap((message) => message.content ?? []).find((block) => block.type === "text")?.text;
      if (text?.trim()) {
        last = text.trim();
      }
    } catch {
      // partial line at tail boundary — skip
    }
  }
  return last;
}

function firstJsonStringField(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"])*)"`));
  return match?.[1] ? unescapeJsonString(match[1]) : undefined;
}

function lastJsonStringField(source: string, field: string): string | undefined {
  const regex = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "g");
  let value: string | undefined;
  for (const match of source.matchAll(regex)) {
    if (match[1]) {
      value = unescapeJsonString(match[1]);
    }
  }
  return value;
}

/**
 * Like {@link lastJsonStringField} but restricted to JSONL lines whose
 * `"type"` is `"session_metadata"`. The old approach scanned the entire
 * raw head+tail text for `"title"`, which would pick up stray `"title"`
 * keys from tool-call inputs, web-search results, or activity frames —
 * causing the sidebar to display an intermediate tool argument instead
 * of the actual session title.
 */
function lastMetadataStringField(source: string, field: string): string | undefined {
  const fieldRegex = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"])*)"`);
  let value: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('"session_metadata"')) continue;
    const match = line.match(fieldRegex);
    if (match?.[1]) {
      value = unescapeJsonString(match[1]);
    }
  }
  return value;
}

function unescapeJsonString(value: string): string {
  return JSON.parse(`"${value}"`) as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

function parseSessionInfoFromMetadata(
  sessionId: string,
  lite: SessionLiteFile,
  metadata: SessionMetadataValue,
  projectRoot?: string,
): SessionInfo | null {
  const summary = metadata.title ?? metadata.aiTitle ?? metadata.lastPrompt ?? metadata.firstPrompt;
  if (!summary?.trim()) return null;
  const firstCreatedAt = firstJsonStringField(lite.head, "createdAt");
  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    customTitle: metadata.title,
    aiTitle: metadata.aiTitle,
    firstPrompt: metadata.firstPrompt,
    cwd: projectRoot,
    createdAt: firstCreatedAt ? Date.parse(firstCreatedAt) : undefined,
    tag: metadata.tag,
    parentSessionId: metadata.parentSessionId,
    forkedFromTurnId: metadata.forkedFromTurnId,
  };
}

/**
 * Scan only for strict session_metadata records while keeping oversized JSONL
 * records (such as base64 image inputs) out of memory.
 */
async function readLastSessionMetadata(path: string): Promise<SessionMetadataValue | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(SESSION_METADATA_SCAN_CHUNK_BYTES);
    let lastMetadata: SessionMetadataValue | undefined;
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;
    let lineTooLarge = false;
    let lineIsSessionMetadata = false;

    const append = (segment: Buffer): void => {
      if (segment.length === 0) return;
      lineBytes += segment.length;
      if (lineTooLarge) return;

      // Transcript records serialize `type` first, so the initial buffered
      // prefix identifies metadata before a large fork `firstPrompt` forces
      // us past the normal per-line cap.
      if (!lineIsSessionMetadata) {
        const prefix = Buffer.concat([...lineChunks, segment]).toString("utf8");
        lineIsSessionMetadata = prefix.includes('"type":"session_metadata"');
      }
      if (!lineIsSessionMetadata && lineBytes > MAX_SESSION_METADATA_LINE_BYTES) {
        lineChunks = [];
        lineTooLarge = true;
        return;
      }
      lineChunks.push(Buffer.from(segment));
    };

    const finishLine = (): void => {
      if (!lineTooLarge) {
        const metadata = parseSessionMetadataLine(Buffer.concat(lineChunks).toString("utf8").replace(/\r$/, ""));
        if (metadata) lastMetadata = mergeMetadata(lastMetadata ?? {}, metadata);
      }
      lineChunks = [];
      lineBytes = 0;
      lineTooLarge = false;
      lineIsSessionMetadata = false;
    };

    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      let start = 0;
      for (let newline = buffer.indexOf(0x0a, start); newline !== -1 && newline < bytesRead; newline = buffer.indexOf(0x0a, start)) {
        append(buffer.subarray(start, newline));
        finishLine();
        start = newline + 1;
      }
      append(buffer.subarray(start, bytesRead));
    }
    if (lineBytes > 0 || lineChunks.length > 0) finishLine();
    return lastMetadata;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseSessionMetadataLine(line: string): SessionMetadataValue | undefined {
  if (!line.includes('"type":"session_metadata"')) return undefined;
  try {
    const entry = JSON.parse(line) as unknown;
    if (!isRecord(entry) || entry.type !== "session_metadata" || !isRecord(entry.metadata)) {
      return undefined;
    }
    const metadata = entry.metadata;
    const parsed: SessionMetadataValue = {};
    if (metadata.isSnapshot === true) {
      parsed.isSnapshot = true;
    }
    const stringFields = [
      "title",
      "aiTitle",
      "tag",
      "firstPrompt",
      "lastPrompt",
      "parentSessionId",
      "forkedFromTurnId",
    ] as const;
    for (const field of stringFields) {
      const value = stringValue(metadata[field]);
      if (value !== undefined) {
        parsed[field] = value;
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Options for listing sessions across all known projects. */
export type ListAllSessionsOptions = {
  pilotHome: string;
  limit?: number;
  offset?: number;
  includeInternal?: boolean;
};

/**
 * List sessions across **all** projects under `{pilotHome}/projects/`. Each
 * project directory is scanned for `.jsonl` files in its `chats/` subfolder.
 * Results are sorted by lastModified descending (most-recent first), then
 * paginated via `limit` / `offset`.
 */
export async function listAllSessions(options: ListAllSessionsOptions): Promise<SessionInfo[]> {
  const projectsDir = resolve(options.pilotHome, "projects");
  let projectIds: string[];
  try {
    projectIds = await readdir(projectsDir);
  } catch {
    return [];
  }

  const all: SessionInfo[] = [];
  for (const projectId of projectIds) {
    const chatDir = join(projectsDir, projectId, "chats");
    let names: string[];
    try {
      names = await readdir(chatDir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      if (!options.includeInternal && isInternalSession(sessionId)) continue;
      const info = await readSessionInfo(join(chatDir, name), sessionId);
      if (info) {
        info.cwd = projectId;
        all.push(info);
      }
    }
  }

  all.sort((left, right) => right.lastModified - left.lastModified);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? all.length;
  return all.slice(offset, limit === 0 ? undefined : offset + limit);
}

/** Options for title-based session search. */
export type SearchSessionsByTitleOptions = {
  projectRoot: string;
  pilotHome: string;
  query: string;
  limit?: number;
  includeInternal?: boolean;
};

/**
 * Search sessions within a project by matching `query` (case-insensitive
 * substring) against `customTitle`, `aiTitle`, and `firstPrompt`. Returns
 * results sorted by lastModified descending.
 */
export async function searchSessionsByTitle(options: SearchSessionsByTitleOptions): Promise<SessionInfo[]> {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  let names: string[];
  try {
    names = await readdir(chatDir);
  } catch {
    return [];
  }

  const needle = options.query.toLowerCase();
  const results: SessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!options.includeInternal && isInternalSession(sessionId)) continue;
    const info = await readSessionInfo(join(chatDir, name), sessionId, options.projectRoot);
    if (!info) continue;
    const haystack = [info.customTitle, info.aiTitle, info.firstPrompt]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (haystack.includes(needle)) {
      results.push(info);
    }
  }

  results.sort((left, right) => right.lastModified - left.lastModified);
  return options.limit ? results.slice(0, options.limit) : results;
}
