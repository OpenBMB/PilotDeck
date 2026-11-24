import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CronRuntimeLogger } from "../runtime/CronRuntime.js";
import { cronRunEventsPath, resolveCronPaths } from "./CronPaths.js";

type JsonRecord = Record<string, unknown>;

type StoreSnapshot = {
  dir: string;
  tasks: unknown[];
  taskFileWritable: boolean;
  invalidRunLines: string[];
  runs: JsonRecord[];
};

const LOCK_STALE_MS = 10 * 60_000;

export async function migrateCronStores(input: {
  pilotHome: string;
  logger?: CronRuntimeLogger;
}): Promise<void> {
  const rootDir = resolve(input.pilotHome, "cron");
  const releaseLock = await acquireMigrationLock(rootDir, input.logger);
  try {
    const snapshots = await readSnapshots(resolve(rootDir, "projects"));
    if (snapshots.length === 0) return;

    const blockedTaskDirs = new Set(
      snapshots.filter((snapshot) => !snapshot.taskFileWritable).map((snapshot) => snapshot.dir),
    );
    for (const projectDir of blockedTaskDirs) {
      input.logger?.warn("cron migration preserved an unreadable task store", { projectDir });
    }
    const taskProjects = buildTaskProjectIndex(snapshots);
    const finalTasks = new Map<string, unknown[]>();
    const finalRuns = new Map<string, { records: JsonRecord[]; invalidLines: string[] }>();
    const runTargets = new Map<string, Set<string>>();

    for (const snapshot of snapshots) {
      for (const task of snapshot.tasks) {
        const targetDir = resolveTaskTargetDir(
          input.pilotHome,
          snapshot.dir,
          task,
          blockedTaskDirs,
        );
        pushMapArray(finalTasks, targetDir, task);
      }
      for (const line of snapshot.invalidRunLines) {
        const bucket = getRunBucket(finalRuns, snapshot.dir);
        bucket.invalidLines.push(line);
      }
      for (const run of snapshot.runs) {
        const targetDir = resolveRunTargetDir(
          input.pilotHome,
          snapshot.dir,
          run,
          taskProjects,
          blockedTaskDirs,
        );
        getRunBucket(finalRuns, targetDir).records.push(run);
        if (typeof run.runId === "string") {
          const targets = runTargets.get(run.runId) ?? new Set<string>();
          targets.add(targetDir);
          runTargets.set(run.runId, targets);
        }
      }
    }

    for (const snapshot of snapshots) {
      if (!finalTasks.has(snapshot.dir)) finalTasks.set(snapshot.dir, []);
      if (!finalRuns.has(snapshot.dir)) {
        finalRuns.set(snapshot.dir, { records: [], invalidLines: [] });
      }
    }

    for (const [dir, tasks] of finalTasks) {
      finalTasks.set(dir, dedupeTasks(tasks, input.logger, dir));
    }
    for (const [dir, bucket] of finalRuns) {
      bucket.records = dedupeRuns(bucket.records);
    }

    await stageDestinationData(snapshots, finalTasks, finalRuns);
    await migrateRunEvents(snapshots, runTargets, input.logger);
    await writeFinalSnapshots(snapshots, finalTasks, finalRuns);
    await writeFile(
      resolve(rootDir, "store-migration-v2.json"),
      `${JSON.stringify({ version: 2, completedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf-8",
    );
  } finally {
    await releaseLock();
  }
}

async function readSnapshots(projectsDir: string): Promise<StoreSnapshot[]> {
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots: StoreSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(projectsDir, entry.name);
    snapshots.push({
      dir,
      ...(await readTasks(resolve(dir, "tasks.json"))),
      ...(await readRuns(resolve(dir, "run-history.jsonl"))),
    });
  }
  return snapshots;
}

async function readTasks(
  path: string,
): Promise<Pick<StoreSnapshot, "tasks" | "taskFileWritable">> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { schemaVersion?: unknown; tasks?: unknown } | null;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
      return { tasks: [], taskFileWritable: false };
    }
    return { tasks: parsed.tasks, taskFileWritable: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { tasks: [], taskFileWritable: true };
    }
    return { tasks: [], taskFileWritable: false };
  }
}

async function readRuns(path: string): Promise<Pick<StoreSnapshot, "runs" | "invalidRunLines">> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { runs: [], invalidRunLines: [] };
    }
    throw error;
  }
  const runs: JsonRecord[] = [];
  const invalidRunLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        runs.push(parsed as JsonRecord);
      } else {
        invalidRunLines.push(line);
      }
    } catch {
      invalidRunLines.push(line);
    }
  }
  return { runs, invalidRunLines };
}

function buildTaskProjectIndex(snapshots: StoreSnapshot[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    for (const task of snapshot.tasks) {
      if (!isRecord(task) || typeof task.taskId !== "string") continue;
      const projectKey = normalizedProjectKey(task.projectKey);
      if (!projectKey) continue;
      const projects = index.get(task.taskId) ?? new Set<string>();
      projects.add(projectKey);
      index.set(task.taskId, projects);
    }
  }
  return index;
}

function resolveTaskTargetDir(
  pilotHome: string,
  sourceDir: string,
  task: unknown,
  blockedTaskDirs: Set<string>,
): string {
  if (!isRecord(task)) return sourceDir;
  const projectKey = normalizedProjectKey(task.projectKey);
  const targetDir = projectKey
    ? resolveCronPaths({ pilotHome, projectKey }).projectDir
    : sourceDir;
  return blockedTaskDirs.has(targetDir) ? sourceDir : targetDir;
}

function resolveRunTargetDir(
  pilotHome: string,
  sourceDir: string,
  run: JsonRecord,
  taskProjects: Map<string, Set<string>>,
  blockedTaskDirs: Set<string>,
): string {
  const explicitProject = normalizedProjectKey(run.projectKey);
  if (explicitProject) {
    const targetDir = resolveCronPaths({ pilotHome, projectKey: explicitProject }).projectDir;
    return blockedTaskDirs.has(targetDir) ? sourceDir : targetDir;
  }
  if (typeof run.taskId !== "string") return sourceDir;
  const projects = taskProjects.get(run.taskId);
  if (projects?.size !== 1) return sourceDir;
  const targetDir = resolveCronPaths({ pilotHome, projectKey: [...projects][0] }).projectDir;
  return blockedTaskDirs.has(targetDir) ? sourceDir : targetDir;
}

async function stageDestinationData(
  snapshots: StoreSnapshot[],
  finalTasks: Map<string, unknown[]>,
  finalRuns: Map<string, { records: JsonRecord[]; invalidLines: string[] }>,
): Promise<void> {
  const originals = new Map(snapshots.map((snapshot) => [snapshot.dir, snapshot]));
  for (const [dir, tasks] of finalTasks) {
    const original = originals.get(dir);
    if (original && !original.taskFileWritable) continue;
    // Preserve every source record until all destinations have been written.
    const existing = original?.tasks ?? [];
    const additions = findUnstagedRecords(existing, tasks);
    if (additions.length > 0) await writeTaskFile(dir, [...existing, ...additions]);
  }
  for (const [dir, bucket] of finalRuns) {
    const original = originals.get(dir);
    const existing = original?.runs ?? [];
    const additions = findUnstagedRecords(existing, bucket.records);
    if (additions.length === 0) continue;
    await writeRunFile(dir, {
      records: [...existing, ...additions],
      invalidLines: original?.invalidRunLines ?? [],
    });
  }
}

function findUnstagedRecords<T>(existing: T[], records: T[]): T[] {
  const saved = new Set(existing.map((record) => JSON.stringify(record)));
  return records.filter((record) => !saved.has(JSON.stringify(record)));
}

async function writeFinalSnapshots(
  snapshots: StoreSnapshot[],
  finalTasks: Map<string, unknown[]>,
  finalRuns: Map<string, { records: JsonRecord[]; invalidLines: string[] }>,
): Promise<void> {
  const originals = new Map(snapshots.map((snapshot) => [snapshot.dir, snapshot]));
  for (const [dir, tasks] of finalTasks) {
    const original = originals.get(dir);
    if (original && !original.taskFileWritable) continue;
    await writeTaskFile(dir, tasks);
  }
  for (const [dir, bucket] of finalRuns) {
    await writeRunFile(dir, bucket);
  }
}

async function writeTaskFile(dir: string, tasks: unknown[]): Promise<void> {
  const migratedTasks = tasks.map(task => isRecord(task) && task.mode === "plan" ? { ...task, mode: "default" } : task);
  await atomicWrite(
    resolve(dir, "tasks.json"),
    `${JSON.stringify({ schemaVersion: 1, tasks: migratedTasks }, null, 2)}\n`,
  );
}

async function writeRunFile(
  dir: string,
  bucket: { records: JsonRecord[]; invalidLines: string[] },
): Promise<void> {
  const lines = [
    ...bucket.records.map((record) => JSON.stringify(record)),
    ...bucket.invalidLines,
  ];
  await atomicWrite(resolve(dir, "run-history.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
}

async function migrateRunEvents(
  snapshots: StoreSnapshot[],
  runTargets: Map<string, Set<string>>,
  logger?: CronRuntimeLogger,
): Promise<void> {
  for (const snapshot of snapshots) {
    for (const run of snapshot.runs) {
      if (typeof run.runId !== "string") continue;
      const targets = runTargets.get(run.runId);
      if (!targets || targets.size !== 1) continue;
      const targetDir = [...targets][0];
      if (targetDir === snapshot.dir) continue;
      const sourcePath = cronRunEventsPath(pathsForDir(snapshot.dir), run.runId);
      const targetPath = cronRunEventsPath(pathsForDir(targetDir), run.runId);
      let sourceRaw: string;
      try {
        sourceRaw = await readFile(sourcePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let targetRaw = "";
      try {
        targetRaw = await readFile(targetPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const merged = mergeJsonLines(targetRaw, sourceRaw);
      await atomicWrite(targetPath, merged);
      await unlink(sourcePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          logger?.warn("cron migration could not remove source run event file", {
            sourcePath,
            error: error.message,
          });
        }
      });
    }
  }
}

function pathsForDir(projectDir: string) {
  return {
    pilotHome: "",
    projectKey: "",
    projectId: "",
    rootDir: resolve(projectDir, "..", ".."),
    projectDir,
    tasksFile: resolve(projectDir, "tasks.json"),
    runsDir: resolve(projectDir, "runs"),
    runHistoryFile: resolve(projectDir, "run-history.jsonl"),
  };
}

function dedupeTasks(
  tasks: unknown[],
  logger: CronRuntimeLogger | undefined,
  projectDir: string,
): unknown[] {
  const anonymous: unknown[] = [];
  const byId = new Map<string, unknown>();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.taskId !== "string") {
      anonymous.push(task);
      continue;
    }
    const current = byId.get(task.taskId);
    if (!current || compareUpdatedAt(task, current) >= 0) {
      if (current) {
        logger?.warn("cron migration resolved duplicate task", {
          taskId: task.taskId,
          projectDir,
        });
      }
      byId.set(task.taskId, task);
    }
  }
  return [...byId.values(), ...anonymous];
}

function dedupeRuns(runs: JsonRecord[]): JsonRecord[] {
  const anonymous: JsonRecord[] = [];
  const byId = new Map<string, JsonRecord>();
  for (const run of runs) {
    if (typeof run.runId !== "string") {
      anonymous.push(run);
      continue;
    }
    const current = byId.get(run.runId);
    if (!current || compareRun(run, current) >= 0) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values(), ...anonymous].sort((left, right) =>
    String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
}

function compareUpdatedAt(left: JsonRecord, right: unknown): number {
  const rightRecord = isRecord(right) ? right : {};
  return String(left.updatedAt ?? "").localeCompare(String(rightRecord.updatedAt ?? ""));
}

function compareRun(left: JsonRecord, right: JsonRecord): number {
  const leftTerminal = typeof left.finishedAt === "string" ? 1 : 0;
  const rightTerminal = typeof right.finishedAt === "string" ? 1 : 0;
  if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
  return String(left.finishedAt ?? left.startedAt ?? "")
    .localeCompare(String(right.finishedAt ?? right.startedAt ?? ""));
}

function mergeJsonLines(left: string, right: string): string {
  const lines = new Set(
    `${left}\n${right}`.split("\n").filter((line) => line.trim().length > 0),
  );
  return lines.size ? `${[...lines].join("\n")}\n` : "";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  try {
    await rename(tempPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      await copyFile(tempPath, path);
      await unlink(tempPath).catch(() => undefined);
      return;
    }
    throw error;
  }
}

async function acquireMigrationLock(
  rootDir: string,
  logger?: CronRuntimeLogger,
): Promise<() => Promise<void>> {
  await mkdir(rootDir, { recursive: true });
  const lockPath = resolve(rootDir, ".store-migration.lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number;
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > LOCK_STALE_MS) {
        logger?.warn("cron store migration removed a stale lock", { lockPath, ageMs: age });
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`Timed out waiting for Cron store migration lock: ${lockPath}`);
}

function normalizedProjectKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? resolve(value) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pushMapArray(map: Map<string, unknown[]>, key: string, value: unknown): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function getRunBucket(
  map: Map<string, { records: JsonRecord[]; invalidLines: string[] }>,
  key: string,
): { records: JsonRecord[]; invalidLines: string[] } {
  const bucket = map.get(key) ?? { records: [], invalidLines: [] };
  map.set(key, bucket);
  return bucket;
}
