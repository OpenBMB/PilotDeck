import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectAccessDb, sessionOwnersDb } from '../database/db.js';
import { isAuthEnabled } from './auth-service.js';
import { groupChatDb } from './group-chat-db.js';
import { extractProjectDirectory } from '../projects.js';

const PROJECT_RANK = { viewer: 1, editor: 2, owner: 3 };

export function canonicalizeProjectPath(value) {
  const resolved = path.resolve(String(value || process.cwd()));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function getUserGeneralPath(userId) {
  const pilotHome = process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
  const workspace = path.join(pilotHome, 'users', String(userId), 'general');
  fs.mkdirSync(workspace, { recursive: true });
  return canonicalizeProjectPath(workspace);
}

export function getProjectRole(projectPath, user) {
  if (!user) return null;
  if (!isAuthEnabled()) return 'owner';
  const canonical = canonicalizeProjectPath(projectPath);
  const generalPath = getUserGeneralPath(user.id);
  if (canonical === generalPath) {
    projectAccessDb.ensureOwner(canonical, user.id);
    return 'owner';
  }
  let role = projectAccessDb.getRole(canonical, user.id);
  if (!role && user.systemRole === 'owner') {
    const existingMembers = projectAccessDb.listMembers(canonical);
    // Idempotent migration: projects with no ACL belonged to the pre-login
    // local user. Do not implicitly grant owner access once another user has
    // established an ACL for the path.
    if (existingMembers.length === 0) {
      projectAccessDb.ensureOwner(canonical, user.id);
      role = 'owner';
    }
  }
  return role;
}

export function hasProjectRole(actualRole, minimumRole) {
  return Boolean(actualRole && PROJECT_RANK[actualRole] >= PROJECT_RANK[minimumRole]);
}

export function requireProjectRole(projectPath, user, minimumRole = 'viewer') {
  const canonical = canonicalizeProjectPath(projectPath);
  const role = getProjectRole(canonical, user);
  if (!hasProjectRole(role, minimumRole)) {
    const error = new Error('Project not found.');
    error.statusCode = 404;
    throw error;
  }
  return { projectPath: canonical, projectRole: role };
}

export async function resolveProjectNameForUser(projectName, user) {
  if (projectName.startsWith('group:')) {
    const roomId = projectName.slice('group:'.length);
    const room = roomId ? groupChatDb.getRoom(user.id, roomId) : null;
    if (!room) {
      const error = new Error('Project not found.');
      error.statusCode = 404;
      throw error;
    }
    return canonicalizeProjectPath(room.projectPath);
  }
  if (projectName === 'general') return getUserGeneralPath(user.id);
  return canonicalizeProjectPath(await extractProjectDirectory(projectName));
}

function requiredRoleForProjectRequest(req) {
  const relative = req.path.replace(/^\/+/, '');
  if (/^[^/]+\/(rename|members|member-candidates)(?:\/|$)/u.test(relative)) return 'owner';
  if (req.method === 'GET' || req.method === 'HEAD') return 'viewer';
  if (req.method === 'DELETE' && relative.split('/').length === 1) return 'owner';
  return 'editor';
}

export async function authorizeProjectRequest(req, res, next) {
  try {
    const relative = req.path.replace(/^\/+/, '');
    if (!relative) return next();
    const first = relative.split('/')[0];
    if (['create', 'create-workspace', 'clone-progress'].includes(first)) return next();
    const projectPath = await resolveProjectNameForUser(decodeURIComponent(first), req.user);
    if (/^[^/]+\/(members|member-candidates)(?:\/|$)/u.test(relative)
        && ['owner', 'admin'].includes(req.user.systemRole)) {
      req.projectPath = projectPath;
      req.projectRole = getProjectRole(projectPath, req.user) || 'system-admin';
      return next();
    }
    const { projectRole } = requireProjectRole(projectPath, req.user, requiredRoleForProjectRequest(req));
    req.projectPath = projectPath;
    req.projectRole = projectRole;
    if (projectRole === 'viewer' && req.body && typeof req.body === 'object') {
      req.body.permissionMode = 'read-only';
      req.body.runMode = 'ask';
    }
    return next();
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode === 404 ? 'Not found.' : error.message });
  }
}

export function filterProjectsForUser(projects, user) {
  return projects.filter((project) => {
    const projectPath = project.name === 'general'
      ? getUserGeneralPath(user.id)
      : canonicalizeProjectPath(project.fullPath || project.path);
    const role = getProjectRole(projectPath, user);
    if (!role) return false;
    project.fullPath = projectPath;
    project.path = projectPath;
    project.projectRole = role;
    project.sessions = filterSessionsForUser(project.sessions || [], projectPath, user);
    project.sessionMeta = {
      ...(project.sessionMeta || {}),
      total: project.sessions.length,
      hasMore: false,
    };
    return true;
  });
}

export function filterSessionsForUser(sessions, projectPath, user) {
  const canonical = canonicalizeProjectPath(projectPath);
  const role = getProjectRole(canonical, user);
  return sessions.filter((session) => {
    const existing = sessionOwnersDb.get(session.id);
    if (existing) return existing.user_id === Number(user.id);
    // Historical sessions are claimed only by the migrated project owner.
    if (role === 'owner' && user.systemRole === 'owner') {
      sessionOwnersDb.create(session.id, canonical, user.id);
      return true;
    }
    return false;
  });
}

export function requireSessionOwner(sessionKey, user, { allowClaim = false, projectPath = null } = {}) {
  const existing = sessionOwnersDb.get(sessionKey);
  if (existing?.user_id === Number(user.id)) return existing;
  if (!existing && allowClaim && projectPath && user.systemRole === 'owner') {
    const canonical = canonicalizeProjectPath(projectPath);
    requireProjectRole(canonical, user, 'owner');
    sessionOwnersDb.create(sessionKey, canonical, user.id);
    return sessionOwnersDb.get(sessionKey);
  }
  const error = new Error('Session not found.');
  error.statusCode = 404;
  throw error;
}

export function createSessionOwnership(sessionKey, projectPath, user) {
  const canonical = canonicalizeProjectPath(projectPath);
  requireProjectRole(canonical, user, 'viewer');
  sessionOwnersDb.create(sessionKey, canonical, user.id);
  return requireSessionOwner(sessionKey, user);
}
