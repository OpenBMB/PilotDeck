import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import type { RouterDecision } from "../protocol/decision.js";

export type RouterStatsRecord = {
  sessionId: string;
  projectPath?: string;
  scenarioType: RouterDecision["scenarioType"];
  resolvedFrom: RouterDecision["resolvedFrom"];
  provider: string;
  model: string;
  tier?: string;
  role?: "main" | "subagent";
  usage: CanonicalUsage;
  cost?: { input: number; output: number; cacheRead: number; total: number };
  startedAt: string;
  endedAt: string;
};

export type RouterStatsAggregate = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
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
const AUTO_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export class TokenStatsCollector {
  private readonly enabled: boolean;
  private readonly filePath: string | undefined;
  private readonly modelPricing: RouterStatsConfig["modelPricing"];
  private data: PersistedData;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private recentRecords: RouterStatsRecord[] = [];

  constructor(config: RouterStatsConfig | undefined) {
    this.enabled = config?.enabled ?? false;
    this.modelPricing = config?.modelPricing;

    if (this.enabled) {
      if (config?.filePath) {
        this.filePath = config.filePath;
      } else {
        const dir = path.join(os.homedir(), ".pilotdeck");
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
        this.filePath = path.join(dir, "router-stats.json");
      }
      this.data = this.loadFromDisk();
      this.flushTimer = setInterval(() => { this.flushIfDirty(); }, AUTO_FLUSH_INTERVAL_MS);
      if (this.flushTimer.unref) this.flushTimer.unref();
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

    this.recentRecords.push(record);
    if (this.recentRecords.length > 500) {
      this.recentRecords = this.recentRecords.slice(-250);
    }

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

    this.dirty = true;
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
    if (!this.enabled || !this.filePath) return;
    this.dirty = false;
    try {
      const json = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(this.filePath, json, "utf-8");
    } catch { /* best-effort */ }
  }

  clear(): void {
    this.data = createPersistedData();
    this.recentRecords = [];
    this.dirty = true;
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private flushIfDirty(): void {
    if (this.dirty) {
      void this.flush();
    }
  }

  private loadFromDisk(): PersistedData {
    if (!this.filePath) return createPersistedData();
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedData>;
      return {
        hourly: parsed.hourly && typeof parsed.hourly === "object" ? parsed.hourly : {},
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        global: isAggregate(parsed.global) ? parsed.global : createAggregate(),
      };
    } catch {
      return createPersistedData();
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
    return {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      total: inputCost + outputCost + cacheReadCost,
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
}

function createAggregate(): RouterStatsAggregate {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
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
  agg.totalCost += record.cost?.total ?? 0;

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
