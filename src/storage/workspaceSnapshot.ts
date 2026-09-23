import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type WorkspaceSnapshotConfig = {
  root: string;
  snapshotRoot: string;
};

export function resolveWorkspaceSnapshotConfig(
  env: Record<string, string | undefined> = process.env,
): WorkspaceSnapshotConfig | undefined {
  const root = env.PILOTDECK_LEGAL_STORAGE_ROOT?.trim();
  if (!root) return undefined;
  return {
    root: resolve(root),
    snapshotRoot: resolve(env.PILOTDECK_LEGAL_SNAPSHOT_ROOT?.trim() || root),
  };
}

export type WorkspaceSnapshotFailureKind =
  | "timeout"
  | "interrupted"
  | "agent_error"
  | "gateway_error"
  | "unknown";

export type WorkspaceSnapshotInput = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  workspaceDir: string;
  workspaceStable?: boolean;
  failureKind?: WorkspaceSnapshotFailureKind;
  failureReason?: string;
};

export type WorkspaceSnapshotResult = {
  snapshotId: string;
  phase: "pre_user" | "post_agent";
  state: "committed" | "failed";
  manifestPath?: string;
  failureMarkerPath?: string;
  error?: string;
};

export type WorkspaceSnapshotRecorder = {
  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
};

export type WorkspaceSnapshotDescriptor = {
  snapshotId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  phase: "pre_user" | "post_agent";
  state: "committed" | "failed";
  createdAt?: string;
  manifestPath: string;
};

export type WorkspaceSnapshotProvider = {
  list(): Promise<WorkspaceSnapshotDescriptor[]>;
  get(snapshotId: string): Promise<Record<string, unknown> | undefined>;
  restore(snapshotId: string, targetRoot: string): Promise<{ restored: boolean; workspaceKey: string }>;
};

export function createWorkspaceSnapshotProvider(config: WorkspaceSnapshotConfig): WorkspaceSnapshotProvider {
  return {
    async list() {
      const results: WorkspaceSnapshotDescriptor[] = [];
      await walkSnapshotManifests(resolve(config.snapshotRoot), async (manifestPath, manifest) => {
        if (typeof manifest.snapshotId !== "string" || typeof manifest.workspaceId !== "string"
          || typeof manifest.sessionId !== "string" || typeof manifest.turnId !== "string"
          || typeof manifest.runId !== "string" || (manifest.phase !== "pre_user" && manifest.phase !== "post_agent")) return;
        results.push({
          snapshotId: manifest.snapshotId,
          workspaceId: manifest.workspaceId,
          sessionId: manifest.sessionId,
          turnId: manifest.turnId,
          runId: manifest.runId,
          phase: manifest.phase,
          state: "committed",
          ...(typeof manifest.createdAt === "string" ? { createdAt: manifest.createdAt } : {}),
          manifestPath,
        });
      });
      return results.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
    },
    async get(snapshotId) {
      const found = await findSnapshotManifest(resolve(config.snapshotRoot), snapshotId);
      return found ? found.manifest : undefined;
    },
    async restore(snapshotId, targetRoot) {
      const found = await findSnapshotManifest(resolve(config.snapshotRoot), snapshotId);
      if (!found) throw new Error(`Snapshot ${snapshotId} was not found.`);
      const entries = Array.isArray(found.manifest.entries) ? found.manifest.entries as Array<Record<string, unknown>> : [];
      const destination = resolve(targetRoot);
      await mkdir(destination, { recursive: true });
      for (const entry of entries) {
        if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
          throw new Error("Snapshot contains an unsafe relative path.");
        }
        const output = resolve(destination, entry.path);
        if (!output.startsWith(`${destination}${sep}`) && output !== destination) throw new Error("Snapshot path escapes target workspace.");
        await mkdir(dirname(output), { recursive: true });
        if (entry.entryType === "symlink" && typeof entry.linkTarget === "string") {
          await rm(output, { force: true }).catch(() => undefined);
          await symlink(entry.linkTarget, output);
        } else if (entry.entryType === "file" && typeof entry.objectKey === "string") {
          const source = resolve(config.snapshotRoot, entry.objectKey);
          await writeFile(output, await readFile(source));
        }
      }
      return { restored: true, workspaceKey: destination };
    },
  };
}

async function walkSnapshotManifests(root: string, visit: (path: string, manifest: Record<string, unknown>) => Promise<void>): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) await walkSnapshotManifests(path, visit);
    else if (name === "manifest.json") {
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await visit(path, manifest);
    }
  }
}

async function findSnapshotManifest(root: string, snapshotId: string): Promise<{ manifestPath: string; manifest: Record<string, unknown> } | undefined> {
  let result: { manifestPath: string; manifest: Record<string, unknown> } | undefined;
  await walkSnapshotManifests(root, async (manifestPath, manifest) => {
    if (manifest.snapshotId === snapshotId) result = { manifestPath, manifest };
  });
  return result;
}

type SnapshotEntry = {
  path: string;
  entryType: "file" | "symlink";
  size: number;
  digest?: string;
  objectKey?: string;
  linkTarget?: string;
};

export class ContentAddressedWorkspaceSnapshotRecorder implements WorkspaceSnapshotRecorder {
  private readonly completed = new Map<string, WorkspaceSnapshotResult>();
  private readonly inFlight = new Map<string, Promise<WorkspaceSnapshotResult>>();

