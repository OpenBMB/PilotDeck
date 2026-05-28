import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { findCanonicalProjectRoot } from "../session/worktree/findCanonicalProjectRoot.js";

export type PilotPathEnv = Record<string, string | undefined>;

export const DEFAULT_PILOT_HOME = "~/.pilotdeck";
export const PILOT_CONFIG_FILE_NAME = "pilotdeck.yaml";
export const PILOT_PROJECT_DIR_NAME = ".pilotdeck";

export type PilotExtensionPaths = {
  globalPluginsDir: string;
  globalSkillsDir: string;
  projectPluginsDir: string;
  projectSkillsDir: string;
};

export function resolvePilotHome(env: PilotPathEnv = process.env): string {
  return normalizeHomePath(env.PILOT_HOME ?? DEFAULT_PILOT_HOME);
}

export function getPilotConfigFilePath(pilotHome: string): string {
  return resolve(pilotHome, PILOT_CONFIG_FILE_NAME);
}

export function getPilotProjectConfigFilePath(projectRoot: string): string {
  return resolve(projectRoot, PILOT_PROJECT_DIR_NAME, PILOT_CONFIG_FILE_NAME);
}

export function getPilotMemoryRootDir(pilotHome: string): string {
  return resolve(pilotHome, "memory");
}

export function getPilotProjectChatDir(projectRoot: string, pilotHome: string): string {
  const projectId = resolveStoredProjectId(projectRoot, pilotHome) ?? createProjectId(projectRoot);
  return resolve(pilotHome, "projects", projectId, "chats");
}

/**
 * Async variant that first resolves a worktree cwd to its canonical
 * main-repository root (so all worktrees share the same project ID).
 * Use this for all new code. The sync `getPilotProjectChatDir` keeps
 * the legacy behaviour for callers that cannot await.
 */
export async function getPilotProjectChatDirAsync(
  projectRoot: string,
  pilotHome: string,
): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  const projectId = resolveStoredProjectId(canonical, pilotHome) ?? createProjectId(canonical);
  return resolve(pilotHome, "projects", projectId, "chats");
}

export function getPilotExtensionPaths(projectRoot: string, pilotHome: string): PilotExtensionPaths {
  return {
    globalPluginsDir: resolve(pilotHome, "plugins"),
    globalSkillsDir: resolve(pilotHome, "skills"),
    projectPluginsDir: resolve(projectRoot, PILOT_PROJECT_DIR_NAME, "plugins"),
    projectSkillsDir: resolve(projectRoot, PILOT_PROJECT_DIR_NAME, "skills"),
  };
}

export function createProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  return createLegacyProjectId(normalizedRoot);
}

export function createCollisionResistantProjectId(projectRoot: string): string {
  const normalizedRoot = resolve(projectRoot);
  const legacyId = createLegacyProjectId(normalizedRoot);
  const digest = createHash("sha1").update(normalizedRoot).digest("hex").slice(0, 10);
  return `${legacyId}--${digest}`;
}

/**
 * Async variant: resolves canonical (worktree-aware) root before hashing.
 * Two worktrees of the same repo produce the same project ID.
 */
export async function createProjectIdAsync(projectRoot: string): Promise<string> {
  const canonical = await findCanonicalProjectRoot(projectRoot);
  return createProjectId(canonical);
}

function normalizeHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

function createLegacyProjectId(projectRoot: string): string {
  // Normalize to forward slashes so the same physical path produces the same
  // project ID on Windows (\) and Unix (/). Also strip a Windows drive-letter
  // prefix (e.g. "C:") so "C:\Users\foo" slugifies identically to "/Users/foo".
  const normalized = projectRoot.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function resolveStoredProjectId(projectRoot: string, pilotHome: string): string | null {
  const projectsDir = resolve(pilotHome, "projects");
  if (!existsSync(projectsDir)) {
    return null;
  }
  const target = resolve(projectRoot);
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const markerPath = resolve(projectsDir, entry.name, ".cwd");
      let marker: string;
      try {
        marker = readFileSync(markerPath, "utf8").trim();
      } catch {
        continue;
      }
      if (!marker || resolve(marker) !== target) {
        continue;
      }
      try {
        if (statSync(marker).isDirectory()) {
          return entry.name;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}
