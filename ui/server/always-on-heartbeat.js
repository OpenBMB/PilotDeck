import { promises as fs } from 'fs';
import path from 'path';
import { sendCronDaemonRequest } from './services/cron-daemon-owner.js';
import { getAlwaysOnHeartbeatPath } from './services/always-on-paths.js';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function resolveProjectRoot(project) {
  const direct = normalizeString(project?.projectRoot) || normalizeString(project?.fullPath) || normalizeString(project?.path);
  if (direct) return path.resolve(direct);
  const projectName = normalizeString(project?.projectName) || normalizeString(project?.name);
  if (!projectName) return '';
  const { extractProjectDirectory } = await import('./projects.js');
  return path.resolve(await extractProjectDirectory(projectName));
}

async function resolveProjectRoots(projects) {
  if (!Array.isArray(projects)) return [];
  const roots = [];
  for (const project of projects) {
    const root = await resolveProjectRoot(project);
    if (root) roots.push(root);
  }
  return [...new Set(roots)];
}

async function registerProject(projectRoot) {
  try {
    await sendCronDaemonRequest({ type: 'register_project', projectRoot });
  } catch {
    // The daemon may not be up yet; the next heartbeat will retry.
  }
}

export function createAlwaysOnHeartbeatManager({
  getActivePilotDeckSessions = () => [],
  registerProjectFn = registerProject
} = {}) {
  const wsFiles = new WeakMap();
  const wsIds = new WeakMap();
  const wsProjectRoots = new WeakMap();

  function getWsId(ws) {
    let id = wsIds.get(ws);
    if (!id) {
      id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      wsIds.set(ws, id);
    }
    return id;
  }

  async function writeBeat(ws, projectRoot, payload) {
    const wsId = getWsId(ws);
    const fileName = `webui-${wsId}.beat`;
    const filePath = getAlwaysOnHeartbeatPath(projectRoot, fileName);
    const processingSessionIds = Array.isArray(payload.processingSessionIds)
      ? payload.processingSessionIds.filter((id) => typeof id === 'string')
      : [];
    const beat = {
      schemaVersion: 1,
      writerKind: 'webui',
      writerId: wsId,
      writtenAt: new Date().toISOString(),
      agentBusy: Boolean(payload.agentBusy) || processingSessionIds.length > 0,
      processingSessionIds,
      lastUserMsgAt: normalizeString(payload.lastUserMsgAt) || null,
    };

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(beat, null, 2), 'utf8');
    const files = wsFiles.get(ws) || new Set();
    files.add(filePath);
    wsFiles.set(ws, files);
    await registerProjectFn(projectRoot);
  }

  async function handlePresence(ws, payload = {}) {
    const roots = new Map();
    const selectedRoot = await resolveProjectRoot(payload.selectedProject);
    const alwaysOnRoots = await resolveProjectRoots(payload.alwaysOnProjects);

    for (const projectRoot of alwaysOnRoots) {
      roots.set(projectRoot, {
        agentBusy: false,
        processingSessionIds: [],
        lastUserMsgAt: selectedRoot === projectRoot ? payload.lastUserMsgAt : null,
      });
    }
    const activeSessions = getActivePilotDeckSessions();
    for (const session of activeSessions) {
      const cwd = normalizeString(session?.cwd);
      if (!cwd) continue;
      const projectRoot = path.resolve(cwd);
      const existing = roots.get(projectRoot);
      if (!existing) continue;
      existing.agentBusy = true;
      existing.processingSessionIds.push(session.sessionId);
      roots.set(projectRoot, existing);
    }

    for (const [projectRoot, beatPayload] of roots) {
      await writeBeat(ws, projectRoot, beatPayload);
    }
    wsProjectRoots.set(ws, new Set(roots.keys()));
    return [...roots.keys()];
  }

  async function clearPresence(ws) {
    const files = wsFiles.get(ws);
    if (!files) {
      wsProjectRoots.delete(ws);
      return;
    }
    await Promise.all([...files].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    wsFiles.delete(ws);
    wsProjectRoots.delete(ws);
  }

  return {
    getWriterId: getWsId,
    getProjectRoots(ws) {
      return [...(wsProjectRoots.get(ws) || [])];
    },
    handlePresence,
    clearPresence,
  };
}
