import express from 'express';
import { projectAccessDb, userDb } from '../database/db.js';
import { canonicalizeProjectPath } from '../services/access-control.js';
import { recordAudit } from '../services/auth-service.js';

const router = express.Router({ mergeParams: true });
const ROLES = new Set(['owner', 'editor', 'viewer']);

router.get('/:projectName/members', (req, res) => {
  return res.json({ members: projectAccessDb.listMembers(canonicalizeProjectPath(req.projectPath)) });
});

router.get('/:projectName/member-candidates', (req, res) => {
  const projectPath = canonicalizeProjectPath(req.projectPath);
  const existing = new Set(projectAccessDb.listMembers(projectPath).map((member) => Number(member.user_id)));
  const candidates = userDb.listUsers().flatMap((user) => user.is_active && !existing.has(Number(user.id))
    ? [{ id: user.id, username: user.username, displayName: user.display_name || user.username, systemRole: user.system_role }]
    : []);
  return res.json({ candidates });
});

router.put('/:projectName/members/:userId', (req, res) => {
  const projectPath = canonicalizeProjectPath(req.projectPath);
  const userId = Number(req.params.userId);
  const role = String(req.body?.role || '');
  const target = userDb.getUserById(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid project role.' });
  projectAccessDb.setRole(projectPath, userId, role, req.user.id);
  recordAudit(req, { eventType: 'project.access_updated', targetType: 'project', targetId: projectPath, metadata: { userId, role } });
  return res.json({ success: true, members: projectAccessDb.listMembers(projectPath) });
});

router.delete('/:projectName/members/:userId', (req, res) => {
  const projectPath = canonicalizeProjectPath(req.projectPath);
  const userId = Number(req.params.userId);
  const members = projectAccessDb.listMembers(projectPath);
  const target = members.find((member) => member.user_id === userId);
  if (!target) return res.status(404).json({ error: 'Project member not found.' });
  if (target.role === 'owner' && members.filter((member) => member.role === 'owner').length <= 1) {
    return res.status(409).json({ error: 'A project must retain at least one owner.' });
  }
  projectAccessDb.remove(projectPath, userId);
  recordAudit(req, { eventType: 'project.access_removed', targetType: 'project', targetId: projectPath, metadata: { userId } });
  return res.json({ success: true });
});

export default router;
