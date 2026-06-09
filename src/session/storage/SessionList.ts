import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { readSessionLite, type SessionLiteFile } from "./SessionLiteReader.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;

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
    const lite = await readSessionLite(join(chatDir, name));
    if (!lite) {
      continue;
    }
    const sessionId = name.slice(0, -".jsonl".length);
    if (!options.includeInternal && isInternalSession(sessionId)) {
      continue;
    }
    const info = parseSessionInfoFromLite(sessionId, lite, options.projectRoot);
    if (info) {
      sessions.push(info);
    }
  }

  sessions.sort((left, right) => right.lastModified - left.lastModified);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? sessions.length;
  return sessions.slice(offset, limit === 0 ? undefined : offset + limit);
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
      const lite = await readSessionLite(join(chatDir, name));
      if (!lite) continue;
      const info = parseSessionInfoFromLite(sessionId, lite);
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
    const lite = await readSessionLite(join(chatDir, name));
    if (!lite) continue;
    const info = parseSessionInfoFromLite(sessionId, lite, options.projectRoot);
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
