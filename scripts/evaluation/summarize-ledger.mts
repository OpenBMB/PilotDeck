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
const detail = ["task_id,attempts,known_cost_usd,unknown_cost_attempts,judge_cost_usd,fallback_attempts,duration_ms"];
let knownCost = 0;
let unknown = 0;
for (const [taskId, attempts] of byTask) {
  const costs = attempts.filter((x) => typeof x.cost === "number").reduce((n, x) => n + x.cost, 0);
  const unknownCount = attempts.filter((x) => x.costSource === "unknown").length;
  const judge = attempts.filter((x) => x.role === "judge" && typeof x.cost === "number").reduce((n, x) => n + x.cost, 0);
  const fallback = attempts.filter((x) => x.role === "fallback").length;
  const starts = attempts.map((x) => Date.parse(x.startedAt)).filter(Number.isFinite);
  const ends = attempts.map((x) => Date.parse(x.endedAt)).filter(Number.isFinite);
  const duration = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : "";
  knownCost += costs; unknown += unknownCount;
  detail.push([quote(taskId), attempts.length, costs, unknownCount, judge, fallback, duration].join(","));
}
fs.writeFileSync(path.join(outputDir, "tasks.csv"), `${detail.join("\n")}\n`);
fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({
  schemaVersion: 1, tasks: byTask.size, attempts: rows.length, knownCostUsd: knownCost,
  unknownCostAttempts: unknown, unknownCostRatio: rows.length ? unknown / rows.length : null,
  caveat: "Costs exclude attempts whose costSource is unknown; do not treat knownCostUsd as a reconciled bill when unknownCostAttempts > 0.",
}, null, 2) + "\n");
