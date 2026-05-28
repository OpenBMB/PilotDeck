import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AlwaysOnCurrentWorkspaceRef,
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  WorkspaceStrategyId,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "./AlwaysOnPaths.js";

export function getDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultDiscoveryState(now: Date): AlwaysOnDiscoveryState {
  return {
    schemaVersion: 1,
    todayKey: getDayKey(now),
    todayRunCount: 0,
    consecutiveFailures: 0,
  };
}

export class DiscoveryStateStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async read(now: Date): Promise<AlwaysOnDiscoveryState> {
    let raw: string;
    try {
      raw = await readFile(this.paths.stateFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultDiscoveryState(now);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultDiscoveryState(now);
    }
    return resetDailyBudgetIfNeeded(normalizeState(parsed, now), now);
  }

  async write(state: AlwaysOnDiscoveryState): Promise<void> {
    await mkdir(dirname(this.paths.stateFile), { recursive: true });
    await writeFile(this.paths.stateFile, JSON.stringify(state, null, 2), "utf-8");
  }

  async markFireStarted(runId: string, now: Date): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(now);
    const next: AlwaysOnDiscoveryState = {
      ...current,
      lastFireStartedAt: now.toISOString(),
      lastRunId: runId,
      todayKey: getDayKey(now),
      todayRunCount: current.todayRunCount + 1,
    };
    await this.write(next);
    return next;
  }

  async markFireCompleted(input: {
    outcome: AlwaysOnDiscoveryOutcome;
    runId: string;
    planId?: string;
    now: Date;
  }): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(input.now);
    const next: AlwaysOnDiscoveryState = {
      ...current,
      lastFireCompletedAt: input.now.toISOString(),
      lastFireOutcome: input.outcome,
      lastRunId: input.runId,
      lastPlanId: input.planId,
      consecutiveFailures: input.outcome === "failed" ? current.consecutiveFailures + 1 : 0,
    };
    await this.write(next);
    return next;
  }

  async setActiveWorkCycleId(cycleId: string, now: Date): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(now);
    const next: AlwaysOnDiscoveryState = {
      ...current,
      activeWorkCycleId: cycleId,
    };
    delete next.currentWorkspace;
    await this.write(next);
    return next;
  }

  async clearActiveWorkCycleId(now: Date): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(now);
    if (!current.activeWorkCycleId) {
      return current;
    }
    const next: AlwaysOnDiscoveryState = { ...current };
    delete next.activeWorkCycleId;
    await this.write(next);
    return next;
  }

  async setDormant(now: Date): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(now);
    const next: AlwaysOnDiscoveryState = {
      ...current,
      dormant: {
        since: now.toISOString(),
        lastBaselineAt: now.toISOString(),
      },
    };
    await this.write(next);
    return next;
  }

  async clearDormant(now: Date): Promise<AlwaysOnDiscoveryState> {
    const current = await this.read(now);
    if (!current.dormant) {
      return current;
    }
    const next: AlwaysOnDiscoveryState = { ...current };
    delete next.dormant;
    await this.write(next);
    return next;
  }
}

function normalizeState(value: unknown, now: Date): AlwaysOnDiscoveryState {
  if (!value || typeof value !== "object") {
    return defaultDiscoveryState(now);
  }
  const candidate = value as Partial<AlwaysOnDiscoveryState> & Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    return defaultDiscoveryState(now);
  }
  return {
    schemaVersion: 1,
    lastFireStartedAt: typeof candidate.lastFireStartedAt === "string" ? candidate.lastFireStartedAt : undefined,
    lastFireCompletedAt:
      typeof candidate.lastFireCompletedAt === "string" ? candidate.lastFireCompletedAt : undefined,
    lastFireOutcome: normalizeOutcome(candidate.lastFireOutcome),
    lastPlanId: typeof candidate.lastPlanId === "string" ? candidate.lastPlanId : undefined,
    lastRunId: typeof candidate.lastRunId === "string" ? candidate.lastRunId : undefined,
    todayKey: typeof candidate.todayKey === "string" ? candidate.todayKey : getDayKey(now),
    todayRunCount:
      typeof candidate.todayRunCount === "number" && candidate.todayRunCount >= 0
        ? candidate.todayRunCount
        : 0,
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && candidate.consecutiveFailures >= 0
        ? candidate.consecutiveFailures
        : 0,
    dormant: normalizeDormant(candidate.dormant),
    activeWorkCycleId: typeof candidate.activeWorkCycleId === "string" ? candidate.activeWorkCycleId : undefined,
    currentWorkspace: normalizeCurrentWorkspace(candidate.currentWorkspace),
  };
}

function normalizeCurrentWorkspace(value: unknown): AlwaysOnCurrentWorkspaceRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const runId = typeof candidate.runId === "string" ? candidate.runId : undefined;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd : undefined;
  const strategy = normalizeWorkspaceStrategy(candidate.strategy);
  if (!runId || !cwd || !strategy) return undefined;
  const rawMeta = candidate.metadata;
  const metadata: Record<string, string> = {};
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    for (const [key, val] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (typeof val === "string") metadata[key] = val;
    }
  }
  return { runId, cwd, strategy, metadata };
}

function normalizeWorkspaceStrategy(value: unknown): WorkspaceStrategyId | undefined {
  if (value === "git-worktree" || value === "snapshot-copy") return value;
  return undefined;
}

function normalizeOutcome(value: unknown): AlwaysOnDiscoveryState["lastFireOutcome"] {
  if (
    value === "executed" ||
    value === "no_plan" ||
    value === "failed" ||
    value === "aborted"
  ) {
    return value;
  }
  return undefined;
}

function normalizeDormant(value: unknown): AlwaysOnDiscoveryState["dormant"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const dormant = value as Record<string, unknown>;
  if (typeof dormant.since !== "string" || typeof dormant.lastBaselineAt !== "string") {
    return undefined;
  }
  return {
    since: dormant.since,
    lastBaselineAt: dormant.lastBaselineAt,
    lastChangeAt: typeof dormant.lastChangeAt === "string" ? dormant.lastChangeAt : undefined,
  };
}

function resetDailyBudgetIfNeeded(
  state: AlwaysOnDiscoveryState,
  now: Date,
): AlwaysOnDiscoveryState {
  const today = getDayKey(now);
  if (state.todayKey === today) {
    return state;
  }
  return { ...state, todayKey: today, todayRunCount: 0 };
}
