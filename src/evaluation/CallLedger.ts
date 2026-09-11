import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { CanonicalUsage } from "../model/index.js";
import type { RouterModelPricingMap } from "../router/utils/modelPricing.js";
import { lookupModelPricing } from "../router/utils/modelPricing.js";

export type CallRole = "judge" | "main" | "subagent" | "retry" | "fallback" | "compaction";
export type AttemptStatus = "succeeded" | "failed" | "cancelled" | "unknown";
export type CostSource = "provider_reported" | "price_table_calculated" | "estimated" | "unknown";
export type UsageSource = "provider_reported" | "estimated" | "unknown";

export type LedgerAttempt = {
  schemaVersion: 1;
  eventType: "model_attempt";
  runId: string;
  taskId: string;
  sessionId: string;
  decisionId?: string;
  callId: string;
  attemptId: string;
  parentId?: string;
  strategyVersion: string;
  baselineCommit: string;
  provider: string;
  model: string;
  role: CallRole;
  attemptNumber: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: AttemptStatus;
  errorType?: string;
  usage?: CanonicalUsage;
  usageSource: UsageSource;
  cost?: number;
  costCurrency: "USD";
  costSource: CostSource;
  retryOfAttemptId?: string;
  fallbackFromAttemptId?: string;
};

export type LedgerAttemptInput = Omit<LedgerAttempt,
  "schemaVersion" | "eventType" | "attemptId" | "durationMs" | "cost" | "costCurrency" | "costSource"
> & { attemptId?: string };

export type CallLedgerOptions = {
  filePath: string;
  modelPricing?: RouterModelPricingMap;
};

/** Append-only, content-free provider-attempt ledger. One physical request is one row. */
export class CallLedger {
  private readonly filePath: string;
  private readonly modelPricing?: RouterModelPricingMap;
  private fd: number | undefined;

  constructor(options: CallLedgerOptions) {
    this.filePath = path.resolve(options.filePath);
    this.modelPricing = options.modelPricing;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, "a");
  }

  append(input: LedgerAttemptInput): LedgerAttempt {
    const durationMs = Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt));
    const priced = priceAttempt(input.usage, input.usageSource, input.provider, input.model, this.modelPricing);
    const record: LedgerAttempt = {
      ...input,
      schemaVersion: 1,
      eventType: "model_attempt",
      attemptId: input.attemptId ?? randomUUID(),
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      costCurrency: "USD",
      ...priced,
    };
    fs.writeSync(this.fd!, `${JSON.stringify(record)}\n`);
    return record;
  }

  dispose(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

function priceAttempt(
  usage: CanonicalUsage | undefined,
  usageSource: UsageSource,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): Pick<LedgerAttempt, "cost" | "costSource"> {
  if (usage?.nativeCost != null) {
    return { cost: usage.nativeCost, costSource: "provider_reported" };
  }
  if (!usage || usageSource === "unknown") return { costSource: "unknown" };
  const pricing = lookupModelPricing(provider, model, modelPricing);
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cost = (
    input * (pricing.input ?? 0) +
    output * (pricing.output ?? 0) +
    cacheRead * (pricing.cacheRead ?? pricing.input ?? 0) +
    cacheWrite * (pricing.input ?? 0)
  ) / 1_000_000;
  return { cost, costSource: usageSource === "estimated" ? "estimated" : "price_table_calculated" };
}
