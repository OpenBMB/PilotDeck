import * as fs from "node:fs";
import * as path from "node:path";
import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import { resolvePilotHome } from "../../pilot/paths.js";
import type { RouterDecision } from "../protocol/decision.js";
import { lookupModelPricing } from "../utils/modelPricing.js";

export type RouterStatsRecord = {
  sessionId: string;
  turnId?: string;
  projectPath?: string;
  scenarioType: RouterDecision["scenarioType"];
  resolvedFrom: RouterDecision["resolvedFrom"];
  provider: string;
  model: string;
  tier?: string;
  role?: "main" | "subagent";
  usage: CanonicalUsage;
  cost?: { input: number; output: number; cacheRead: number; total: number };
  baselineCost?: number;
  startedAt: string;
  endedAt: string;
};

export type RouterStatsAggregate = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavedCost: number;
  perScenario: Record<string, number>;
  perModel: Record<string, number>;
  perProvider: Record<string, number>;
  perTier: Record<string, number>;
  perRole: Record<string, number>;
};

type HourlyBucket = RouterStatsAggregate & { hour: string };

type SessionBucket = {
  sessionId: string;
  aggregate: RouterStatsAggregate;
  requestLog: RouterStatsRecord[];
};

type PersistedData = {
  hourly: Record<string, HourlyBucket>;
  sessions: Record<string, SessionBucket>;
  global: RouterStatsAggregate;
};

const MAX_HOURLY_BUCKETS = 72;
const MAX_SESSIONS = 200;

export class TokenStatsCollector {
  private readonly enabled: boolean;
  private readonly jsonlPath: string | undefined;
  private readonly modelPricing: RouterStatsConfig["modelPricing"];
  private readonly baselineModel: RouterStatsConfig["baselineModel"];
  private data: PersistedData;
  private recentRecords: RouterStatsRecord[] = [];
  private fd: number | undefined;

  constructor(config: RouterStatsConfig | undefined) {
    this.enabled = config?.enabled ?? false;
    this.modelPricing = config?.modelPricing;
    this.baselineModel = config?.baselineModel;

    if (this.enabled) {
      const routerDir = config?.filePath
        ? path.dirname(config.filePath)
        : path.join(resolvePilotHome(), "router");
      try { fs.mkdirSync(routerDir, { recursive: true }); } catch { /* ok */ }

      this.jsonlPath = path.join(routerDir, "stats.jsonl");

      // One-time migration: old JSON formats → JSONL
      migrateJsonToJsonl(routerDir, this.jsonlPath);

      this.data = this.rebuildFromJsonl();

      // Keep the file open for appends so multiple collector instances
      // (one per project runtime) safely share the same file via O_APPEND.
      try {
        this.fd = fs.openSync(this.jsonlPath, "a");
      } catch { /* will fall back to per-write open */ }
    } else {
      this.data = createPersistedData();
    }
  }

  observe(record: RouterStatsRecord): void {
    if (!this.enabled) return;

    if (record.usage.nativeCost != null && record.usage.nativeCost > 0) {
      record.cost = { input: 0, output: 0, cacheRead: 0, total: record.usage.nativeCost };
    } else {
      record.cost = this.calculateCost(record.usage, record.provider, record.model);
    }

    record.baselineCost = this.calculateBaselineCostForRecord(record.usage, record.provider, record.model) ?? record.cost!.total;

    this.recentRecords.push(record);
    if (this.recentRecords.length > 500) {
      this.recentRecords = this.recentRecords.slice(-250);
    }

    // Update in-memory aggregates
    bumpAggregate(this.data.global, record);

    const hour = record.startedAt.slice(0, 13);
    if (!this.data.hourly[hour]) {
      this.data.hourly[hour] = { ...createAggregate(), hour };
    }
    bumpAggregate(this.data.hourly[hour]!, record);
    this.pruneHourly();

    if (!this.data.sessions[record.sessionId]) {
      this.data.sessions[record.sessionId] = {
        sessionId: record.sessionId,
        aggregate: createAggregate(),
        requestLog: [],
      };
    }
    const sess = this.data.sessions[record.sessionId]!;
    bumpAggregate(sess.aggregate, record);
    sess.requestLog.push(record);
    if (sess.requestLog.length > 200) {
      sess.requestLog = sess.requestLog.slice(-100);
    }
    this.pruneSessions();

    // Append immediately — no batching needed; O_APPEND is atomic for
    // small writes on Linux/macOS so concurrent collectors are safe.
    this.appendRecord(record);
  }

  snapshot(): RouterStatsAggregate {
    return copyAggregate(this.data.global);
  }

