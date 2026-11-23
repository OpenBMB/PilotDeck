import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { FileVersion } from "./types.js";

export type CaptureWorkerRequest = {
  target: string;
  objectsDir: string;
  maxFileBytes: number;
  save: boolean;
};

type WorkerMessage = {
  id: number;
  ok: boolean;
  result?: FileVersion;
  error?: { code?: string; message: string };
};

const WORKER_SCRIPT = `
const { parentPort } = require("node:worker_threads");
const { createHash, randomUUID } = require("node:crypto");
const { constants, promises: fs } = require("node:fs");
const path = require("node:path");

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

async function putObjectIfMissing(objectsDir, content) {
  const hash = digest(content);
  const destination = path.join(objectsDir, hash);
  try {
    await fs.access(destination);
    return hash;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await fs.mkdir(objectsDir, { recursive: true, mode: 0o700 });
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return hash;
}

async function captureTarget({ target, objectsDir, maxFileBytes, save }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let before;
    try {
      before = await fs.lstat(target);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { kind: "absent" };
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      return {
        kind: "unprotected",
        reason: "Symbolic links and non-regular files are not restored automatically.",
        fingerprint: digest(Buffer.from(JSON.stringify([
          before.dev,
          before.ino,
          before.mode,
          before.size,
          before.mtimeMs,
          before.ctimeMs,
          before.isSymbolicLink() ? await fs.readlink(target) : null,
        ]))),
      };
    }
    if (before.size > maxFileBytes) {
      return {
        kind: "unprotected",
        reason: "File exceeds the 10 MB checkpoint limit.",
        fingerprint: digest(Buffer.from(JSON.stringify([
          before.dev,
          before.ino,
          before.mode,
          before.size,
          before.mtimeMs,
          before.ctimeMs,
          null,
        ]))),
      };
    }
    let content;
    try {
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino) continue;
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      if (hasCode(error, "ELOOP")) {
        return { kind: "unprotected", reason: "File was replaced with a symbolic link." };
      }
      throw error;
    }
    let after;
    try {
      after = await fs.lstat(target);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      continue;
    }
    const hash = save ? await putObjectIfMissing(objectsDir, content) : digest(content);
    return {
      kind: "file",
      hash,
      size: content.length,
      mode: before.mode & 0o777,
      binary: content.includes(0),
      fingerprint: digest(Buffer.from(JSON.stringify([
        before.dev,
        before.ino,
        before.size,
        before.mode,
        before.mtimeMs,
        before.ctimeMs,
      ]))),
    };
  }
  return { kind: "unprotected", reason: "File changed while its checkpoint was being captured." };
}

parentPort.on("message", async (message) => {
  const { id, payload } = message;
  try {
    const result = await captureTarget(payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        code: error && typeof error === "object" ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
`;

const IDLE_SHUTDOWN_MS = 10_000;

class CheckpointWorkerSlot {
  readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: FileVersion) => void; reject: (e: Error) => void }>();

  constructor(private readonly onExit: (slot: CheckpointWorkerSlot) => void) {
    this.worker = new Worker(WORKER_SCRIPT, { eval: true });
    this.worker.unref();
    this.worker.on("message", (msg: WorkerMessage) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) {
        entry.resolve(msg.result);
      } else {
        const err = new Error(msg.error?.message ?? "Checkpoint worker failed");
        if (msg.error?.code) {
          (err as NodeJS.ErrnoException).code = msg.error.code;
        }
        entry.reject(err);
      }
    });
    this.worker.on("error", (error) => {
      for (const entry of this.pending.values()) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
      this.onExit(this);
    });
    this.worker.on("exit", () => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error("Checkpoint worker exited unexpectedly."));
      }
      this.pending.clear();
      this.onExit(this);
    });
  }

  get activeCount(): number {
    return this.pending.size;
  }

  run(id: number, payload: CaptureWorkerRequest): Promise<FileVersion> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, payload });
    });
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

class CheckpointWorkerPool {
  private readonly maxWorkers: number;
  private slots: CheckpointWorkerSlot[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(maxWorkers = Math.min(4, Math.max(2, os.cpus().length - 1))) {
    this.maxWorkers = maxWorkers;
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const totalActive = this.slots.reduce((sum, s) => sum + s.activeCount, 0);
      if (totalActive === 0) {
        const toStop = this.slots;
        this.slots = [];
        for (const slot of toStop) {
          slot.terminate();
        }
      } else {
        this.scheduleIdleShutdown();
      }
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private pickSlot(): CheckpointWorkerSlot {
    if (this.slots.length < this.maxWorkers) {
      const created = new CheckpointWorkerSlot((exited) => {
        this.slots = this.slots.filter((s) => s !== exited);
      });
      this.slots.push(created);
      return created;
    }
    let best = this.slots[0]!;
    for (const slot of this.slots) {
      if (slot.activeCount < best.activeCount) {
        best = slot;
      }
    }
    return best;
  }

  async captureFile(payload: CaptureWorkerRequest): Promise<FileVersion> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const slot = this.pickSlot();
    const id = this.nextId++;
    try {
      return await slot.run(id, payload);
    } finally {
      if (this.slots.every((s) => s.activeCount === 0)) {
        this.scheduleIdleShutdown();
      }
    }
  }
}

let sharedPool: CheckpointWorkerPool | undefined;

export function getCheckpointWorkerPool(): CheckpointWorkerPool {
  if (!sharedPool) {
    sharedPool = new CheckpointWorkerPool();
  }
  return sharedPool;
}

export function resolveCheckpointObjectPath(directory: string): string {
  return path.join(directory, "objects");
}

