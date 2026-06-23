import * as fs from "node:fs";
import * as path from "node:path";
import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import { resolvePilotHome } from "../../pilot/paths.js";
import type { RouterDecision } from "../protocol/decision.js";

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
      const filePath = config?.filePath?.trim() ? config.filePath : undefined;
      const routerDir = filePath
        ? path.dirname(filePath)
        : path.join(resolvePilotHome(), "router");
      try { fs.mkdirSync(routerDir, { recursive: true }); } catch { /* ok */ }

      this.jsonlPath = filePath ?? path.join(routerDir, "stats.jsonl");

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
    const pricing = this.lookupPricing(provider, model);
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

  private lookupPricing(
    provider: string,
    model: string,
  ): { input?: number; output?: number; cacheRead?: number } | undefined {
    const combined = `${provider}/${model}`;
    if (this.modelPricing) {
      const exact = this.modelPricing[combined];
      if (exact) return exact;
      for (const [key, val] of Object.entries(this.modelPricing)) {
        if (model.includes(key) || key.includes(model)) return val;
      }
    }
    return lookupDefaultPricing(combined, model);
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

// $/million tokens – fallback when neither nativeCost nor user modelPricing is available
const DEFAULT_PRICING: Array<{ pattern: RegExp; input: number; output: number; cacheRead?: number }> = [
  // DeepSeek
  { pattern: /deepseek.*flash/i, input: 0.20, output: 0.60 },
  { pattern: /deepseek.*chat/i, input: 0.50, output: 1.50 },
  { pattern: /deepseek.*reasoner/i, input: 0.80, output: 2.00 },
  { pattern: /deepseek.*v3/i, input: 0.27, output: 1.10 },
  // Anthropic Claude
  { pattern: /claude.*opus/i, input: 15.00, output: 75.00, cacheRead: 1.50 },
  { pattern: /claude.*sonnet/i, input: 3.00, output: 15.00, cacheRead: 0.30 },
  { pattern: /claude.*haiku/i, input: 0.80, output: 4.00, cacheRead: 0.08 },
  // OpenAI
  { pattern: /gpt-4o-mini/i, input: 0.15, output: 0.60, cacheRead: 0.075 },
  { pattern: /gpt-4o/i, input: 2.50, output: 10.00, cacheRead: 1.25 },
  { pattern: /gpt-4\.1/i, input: 2.00, output: 8.00, cacheRead: 0.50 },
  { pattern: /gpt-5/i, input: 2.00, output: 8.00, cacheRead: 0.50 },
  { pattern: /o[134]-mini/i, input: 1.10, output: 4.40 },
  { pattern: /o[134]-pro/i, input: 10.00, output: 40.00 },
  { pattern: /o[134]/i, input: 2.50, output: 10.00 },
  // Google Gemini
  { pattern: /gemini.*flash/i, input: 0.10, output: 0.40 },
  { pattern: /gemini.*pro/i, input: 1.25, output: 5.00 },
  // GLM / ChatGLM / Zhipu
  { pattern: /glm/i, input: 0.50, output: 1.00 },
  // Qwen / Tongyi
  { pattern: /qwen.*turbo/i, input: 0.30, output: 0.60 },
  { pattern: /qwen.*plus/i, input: 0.80, output: 2.00 },
  { pattern: /qwen.*max/i, input: 2.00, output: 6.00 },
  { pattern: /qwen/i, input: 0.50, output: 1.50 },
  // Llama / Meta
  { pattern: /llama.*70b/i, input: 0.80, output: 0.80 },
  { pattern: /llama.*405b/i, input: 3.00, output: 3.00 },
  { pattern: /llama/i, input: 0.20, output: 0.20 },
  // Mistral
  { pattern: /mistral.*large/i, input: 2.00, output: 6.00 },
  { pattern: /mistral.*small/i, input: 0.10, output: 0.30 },
  { pattern: /mistral/i, input: 0.25, output: 0.25 },
  // Yi / 01.AI
  { pattern: /yi-/i, input: 0.30, output: 0.30 },
  // Moonshot / Kimi
  { pattern: /moonshot|kimi/i, input: 1.00, output: 2.00 },
  // Doubao / ByteDance
  { pattern: /doubao/i, input: 0.40, output: 0.80 },
];

const FALLBACK_PRICING = { input: 0.50, output: 1.50 };

function lookupDefaultPricing(
  combined: string,
  model: string,
): { input?: number; output?: number; cacheRead?: number } {
  for (const entry of DEFAULT_PRICING) {
    if (entry.pattern.test(combined) || entry.pattern.test(model)) {
      return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead };
    }
  }
  return FALLBACK_PRICING;
}
