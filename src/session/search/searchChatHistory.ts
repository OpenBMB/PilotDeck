import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { sanitizeSessionIdForPath } from "../storage/ProjectSessionStorage.js";
import { readSessionInfo, type SessionInfo } from "../storage/SessionList.js";

const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SNIPPET_RADIUS = 60;

export type ChatHistorySearchRole = "user" | "assistant";

export type ChatHistorySearchMatch = {
  sessionId: string;
  sessionTitle: string;
  projectKey?: string;
  role: ChatHistorySearchRole;
  text: string;
  snippet: string;
  createdAt: string;
  lineNumber: number;
};

export type SearchChatHistoryOptions = {
  pilotHome: string;
  /** When omitted, searches all projects under pilotHome. */
  projectRoot?: string;
  query: string;
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  role?: ChatHistorySearchRole | "all";
  sessionId?: string;
  includeInternal?: boolean;
};

export type SearchChatHistoryResult = {
  query: string;
  matches: ChatHistorySearchMatch[];
  truncated: boolean;
  sessionsScanned: number;
};

export type ParsedChatSearchArgs = {
  query: string;
  allProjects: boolean;
  limit?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  role?: ChatHistorySearchRole | "all";
  sessionId?: string;
};

export function parseChatSearchArgs(raw: string): ParsedChatSearchArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let allProjects = false;
  let limit: number | undefined;
  let regex = false;
  let caseSensitive = false;
  let role: ChatHistorySearchRole | "all" | undefined;
  let sessionId: string | undefined;
  const queryParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--all" || token === "-a") {
      allProjects = true;
      continue;
    }
    if (token === "--regex" || token === "-E") {
      regex = true;
      continue;
    }
    if (token === "--case-sensitive") {
      caseSensitive = true;
      continue;
    }
    if (token === "--limit" || token === "-n") {
      const value = Number(tokens[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        limit = Math.min(Math.floor(value), MAX_LIMIT);
        index += 1;
      }
      continue;
    }
    if (token === "--role" || token === "-r") {
      const value = tokens[index + 1];
      if (value === "user" || value === "assistant" || value === "all") {
        role = value;
        index += 1;
      }
      continue;
    }
    if (token === "--session" || token === "-s") {
      const value = tokens[index + 1];
      if (value) {
        sessionId = value;
        index += 1;
      }
      continue;
    }
    queryParts.push(token);
  }

  return {
    query: queryParts.join(" "),
    allProjects,
    limit,
    regex,
    caseSensitive,
    role,
    sessionId,
  };
}

