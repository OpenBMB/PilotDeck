import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ChannelStatePersistenceOptions = {
  stateDir: string;
  debounceMs?: number;
};

/**
 * Persists IM channel session-mapper state to disk so that active sessions
 * and project bindings survive PilotDeck restarts.
 *
 * Each channel gets its own `<channelKey>.state.json` file under `stateDir`.
 * Writes are debounced to avoid excessive I/O during high-frequency messaging.
 */
export class ChannelStatePersistence {
  private readonly stateDir: string;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirty = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: ChannelStatePersistenceOptions) {
    this.stateDir = options.stateDir;
    this.debounceMs = options.debounceMs ?? 2000;
  }

  async load<T>(channelKey: string): Promise<T | undefined> {
    const filePath = this.filePath(channelKey);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  save(channelKey: string, state: unknown): void {
    this.dirty.set(channelKey, state);
    const existing = this.pending.get(channelKey);
    if (existing) clearTimeout(existing);
    this.pending.set(
      channelKey,
      setTimeout(() => {
        this.pending.delete(channelKey);
        void this.ensureWrite(channelKey).catch((err: unknown) => {
          console.warn(
            `[channels] failed to persist ${channelKey} state: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, this.debounceMs),
    );
  }

  async flush(): Promise<void> {
    for (const [key, timer] of this.pending) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
    const keys = new Set([...this.dirty.keys(), ...this.inFlight.keys()]);
    await Promise.all([...keys].map((key) => this.ensureWrite(key)));
  }

  private ensureWrite(channelKey: string): Promise<void> {
    const existing = this.inFlight.get(channelKey);
    if (existing) return existing;

    const write = this.drainWrites(channelKey).finally(() => {
      if (this.inFlight.get(channelKey) === write) {
        this.inFlight.delete(channelKey);
      }
    });
    this.inFlight.set(channelKey, write);
    return write;
  }

  private async drainWrites(channelKey: string): Promise<void> {
    while (this.dirty.has(channelKey)) {
      await this.writeToDisk(channelKey);
    }
  }

  private async writeToDisk(channelKey: string): Promise<void> {
    const state = this.dirty.get(channelKey);
    if (state === undefined) return;
    this.dirty.delete(channelKey);

    const filePath = this.filePath(channelKey);
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = resolve(dir, `.${channelKey}.state.${randomUUID().slice(0, 8)}.tmp`);
    try {
      await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  private filePath(channelKey: string): string {
    return resolve(this.stateDir, `${channelKey}.state.json`);
  }
}
