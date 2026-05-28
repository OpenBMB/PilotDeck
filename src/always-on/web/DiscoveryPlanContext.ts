/**
 * Discovery context aggregation.
 *
 * Extracted from `ui/server/discovery-plans.js`
 * `getProjectDiscoveryContext`. Collects workspace signals (git),
 * memory file summaries, existing plans, cron job overviews, and
 * recent chat sessions into a single snapshot consumed by the
 * Always-On discovery phase.
 *
 * All I/O is injectable so tests can substitute stubs.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  normalizeString,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
} from "./DiscoveryPlanStatus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 7;
const MAX_ITEMS = 8;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type DiscoveryContextDeps = {
  projectName: string;
  projectRoot: string;
  getProjectCronJobsOverview: (
    projectName: string,
  ) => Promise<{ jobs: CronJobOverview[] }>;
  getSessions: (
    projectName: string,
    limit: number,
    offset: number,
  ) => Promise<{ sessions: SessionRecord[] }>;
  extractProjectDirectory: (name: string) => Promise<string>;
};

type CronJobOverview = {
  id: string;
  status: string;
  cron: string;
  recurring: boolean;
  manualOnly: boolean;
  prompt: string;
  latestRun?: { summary?: string } | null;
};

type SessionRecord = Record<string, unknown> & {
  id?: string;
  sessionKind?: string;
  lastActivity?: string;
  updated_at?: string;
  createdAt?: string;
  created_at?: string;
  summary?: string;
  title?: string;
  name?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function buildDiscoveryContext(deps: DiscoveryContextDeps) {
  const { projectName, projectRoot } = deps;
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const [workspaceSignals, cronOverview, sessionResult] = await Promise.all([
    collectWorkspaceSignals(projectRoot),
    deps.getProjectCronJobsOverview(projectName).catch(() => ({ jobs: [] as CronJobOverview[] })),
    deps.getSessions(projectName, Number.MAX_SAFE_INTEGER, 0).catch(() => ({ sessions: [] as SessionRecord[] })),
  ]);

  const recentChats = Array.isArray(sessionResult?.sessions)
    ? sessionResult.sessions
        .filter((s) => s?.sessionKind !== "background_task")
        .filter(
          (s) =>
            (toTimestampValue(s?.lastActivity || s?.updated_at || s?.createdAt || s?.created_at) ?? 0) >= cutoff,
        )
        .sort(
          (a, b) =>
            (toTimestampValue(b?.lastActivity || b?.updated_at || b?.createdAt || b?.created_at) ?? 0) -
            (toTimestampValue(a?.lastActivity || a?.updated_at || a?.createdAt || a?.created_at) ?? 0),
        )
        .slice(0, MAX_ITEMS)
        .map(buildRecentChatEntry)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    workspace: { projectName, projectRoot, signals: workspaceSignals },
    memory: [],
    existingPlans: [] as unknown[],
    cronJobs: Array.isArray(cronOverview?.jobs)
      ? cronOverview.jobs.slice(0, MAX_ITEMS).map(buildCronContextItem)
      : [],
    recentChats,
  };
}

// ---------------------------------------------------------------------------
// Workspace signal collection
// ---------------------------------------------------------------------------

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => done(""));
    child.on("close", (code) => done(code === 0 ? stdout.trim() : ""));
  });
}

async function collectWorkspaceSignals(projectRoot: string): Promise<string[]> {
  const [gitStatus, recentCommit] = await Promise.all([
    runCommand("git", ["-C", projectRoot, "status", "--short"], projectRoot),
    runCommand(
      "git",
      ["-C", projectRoot, "log", "-1", "--stat", "--oneline", "--decorate=no"],
      projectRoot,
    ),
  ]);

  const signals: string[] = [];
  signals.push(`Project root: ${projectRoot}`);
  if (gitStatus) {
    signals.push(`Git status:\n${gitStatus.split("\n").slice(0, 20).join("\n")}`);
  }
  if (recentCommit) {
    signals.push(`Latest commit:\n${recentCommit.split("\n").slice(0, 12).join("\n")}`);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Memory signal collection
// ---------------------------------------------------------------------------

async function walkDirectory(rootDir: string, visit: (path: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") return;
        await walkDirectory(entryPath, visit);
        return;
      }
      if (entry.isFile()) await visit(entryPath);
    }),
  );
}

async function collectMemorySignals(projectName: string) {
  const projectStoreDir = join(homedir(), ".pilotdeck", "projects", projectName);
  const candidates: { entryPath: string; modifiedAt: string }[] = [];

  await walkDirectory(projectStoreDir, async (entryPath) => {
    const normalized = entryPath.replace(/\\/g, "/");
    const isSessionMemorySummary = normalized.endsWith("/session-memory/summary.md");
    const isAutoMemoryFile = normalized.includes("/memory/") && normalized.endsWith(".md");
    if (!isSessionMemorySummary && !isAutoMemoryFile) return;

    try {
      const stats = await fs.stat(entryPath);
      candidates.push({ entryPath, modifiedAt: stats.mtime.toISOString() });
    } catch {
      // transient file
    }
  });

  candidates.sort(
    (a, b) => (toTimestampValue(b.modifiedAt) ?? 0) - (toTimestampValue(a.modifiedAt) ?? 0),
  );

  const selected = candidates.slice(0, MAX_ITEMS);
  return Promise.all(
    selected.map(async (candidate) => {
      const raw = await fs.readFile(candidate.entryPath, "utf8").catch(() => "");
      return {
        path: relative(projectStoreDir, candidate.entryPath).replace(/\\/g, "/"),
        modifiedAt: candidate.modifiedAt,
        summary: truncateText(raw, 280),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

function summarizeSession(session: SessionRecord | null | undefined): string {
  const summary = normalizeString(
    session?.summary || session?.title || session?.name || session?.lastUserMessage || session?.lastAssistantMessage,
  );
  return truncateText(summary, 200);
}

function buildRecentChatEntry(session: SessionRecord) {
  return {
    id: session.id,
    summary: summarizeSession(session),
    lastActivity: toIsoTimestamp(
      session.lastActivity || session.updated_at || session.createdAt || session.created_at,
    ),
    lastUserMessage: truncateText(session.lastUserMessage, 220),
    lastAssistantMessage: truncateText(session.lastAssistantMessage, 220),
  };
}

function buildCronContextItem(job: CronJobOverview) {
  return {
    id: job.id,
    status: job.status,
    cron: job.cron,
    recurring: Boolean(job.recurring),
    manualOnly: Boolean(job.manualOnly),
    prompt: truncateText(job.prompt, 180),
    latestRunSummary: truncateText(job.latestRun?.summary, 180),
  };
}
