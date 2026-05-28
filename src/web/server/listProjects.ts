/**
 * Enumerate PilotDeck projects.
 *
 * Source of truth (Phase 3): the `projects/` directory under `pilotHome`.
 * Each subdirectory is a project ID; we surface its derived name + the
 * encoded `fullPath` we can recover from the ID. Where possible we also
 * include the session count via `listProjectSessions`.
 *
 * When `defaultProjectRoot` is provided, it is appended even if it
 * has no chats yet. Omit it to skip this behaviour (e.g. dev mode).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { listProjectSessions } from "../../session/index.js";
import { createProjectId } from "../../pilot/index.js";
import type { WebListProjectsResult, WebProjectSummary } from "../client/protocol.js";

export type ListWebProjectsOptions = {
  pilotHome: string;
  defaultProjectRoot?: string;
};

export async function listWebProjects(
  options: ListWebProjectsOptions,
): Promise<WebListProjectsResult> {
  const seen = new Set<string>();
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
    const summary = await summarizeProject(fullPath, options);
    seen.add(summary.projectKey);
    projects.push(summary);
  }

  if (options.defaultProjectRoot) {
    const normalizedDefault = resolve(options.defaultProjectRoot);
    if (!seen.has(normalizedDefault)) {
      const summary = await summarizeProject(normalizedDefault, options);
      projects.push(summary);
    }
  }

  projects.sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
  return { projects };
}

export async function describeWebProject(
  projectKey: string,
  options: ListWebProjectsOptions,
): Promise<WebProjectSummary> {
  return summarizeProject(projectKey, options);
}

async function summarizeProject(
  projectRoot: string,
  options: ListWebProjectsOptions,
): Promise<WebProjectSummary> {
  let sessionCount = 0;
  let lastActivity: number | undefined;
  try {
    const sessions = await listProjectSessions({
      projectRoot,
      pilotHome: options.pilotHome,
    });
    sessionCount = sessions.length;
    lastActivity = sessions[0]?.lastModified;
  } catch {
    sessionCount = 0;
  }
  return {
    projectKey: projectRoot,
    name: basename(projectRoot) || projectRoot,
    fullPath: projectRoot,
    sessionCount,
    lastActivity,
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
