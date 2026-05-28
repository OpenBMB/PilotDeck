/**
 * Discovery plan lifecycle service.
 *
 * Extracted from `ui/server/discovery-plans.js`. Owns:
 *   - plan store read/write/normalize
 *   - queue / update / archive operations (with guards)
 *   - run event + log emission
 *   - overview building
 *
 * Depends on injectable I/O adapters so tests can substitute stubs.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  sortDiscoveryPlans,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
  type WebPlanContextRefs,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// Re-export so callers only need one import for the full service.
export {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_VERSION = 1;
const STRUCTURE_VERSION = 1;

type PlanIndex = {
  version: number;
  plans: WebPlanRecord[];
};

const EMPTY_STORE: PlanIndex = { version: INDEX_VERSION, plans: [] };

// ---------------------------------------------------------------------------
// Dependencies — callers inject these so the service stays testable
// ---------------------------------------------------------------------------

/** Emits run-history events + run log lines. */
export type RunEventSink = {
  appendRunEvent(
    projectRoot: string,
    event: Record<string, unknown>,
  ): Promise<unknown>;
  appendRunLog(
    projectRoot: string,
    runId: string,
    lines: string[],
  ): Promise<void>;
  appendRunLogEvent(
    projectRoot: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  formatLogLine(entry: Record<string, unknown>): string;
};

export type ProjectPathResolver = {
  /** Resolve a display-name / encoded project name to the absolute root. */
  extractProjectDirectory(projectName: string): Promise<string>;
};

export type SessionActivityChecker = {
  isSessionActive(sessionId: string): boolean;
};

export type SessionLister = {
  getSessions(
    projectName: string,
    limit: number,
    offset: number,
  ): Promise<{ sessions: Array<Record<string, unknown>> }>;
};

export type WorkspaceManager = {
  applyWorktreeChanges(
    workspaceCwd: string,
    projectRoot: string,
  ): Promise<{ applied: boolean; diff?: string; error?: string }>;
  disposeWorkspace(
    strategy: string,
    cwd: string,
    projectRoot: string,
  ): Promise<void>;
};

export type DiscoveryPlanServiceDeps = {
  pilotHome: string;
  createProjectId: (projectRoot: string) => string;
  paths: ProjectPathResolver;
  sessions: SessionLister;
  activity: SessionActivityChecker;
  events: RunEventSink;
  workspace?: WorkspaceManager;
};

// ---------------------------------------------------------------------------
// Paths (mirrors ui/server/discovery-plans.js helpers)
// ---------------------------------------------------------------------------

function resolveProjectDir(pilotHome: string, createProjectId: (root: string) => string, projectRoot: string): string {
  const projectId = createProjectId(resolve(projectRoot));
  return join(pilotHome, "always-on", "projects", projectId);
}

function indexPath(projectDir: string): string {
  return join(projectDir, "plans", "index.json");
}

function planMarkdownDir(projectDir: string): string {
  return join(projectDir, "plans");
}

function relativePlanPath(planId: string): string {
  return join("plans", `${planId}.md`);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function createEmptyContextRefs(): WebPlanContextRefs {
  return {
    workingDirectory: [],
    memory: [],
    existingPlans: [],
    cronJobs: [],
    recentChats: [],
  };
}

export function normalizeDiscoveryPlanRecord(record: Record<string, unknown> | null | undefined): WebPlanRecord {
  const now = new Date().toISOString();
  const rawContextRefs =
    record?.contextRefs && typeof record.contextRefs === "object" && !Array.isArray(record.contextRefs)
      ? (record.contextRefs as Record<string, unknown>)
      : null;
  const contextRefs: WebPlanContextRefs = rawContextRefs
    ? {
        workingDirectory: normalizeStringList(rawContextRefs.workingDirectory),
        memory: normalizeStringList(rawContextRefs.memory),
        existingPlans: normalizeStringList(rawContextRefs.existingPlans),
        cronJobs: normalizeStringList(rawContextRefs.cronJobs),
        recentChats: normalizeStringList(rawContextRefs.recentChats),
      }
    : createEmptyContextRefs();

  const fallbackId = `plan-${randomUUID().slice(0, 8)}`;
  const id = normalizeString(record?.id, fallbackId);
  const sourceId = normalizeString(
    (record?.sourceDiscoverySessionId as string) || (record?.sourceRunId as string),
  );
  const gatewayStatus = normalizeString(record?.status, "ready");
  const mappedStatus =
    gatewayStatus === "executing" ? "running" :
    gatewayStatus === "superseded" ? "archived" :
    gatewayStatus === "applying" ? "completed" :
    gatewayStatus === "applied" ? "archived" :
    gatewayStatus === "apply_failed" ? "completed" :
    gatewayStatus;

  return {
    id,
    title: normalizeString(record?.title, "Untitled discovery plan"),
    createdAt: toIsoTimestamp(record?.createdAt as string) || now,
    updatedAt: toIsoTimestamp((record?.updatedAt as string) || (record?.createdAt as string)) || now,
    status: mappedStatus,
    summary: normalizeString(record?.summary),
    rationale: normalizeString(record?.rationale),
    dedupeKey: normalizeString(record?.dedupeKey, id),
    sourceDiscoverySessionId: sourceId,
    executionSessionId: normalizeString(record?.executionSessionId),
    executionStartedAt: toIsoTimestamp(record?.executionStartedAt as string),
    executionLastActivityAt: toIsoTimestamp(record?.executionLastActivityAt as string),
    executionStatus: normalizeString(record?.executionStatus),
    latestSummary: normalizeString(record?.latestSummary),
    contextRefs,
    planFilePath: normalizeString(record?.planFilePath, relativePlanPath(id)),
    reportFilePath: normalizeString(record?.reportFilePath) || undefined,
    structureVersion:
      typeof record?.structureVersion === "number" ? record.structureVersion : STRUCTURE_VERSION,
    workCycleId: normalizeString(record?.workCycleId) || undefined,
    workspace: normalizeWorkspaceRef(record?.workspace),
  };
}

function normalizeWorkspaceRef(
  raw: unknown,
): { strategy: string; cwd: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const strategy = typeof obj.strategy === "string" ? obj.strategy : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
  if (!strategy || !cwd) return undefined;
  return { strategy, cwd };
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

async function readPlanStore(projectDir: string): Promise<PlanIndex> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.plans)) {
      return { ...EMPTY_STORE };
    }
    const version =
      typeof parsed.schemaVersion === "number"
        ? parsed.schemaVersion
        : typeof parsed.version === "number"
          ? parsed.version
          : INDEX_VERSION;
    return {
      version,
      plans: (parsed.plans as unknown[]).map((p) => normalizeDiscoveryPlanRecord(p as Record<string, unknown>)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...EMPTY_STORE };
    }
    throw error;
  }
}

