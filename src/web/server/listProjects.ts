/**
 * Enumerate PilotDeck projects.
 *
 * Source of truth: the `projects/` directory under `pilotHome`.
 * Each subdirectory is a project ID; we surface its derived name + the
 * encoded `fullPath` we can recover from the ID. Where possible we also
 * count stored sessions using file attributes without opening transcripts.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { listSessionFiles, isInternalSession } from "../../session/storage/SessionCatalog.js";
import { createProjectId, getPilotProjectChatDir } from "../../pilot/index.js";
import type { WebListProjectsResult, WebProjectSummary } from "../client/protocol.js";

export type ListWebProjectsOptions = {
  pilotHome: string;
};

export async function listWebProjects(
  options: ListWebProjectsOptions,
): Promise<WebListProjectsResult> {
  const projects: WebProjectSummary[] = [];

  const projectsDir = resolve(options.pilotHome, "projects");
  let projectIds: string[] = [];
  try {
    projectIds = await readdir(projectsDir);
  } catch {
    projectIds = [];
  }

  for (const id of projectIds) {
    const dir = resolve(projectsDir, id);
    let isDir = false;
    try {
      const s = await stat(dir);
      isDir = s.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const fullPath = await resolveProjectPathFromId(projectsDir, id);
    if (!fullPath) {
      // Encoded id no longer maps to an existing absolute path on disk
      // (typical for stale dirs created by older runs that resolve()'d a
      // relative projectKey under the wrong cwd). Skipping keeps the UI
      // project list trustworthy.
      continue;
    }
    if (resolve(fullPath) === resolve(options.pilotHome)) {
      continue;
    }
    const summary = await summarizeProject(fullPath, options, dir);
    projects.push(summary);
  }

  projects.sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
  return { projects };
}

/** Registration-only lookup: never read chat transcripts to validate a send. */
export async function listRegisteredWebProjects(
  options: ListWebProjectsOptions,
): Promise<Array<{ projectKey: string }>> {
  const projectsDir = resolve(options.pilotHome, "projects");
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const projects: Array<{ projectKey: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectKey = await resolveProjectPathFromId(projectsDir, entry.name);
    if (projectKey && resolve(projectKey) !== resolve(options.pilotHome)) projects.push({ projectKey });
  }
  return projects;
}

/** Cache locations, not authorization: revalidate registrations on every lookup. */
export function createRegisteredWebProjectResolver(options: ListWebProjectsOptions) {
  const projectsDir = resolve(options.pilotHome, "projects");
  const locations = new Map<string, string>();
  return async (projectKey: string): Promise<string | undefined> => {
    const requested = resolve(projectKey);
    const directId = createProjectId(requested);
    const matches = async (id: string): Promise<boolean> => {
      if (!(await stat(resolve(projectsDir, id)).catch(() => undefined))?.isDirectory()) return false;
      const registered = await resolveProjectPathFromId(projectsDir, id);
      return registered !== null && resolve(registered) === requested;
    };
    const cachedId = locations.get(requested);
    for (const id of new Set([cachedId, directId])) {
      if (id && await matches(id)) return requested;
    }
    locations.delete(requested);
    // Legacy/collision-resistant directories may use a different ID. Only
    // inspect registration markers; session counts and titles are irrelevant.
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === directId || entry.name === cachedId) continue;
      if (await matches(entry.name)) {
        if (locations.size >= 256) locations.delete(locations.keys().next().value!);
        locations.set(requested, entry.name);
        return requested;
      }
    }
    return undefined;
  };
}

export async function describeWebProject(
  projectKey: string,
  options: ListWebProjectsOptions,
): Promise<WebProjectSummary> {
  const projectStorageDir = await resolveProjectStorageDir(projectKey, options);
  return summarizeProject(projectKey, options, projectStorageDir);
}

