import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { DiscoveryPlanIndex, DiscoveryPlanRecord, DiscoveryPlanStatus } from "../protocol/types.js";
import { planMarkdownPath, type AlwaysOnPaths } from "./AlwaysOnPaths.js";

const DEFAULT_INDEX: DiscoveryPlanIndex = { schemaVersion: 1, plans: [] };

export class DiscoveryPlanStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async readIndex(): Promise<DiscoveryPlanIndex> {
    let raw: string;
    try {
      raw = await readFile(this.paths.planIndexFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return cloneIndex(DEFAULT_INDEX);
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1 && Array.isArray(parsed.plans)) {
        return parsed as DiscoveryPlanIndex;
      }
    } catch {
      // fall through
    }
    return cloneIndex(DEFAULT_INDEX);
  }

  async writeIndex(index: DiscoveryPlanIndex): Promise<void> {
    await mkdir(dirname(this.paths.planIndexFile), { recursive: true });
    await writeFile(this.paths.planIndexFile, JSON.stringify(index, null, 2), "utf-8");
  }

  async writePlanMarkdown(planId: string, markdown: string): Promise<string> {
    const filePath = planMarkdownPath(this.paths, planId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  async readPlanMarkdown(planId: string): Promise<string | undefined> {
    const filePath = planMarkdownPath(this.paths, planId);
    try {
      return await readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async upsert(record: DiscoveryPlanRecord): Promise<DiscoveryPlanRecord> {
    const index = await this.readIndex();
    const existingIndex = index.plans.findIndex((entry) => entry.id === record.id);
    const stored = freezeRecord(toRelativePaths(record, this.paths));
    if (existingIndex >= 0) {
      index.plans[existingIndex] = stored;
    } else {
      index.plans.push(stored);
    }
    await this.writeIndex(index);
    return stored;
  }

  async updateStatus(
    planId: string,
    update: {
      status?: DiscoveryPlanStatus;
      reportFilePath?: string;
      workCycleId?: string;
    },
  ): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    const target = index.plans.find((entry) => entry.id === planId);
    if (!target) return undefined;
    if (update.status !== undefined) {
      target.status = update.status;
      const raw = target as Record<string, unknown>;
      if ("executionStatus" in raw && (update.status === "completed" || update.status === "failed")) {
        raw.executionStatus = update.status;
      }
    }
    if (update.reportFilePath !== undefined) {
      target.reportFilePath = relativeIfInsideRoot(update.reportFilePath, this.paths.projectDir);
    }
    if (update.workCycleId !== undefined) {
      target.workCycleId = update.workCycleId;
      delete target.workspace;
    }
    await this.writeIndex(index);
    return target;
  }

  async getRecord(planId: string): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    return index.plans.find((entry) => entry.id === planId);
  }
}

function cloneIndex(index: DiscoveryPlanIndex): DiscoveryPlanIndex {
  return { schemaVersion: 1, plans: index.plans.map((entry) => ({ ...entry })) };
}

function toRelativePaths(record: DiscoveryPlanRecord, paths: AlwaysOnPaths): DiscoveryPlanRecord {
  return {
    ...record,
    planFilePath: relativeIfInsideRoot(record.planFilePath, paths.projectDir),
    reportFilePath: record.reportFilePath
      ? relativeIfInsideRoot(record.reportFilePath, paths.projectDir)
      : undefined,
  };
}

function relativeIfInsideRoot(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || rel === "") {
    return filePath;
  }
  return rel;
}

function freezeRecord(record: DiscoveryPlanRecord): DiscoveryPlanRecord {
  return { ...record };
}