export async function searchChatHistory(options: SearchChatHistoryOptions): Promise<SearchChatHistoryResult> {
  const query = options.query.trim();
  if (!query) {
    return { query, matches: [], truncated: false, sessionsScanned: 0 };
  }

  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const matcher = buildMatcher(query, {
    caseSensitive: options.caseSensitive ?? false,
    regex: options.regex ?? false,
  });
  const roleFilter = options.role ?? "all";
  const includeInternal = options.includeInternal ?? false;

  const sessionFiles = await collectSessionFiles({
    pilotHome: options.pilotHome,
    projectRoot: options.projectRoot,
    sessionId: options.sessionId,
    includeInternal,
  });

  const titleBySession = await buildSessionTitleIndex(sessionFiles);
  const matches: ChatHistorySearchMatch[] = [];
  let truncated = false;

  for (const file of sessionFiles) {
    const fileMatches = await searchSessionFile(file, matcher, roleFilter);
    for (const match of fileMatches) {
      const title = titleBySession.get(`${file.projectKey ?? ""}:${match.sessionId}`) ?? match.sessionId;
      matches.push({
        ...match,
        sessionTitle: title,
        projectKey: file.projectKey,
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return {
    query,
    matches,
    truncated,
    sessionsScanned: sessionFiles.length,
  };
}

type SessionFileTarget = {
  path: string;
  projectKey?: string;
};

type SearchableLine = {
  role: ChatHistorySearchRole;
  text: string;
  createdAt: string;
};

type Matcher = {
  test: (text: string) => boolean;
  findIndex: (text: string) => number;
};

function buildMatcher(
  query: string,
  options: { caseSensitive: boolean; regex: boolean },
): Matcher {
  if (options.regex) {
    const flags = options.caseSensitive ? "" : "i";
    const pattern = new RegExp(query, flags);
    return {
      test: (text) => pattern.test(text),
      findIndex: (text) => {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        return match?.index ?? -1;
      },
    };
  }

  const needle = options.caseSensitive ? query : query.toLowerCase();
  return {
    test: (text) => {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      return haystack.includes(needle);
    },
    findIndex: (text) => {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      return haystack.indexOf(needle);
    },
  };
}

async function collectSessionFiles(options: {
  pilotHome: string;
  projectRoot?: string;
  sessionId?: string;
  includeInternal: boolean;
}): Promise<SessionFileTarget[]> {
  if (options.sessionId) {
    const projectRoot = options.projectRoot ?? process.cwd();
    const chatDir = getPilotProjectChatDir(projectRoot, options.pilotHome);
    if (!options.includeInternal && isInternalSession(options.sessionId)) {
      return [];
    }
    return [{
      path: join(chatDir, `${sanitizeSessionIdForPath(options.sessionId)}.jsonl`),
      projectKey: projectRoot,
    }];
  }

  if (options.projectRoot) {
    const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
    return listJsonlFiles(chatDir, options.projectRoot, options.includeInternal);
  }

  const projectsDir = resolve(options.pilotHome, "projects");
  let projectIds: string[];
  try {
    projectIds = await readdir(projectsDir);
  } catch {
    return [];
  }

  const files: SessionFileTarget[] = [];
  for (const projectId of projectIds) {
    const chatDir = join(projectsDir, projectId, "chats");
    files.push(...await listJsonlFiles(chatDir, projectId, options.includeInternal));
  }
  return files;
}

async function listJsonlFiles(
  chatDir: string,
  projectKey: string,
  includeInternal: boolean,
): Promise<SessionFileTarget[]> {
  let names: string[];
  try {
    names = await readdir(chatDir);
  } catch {
    return [];
  }

  const files: SessionFileTarget[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!includeInternal && isInternalSession(sessionId)) continue;
    files.push({
      path: join(chatDir, name),
      projectKey,
    });
  }
  return files;
}

async function buildSessionTitleIndex(files: SessionFileTarget[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  await Promise.all(files.map(async (file) => {
    const sessionId = file.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "");
    if (!sessionId) return;
    const info = await readSessionInfo(file.path, sessionId, file.projectKey);
    if (!info) return;
    titles.set(`${file.projectKey ?? ""}:${sessionId}`, formatSessionTitle(info));
  }));

  return titles;
}

function formatSessionTitle(session: SessionInfo): string {
  return session.customTitle ?? session.aiTitle ?? session.summary ?? session.sessionId;
}

async function searchSessionFile(
  file: SessionFileTarget,
  matcher: Matcher,
  roleFilter: ChatHistorySearchRole | "all",
): Promise<Omit<ChatHistorySearchMatch, "sessionTitle" | "projectKey">[]> {
  const matches: Omit<ChatHistorySearchMatch, "sessionTitle" | "projectKey">[] = [];
  const stream = createReadStream(file.path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : file.path;
    const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
    const searchable = extractSearchableLines(entry);
    for (const item of searchable) {
      if (roleFilter !== "all" && item.role !== roleFilter) continue;
      if (!matcher.test(item.text)) continue;
      matches.push({
        sessionId,
        role: item.role,
        text: item.text,
        snippet: buildSnippet(item.text, matcher),
        createdAt,
        lineNumber,
      });
    }
  }

  return matches;
}

function extractSearchableLines(entry: Record<string, unknown>): SearchableLine[] {
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  const type = entry.type;

  if (type === "accepted_input" && Array.isArray(entry.messages)) {
    const text = extractCanonicalText(entry.messages);
    if (text) {
      return [{ role: "user", text, createdAt }];
    }
    return [];
  }

  if ((type === "assistant_message" || type === "durable_message") && isRecord(entry.message)) {
    const text = extractCanonicalText([entry.message]);
    if (text) {
      return [{ role: "assistant", text, createdAt }];
    }
  }

  return [];
}

function extractCanonicalText(messages: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "text") continue;
      const text = block.text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function buildSnippet(text: string, matcher: Matcher): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const matchIndex = matcher.findIndex(normalized);
  const center = matchIndex >= 0 ? matchIndex : 0;
  const start = Math.max(0, center - SNIPPET_RADIUS);
  const end = Math.min(normalized.length, center + SNIPPET_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function isInternalSession(sessionId: string): boolean {
  return ALWAYS_ON_AUXILIARY_PATTERN.test(sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