async function resolveProjectStorageDir(
  projectRoot: string,
  options: ListWebProjectsOptions,
): Promise<string | undefined> {
  const projectsDir = resolve(options.pilotHome, "projects");
  const candidate = resolve(projectsDir, createProjectId(projectRoot));
  let legacyCandidate: string | undefined;
  try {
    if ((await stat(candidate)).isDirectory()) {
      try {
        const marker = (await readFile(resolve(candidate, ".cwd"), "utf8")).trim();
        if (marker && resolve(marker) === resolve(projectRoot)) {
          return candidate;
        }
        if (!marker) legacyCandidate = candidate;
      } catch {
        // Legacy project directories may not have a marker.
        legacyCandidate = candidate;
      }
    }
  } catch {
    // Fall through to .cwd marker lookup for collision-resistant IDs.
  }

  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const marker = (await readFile(resolve(projectsDir, entry.name, ".cwd"), "utf8")).trim();
      if (marker && resolve(marker) === resolve(projectRoot)) {
        return resolve(projectsDir, entry.name);
      }
    } catch {
      // Ignore missing or unreadable markers.
    }
  }
  return legacyCandidate;
}

async function summarizeProject(
  projectRoot: string,
  options: ListWebProjectsOptions,
  projectStorageDir?: string,
): Promise<WebProjectSummary> {
  let sessionCount = 0;
  let lastActivity: number | undefined;
  let createdAt: number | undefined;
  if (projectStorageDir) {
    try {
      const storageStats = await stat(projectStorageDir);
      createdAt = storageStats.birthtimeMs || storageStats.ctimeMs;
    } catch {
      createdAt = undefined;
    }
  }
  try {
    const chatDir = projectStorageDir
      ? resolve(projectStorageDir, "chats")
      : getPilotProjectChatDir(projectRoot, options.pilotHome);
    const files = (await listSessionFiles(options.pilotHome, chatDir)).filter((file) => !isInternalSession(file.sessionId));
    sessionCount = files.length;
    lastActivity = files[0]?.mtime;
  } catch {
    sessionCount = 0;
  }
  return {
    projectKey: projectRoot,
    name: basename(projectRoot) || projectRoot,
    fullPath: projectRoot,
    sessionCount,
    lastActivity,
    createdAt,
  };
}

async function resolveProjectPathFromId(projectsDir: string, projectId: string): Promise<string | null> {
  const markerPath = resolve(projectsDir, projectId, ".cwd");
  try {
    const marker = (await readFile(markerPath, "utf8")).trim();
    if (!marker) {
      return null;
    }
    const markerStat = await stat(marker);
    if (markerStat.isDirectory()) {
      return marker;
    }
  } catch {
    // No marker (or stale marker) — fall back to legacy id decoding.
  }
  return tryDecodeProjectId(projectId);
}

/**
 * Legacy project IDs are path-slug encodings where separators become `-`.
 * Recovery is heuristic-only; we keep this for backwards compatibility
 * when `.cwd` markers are missing.
 */
async function tryDecodeProjectId(id: string): Promise<string | null> {
  // Walk every `-` and treat it as a `/` boundary. Validate by checking
  // that the path exists AND `createProjectId(decoded)` round-trips back
  // to the original id (this catches names that happen to share an
  // encoded form but live on different paths).
  const segments = id.split("-");
  const isWindows = process.platform === "win32";
  for (let firstSlash = 0; firstSlash < segments.length; firstSlash += 1) {
    const candidates: string[] = [];
    if (isWindows) {
      // On Windows, try common drive letter prefixes (e.g. C:\Users\...)
      const rest = segments.slice(firstSlash).join("\\");
      for (const drive of ["C", "D", "E"]) {
        candidates.push(`${drive}:\\${rest}`);
      }
    }
    // Always try Unix-style as well (works on macOS/Linux, harmless on Windows)
    candidates.push("/" + segments.slice(firstSlash).join("/"));

    for (const candidate of candidates) {
      const reEncoded = createProjectId(candidate);
      if (reEncoded !== id) continue;
      try {
        const stats = await stat(candidate);
        if (stats.isDirectory()) {
          return candidate;
        }
      } catch {
        // ignore — try next candidate
      }
    }
  }
  return null;
}
