import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export function pilotDeckWorkDir() {
  const configured = String(process.env.PILOTDECK_WORK_DIR ?? '').trim();
  return configured ? resolveThroughExistingAncestor(configured) : null;
}

export function resolveThroughExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];
  while (!fsSync.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = fsSync.existsSync(current) ? fsSync.realpathSync.native(current) : current;
  return path.resolve(base, ...suffix);
}

export function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function samePath(left, right) {
  return resolveThroughExistingAncestor(left) === resolveThroughExistingAncestor(right);
}

export function assertInternalPath(filePath, purpose) {
  const workDir = pilotDeckWorkDir();
  if (!workDir) {
    throw new Error(`${purpose} requires PILOTDECK_WORK_DIR; keep PPTX work artifacts in the turn-scoped directory`);
  }
  const resolved = resolveThroughExistingAncestor(filePath);
  if (!isInsidePath(resolved, workDir)) {
    throw new Error(`${purpose} must be under PILOTDECK_WORK_DIR (${workDir})`);
  }
  return resolved;
}

export function assertDeliveryPath(filePath) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && isInsidePath(resolved, workDir)) {
    throw new Error('The final PPTX deliverable must be outside PILOTDECK_WORK_DIR');
  }
  return resolved;
}

export function assertDistinctPaths(artifacts) {
  const entries = Object.entries(artifacts).filter(([, value]) => value);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (!samePath(entries[left][1], entries[right][1])) continue;
      throw new Error(`PPTX ${entries[left][0]} and ${entries[right][0]} must use distinct paths`);
    }
  }
}

export async function fileSha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

export async function pathExists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

export async function writeJson(filePath, value) {
  const output = assertInternalPath(filePath, 'PPTX JSON report');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return output;
}
