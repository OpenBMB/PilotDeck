import * as fs from "node:fs";
import * as path from "node:path";

type Result = { taskId: string; sessionId: string; strategy: string; repeat: number; success: boolean; latencyMs: number };
type Call = { taskId: string; strategyVersion: string; cost?: number; costSource: string; role: string };
const [resultsPath, callsPath, outputDir] = process.argv.slice(2);
if (!resultsPath || !callsPath || !outputDir) throw new Error("usage: analyze-results.mts <results.jsonl> <calls.jsonl> <new-output-dir>");
if (fs.existsSync(outputDir)) throw new Error(`refusing to overwrite existing output: ${outputDir}`);
fs.mkdirSync(outputDir, { recursive: false });
const read = <T>(file: string): T[] => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x));
const results = read<Result>(resultsPath), calls = read<Call>(callsPath);
const strategies = [...new Set(results.map((x) => x.strategy))].sort();
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
    judgeCostUsd: cs.filter((x) => x.role === "judge").reduce((n, x) => n + (x.cost ?? 0), 0),
  };
});
fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({ schemaVersion: 1, rows, limitations: [
  "Known cost excludes unknown-cost attempts.", "No non-inferiority claim is valid without a predeclared margin and adequate session-level sample size."
] }, null, 2) + "\n");
const csv = [Object.keys(rows[0] ?? {}).join(","), ...rows.map((row) => Object.values(row).map(csvCell).join(","))];
fs.writeFileSync(path.join(outputDir, "summary.csv"), csv.join("\n") + "\n");
fs.writeFileSync(path.join(outputDir, "cost-success.svg"), svg(rows));

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * q))]!;
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
