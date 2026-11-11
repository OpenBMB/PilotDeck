import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Private files, deliberately separate from the editable/exportable mcp.json. */
export class OAuthStore<T> {
  private readonly directory: string;
  constructor(home: string) { this.directory = join(home, 'credentials', 'mcp-oauth'); }
  private path(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex')); }
  async read(id: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(id: string, value: T): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path(id)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path(id));
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(id: string) { await rm(this.path(id), { force: true }); }
  /** Covers the gateway and UI server on the same filesystem. Never steals a live lock. */
  async locked<R>(id: string, task: () => Promise<R>): Promise<R> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.path(id)}.lock`;
    const deadline = Date.now() + 30_000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('MCP OAuth credentials are busy. Retry; after a process crash, remove its stale lock only when PilotDeck is stopped.');
        await delay(50);
      }
    }
    try { return await task(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
