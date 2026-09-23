import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile, lstat, mkdir, readlink, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type LegalStorageConfig = {
  root: string;
  database?: { url?: string; schema?: string; table?: string };
  snapshotRoot?: string;
  objectPrefix?: string;
  storageConfigVersion?: string;
};

export function resolveLegalStorageConfig(
  env: Record<string, string | undefined> = process.env,
): LegalStorageConfig | undefined {
  const root = env.PILOTDECK_LEGAL_STORAGE_ROOT?.trim();
  if (!root) return undefined;
  return {
    root: resolve(root),
    snapshotRoot: env.PILOTDECK_LEGAL_SNAPSHOT_ROOT?.trim() || resolve(root),
    database: {
      url: env.PILOTDECK_LEGAL_DATABASE_URL?.trim() || undefined,
      schema: env.PILOTDECK_LEGAL_DATABASE_SCHEMA?.trim() || undefined,
      table: env.PILOTDECK_LEGAL_DATABASE_TABLE?.trim() || undefined,
    },
    storageConfigVersion: env.PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION?.trim() || "env",
    objectPrefix: env.PILOTDECK_LEGAL_OBJECT_PREFIX?.trim() || undefined,
  };
}

export type InvocationLogContext = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  logicalCallId: string;
  caller: "agent" | "subagent" | "router_judge";
  subSessionId?: string;
  parentToolCallId?: string;
  storageConfigVersion?: string;
};

export type InvocationLogRecord = InvocationLogContext & {
  requestLogId: string;
  requestId: string;
  attempt: number;
  provider: string;
  protocol: string;
  model: string;
  stream: boolean;
  requestBody: string;
  responseBody?: string;
  requestBytes: number;
  responseBytes?: number;
  httpStatus?: number;
  outcome: "success" | "provider_error" | "transport_error" | "aborted" | "timeout" | "incomplete";
  responseComplete: boolean;
  startedAt: string;
  completedAt: string;
  retryReason?: string;
  storageConfigVersion?: string;
};

export type ModelInvocationLogSink = {
  stage(record: InvocationLogRecord): void;
  append(record: InvocationLogRecord): Promise<void>;
};

export class JsonlInvocationLogSink implements ModelInvocationLogSink {
  private writeTail: Promise<void> = Promise.resolve();
  private readonly appended = new Set<string>();

  constructor(private readonly config: LegalStorageConfig) {}

  stage(record: InvocationLogRecord): void {
    const path = this.pathFor(record);
    const pendingDir = join(dirname(path), ".pending");
    mkdirSync(pendingDir, { recursive: true });
    const stagedPath = join(pendingDir, `${safePart(record.requestLogId)}.json`);
    const temporaryPath = `${stagedPath}.tmp-${randomUUID()}`;
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(temporaryPath, "wx");
      writeFileSync(fileDescriptor, JSON.stringify(record), "utf8");
      fsyncSync(fileDescriptor);
      const completedDescriptor = fileDescriptor;
      fileDescriptor = undefined;
      closeSync(completedDescriptor);
      renameSync(temporaryPath, stagedPath);
      if (process.platform !== "win32") {
        const directoryDescriptor = openSync(pendingDir, "r");
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be renamed.
      }
      throw error;
    }
  }

  async append(record: InvocationLogRecord): Promise<void> {
    return this.enqueue(async () => {
      if (this.appended.has(record.requestLogId)) return;
      const path = this.pathFor(record);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
      await unlink(join(dirname(path), ".pending", `${safePart(record.requestLogId)}.json`)).catch(() => undefined);
      this.appended.add(record.requestLogId);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(operation);
    this.writeTail = next.catch(() => undefined);
    return next;
  }

  private pathFor(record: InvocationLogRecord): string {
    const workspace = safePart(record.workspaceId);
    const session = safePart(record.sessionId);
    return join(this.config.root, "workspaces", workspace, "sessions", session, "llm", "invocations.jsonl");
  }
}

export type WorkspaceSnapshotInput = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  roundNumber?: number;
  workspaceDir: string;
  workspaceStable?: boolean;
  failureKind?: WorkspaceSnapshotFailureKind;
  failureReason?: string;
};

export type WorkspaceSnapshotFailureKind =
  | "timeout"
  | "interrupted"
  | "agent_error"
  | "gateway_error"
  | "unknown";

export type WorkspaceSnapshotResult = {
  snapshotId: string;
  phase: "pre_user" | "post_agent";
  state: "committed" | "failed";
  abnormal?: boolean;
  roundStatus?: "captured" | "failed" | "aborted";
  failureKind?: WorkspaceSnapshotFailureKind;
  failureReason?: string;
  manifestPath?: string;
  failureMarkerPath?: string;
  error?: string;
};

type SnapshotEntry = {
  path: string;
  entryType: "file" | "symlink";
  size: number;
  md5?: string;
  objectKey?: string;
  linkTarget?: string;
};

export type WorkspaceSnapshotRecorder = {
  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
};

export class ContentAddressedWorkspaceSnapshotRecorder implements WorkspaceSnapshotRecorder {
  private readonly completed = new Map<string, WorkspaceSnapshotResult>();
  private readonly inFlight = new Map<string, Promise<WorkspaceSnapshotResult>>();

