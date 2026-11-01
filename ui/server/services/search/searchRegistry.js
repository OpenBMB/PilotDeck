import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolvePilotHome } from '../../utils/pilotPaths.js';
import { readRegisteredProject } from '../projectRegistration.js';
import { mapConcurrent } from './searchCommon.js';

export async function listSearchProjects(pilotHome = resolvePilotHome()) {
  const directory = path.join(pilotHome, 'projects');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const projects = [];
  await mapConcurrent(entries.filter(entry => entry.isDirectory()), async entry => {
    const root = await readRegisteredProject(directory, entry.name);
    if (!root) return;
    const general = path.resolve(root) === path.resolve(pilotHome);
    projects.push({ name: general ? 'general' : entry.name, storageId: entry.name,
      displayName: general ? 'general' : path.basename(root), fullPath: root, path: root,
      ...(general ? { kind: 'general', capabilities: { files: false, explore: false } } : {}) });
  });
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