  constructor(private readonly config: WorkspaceSnapshotConfig) {}

  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "pre_user");
  }

  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "post_agent");
  }

  private async capture(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
  ): Promise<WorkspaceSnapshotResult> {
    const key = `${input.sessionId}\0${input.turnId}\0${phase}`;
    const completed = this.completed.get(key);
    if (completed) return completed;
    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;

    const operation = this.captureOnce(input, phase);
    this.inFlight.set(key, operation);
    try {
      const result = await operation;
      this.completed.set(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async captureOnce(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
  ): Promise<WorkspaceSnapshotResult> {
    const snapshotId = createHash("sha256")
      .update(`${input.sessionId}\0${input.turnId}\0${phase}`)
      .digest("hex");
    const snapshotRoot = resolve(this.config.snapshotRoot);
    const partition = join(
      snapshotRoot,
      "workspaces",
      safePart(input.workspaceId),
      "sessions",
      safePart(input.sessionId),
      "snapshots",
      snapshotId,
    );
    const manifestPath = join(partition, "manifest.json");
    const committedPath = join(partition, "_COMMITTED");
    const failureMarkerPath = join(partition, "_FAILED.json");

    if (await exists(committedPath)) {
      return { snapshotId, phase, state: "committed", manifestPath };
    }
    if (await exists(failureMarkerPath)) {
      const error = await readFailureMessage(failureMarkerPath);
      return { snapshotId, phase, state: "failed", failureMarkerPath, error };
    }

    const temporaryDir = join(partition, `.tmp-${randomUUID()}`);
    try {
      if (input.workspaceStable === false) {
        throw new Error("Workspace did not become quiescent before snapshot capture.");
      }
      await mkdir(temporaryDir, { recursive: true });
      const entries = await this.scanWorkspace(resolve(input.workspaceDir), snapshotRoot);
      const manifest = {
        snapshotId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        phase,
        abnormal: phase === "post_agent",
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        entries,
        createdAt: new Date().toISOString(),
      };
      const temporaryManifest = join(temporaryDir, "manifest.json");
      await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
      await mkdir(partition, { recursive: true });
      await rename(temporaryManifest, manifestPath);
      await atomicMarker(committedPath, "");
      await rm(temporaryDir, { recursive: true, force: true });
      return { snapshotId, phase, state: "committed", manifestPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await unlink(manifestPath).catch(() => undefined);
      await unlink(committedPath).catch(() => undefined);
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(partition, { recursive: true });
      await atomicMarker(failureMarkerPath, JSON.stringify({
        snapshotId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        phase,
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        state: "failed",
        error: message,
        createdAt: new Date().toISOString(),
      }, null, 2));
      return { snapshotId, phase, state: "failed", failureMarkerPath, error: message };
    }
  }

  private async scanWorkspace(workspaceDir: string, snapshotRoot: string): Promise<SnapshotEntry[]> {
    const rootRelation = relative(workspaceDir, snapshotRoot);
    if (rootRelation === "") {
      throw new Error("Snapshot root must not be the workspace root.");
    }
    const snapshotInsideWorkspace = !rootRelation.startsWith(`..${sep}`) && rootRelation !== "..";
    const entries: SnapshotEntry[] = [];

    const visit = async (directory: string): Promise<void> => {
      const names = await readdir(directory);
      names.sort();
      for (const name of names) {
        const absolute = join(directory, name);
        if (snapshotInsideWorkspace && (absolute === snapshotRoot || absolute.startsWith(`${snapshotRoot}${sep}`))) {
          continue;
        }
        const path = relative(workspaceDir, absolute).split(sep).join("/");
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          entries.push({ path, entryType: "symlink", size: 0, linkTarget: await readlink(absolute) });
        } else if (info.isDirectory()) {
          await visit(absolute);
        } else if (info.isFile()) {
          const stored = await this.storeFile(absolute, snapshotRoot);
          entries.push({ path, entryType: "file", size: stored.size, digest: stored.digest, objectKey: stored.objectKey });
        }
      }
    };

    await visit(workspaceDir);
    return entries;
  }

  private async storeFile(
    sourcePath: string,
    snapshotRoot: string,
  ): Promise<{ digest: string; size: number; objectKey: string }> {
    const objectRoot = join(snapshotRoot, "objects", "sha256");
    await mkdir(objectRoot, { recursive: true });
    const temporary = join(objectRoot, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(sourcePath),
        hashingStream,
        createWriteStream(temporary, { flags: "wx" }),
      );
      const digest = hash.digest("hex");
      const objectKey = `objects/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
      const objectPath = join(snapshotRoot, objectKey);
      await mkdir(dirname(objectPath), { recursive: true });
      if (await exists(objectPath)) {
        await unlink(temporary);
        return { digest, size, objectKey };
      }
      try {
        await rename(temporary, objectPath);
      } catch (error) {
        if (!await exists(objectPath)) throw error;
        await unlink(temporary).catch(() => undefined);
      }
      return { digest, size, objectKey };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

async function atomicMarker(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function readFailureMessage(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { error?: unknown };
    return typeof value.error === "string" ? value.error : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function safePart(value: string): string {
  const raw = value.trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error("Invalid snapshot identity.");
  }
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid snapshot identity.");
  return safe;
}