  constructor(private readonly config: LegalStorageConfig) {}

  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "pre_user", "captured");
  }

  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "post_agent", input.failureKind === "interrupted" ? "aborted" : "failed");
  }

  private async capture(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
    roundStatus: "captured" | "failed" | "aborted",
  ): Promise<WorkspaceSnapshotResult> {
    const key = `${input.sessionId}\0${input.turnId}\0${phase}`;
    const prior = this.completed.get(key);
    if (prior) return prior;
    const active = this.inFlight.get(key);
    if (active) return active;

    const operation = this.captureOnce(input, phase, roundStatus);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async captureOnce(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
    roundStatus: "captured" | "failed" | "aborted",
  ): Promise<WorkspaceSnapshotResult> {
    const key = `${input.sessionId}\0${input.turnId}\0${phase}`;
    const snapshotId = randomUUID();
    const snapshotRoot = resolve(this.config.snapshotRoot ?? this.config.root);
    const partition = join(snapshotRoot, "workspaces", safePart(input.workspaceId), "sessions", safePart(input.sessionId), "snapshots", snapshotId);
    const temp = join(partition, ".tmp");
    const manifestPath = join(partition, "manifest.json");
    const abnormal = phase === "post_agent";
    try {
      await mkdir(join(snapshotRoot, "objects", "md5"), { recursive: true });
      await mkdir(temp, { recursive: true });
      if (input.workspaceStable === false) {
        throw new Error("Workspace did not finish unwinding before snapshot capture");
      }
      const entries = await this.scanWorkspace(resolve(input.workspaceDir), snapshotRoot);
      const manifest = {
        snapshotId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        roundNumber: input.roundNumber,
        phase,
        abnormal,
        roundStatus,
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        storageConfigVersion: this.config.storageConfigVersion,
        entries,
        createdAt: new Date().toISOString(),
      };
      const temporaryManifest = join(temp, "manifest.json");
      await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
      await rename(temporaryManifest, manifestPath);
      await writeFile(join(partition, "_COMMITTED"), "", "utf8");
      await rm(temp, { recursive: true, force: true });
      const result = {
        snapshotId,
        phase,
        state: "committed" as const,
        abnormal,
        roundStatus,
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        manifestPath,
      };
      this.completed.set(key, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await unlink(manifestPath).catch(() => undefined);
      await unlink(join(partition, "_COMMITTED")).catch(() => undefined);
      const failureMarkerPath = await this.writeFailureMarker(partition, {
        snapshotId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        phase,
        abnormal,
        roundStatus,
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        state: "failed",
        error: message,
        createdAt: new Date().toISOString(),
      });
      const result = {
        snapshotId,
        phase,
        state: "failed" as const,
        abnormal,
        roundStatus,
        failureKind: input.failureKind,
        failureReason: input.failureReason,
        failureMarkerPath,
        error: message,
      };
      this.completed.set(key, result);
      return result;
    }
  }

  private async writeFailureMarker(partition: string, marker: object): Promise<string | undefined> {
    const markerPath = join(partition, "_FAILED.json");
    const temporary = join(partition, `.failed-${randomUUID()}.tmp`);
    try {
      await mkdir(partition, { recursive: true });
      await writeFile(temporary, JSON.stringify(marker, null, 2), "utf8");
      await rename(temporary, markerPath);
      return markerPath;
    } catch {
      await unlink(temporary).catch(() => undefined);
      return undefined;
    }
  }

  private async scanWorkspace(workspaceDir: string, snapshotRoot: string): Promise<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const absolute = join(directory, name);
        const relativePath = relative(workspaceDir, absolute).split(sep).join("/");
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          const target = await readlink(absolute);
          entries.push({ path: relativePath, entryType: "symlink", size: 0, linkTarget: target });
          continue;
        }
        if (info.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!info.isFile()) continue;
        const stored = await storeContentAddressedFile(absolute, snapshotRoot);
        entries.push({
          path: relativePath,
          entryType: "file",
          size: stored.size,
          md5: stored.digest,
          objectKey: stored.objectKey,
        });
      }
    };
    await visit(workspaceDir);
    return entries;
  }
}

async function storeContentAddressedFile(
  sourcePath: string,
  snapshotRoot: string,
): Promise<{ digest: string; size: number; objectKey: string }> {
  const objectRoot = join(snapshotRoot, "objects", "md5");
  await mkdir(objectRoot, { recursive: true });
  const temporary = join(objectRoot, `.tmp-${randomUUID()}`);
  const hash = createHash("md5");
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
    const objectKey = `objects/md5/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
    const objectPath = join(snapshotRoot, objectKey);
    await mkdir(dirname(objectPath), { recursive: true });
    try {
      const existing = await lstat(objectPath);
      if (!existing.isFile() || existing.size !== size || await md5File(objectPath) !== digest) {
        throw new Error(`Snapshot object verification failed: ${objectKey}`);
      }
      await unlink(temporary);
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          await rename(temporary, objectPath);
        } catch (renameError) {
          try {
            const raced = await lstat(objectPath);
            if (!raced.isFile() || raced.size !== size || await md5File(objectPath) !== digest) {
              throw renameError;
            }
            await unlink(temporary);
          } catch (verificationError) {
            throw isMissingFileError(verificationError) ? renameError : verificationError;
          }
        }
      } else {
        throw error;
      }
    }
    return { digest, size, objectKey };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function safePart(value: string): string {
  const raw = value.trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid storage identity");
  }
  const part = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!part || part === "." || part === "..") throw new Error("Invalid storage identity");
  return part;
}
