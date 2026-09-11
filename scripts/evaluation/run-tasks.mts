import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).filter((x) => x.startsWith("--") && x.includes("=")).map((x) => {
  const at = x.indexOf("="); return [x.slice(2, at), x.slice(at + 1)];
}));
const taskFile = args.tasks, strategy = args.strategy, command = args.command, outputDir = args.output;
const repeat = Number(args.repeat ?? 1), split = args.split ?? "test";
if (!taskFile || !strategy || !command || !outputDir) throw new Error("required: --tasks=... --strategy=... --command=... --output=<new-dir> [--split=test] [--repeat=1]");
if (fs.existsSync(outputDir)) throw new Error(`refusing to overwrite existing output: ${outputDir}`);
fs.mkdirSync(outputDir, { recursive: false });
const manifest = JSON.parse(fs.readFileSync(taskFile, "utf8")) as { tasks: Array<{ id: string; sessionId: string; split: string }> };
const tasks = manifest.tasks.filter((task) => task.split === split);
const results: string[] = [];
for (const task of tasks) {
  const taskDir = path.resolve(outputDir, task.id);
  fs.mkdirSync(taskDir, { recursive: false });
  const started = Date.now();
  const run = spawnSync(command, [], {
    shell: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", cwd: taskDir,
    env: { ...process.env, PILOTROUTE_TASK_ID: task.id, PILOTROUTE_SESSION_ID: task.sessionId, PILOTROUTE_STRATEGY: strategy, PILOTROUTE_REPEAT: String(repeat), PILOTROUTE_OUTPUT_DIR: taskDir },
    timeout: Number(args.timeoutMs ?? 600_000),
  });
  fs.writeFileSync(path.join(taskDir, "stdout.txt"), run.stdout ?? "");
  fs.writeFileSync(path.join(taskDir, "stderr.txt"), run.stderr ?? "");
  results.push(JSON.stringify({
    taskId: task.id, sessionId: task.sessionId, strategy, repeat,
    success: run.status === 0, latencyMs: Date.now() - started,
    exitCode: run.status, errorType: run.error?.name,
  }));
}
fs.writeFileSync(path.join(outputDir, "results.jsonl"), results.join("\n") + (results.length ? "\n" : ""));
fs.writeFileSync(path.join(outputDir, "run.json"), JSON.stringify({ schemaVersion: 1, strategy, repeat, split, taskFile: path.resolve(taskFile), command, tasks: tasks.length, createdAt: new Date().toISOString() }, null, 2) + "\n");
