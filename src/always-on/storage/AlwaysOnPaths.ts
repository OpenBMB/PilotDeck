import { resolve } from "node:path";
import { createProjectId } from "../../pilot/paths.js";

const ROOT_DIR_NAME = "always-on";

export type AlwaysOnPaths = {
  pilotHome: string;
  projectKey: string;
  projectId: string;
  rootDir: string;
  projectDir: string;
  stateFile: string;
  plansDir: string;
  planIndexFile: string;
  cyclesDir: string;
  cycleIndexFile: string;
  reportsDir: string;
  runsDir: string;
  runHistoryFile: string;
  eventsFile: string;
  locksDir: string;
  discoveryLockFile: string;
  worktreesDir: string;
  snapshotsDir: string;
};

export function resolveAlwaysOnPaths(input: {
  pilotHome: string;
  projectKey: string;
  worktreesBaseDir?: string;
  snapshotsBaseDir?: string;
}): AlwaysOnPaths {
  const pilotHome = resolve(input.pilotHome);
  const projectKey = resolve(input.projectKey);
  const projectId = createProjectId(projectKey);
  const rootDir = resolve(pilotHome, ROOT_DIR_NAME);
  const projectDir = resolve(rootDir, "projects", projectId);
  const worktreesDir = resolve(input.worktreesBaseDir ?? resolve(rootDir, "worktrees"), projectId);
  const snapshotsDir = resolve(input.snapshotsBaseDir ?? resolve(rootDir, "snapshots"), projectId);

  return {
    pilotHome,
    projectKey,
    projectId,
    rootDir,
    projectDir,
    stateFile: resolve(projectDir, "state.json"),
    plansDir: resolve(projectDir, "plans"),
    planIndexFile: resolve(projectDir, "plans", "index.json"),
    cyclesDir: resolve(projectDir, "cycles"),
    cycleIndexFile: resolve(projectDir, "cycles", "index.json"),
    reportsDir: resolve(projectDir, "reports"),
    runsDir: resolve(projectDir, "runs"),
    runHistoryFile: resolve(projectDir, "run-history.jsonl"),
    eventsFile: resolve(projectDir, "events.jsonl"),
    locksDir: resolve(projectDir, "locks"),
    discoveryLockFile: resolve(projectDir, "locks", "discovery.lock"),
    worktreesDir,
    snapshotsDir,
  };
}

export function planMarkdownPath(paths: AlwaysOnPaths, planId: string): string {
  return resolve(paths.plansDir, `${sanitizeId(planId)}.md`);
}

export function reportMarkdownPath(paths: AlwaysOnPaths, runId: string): string {
  return resolve(paths.reportsDir, `${sanitizeId(runId)}.md`);
}

export function runEventsPath(paths: AlwaysOnPaths, runId: string): string {
  return resolve(paths.runsDir, `${sanitizeId(runId)}.events.jsonl`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}
