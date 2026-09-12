import * as fs from "node:fs";
import * as path from "node:path";

type Result = { taskId: string; sessionId: string; strategy: string; repeat: number; success: boolean; latencyMs: number; ttftMs?: number; noOutputWaitMs?: number; fallbackRecoveryMs?: number; cancellationMs?: number; failureReason?: string };
type Call = { taskId: string; strategyVersion: string; cost?: number; costSource: string; role: string };
const [resultsPath, callsPath, outputDir] = process.argv.slice(2);
if (!resultsPath || !callsPath || !outputDir) throw new Error("usage: analyze-results.mts <results.jsonl> <calls.jsonl> <new-output-dir>");
if (fs.existsSync(outputDir)) throw new Error(`refusing to overwrite existing output: ${outputDir}`);
fs.mkdirSync(outputDir, { recursive: false });
const read = <T,>(file: string): T[] => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x));
const results = read<Result>(resultsPath), calls = read<Call>(callsPath);
const strategies = [...new Set(results.map((x) => x.strategy))].sort();
const baseline = process.env.PILOTROUTE_BASELINE ?? strategies[0];
const rows = strategies.map((strategy) => {
  const rs = results.filter((x) => x.strategy === strategy);
  const cs = calls.filter((x) => x.strategyVersion === strategy);
  const successes = rs.filter((x) => x.success).length;
  const knownCost = cs.reduce((n, x) => n + (typeof x.cost === "number" ? x.cost : 0), 0);
  const unknown = cs.filter((x) => x.costSource === "unknown").length;
  const latencies = rs.map((x) => x.latencyMs).sort((a, b) => a - b);
  return {
    strategy, samples: rs.length, independentSessions: new Set(rs.map((x) => x.sessionId)).size,
    successes, successRate: rs.length ? successes / rs.length : null,
    knownCostUsd: knownCost, unknownCostAttempts: unknown,
    averageTaskCostUsd: rs.length ? knownCost / rs.length : null,
    costPerSuccessUsd: successes ? knownCost / successes : null,
    p50LatencyMs: quantile(latencies, 0.5), p95LatencyMs: quantile(latencies, 0.95),
    p50TtftMs: quantile(numbers(rs, "ttftMs"), 0.5), p95TtftMs: quantile(numbers(rs, "ttftMs"), 0.95),
    p95NoOutputWaitMs: quantile(numbers(rs, "noOutputWaitMs"), 0.95),
    p50FallbackRecoveryMs: quantile(numbers(rs, "fallbackRecoveryMs"), 0.5),
    p95CancellationMs: quantile(numbers(rs, "cancellationMs"), 0.95),
    judgeCostUsd: cs.filter((x) => x.role === "judge").reduce((n, x) => n + (x.cost ?? 0), 0),
  };
});
const comparisons = strategies.filter((strategy) => strategy !== baseline).map((strategy) => pairedComparison(baseline!, strategy));
fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({ schemaVersion: 1, baseline, rows, comparisons, limitations: [
  "Known cost excludes unknown-cost attempts.", "No non-inferiority claim is valid without a predeclared margin and adequate session-level sample size."
] }, null, 2) + "\n");
const csv = [Object.keys(rows[0] ?? {}).join(","), ...rows.map((row) => Object.values(row).map(csvCell).join(","))];
fs.writeFileSync(path.join(outputDir, "summary.csv"), csv.join("\n") + "\n");
fs.writeFileSync(path.join(outputDir, "cost-success.svg"), svg(rows));
fs.writeFileSync(path.join(outputDir, "failures.json"), JSON.stringify(results.filter((x) => !x.success).map((x) => ({ taskId: x.taskId, sessionId: x.sessionId, strategy: x.strategy, repeat: x.repeat, failureReason: x.failureReason ?? "unspecified" })), null, 2) + "\n");

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * q))]!;
}
function numbers(rows: Result[], key: "ttftMs" | "noOutputWaitMs" | "fallbackRecoveryMs" | "cancellationMs"): number[] {
  return rows.map((x) => x[key]).filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
}
function csvCell(value: unknown): string { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function svg(data: typeof rows): string {
  const width = 720, height = 420, pad = 60;
  const maxCost = Math.max(0.000001, ...data.map((x) => x.averageTaskCostUsd ?? 0));
  const dots = data.map((x, i) => {
    const cx = pad + ((x.averageTaskCostUsd ?? 0) / maxCost) * (width - pad * 2);
    const cy = height - pad - (x.successRate ?? 0) * (height - pad * 2);
    return `<circle cx="${cx}" cy="${cy}" r="6"/><text x="${cx + 9}" y="${cy - 7}">${escapeXml(x.strategy)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><path d="M${pad} ${pad}V${height-pad}H${width-pad}" fill="none" stroke="black"/><text x="${width/2}" y="${height-12}" text-anchor="middle">Average known task cost (USD)</text><text x="18" y="${height/2}" transform="rotate(-90 18 ${height/2})" text-anchor="middle">Success rate</text><g fill="#2563eb" font-family="sans-serif" font-size="12">${dots}</g></svg>\n`;
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }

function pairedComparison(base: string, candidate: string) {
  const index = new Map(results.filter((x) => x.strategy === base).map((x) => [`${x.taskId}\0${x.repeat}`, x]));
  const pairs = results.filter((x) => x.strategy === candidate).flatMap((next) => {
    const previous = index.get(`${next.taskId}\0${next.repeat}`);
    return previous ? [{ sessionId: next.sessionId, taskId: next.taskId, delta: Number(next.success) - Number(previous.success), previous, next }] : [];
  });
  const pairsBySession = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const sessionPairs = pairsBySession.get(pair.sessionId) ?? [];
    sessionPairs.push(pair);
    pairsBySession.set(pair.sessionId, sessionPairs);
  }
  const sessionDeltas = [...pairsBySession.values()].map((xs) => xs.reduce((n, x) => n + x.delta, 0) / xs.length);
  const samples = bootstrapMean(sessionDeltas, 2_000, 0x50494c4f);
  return {
    candidate, pairedTasks: pairs.length, independentSessions: sessionDeltas.length,
    successRateDifference: mean(pairs.map((x) => x.delta)),
    sessionBootstrap95CI: samples.length ? [quantile(samples, 0.025), quantile(samples, 0.975)] : null,
    newlyFailedTaskIds: pairs.filter((x) => x.previous.success && !x.next.success).map((x) => x.taskId),
    newlyRecoveredTaskIds: pairs.filter((x) => !x.previous.success && x.next.success).map((x) => x.taskId),
  };
}
function mean(values: number[]): number | null { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function bootstrapMean(values: number[], repetitions: number, seed: number): number[] {
  if (!values.length) return [];
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 0x100000000);
  return Array.from({ length: repetitions }, () => {
    let total = 0; for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]!;
    return total / values.length;
  }).sort((a, b) => a - b);
}
