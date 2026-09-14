import * as fs from "node:fs";
import * as path from "node:path";

const [input, outputDir] = process.argv.slice(2);
if (!input || !outputDir) {
  throw new Error("usage: summarize-ledger.mts <calls.jsonl> <new-output-dir>");
}
if (fs.existsSync(outputDir)) throw new Error(`refusing to overwrite existing output: ${outputDir}`);
fs.mkdirSync(outputDir, { recursive: false });
const rows = fs.readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const byTask = new Map<string, any[]>();
for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const costSources = ["provider_reported", "price_table_calculated", "estimated", "unknown"] as const;
const usageSources = ["provider_reported", "estimated", "unknown"] as const;
const detail = [
  "task_id,attempts,known_cost_usd,provider_reported_cost_usd,price_table_cost_usd,estimated_cost_usd," +
  "unknown_cost_attempts,provider_usage_attempts,estimated_usage_attempts,unknown_usage_attempts," +
  "judge_cost_usd,fallback_attempts,duration_ms",
];
let knownCost = 0;
let unknown = 0;
const costBySource = Object.fromEntries(costSources.map((source) => [source, { attempts: 0, costUsd: 0 }]));
const usageBySource = Object.fromEntries(usageSources.map((source) => [source, { attempts: 0 }]));
for (const [taskId, attempts] of byTask) {
  const costs = attempts.filter((x) => typeof x.cost === "number").reduce((n, x) => n + x.cost, 0);
  const unknownCount = attempts.filter((x) => x.costSource === "unknown").length;
  const costFor = (source: string) => attempts
    .filter((x) => x.costSource === source && typeof x.cost === "number")
    .reduce((n, x) => n + x.cost, 0);
  const usageCount = (source: string) => attempts.filter((x) => x.usageSource === source).length;
  const judge = attempts.filter((x) => x.role === "judge" && typeof x.cost === "number").reduce((n, x) => n + x.cost, 0);
  const fallback = attempts.filter((x) => x.role === "fallback").length;
  const starts = attempts.map((x) => Date.parse(x.startedAt)).filter(Number.isFinite);
  const ends = attempts.map((x) => Date.parse(x.endedAt)).filter(Number.isFinite);
  const duration = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : "";
  knownCost += costs; unknown += unknownCount;
  for (const source of costSources) {
    costBySource[source].attempts += attempts.filter((x) => x.costSource === source).length;
    costBySource[source].costUsd += costFor(source);
  }
  for (const source of usageSources) usageBySource[source].attempts += usageCount(source);
  detail.push([
    quote(taskId), attempts.length, costs,
    costFor("provider_reported"), costFor("price_table_calculated"), costFor("estimated"), unknownCount,
    usageCount("provider_reported"), usageCount("estimated"), usageCount("unknown"),
    judge, fallback, duration,
  ].join(","));
}
fs.writeFileSync(path.join(outputDir, "tasks.csv"), `${detail.join("\n")}\n`);
fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({
  schemaVersion: 1, tasks: byTask.size, attempts: rows.length, knownCostUsd: knownCost,
  unknownCostAttempts: unknown, unknownCostRatio: rows.length ? unknown / rows.length : null,
  costBySource, usageBySource,
  reconciliationEligible: unknown === 0 && costBySource.estimated.attempts === 0,
  caveat: "Costs exclude unknown attempts. Estimated costs are shown but are not provider-bill evidence. Reconciliation requires no unknown or estimated attempts.",
}, null, 2) + "\n");
