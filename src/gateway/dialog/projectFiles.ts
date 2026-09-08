import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MatchRange,
  ProjectFileEntry,
  ProjectFilesListInput,
  ProjectFilesListResult,
} from "../protocol/types.js";
import { DialogGatewayError } from "./errors.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const SCAN_TIMEOUT_MS = 5_000;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".pilotdeck",
  ".tmp",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

type Cursor = { version: 1; offset: number; signature: string };

export async function listProjectFiles(input: ProjectFilesListInput): Promise<ProjectFilesListResult> {
  const projectRoot = resolveRequiredProjectKey(input.projectKey);
  const canonicalRoot = await realpath(projectRoot).catch(() => {
    throw new DialogGatewayError("PROJECT_NOT_FOUND", `Project does not exist: ${input.projectKey}`);
  });
  const rootInfo = await stat(canonicalRoot);
  if (!rootInfo.isDirectory()) {
    throw new DialogGatewayError("PROJECT_NOT_FOUND", `Project is not a directory: ${input.projectKey}`);
  }

  const query = normalizeQuery(input.query);
  const includeDirs = input.includeDirs !== false;
  const limit = normalizeLimit(input.limit);
  const signature = querySignature(canonicalRoot, query, includeDirs);
  const offset = decodeCursor(input.cursor, signature);
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  const entries: ProjectFileEntry[] = [];
  const scan = { count: 0, visitedDirectories: new Set<string>([canonicalRoot]) };

  await walk(canonicalRoot, canonicalRoot, 0, entries, deadline, includeDirs, query, scan);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const items = entries.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    projectKey: canonicalRoot,
    ...(nextOffset < entries.length
      ? { nextCursor: encodeCursor({ version: 1, offset: nextOffset, signature }) }
      : {}),
  };
}

async function walk(
  root: string,
  directory: string,
  depth: number,
  output: ProjectFileEntry[],
  deadline: number,
  includeDirs: boolean,
  query: string,
  scan: { count: number; visitedDirectories: Set<string> },
): Promise<void> {
  if (Date.now() > deadline || scan.count >= MAX_ENTRIES || depth > MAX_DEPTH) {
    throw new DialogGatewayError("FILE_INDEX_LIMIT", "Project file scan exceeded its resource limit.");
  }
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    scan.count += 1;
    if (Date.now() > deadline || scan.count > MAX_ENTRIES) {
      throw new DialogGatewayError("FILE_INDEX_LIMIT", "Project file scan exceeded its resource limit.");
    }
    if (child.isDirectory() && EXCLUDED_DIRECTORIES.has(child.name)) continue;
    const absolute = resolve(directory, child.name);
    const canonical = await realpath(absolute).catch(() => undefined);
    if (!canonical || !isWithinRoot(root, canonical)) continue;
    const info = await stat(canonical).catch(() => undefined);
    if (!info) continue;
    const relativePath = relative(root, canonical).split(sep).join("/");
    if (!relativePath) continue;
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
    if (!kind) continue;
    const matches = query ? collectMatches(child.name, relativePath, query) : undefined;
    if ((!query || (matches && matches.length > 0)) && (kind === "file" || includeDirs)) {
      output.push({
        id: stableEntryId(root, relativePath),
        name: basename(relativePath),
        relativePath,
        kind,
        size: kind === "file" ? info.size : 0,
        mtimeMs: info.mtimeMs,
        ...(matches && matches.length > 0 ? { matches } : {}),
      });
    }
    if (kind === "directory") {
      if (scan.visitedDirectories.has(canonical)) continue;
      scan.visitedDirectories.add(canonical);
      await walk(root, canonical, depth + 1, output, deadline, includeDirs, query, scan);
    }
  }
}

function collectMatches(name: string, relativePath: string, query: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  appendMatches(ranges, "name", name, query);
  appendMatches(ranges, "relativePath", relativePath, query);
  return ranges;
}

function appendMatches(output: MatchRange[], field: string, value: string, query: string): void {
  const lower = value.toLocaleLowerCase();
  let from = 0;
  while (from <= lower.length - query.length) {
    const start = lower.indexOf(query, from);
    if (start < 0) break;
    output.push({ field, start, end: start + query.length });
    from = start + Math.max(1, query.length);
  }
}

function normalizeQuery(value: string | undefined): string {
  const query = value?.trim().toLocaleLowerCase() ?? "";
  if (query.length > 256) {
    throw new DialogGatewayError("INVALID_QUERY", "query must not exceed 256 characters.");
  }
  return query;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new DialogGatewayError("INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function resolveRequiredProjectKey(projectKey: string): string {
  if (typeof projectKey !== "string" || projectKey.trim().length === 0) {
    throw new DialogGatewayError("PROJECT_NOT_FOUND", "projectKey is required.");
  }
  return resolve(projectKey);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function stableEntryId(root: string, relativePath: string): string {
  return `sha256:${createHash("sha256").update(root).update("\0").update(relativePath).digest("hex")}`;
}

function querySignature(root: string, query: string, includeDirs: boolean): string {
  return createHash("sha256").update(JSON.stringify({ root, query, includeDirs })).digest("base64url");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, signature: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (parsed.version !== 1 || parsed.signature !== signature || !Number.isInteger(parsed.offset) || (parsed.offset ?? -1) < 0) {
      throw new Error("invalid");
    }
    return parsed.offset as number;
  } catch {
    throw new DialogGatewayError("INVALID_CURSOR", "cursor is invalid or does not match the query.");
  }
}
