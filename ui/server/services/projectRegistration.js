import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectId } from '../utils/pilotPaths.js';

export function projectNotFound() {
  return Object.assign(new Error('Project not found'), { code: 'PROJECT_NOT_FOUND', status: 404 });
}

export async function readRegisteredProject(projectsDir, id) {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[/\\\0]/.test(id)) return null;
  const storage = path.join(projectsDir, id);
  const info = await fs.lstat(storage).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  let root;
  try {
    const marker = path.join(storage, '.cwd');
    const markerInfo = await fs.lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) return null;
    root = (await fs.readFile(marker, 'utf8')).trim();
    if (!root || !path.isAbsolute(root) || root.includes('\0')) return null;
  } catch (error) {
    if (error.code !== 'ENOENT') return null;
    // Decode only IDs backed by a real registration directory.
    const parts = id.split('-');
    for (let start = 0; start < parts.length; start++) {
      const candidates = ['/' + parts.slice(start).join('/')];
      if (process.platform === 'win32') {
        for (const drive of ['C', 'D', 'E']) candidates.push(`${drive}:\\${parts.slice(start).join('\\')}`);
      }
      for (const candidate of candidates) {
        if (createProjectId(candidate) === id && (await fs.stat(candidate).catch(() => null))?.isDirectory()) return candidate;
      }
    }
    return null;
  }
  // Saved sessions outlive their workspace; file routes check root availability.
  return path.resolve(root);
}

export async function resolveRegisteredProject(name, pilotHome) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw projectNotFound();
  if (name === 'general' || (path.isAbsolute(name) && path.resolve(name) === path.resolve(pilotHome))) return pilotHome;
  const projectsDir = path.join(pilotHome, 'projects');
  if (!path.isAbsolute(name)) {
    const root = await readRegisteredProject(projectsDir, name);
    if (root) return root;
  } else {
    const requested = path.resolve(name);
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = await readRegisteredProject(projectsDir, entry.name);
      if (root && path.resolve(root) === requested) return root;
    }
  }
  throw projectNotFound();
}
