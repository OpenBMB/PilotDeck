import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type SessionFile = {
  path: string;
  sessionId: string;
  mtime: number;
  ctime: number;
  size: number;
};

const scans = new Map<string, Promise<SessionFile[]>>();

export function isInternalSession(sessionId: string): boolean {
  return /^always-on-(discovery|workspace|report)[:\-]/.test(sessionId);
}

/** File attributes only: project counts must never parse every transcript. */
export function listSessionFiles(chatDir: string): Promise<SessionFile[]> {
  const running = scans.get(chatDir);
  if (running) return running;
  const scan = scanSessionFiles(chatDir).finally(() => {
    if (scans.get(chatDir) === scan) scans.delete(chatDir);
  });
  scans.set(chatDir, scan);
  return scan;
}

async function scanSessionFiles(chatDir: string): Promise<SessionFile[]> {
  const entries = await readdir(chatDir, { withFileTypes: true }).catch(() => []);
  // Ignore subagent subdirectories, empty/unreadable files and symbolic links.
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  const files: SessionFile[] = [];
  for (let start = 0; start < names.length; start += 16) {
    const batch = await Promise.all(names.slice(start, start + 16).map(async ({ name }) => {
      const path = join(chatDir, name);
      const info = await stat(path).catch(() => null);
      return info?.isFile() && info.size > 0 ? {
        path, sessionId: name.slice(0, -6), mtime: info.mtimeMs,
        ctime: info.ctimeMs, size: info.size,
      } : null;
    }));
    files.push(...batch.filter((file): file is SessionFile => file !== null));
  }
  // Stable ties are important for offset pagination across refreshes.
  return files.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));
}
