import * as fs from "node:fs";
import * as path from "node:path";
import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import { resolvePilotHome } from "../../pilot/paths.js";
import type { RouterDecision } from "../protocol/decision.js";
import { lookupModelPricing, lookupModelPricingWithSource } from "../utils/modelPricing.js";

export type RouterCostSource = "provider_reported" | "configured_price" | "built_in_estimate" | "fallback_estimate" | "legacy_unknown";

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
  /** Provenance of `cost`; older persisted records intentionally remain unknown. */
  costSource?: RouterCostSource;
  baselineCost?: number;
  startedAt: string;
  endedAt: string;
};

export type RouterModelUsageRoleAggregate = {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  costSources: Partial<Record<RouterCostSource, number>>;
};

/** Durable per-provider/model accounting derived from Router-owned request records. */
export type RouterModelUsageAggregate = RouterModelUsageRoleAggregate & {
  provider: string;
  model: string;
  roles: Partial<Record<"main" | "subagent", RouterModelUsageRoleAggregate>>;
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
  costSources: Partial<Record<RouterCostSource, number>>;
  perModelUsage: Record<string, RouterModelUsageAggregate>;
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
  private readonly retentionMs: number | undefined;
  private data: PersistedData;
  private recentRecords: RouterStatsRecord[] = [];
  /** Present only when retention is configured, and contains every retained record. */
  private retainedRecords: RouterStatsRecord[] | undefined;
  private expiredRecordsLoaded = false;
  private fd: number | undefined;

  constructor(config: RouterStatsConfig | undefined) {
    this.enabled = config?.enabled ?? false;
    this.modelPricing = config?.modelPricing;
    this.baselineModel = config?.baselineModel;
    this.retentionMs = config?.retentionMs;

    if (this.enabled) {
      const routerDir = config?.filePath
        ? path.dirname(config.filePath)
        : path.join(resolvePilotHome(), "router");
      try { fs.mkdirSync(routerDir, { recursive: true }); } catch { /* ok */ }

      this.jsonlPath = path.join(routerDir, "stats.jsonl");

      // One-time migration: old JSON formats → JSONL
      migrateJsonToJsonl(routerDir, this.jsonlPath);

      this.data = this.rebuildFromJsonl();
      if (this.expiredRecordsLoaded) this.compactRetainedRecords();

      // Default append-only stats keep an O_APPEND descriptor. Retention uses
      // short-lived locked writes because it may atomically replace the file.
      if (this.retentionMs === undefined) {
        try {
          this.fd = fs.openSync(this.jsonlPath, "a");
        } catch { /* will fall back to per-write open */ }
      }
    } else {
      this.data = createPersistedData();
    }
  }

  observe(record: RouterStatsRecord): void {
    if (!this.enabled) return;
    this.pruneExpiredRecords();

    const cost = this.estimateCostBreakdown(record.usage, record.provider, record.model);
    record.cost = cost.breakdown;
    record.costSource = cost.source;

    record.baselineCost = this.calculateBaselineCostForRecord(record.usage, record.provider, record.model) ?? record.cost!.total;

    this.retainedRecords?.push(record);

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
    this.pruneExpiredRecords();
    return copyAggregate(this.data.global);
  }

  /**
   * Returns the same per-request USD estimate used by persisted router stats.
   * This remains available when stats persistence is disabled so a Gateway
   * turn budget does not depend on global metrics being enabled.
   */
  estimateCost(usage: CanonicalUsage | undefined, provider: string, model: string): number {
    if (!usage) return 0;
    return this.estimateCostBreakdown(usage, provider, model).breakdown.total;
  }

  hourlySnapshots(): HourlyBucket[] {
    this.pruneExpiredRecords();
    return Object.values(this.data.hourly).sort((a, b) => a.hour.localeCompare(b.hour));
  }

  sessionSnapshot(sessionId: string): SessionBucket | undefined {
    this.pruneExpiredRecords();
    return this.data.sessions[sessionId];
  }

  /**
   * Returns Gateway-ready, durable model usage for one session or this Router
   * instance. The SDK must consume this aggregate through the Gateway rather
   * than rebuilding it from streamed events or a bounded request log.
   */
  modelUsageSnapshot(sessionId?: string): RouterModelUsageAggregate[] {
    this.pruneExpiredRecords();
    const aggregate = sessionId ? this.data.sessions[sessionId]?.aggregate : this.data.global;
    if (!aggregate) return [];
    return Object.values(aggregate.perModelUsage ?? {})
      .map(copyModelUsage)
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  }

  recent(limit = 50): RouterStatsRecord[] {
    this.pruneExpiredRecords();
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
    if (this.retainedRecords) this.retainedRecords = [];
    if (this.jsonlPath) {
      if (this.retentionMs !== undefined) {
        if (!this.withRetentionJournalLock(() => fs.writeFileSync(this.jsonlPath!, "", "utf-8"))) {
          try { fs.writeFileSync(this.jsonlPath, "", "utf-8"); } catch { /* ok */ }
        }
      } else {
        try { fs.writeFileSync(this.jsonlPath, "", "utf-8"); } catch { /* ok */ }
      }
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
      if (this.retentionMs !== undefined && this.jsonlPath) {
        if (!this.withRetentionJournalLock(() => fs.appendFileSync(this.jsonlPath!, line, "utf-8"))) {
          fs.appendFileSync(this.jsonlPath, line, "utf-8");
        }
        return;
      }
      if (this.fd !== undefined) {
        fs.writeSync(this.fd, line);
      } else if (this.jsonlPath) {
        fs.appendFileSync(this.jsonlPath, line, "utf-8");
      }
    } catch { /* best-effort */ }
  }

  private rebuildFromJsonl(): PersistedData {
    const records: RouterStatsRecord[] = [];
    if (this.retentionMs !== undefined) this.retainedRecords = [];
    if (!this.jsonlPath) return createPersistedData();
    let raw: string;
    try {
      raw = fs.readFileSync(this.jsonlPath, "utf-8");
    } catch {
      return createPersistedData();
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as RouterStatsRecord;
        if (!record.sessionId || !record.startedAt) continue;
        if (!this.isRetained(record)) {
          this.expiredRecordsLoaded = true;
          continue;
        }
        records.push(record);
        this.retainedRecords?.push(record);
      } catch { /* skip malformed lines */ }
    }
    return createDataFromRecords(records);
  }

  private isRetained(record: RouterStatsRecord, now = Date.now()): boolean {
    if (this.retentionMs === undefined) return true;
    const endedAt = Date.parse(record.endedAt);
    // Preserve malformed historical timestamps rather than silently losing an
    // accounting record. Configuration validation only controls new data.
    return !Number.isFinite(endedAt) || endedAt >= now - this.retentionMs;
  }

  private pruneExpiredRecords(): void {
    if (!this.retainedRecords) return;
    const retained = this.retainedRecords.filter((record) => this.isRetained(record));
    if (retained.length === this.retainedRecords.length) return;
    this.retainedRecords = retained;
    this.recentRecords = this.recentRecords.filter((record) => this.isRetained(record));
    this.data = createDataFromRecords(retained);
    this.compactRetainedRecords();
  }

  /** Retention is opt-in; rewrite only while retention-aware writers hold the journal lock. */
  private compactRetainedRecords(): void {
    if (!this.jsonlPath || !this.retainedRecords) return;
    this.withRetentionJournalLock(() => {
      const current = readStatsRecords(this.jsonlPath!);
      const retained = current.filter((record) => this.isRetained(record));
      this.retainedRecords = retained;
      this.recentRecords = this.recentRecords.filter((record) => this.isRetained(record));
      this.data = createDataFromRecords(retained);
      const temporaryPath = `${this.jsonlPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryPath, retained.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
      fs.renameSync(temporaryPath, this.jsonlPath!);
    });
  }

  private withRetentionJournalLock(action: () => void): boolean {
    if (!this.jsonlPath) return false;
    const lockPath = `${this.jsonlPath}.retention.lock`;
    let lock: number | undefined;
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        lock = fs.openSync(lockPath, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        Atomics.wait(waiter, 0, 0, 1);
      }
    }
    if (lock === undefined) return false;
    try {
      action();
      return true;
    } catch {
      return false;
    } finally {
      try { fs.closeSync(lock); } catch { /* ok */ }
      try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    }
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

  private estimateCostBreakdown(
    usage: CanonicalUsage,
    provider: string,
    model: string,
  ): {
    breakdown: { input: number; output: number; cacheRead: number; total: number };
    source: Exclude<RouterCostSource, "legacy_unknown">;
  } {
    if (typeof usage.nativeCost === "number" && Number.isFinite(usage.nativeCost) && usage.nativeCost >= 0) {
      return {
        breakdown: { input: 0, output: 0, cacheRead: 0, total: usage.nativeCost },
        source: "provider_reported",
      };
    }
    return {
      breakdown: this.calculateCost(usage, provider, model),
      source: lookupModelPricingWithSource(provider, model, this.modelPricing).source,
    };
  }

  private calculateCost(
    usage: CanonicalUsage,
    provider: string,
    model: string,
  ): { input: number; output: number; cacheRead: number; total: number } {
    const pricing = lookupModelPricing(provider, model, this.modelPricing);
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
    costSources: {},
    perModelUsage: {},
  };
}

function createPersistedData(): PersistedData {
  return { hourly: {}, sessions: {}, global: createAggregate() };
}

function createDataFromRecords(records: readonly RouterStatsRecord[]): PersistedData {
  const data = createPersistedData();
  for (const record of records) {
    bumpAggregate(data.global, record);

    const hour = record.startedAt.slice(0, 13);
    if (!data.hourly[hour]) data.hourly[hour] = { ...createAggregate(), hour };
    bumpAggregate(data.hourly[hour]!, record);

    if (!data.sessions[record.sessionId]) {
      data.sessions[record.sessionId] = {
        sessionId: record.sessionId,
        aggregate: createAggregate(),
        requestLog: [],
      };
    }
    data.sessions[record.sessionId]!.requestLog.push(record);
    bumpAggregate(data.sessions[record.sessionId]!.aggregate, record);
  }

  const hourKeys = Object.keys(data.hourly).sort();
  while (hourKeys.length > MAX_HOURLY_BUCKETS) delete data.hourly[hourKeys.shift()!];

  const sessionEntries = Object.entries(data.sessions);
  if (sessionEntries.length > MAX_SESSIONS) {
    sessionEntries.sort((left, right) => {
      const leftLast = left[1].requestLog.at(-1)?.endedAt ?? "";
      const rightLast = right[1].requestLog.at(-1)?.endedAt ?? "";
      return leftLast.localeCompare(rightLast);
    });
    for (let index = 0; index < sessionEntries.length - MAX_SESSIONS; index += 1) {
      delete data.sessions[sessionEntries[index]![0]];
    }
  }
  for (const session of Object.values(data.sessions)) {
    if (session.requestLog.length > 200) session.requestLog = session.requestLog.slice(-100);
  }
  return data;
}

function readStatsRecords(filePath: string): RouterStatsRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const records: RouterStatsRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as RouterStatsRecord;
      if (record.sessionId && record.startedAt) records.push(record);
    } catch { /* ignore malformed append-only journal rows */ }
  }
  return records;
}

function copyAggregate(a: RouterStatsAggregate): RouterStatsAggregate {
  return {
    ...a,
    perScenario: { ...a.perScenario },
    perModel: { ...a.perModel },
    perProvider: { ...a.perProvider },
    perTier: { ...a.perTier },
    perRole: { ...a.perRole },
    costSources: { ...(a.costSources ?? {}) },
    perModelUsage: Object.fromEntries(Object.entries(a.perModelUsage ?? {}).map(([key, usage]) => [key, copyModelUsage(usage)])),
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
  bumpCostSource(agg.costSources ?? (agg.costSources = {}), record.costSource ?? "legacy_unknown");

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

  const usage = agg.perModelUsage[modelKey] ?? createModelUsage(record.provider, record.model);
  agg.perModelUsage[modelKey] = usage;
  bumpModelUsage(usage, record.usage, cost, record.costSource ?? "legacy_unknown");
  if (record.role) {
    const roleUsage = usage.roles[record.role] ?? createModelUsageRole();
    usage.roles[record.role] = roleUsage;
    bumpModelUsage(roleUsage, record.usage, cost, record.costSource ?? "legacy_unknown");
  }
}

function createModelUsageRole(): RouterModelUsageRoleAggregate {
  return {
    totalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    costSources: {},
  };
}

function createModelUsage(provider: string, model: string): RouterModelUsageAggregate {
  return { provider, model, ...createModelUsageRole(), roles: {} };
}

function bumpModelUsage(
  aggregate: RouterModelUsageRoleAggregate,
  usage: CanonicalUsage,
  cost: number,
  costSource: RouterCostSource,
): void {
  aggregate.totalRequests += 1;
  aggregate.inputTokens += usage.inputTokens ?? 0;
  aggregate.outputTokens += usage.outputTokens ?? 0;
  aggregate.cacheReadTokens += usage.cacheReadTokens ?? 0;
  aggregate.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  aggregate.totalTokens += usage.totalTokens ?? (
    (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
  );
  aggregate.totalCost += cost;
  bumpCostSource(aggregate.costSources ?? (aggregate.costSources = {}), costSource);
}

function bumpCostSource(target: Partial<Record<RouterCostSource, number>>, source: RouterCostSource): void {
  target[source] = (target[source] ?? 0) + 1;
}

function copyModelUsage(usage: RouterModelUsageAggregate): RouterModelUsageAggregate {
  return {
    ...usage,
    costSources: { ...(usage.costSources ?? {}) },
    roles: Object.fromEntries(Object.entries(usage.roles ?? {}).map(([role, totals]) => [
      role,
      { ...totals, costSources: { ...(totals.costSources ?? {}) } },
    ])),
  };
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