  hourlySnapshots(): HourlyBucket[] {
    return Object.values(this.data.hourly).sort((a, b) => a.hour.localeCompare(b.hour));
  }

  sessionSnapshot(sessionId: string): SessionBucket | undefined {
    return this.data.sessions[sessionId];
  }

  recent(limit = 50): RouterStatsRecord[] {
    if (this.recentRecords.length > 0) {
      return this.recentRecords.slice(-limit);
    }
    const allLogs: RouterStatsRecord[] = [];
    for (const sess of Object.values(this.data.sessions)) {
      allLogs.push(...sess.requestLog);
    }
    allLogs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return allLogs.slice(-limit);
  }

  async flush(): Promise<void> {
    // With JSONL append-only writes, there is nothing to batch-flush.
    // This method is kept for API compatibility (called by shutdown).
  }

  clear(): void {
    this.data = createPersistedData();
    this.recentRecords = [];
    if (this.jsonlPath) {
      try { fs.writeFileSync(this.jsonlPath, "", "utf-8"); } catch { /* ok */ }
    }
  }

  dispose(): void {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* ok */ }
      this.fd = undefined;
    }
  }

  // ── JSONL persistence ──────────────────────────────────────────────

  private appendRecord(record: RouterStatsRecord): void {
    const line = JSON.stringify(record) + "\n";
    try {
      if (this.fd !== undefined) {
        fs.writeSync(this.fd, line);
      } else if (this.jsonlPath) {
        fs.appendFileSync(this.jsonlPath, line, "utf-8");
      }
    } catch { /* best-effort */ }
  }

  private rebuildFromJsonl(): PersistedData {
    const data = createPersistedData();
    if (!this.jsonlPath) return data;
    let raw: string;
    try {
      raw = fs.readFileSync(this.jsonlPath, "utf-8");
    } catch {
      return data;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as RouterStatsRecord;
        if (!record.sessionId || !record.startedAt) continue;

        bumpAggregate(data.global, record);

        const hour = record.startedAt.slice(0, 13);
        if (!data.hourly[hour]) {
          data.hourly[hour] = { ...createAggregate(), hour };
        }
        bumpAggregate(data.hourly[hour]!, record);

        if (!data.sessions[record.sessionId]) {
          data.sessions[record.sessionId] = {
            sessionId: record.sessionId,
            aggregate: createAggregate(),
            requestLog: [],
          };
        }
        const sess = data.sessions[record.sessionId]!;
        bumpAggregate(sess.aggregate, record);
        sess.requestLog.push(record);
      } catch { /* skip malformed lines */ }
    }

    // Prune after full replay
    const hourKeys = Object.keys(data.hourly).sort();
    while (hourKeys.length > MAX_HOURLY_BUCKETS) {
      delete data.hourly[hourKeys.shift()!];
    }
    const sessEntries = Object.entries(data.sessions);
    if (sessEntries.length > MAX_SESSIONS) {
      sessEntries.sort((a, b) => {
        const aLast = a[1].requestLog.at(-1)?.endedAt ?? "";
        const bLast = b[1].requestLog.at(-1)?.endedAt ?? "";
        return aLast.localeCompare(bLast);
      });
      for (let i = 0; i < sessEntries.length - MAX_SESSIONS; i++) {
        delete data.sessions[sessEntries[i]![0]];
      }
    }
    for (const sess of Object.values(data.sessions)) {
      if (sess.requestLog.length > 200) {
        sess.requestLog = sess.requestLog.slice(-100);
      }
    }
    return data;
  }

  private pruneHourly(): void {
    const keys = Object.keys(this.data.hourly).sort();
    while (keys.length > MAX_HOURLY_BUCKETS) {
      const oldest = keys.shift()!;
      delete this.data.hourly[oldest];
    }
  }

  private pruneSessions(): void {
    const entries = Object.entries(this.data.sessions);
    if (entries.length <= MAX_SESSIONS) return;
    entries.sort((a, b) => {
      const aLast = a[1].requestLog[a[1].requestLog.length - 1]?.endedAt ?? "";
      const bLast = b[1].requestLog[b[1].requestLog.length - 1]?.endedAt ?? "";
      return aLast.localeCompare(bLast);
    });
    const toRemove = entries.length - MAX_SESSIONS;
    for (let i = 0; i < toRemove; i++) {
      delete this.data.sessions[entries[i]![0]];
    }
  }

  private calculateCost(
    usage: CanonicalUsage,
    provider: string,
    model: string,
  ): { input: number; output: number; cacheRead: number; total: number } {
    const pricing = lookupModelPricing(provider, model, this.modelPricing);
    if (!pricing) return { input: 0, output: 0, cacheRead: 0, total: 0 };
    const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * (pricing.input ?? 0);
    const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * (pricing.output ?? 0);
    const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheRead ?? 0);
    const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * (pricing.input ?? 0);
    return {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    };
  }

  private calculateBaselineCostForRecord(
    usage: CanonicalUsage,
    provider: string,
    model: string,
  ): number | undefined {
    if (!this.baselineModel?.model) {
      const cost = this.calculateCost(usage, provider, model);
      return cost.total;
    }
    const baseProvider = this.baselineModel.provider || provider;
    const baseModel = this.baselineModel.model;
    if (baseProvider === provider && baseModel === model) {
      return undefined;
    }
    const cost = this.calculateCost(usage, baseProvider, baseModel);
    return cost.total;
  }
}

