import { readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from "node:path";

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
function isProjectChatDirectory(projectsRoot: string, chatDir: string): boolean {
  if (!chatDir.startsWith(projectsRoot + sep)) return false;
  const local = relative(projectsRoot, chatDir);
  const parts = local.split(sep);
  return !isAbsolute(local) && parts.length === 2 && parts[0] !== '..' && parts[1] === 'chats';
}

export function listSessionFiles(pilotHome: string, chatDir: string): Promise<SessionFile[]> {
  const projectsRoot = resolve(pilotHome, 'projects');
  const directory = resolve(chatDir);
  if (!isProjectChatDirectory(projectsRoot, directory)) return Promise.resolve([]);
  const projectId = basename(dirname(directory));
  if (projectId === '.' || projectId === '..') return Promise.resolve([]);
  const key = `${projectsRoot}\0${directory}`;
  const running = scans.get(key);
  if (running) return running;
  const scan = scanSessionFiles(projectsRoot, projectId).finally(() => {
    if (scans.get(key) === scan) scans.delete(key);
  });
  scans.set(key, scan);
  return scan;
}

async function scanSessionFiles(projectsRoot: string, projectId: string): Promise<SessionFile[]> {
  const canonicalRoot = await realpath(projectsRoot).catch(() => null);
  if (!canonicalRoot) return [];
  // Build from the trusted storage root and a single project-name component;
  // never send the caller's arbitrary path to a filesystem operation.
  const directory = join(canonicalRoot, projectId, 'chats');
  if (!directory.startsWith(canonicalRoot + sep)) return [];
  const canonicalDirectory = await realpath(directory).catch(() => null);
  // A legacy name is allowed; a project/chats symlink escaping PilotHome is not.
  if (!canonicalDirectory || !isProjectChatDirectory(canonicalRoot, canonicalDirectory)) return [];
  const entries = await readdir(canonicalDirectory, { withFileTypes: true }).catch(() => []);
  // Ignore subagent subdirectories, empty/unreadable files and symbolic links.
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  const files: SessionFile[] = [];
  for (let start = 0; start < names.length; start += 16) {
    const batch = await Promise.all(names.slice(start, start + 16).map(async ({ name }) => {
      const path = join(canonicalDirectory, name);
      const info = await lstat(path).catch(() => null);
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
