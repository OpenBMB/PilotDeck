/**
 * On-disk persistence for Evo.
 *
 * Workspace layout (under `~/.pilotdeck/evo/`):
 *   evo/policy.json            — { [projectKey]: EvoPolicyMode }
 *   evo/runs/<runId>.json      — one EvoRun per file
 *
 * Runs are stored globally (not per project) so a single Evo dashboard can list
 * every run; each run carries its own `projectKey`. Harness candidate config is
 * written by `EvoManager` under `<project>/.pilotdeck/evo/harness/`.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { EvoPolicyMode, EvoRun } from "./protocol/types.js";
import { DEFAULT_EVO_POLICY } from "./protocol/types.js";

type PolicyMap = Record<string, EvoPolicyMode>;

export class EvoStore {
  private readonly evoRoot: string;
  private readonly runsDir: string;
  private readonly policyFile: string;

  constructor(pilotHome: string) {
    this.evoRoot = resolve(pilotHome, "evo");
    this.runsDir = join(this.evoRoot, "runs");
    this.policyFile = join(this.evoRoot, "policy.json");
  }

  private policyKey(projectKey: string | null | undefined): string {
    return projectKey ? resolve(projectKey) : "__user__";
  }

  async getPolicy(projectKey: string | null | undefined): Promise<EvoPolicyMode> {
    const map = await this.readPolicyMap();
    return map[this.policyKey(projectKey)] ?? DEFAULT_EVO_POLICY;
  }

  async setPolicy(projectKey: string | null | undefined, mode: EvoPolicyMode): Promise<void> {
    const map = await this.readPolicyMap();
    map[this.policyKey(projectKey)] = mode;
    await fs.mkdir(this.evoRoot, { recursive: true });
    await fs.writeFile(this.policyFile, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }

  private async readPolicyMap(): Promise<PolicyMap> {
    try {
      const raw = await fs.readFile(this.policyFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as PolicyMap;
      }
    } catch {
      /* missing or malformed — start fresh */
    }
    return {};
  }

  async saveRun(run: EvoRun): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.writeFile(
      join(this.runsDir, `${run.runId}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8",
    );
  }

  async getRun(runId: string): Promise<EvoRun | null> {
    try {
      const raw = await fs.readFile(join(this.runsDir, `${sanitizeRunId(runId)}.json`), "utf8");
      return JSON.parse(raw) as EvoRun;
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<EvoRun[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.runsDir);
    } catch {
      return [];
    }
    const runs: EvoRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(join(this.runsDir, name), "utf8");
        runs.push(JSON.parse(raw) as EvoRun);
      } catch {
        /* skip unreadable */
      }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "");
}