async function writePlanStore(projectDir: string, store: PlanIndex): Promise<void> {
  await fs.mkdir(planMarkdownDir(projectDir), { recursive: true });
  await fs.writeFile(
    indexPath(projectDir),
    `${JSON.stringify({ schemaVersion: INDEX_VERSION, plans: store.plans }, null, 2)}\n`,
    "utf8",
  );
}

async function readPlanBody(projectDir: string, planFilePath: string): Promise<string> {
  const absolutePath = isAbsolute(planFilePath) ? planFilePath : resolve(projectDir, planFilePath);
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

async function readRawPlanRecord(projectDir: string, planId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.plans)) return null;
    return (parsed.plans as Record<string, unknown>[]).find((p) => p.id === planId) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Overview building
// ---------------------------------------------------------------------------

function buildOverview(
  plan: WebPlanRecord,
  content: string,
  session: WebPlanSession,
  isSessionActive: (id: string) => boolean,
) {
  const status = computePlanStatus(plan, session, isSessionActive);
  const latestSummary = normalizeString(
    session?.lastAssistantMessage || session?.summary || session?.title || plan.latestSummary,
  );
  return {
    ...plan,
    status,
    executionStatus: computeExecutionStatus(plan, session, isSessionActive) || undefined,
    executionStartedAt:
      pickLatestIsoTimestamp(plan.executionStartedAt, session?.createdAt, session?.created_at) || undefined,
    executionLastActivityAt:
      pickLatestIsoTimestamp(plan.executionLastActivityAt, session?.lastActivity, session?.updated_at) || undefined,
    latestSummary: latestSummary || undefined,
    workspace: plan.workspace,
    content: content.trim(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DiscoveryPlanService {
  private readonly deps: DiscoveryPlanServiceDeps;

  constructor(deps: DiscoveryPlanServiceDeps) {
    this.deps = deps;
  }

  private projectDir(projectRoot: string): string {
    return resolveProjectDir(this.deps.pilotHome, this.deps.createProjectId, projectRoot);
  }

  async getPlansOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    if (store.plans.length === 0) return { plans: [] };

    const sessionResult = await this.deps.sessions
      .getSessions(projectName, Number.MAX_SAFE_INTEGER, 0)
      .catch(() => ({ sessions: [] }));
    const sessionsById = new Map<string, Record<string, unknown>>();
    if (Array.isArray(sessionResult?.sessions)) {
      for (const s of sessionResult.sessions) {
        if (s.id) sessionsById.set(s.id as string, s);
      }
    }

    const isActive = (id: string) => this.deps.activity.isSessionActive(id);

    const cycleIndex = await readCycleIndex(projectDir);
    const cycleWorkspaceMap = new Map(cycleIndex.cycles.map((c) => [c.id, c.workspace]));

    const plans = await Promise.all(
      store.plans.map(async (plan) => {
        const body = await readPlanBody(projectDir, plan.planFilePath);
        const session = plan.executionSessionId
          ? (sessionsById.get(plan.executionSessionId) as WebPlanSession) || null
          : null;
        const overview = buildOverview(plan, body, session, isActive);
        if (!overview.workspace && plan.workCycleId) {
          overview.workspace = cycleWorkspaceMap.get(plan.workCycleId);
        }
        return overview;
      }),
    );

    return { plans: sortDiscoveryPlans(plans) };
  }

  /**
   * Archive an entire work cycle: dispose its workspace and mark all
   * associated plans as archived.
   */
  async archiveCycle(projectName: string, cycleId: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    if (cycle.status === "applying") {
      throw makeError("Cannot archive a cycle that is currently being applied", "INVALID_STATE");
    }

    if (cycle.workspace?.cwd && this.deps.workspace) {
      try {
        await this.deps.workspace.disposeWorkspace(
          cycle.workspace.strategy,
          cycle.workspace.cwd,
          projectRoot,
        );
      } catch {
        // Best effort — workspace may already be gone.
      }
    }

    cycle.status = "archived";
    cycle.archivedAt = new Date().toISOString();
    await writeCycleIndex(projectDir, cycleIndex);

    const store = await readPlanStore(projectDir);
    const now = new Date().toISOString();
    for (const plan of store.plans) {
      if (cycle.planIds.includes(plan.id) && plan.status !== "archived") {
        plan.status = "archived";
        plan.updatedAt = now;
      }
    }
    await writePlanStore(projectDir, store);

    return { archived: true };
  }

  /**
   * Mark a cycle as "applying" and return its metadata. The actual apply
   * agent loop is triggered via `gateway.alwaysOnApply` — the caller
   * (discovery-plans.js) fires that RPC after this method returns.
   */
  async queueCycleApply(projectName: string, cycleId: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    if (cycle.status !== "active") {
      throw makeError(
        `Cycle must be in active status to apply (current: ${cycle.status})`,
        "INVALID_STATE",
      );
    }

    if (!cycle.workspace?.cwd) {
      throw makeError(
        "Cycle has no associated workspace to apply",
        "MISSING_WORKSPACE",
      );
    }

    const store = await readPlanStore(projectDir);
    const cyclePlans = store.plans.filter((p) => cycle.planIds.includes(p.id));
    const hasCompleted = cyclePlans.some((p) => p.status === "completed");
    if (!hasCompleted) {
      throw makeError("Cycle has no completed plans to apply", "INVALID_STATE");
    }

    cycle.status = "applying";
    await writeCycleIndex(projectDir, cycleIndex);

    const now = new Date().toISOString();
    const executionToken = randomUUID();

    await this.deps.events.appendRunEvent(projectRoot, {
      runId: executionToken,
      kind: "cycle-apply",
      sourceId: cycle.id,
      title: `Apply cycle: ${cyclePlans.map((p) => p.title).join(", ")}`,
      status: "queued",
      timestamp: now,
      startedAt: now,
      metadata: { cycleId: cycle.id, source: "apply" },
    });

    return {
      cycle,
      projectRoot,
      executionToken,
    };
  }

  /**
   * Finalize a cycle apply — called after the gateway apply RPC completes.
   */
  async updateCycleExecution(
    projectName: string,
    cycleId: string,
    updates: { status: string; executionSessionId?: string; executionToken?: string },
  ) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    const normalizedStatus = updates.status;
    const now = new Date().toISOString();

    if (cycle.status === "applying") {
      const finalStatus = normalizedStatus === "completed" ? "applied" : "active";

      if (finalStatus === "applied" && cycle.workspace?.cwd && this.deps.workspace) {
        try {
          await this.deps.workspace.disposeWorkspace(
            cycle.workspace.strategy,
            cycle.workspace.cwd,
            projectRoot,
          );
        } catch {
          // Best effort cleanup.
        }
      }

      cycle.status = finalStatus;
      if (finalStatus === "applied") cycle.appliedAt = now;
      await writeCycleIndex(projectDir, cycleIndex);

      if (finalStatus === "applied") {
        const store = await readPlanStore(projectDir);
        for (const plan of store.plans) {
          if (cycle.planIds.includes(plan.id) && plan.status !== "archived") {
            plan.status = "archived";
            plan.updatedAt = now;
          }
        }
        await writePlanStore(projectDir, store);
      }
    }

    return { cycle };
  }

  /**
   * Read cycle records for a project.
   */
  async getCyclesOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    return { cycles: cycleIndex.cycles };
  }

  /**
   * Read a plan's report markdown by planId.
   * Returns the raw markdown string (empty if no report exists yet).
   */
  async readReport(projectName: string, planId: string): Promise<{ content: string }> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);

    const rawRecord = await readRawPlanRecord(projectDir, planId);
    if (!rawRecord) throw makeError("Discovery plan not found", "NOT_FOUND");

    let reportPath = typeof rawRecord.reportFilePath === "string" ? rawRecord.reportFilePath : "";

    if (!reportPath) {
      const runId =
        typeof rawRecord.sourceDiscoverySessionId === "string" ? rawRecord.sourceDiscoverySessionId
        : typeof rawRecord.sourceRunId === "string" ? rawRecord.sourceRunId
        : "";
      if (runId) {
        const inferred = join("reports", `${runId}.md`);
        const inferredContent = await readPlanBody(projectDir, inferred);
        if (inferredContent) return { content: inferredContent };
      }
      return { content: "" };
    }

    const content = await readPlanBody(projectDir, reportPath);
    return { content };
  }

  /**
   * Low-level store reader — used by context aggregation.
   */
  async readStore(projectName: string): Promise<PlanIndex> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    return readPlanStore(this.projectDir(projectRoot));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cycle store I/O
// ---------------------------------------------------------------------------

type CycleIndex = {
  schemaVersion: number;
  cycles: Array<{
    id: string;
    projectKey: string;
    status: string;
    workspace: { strategy: string; cwd: string; metadata?: Record<string, string> };
    planIds: string[];
    createdAt: string;
    createdByRunId?: string;
    appliedAt?: string;
    archivedAt?: string;
  }>;
};

const EMPTY_CYCLE_INDEX: CycleIndex = { schemaVersion: 1, cycles: [] };

async function readCycleIndex(projectDir: string): Promise<CycleIndex> {
  const filePath = join(projectDir, "cycles", "index.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.cycles)) {
      return parsed as CycleIndex;
    }
    return { ...EMPTY_CYCLE_INDEX };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...EMPTY_CYCLE_INDEX };
    }
    throw error;
  }
}

async function writeCycleIndex(projectDir: string, index: CycleIndex): Promise<void> {
  const dir = join(projectDir, "cycles");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, "index.json"),
    `${JSON.stringify({ schemaVersion: 1, cycles: index.cycles }, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function makeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
