import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AlwaysOnDiscoveryState,
  DiscoveryPlanIndex,
  WorkCycleIndex,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "./AlwaysOnPaths.js";

const DEFAULT_INDEX: WorkCycleIndex = { schemaVersion: 1, cycles: [] };

export class WorkCycleStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async readIndex(): Promise<WorkCycleIndex> {
    let raw: string;
    try {
      raw = await readFile(this.paths.cycleIndexFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return cloneIndex(DEFAULT_INDEX);
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.schemaVersion === 1 &&
        Array.isArray(parsed.cycles)
      ) {
        return parsed as WorkCycleIndex;
      }
    } catch {
      // fall through
    }
    return cloneIndex(DEFAULT_INDEX);
  }

  async writeIndex(index: WorkCycleIndex): Promise<void> {
    await mkdir(dirname(this.paths.cycleIndexFile), { recursive: true });
    await writeFile(
      this.paths.cycleIndexFile,
      JSON.stringify(index, null, 2),
      "utf-8",
    );
  }

  async getRecord(cycleId: string): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    return index.cycles.find((c) => c.id === cycleId);
  }

  async getActiveCycle(): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    return index.cycles.find((c) => c.status === "active");
  }

  async create(
    handle: WorkspaceHandle,
    runId: string,
    cycleId: string,
    now: Date,
  ): Promise<WorkCycleRecord> {
    const index = await this.readIndex();
    const record: WorkCycleRecord = {
      id: cycleId,
      projectKey: handle.projectKey,
      status: "active",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      planIds: [],
      createdAt: now.toISOString(),
      createdByRunId: runId,
    };
    index.cycles.push(record);
    await this.writeIndex(index);
    return record;
  }

  async addPlan(cycleId: string, planId: string): Promise<void> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return;
    if (!cycle.planIds.includes(planId)) {
      cycle.planIds.push(planId);
      await this.writeIndex(index);
    }
  }

  /**
   * Lazy migration: if no cycles exist on disk but state.json still has
   * currentWorkspace, create a cycle from the legacy data and associate
   * plans that share the same workspace cwd.
   */
  async migrateFromLegacy(): Promise<WorkCycleRecord | undefined> {
    const existing = await this.readIndex();
    if (existing.cycles.length > 0) return undefined;

    let state: AlwaysOnDiscoveryState | undefined;
    try {
      const raw = await readFile(this.paths.stateFile, "utf-8");
      state = JSON.parse(raw) as AlwaysOnDiscoveryState;
    } catch {
      return undefined;
    }

    const ws = state?.currentWorkspace;
    if (!ws || !existsSync(ws.cwd)) return undefined;

    const cycleId = randomUUID();
    const handle: WorkspaceHandle = {
      runId: ws.runId,
      projectKey: this.paths.projectKey,
      strategy: ws.strategy,
      cwd: ws.cwd,
      metadata: { ...ws.metadata },
    };

    let planIds: string[] = [];
    try {
      const planRaw = await readFile(this.paths.planIndexFile, "utf-8");
      const planIndex = JSON.parse(planRaw) as DiscoveryPlanIndex;
      planIds = planIndex.plans
        .filter((p) => p.workspace?.cwd === ws.cwd)
        .map((p) => p.id);
    } catch {
      // no plans or unreadable — fine
    }

    const record: WorkCycleRecord = {
      id: cycleId,
      projectKey: this.paths.projectKey,
      status: "active",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      planIds,
      createdAt: new Date().toISOString(),
      createdByRunId: ws.runId,
    };
    existing.cycles.push(record);
    await this.writeIndex(existing);

    // Update state.json to replace currentWorkspace with activeWorkCycleId
    try {
      const rawState = await readFile(this.paths.stateFile, "utf-8");
      const stateObj = JSON.parse(rawState);
      stateObj.activeWorkCycleId = cycleId;
      delete stateObj.currentWorkspace;
      await writeFile(this.paths.stateFile, JSON.stringify(stateObj, null, 2), "utf-8");
    } catch {
      // best effort
    }

    // Update plan records to set workCycleId
    if (planIds.length > 0) {
      try {
        const planRaw = await readFile(this.paths.planIndexFile, "utf-8");
        const planIndex = JSON.parse(planRaw) as DiscoveryPlanIndex;
        for (const plan of planIndex.plans) {
          if (planIds.includes(plan.id)) {
            (plan as Record<string, unknown>).workCycleId = cycleId;
            delete (plan as Record<string, unknown>).workspace;
          }
        }
        await writeFile(this.paths.planIndexFile, JSON.stringify(planIndex, null, 2), "utf-8");
      } catch {
        // best effort
      }
    }

    return record;
  }

  async updateStatus(
    cycleId: string,
    status: WorkCycleStatus,
    now: Date,
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;
    cycle.status = status;
    if (status === "applied") cycle.appliedAt = now.toISOString();
    if (status === "archived") cycle.archivedAt = now.toISOString();
    await this.writeIndex(index);
    return cycle;
  }
}

function cloneIndex(index: WorkCycleIndex): WorkCycleIndex {
  return {
    schemaVersion: 1,
    cycles: index.cycles.map((c) => ({ ...c, planIds: [...c.planIds] })),
  };
}
