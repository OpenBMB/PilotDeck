/**
 * Per-task output buffer (C5 §6.5.5 step 2).
 *
 * Implementation notes:
 *   - In-memory ring buffer holds up to `maxMemoryBytes` (default 1 MB).
 *   - On overflow, oldest bytes are dropped (`truncated = true`) — the spec
 *     calls for "1 MB ring buffer + disk spill". Disk spill is *optional*
 *     (cb provided via `diskSpill`); the default constructor stores
 *     in-memory only, sufficient for tests and a forwards-compatible
 *     persistence hook.
 *   - `readSlice(offset, maxBytes)` returns the bytes from `offset` to the
 *     current head, capped at `maxBytes`. The caller updates `offset` and
 *     polls again. If `offset` is older than what the buffer retains, we
 *     return everything available with `truncated=true`.
 *   - `totalBytes()` is monotonically increasing — it represents the total
 *     volume seen, not the buffer size. Callers can use it as the next
 *     polling offset.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PilotDeckTaskOutputSlice } from "../protocol/types.js";

export type TaskOutputStoreOptions = {
  taskId: string;
  /** Hard cap on in-memory bytes retained (default 1 MB). */
  maxMemoryBytes?: number;
  /**
   * Optional spill directory. When set, every overflow chunk is appended to
   * `<diskSpillDir>/<taskId>.log` so callers can read the full transcript
   * later (off the ring-buffer fast path).
   */
  diskSpillDir?: string;
};

const DEFAULT_MEMORY_BYTES = 1_000_000;

export class TaskOutputStore {
  private chunks: Buffer[] = [];
  private memBytes = 0;
  private totalSeenBytes = 0;
  private droppedBytes = 0;
  private readonly options: TaskOutputStoreOptions;
  private readonly maxMemoryBytes: number;
  private readonly diskSpillPath: string | null;
  private spillReady = false;

  constructor(options: TaskOutputStoreOptions) {
    this.options = options;
    this.maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MEMORY_BYTES;
    this.diskSpillPath = options.diskSpillDir
      ? path.join(options.diskSpillDir, `${options.taskId}.log`)
      : null;
  }

  /** Append a stdout/stderr chunk. */
  append(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    this.totalSeenBytes += buf.length;

    if (this.diskSpillPath) {
      this.queueSpill(buf);
    }

    this.chunks.push(buf);
    this.memBytes += buf.length;
    while (this.memBytes > this.maxMemoryBytes && this.chunks.length > 0) {
      const oldest = this.chunks.shift()!;
      this.memBytes -= oldest.length;
      this.droppedBytes += oldest.length;
    }
  }

  /**
   * Read the slice at [offset, head). Bytes preceding `offset` that have
   * been dropped from memory are reflected via `truncated=true`. Pass
   * `maxBytes` to bound the return size.
   */
  readSlice(offset: number, maxBytes?: number): PilotDeckTaskOutputSlice {
    const head = this.totalSeenBytes;
    let cursor = Math.max(offset, this.droppedBytes);
    const cap = maxBytes ?? Infinity;
    const truncated = offset < this.droppedBytes;

    if (cursor >= head) {
      return { content: "", nextOffset: head, totalBytes: head, truncated };
    }

    const wanted = Math.min(head - cursor, cap);
    let toSkip = cursor - this.droppedBytes;
    let collected = 0;
    const slices: Buffer[] = [];
    for (const buf of this.chunks) {
      if (collected >= wanted) break;
      if (toSkip >= buf.length) {
        toSkip -= buf.length;
        continue;
      }
      const start = toSkip;
      toSkip = 0;
      const remaining = wanted - collected;
      const end = Math.min(buf.length, start + remaining);
      slices.push(buf.subarray(start, end));
      collected += end - start;
    }
    const content = Buffer.concat(slices).toString("utf8");
    return {
      content,
      nextOffset: cursor + collected,
      totalBytes: head,
      truncated,
    };
  }

  totalBytes(): number {
    return this.totalSeenBytes;
  }

  /** Clear in-memory buffer (the disk spill, if any, remains intact). */
  close(): void {
    this.chunks = [];
    this.memBytes = 0;
  }

  // ---------------------------------------------------------------------

  private spillQueue: Buffer[] = [];
  private spillFlushing = false;

  private queueSpill(chunk: Buffer): void {
    this.spillQueue.push(chunk);
    if (!this.spillFlushing) {
      this.spillFlushing = true;
      void this.flushSpill();
    }
  }

  private async flushSpill(): Promise<void> {
    if (!this.diskSpillPath) {
      this.spillFlushing = false;
      return;
    }
    while (this.spillQueue.length > 0) {
      const next = this.spillQueue.shift()!;
      try {
        if (!this.spillReady) {
          await fs.mkdir(path.dirname(this.diskSpillPath), { recursive: true });
          this.spillReady = true;
        }
        await fs.appendFile(this.diskSpillPath, next);
      } catch {
        // Disk spill is best-effort; never crash the runtime over a write
        // error. Subsequent appends will retry the mkdir.
        this.spillReady = false;
        break;
      }
    }
    this.spillFlushing = false;
  }
}
