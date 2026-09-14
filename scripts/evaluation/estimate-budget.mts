const get = (name: string, fallback: number) => {
  const arg = process.argv.find((x) => x.startsWith(`--${name}=`));
  return arg ? Number(arg.slice(name.length + 3)) : fallback;
};
const tasks = get("tasks", 32), strategies = get("strategies", 5), repeats = get("repeats", 3);
const main = get("main-cost", 0.08), judge = get("judge-cost", 0.002);
const recoveryRate = get("recovery-rate", 0.15), recoveryCost = get("recovery-cost", 0.04);
const scoring = get("scoring-cost", 0);
const baseRuns = tasks * strategies * repeats;
const parts = { main: baseRuns * main, judge: baseRuns * judge, recovery: baseRuns * recoveryRate * recoveryCost, scoring: baseRuns * scoring };
console.log(JSON.stringify({ tasks, strategies, repeats, baseRuns, assumptionsUsdPerRun: { main, judge, recoveryRate, recoveryCost, scoring }, parts, totalUsd: Object.values(parts).reduce((a, b) => a + b, 0) }, null, 2));