function createAggregate(): RouterStatsAggregate {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalBaselineCost: 0,
    totalSavedCost: 0,
    perScenario: {},
    perModel: {},
    perProvider: {},
    perTier: {},
    perRole: {},
  };
}

function createPersistedData(): PersistedData {
  return { hourly: {}, sessions: {}, global: createAggregate() };
}

function copyAggregate(a: RouterStatsAggregate): RouterStatsAggregate {
  return {
    ...a,
    perScenario: { ...a.perScenario },
    perModel: { ...a.perModel },
    perProvider: { ...a.perProvider },
    perTier: { ...a.perTier },
    perRole: { ...a.perRole },
  };
}

function bumpAggregate(agg: RouterStatsAggregate, record: RouterStatsRecord): void {
  agg.totalRequests += 1;
  agg.totalInputTokens += record.usage.inputTokens ?? 0;
  agg.totalOutputTokens += record.usage.outputTokens ?? 0;
  const cost = record.cost?.total ?? 0;
  const baseline = record.baselineCost ?? cost;
  agg.totalCost += cost;
  if (typeof agg.totalBaselineCost !== "number") agg.totalBaselineCost = 0;
  if (typeof agg.totalSavedCost !== "number") agg.totalSavedCost = 0;
  agg.totalBaselineCost += baseline;
  agg.totalSavedCost += baseline - cost;

  agg.perScenario[record.scenarioType] = (agg.perScenario[record.scenarioType] ?? 0) + 1;

  const modelKey = `${record.provider}/${record.model}`;
  agg.perModel[modelKey] = (agg.perModel[modelKey] ?? 0) + 1;
  agg.perProvider[record.provider] = (agg.perProvider[record.provider] ?? 0) + 1;

  if (record.tier) {
    agg.perTier[record.tier] = (agg.perTier[record.tier] ?? 0) + 1;
  }
  if (record.role) {
    agg.perRole[record.role] = (agg.perRole[record.role] ?? 0) + 1;
  }
}

function isAggregate(val: unknown): val is RouterStatsAggregate {
  return typeof val === "object" && val !== null && "totalRequests" in val;
}

/**
 * One-time migration from the old stats.json (or legacy router-stats.json)
 * into the new append-only stats.jsonl format.  Extracts every requestLog
 * entry and writes one JSON line per record.
 */
function migrateJsonToJsonl(routerDir: string, jsonlPath: string): void {
  if (fs.existsSync(jsonlPath)) return; // already migrated

  const candidates = [
    path.join(routerDir, "stats.json"),
    path.join(path.dirname(routerDir), "router-stats.json"),
  ];

  for (const jsonPath of candidates) {
    try {
      if (!fs.existsSync(jsonPath)) continue;
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { sessions?: Record<string, { requestLog?: RouterStatsRecord[] }> };
      if (!parsed?.sessions) continue;

      const lines: string[] = [];
      for (const sess of Object.values(parsed.sessions)) {
        if (!Array.isArray(sess?.requestLog)) continue;
        for (const rec of sess.requestLog) {
          if (rec?.sessionId && rec?.startedAt) {
            lines.push(JSON.stringify(rec));
          }
        }
      }
      lines.sort((a, b) => {
        const aStart = (JSON.parse(a) as RouterStatsRecord).startedAt;
        const bStart = (JSON.parse(b) as RouterStatsRecord).startedAt;
        return aStart.localeCompare(bStart);
      });
      if (lines.length > 0) {
        fs.writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");
      }
      // Rename old file so it won't be read again
      try { fs.renameSync(jsonPath, jsonPath + ".bak"); } catch { /* ok */ }
      return;
    } catch { /* skip this candidate */ }
  }
}
