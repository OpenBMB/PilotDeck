/** Run with Node 22: node --import tsx scripts/benchmark-workspace-checkpoints.ts --workspace /path/to/project */
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FileArtifactCollector } from "../src/session/artifacts/FileArtifactCollector.js";

const { values } = parseArgs({ options: {
  workspace: { type: "string" }, implementation: { type: "string" },
  runs: { type: "string", default: "5" }, output: { type: "string" },
} });
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 3) throw new Error("--runs must be an integer >= 3 (including the initial backup).");
const cwd = resolve(values.workspace ?? process.cwd());
const implementation = values.implementation
  ? pathToFileURL(resolve(values.implementation)).href
  : new URL("../src/session/checkpoints/WorkspaceCheckpoints.js", import.meta.url).href;
const { WorkspaceCheckpoints, CheckpointStore } = await import(implementation) as typeof import("../src/session/checkpoints/WorkspaceCheckpoints.js");
const home = await mkdtemp(join(tmpdir(), "pilotdeck-checkpoint-benchmark-"));
const counters = () => ({ sourceFilesRead: 0, sourceBytesRead: 0, objectReads: 0, objectBytesRead: 0 });
let reads = counters();
let scope = { entries: 0, protectedFiles: 0, protectedBytes: 0 };
const originalFile = CheckpointStore.prototype.captureFile;
const originalObject = CheckpointStore.prototype.readObject;
const originalCapture = CheckpointStore.prototype.capture;
CheckpointStore.prototype.captureFile = async function(relative, save = true) {
  const result = await originalFile.call(this, relative, save);
  if (result.kind === "file") { reads.sourceFilesRead++; reads.sourceBytesRead += result.size; }
  return result;
};
CheckpointStore.prototype.readObject = async function(hash) {
  const result = await originalObject.call(this, hash);
  reads.objectReads++; reads.objectBytesRead += result.length;
  return result;
};
CheckpointStore.prototype.capture = async function(...args) {
  const result = await originalCapture.apply(this, args);
  const files = Object.values(result.files);
  scope = { entries: files.length, protectedFiles: files.filter(file => file.kind === "file").length,
    protectedBytes: files.reduce((sum, file) => sum + (file.kind === "file" ? file.size : 0), 0) };
  return result;
};

const samples = [];
try {
  for (let run = 1; run <= runs; run++) {
    const history = new WorkspaceCheckpoints(cwd, home);
    let collector: FileArtifactCollector | undefined;
    try {
      reads = counters();
      const start = performance.now();
      await history.beginTurn("benchmark", `turn-${run}`, []);
      const checkpointDone = performance.now();
      const startupReads = { ...reads }, captureScope = { ...scope };
      collector = await FileArtifactCollector.start({ cwd });
      const baselineDone = performance.now();
      reads = counters();
      const checkpoint = await history.finishTurn("complete");
      const checkpointFinished = performance.now();
      await collector.finish("complete");
      const sample = { run, case: run === 1 ? "initial-backup" : "unchanged",
        checkpointMs: checkpointDone - start, artifactMs: baselineDone - checkpointDone,
        preparationMs: baselineDone - start, finishCheckpointMs: checkpointFinished - baselineDone,
        finalizationMs: performance.now() - baselineDone, changes: checkpoint?.changes.length,
        ...captureScope, startupReads, finishReads: { ...reads } };
      if (checkpoint?.changes.length !== 0) throw new Error("Workspace changed during the benchmark; repeat with an unchanged workspace.");
      samples.push(sample);
      console.log(JSON.stringify(sample));
    } finally { await history.finishTurn("incomplete"); collector?.dispose(); }
  }
  const median = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const warm = samples.slice(1);
  const result = { node: process.version, platform: process.platform, arch: process.arch,
    workspace: cwd, implementation: fileURLToPath(implementation), runs, samples,
    unchangedMedian: { checkpointMs: median(warm.map(run => run.checkpointMs)),
      artifactMs: median(warm.map(run => run.artifactMs)), preparationMs: median(warm.map(run => run.preparationMs)),
      finishCheckpointMs: median(warm.map(run => run.finishCheckpointMs)) } };
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ unchangedMedian: result.unchangedMedian }));
} finally { await rm(home, { recursive: true, force: true }); }
