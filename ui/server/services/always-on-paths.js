import path from 'path';
import { resolvePilotHome, createProjectId } from '../utils/pilotPaths.js';

export function getAlwaysOnRoot(projectRoot) {
  const pilotHome = resolvePilotHome();
  const projectId = createProjectId(path.resolve(projectRoot));
  return path.join(pilotHome, 'always-on', 'projects', projectId);
}

export function getAlwaysOnHeartbeatsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'heartbeats');
}

export function getAlwaysOnHeartbeatPath(projectRoot, fileName) {
  return path.join(getAlwaysOnHeartbeatsDir(projectRoot), fileName);
}

export function getAlwaysOnDiscoveryLockPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'locks', 'discovery.lock');
}

export function getAlwaysOnDiscoveryStatePath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'state.json');
}

export function getAlwaysOnRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'run-history.jsonl');
}

export function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}
