import crypto from 'node:crypto';
import express from 'express';
import { instancesDb } from '../database/db.js';
import { canonicalizeProjectPath, getProjectRole } from '../services/access-control.js';
import {
  encryptInstanceSecret,
  normalizeInstanceEndpoint,
  serializeInstance,
} from '../services/instance-service.js';
import { recordAudit } from '../services/auth-service.js';

const router = express.Router();

router.get('/', (req, res) => {
  return res.json({ instances: instancesDb.listForUser(req.user.id).map(serializeInstance) });
});

router.post('/', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const endpoint = normalizeInstanceEndpoint(req.body?.endpoint);
    if (!name || name.length > 100) return res.status(400).json({ error: 'Instance name is required.' });
    const projectMappings = [];
    for (const mapping of Array.isArray(req.body?.projectMappings) ? req.body.projectMappings : []) {
      const projectPath = canonicalizeProjectPath(mapping.projectPath);
      if (!getProjectRole(projectPath, req.user)) return res.status(404).json({ error: 'Project not found.' });
      const workspaceKey = String(mapping.workspaceKey || '').trim();
      if (!workspaceKey || workspaceKey.length > 200) return res.status(400).json({ error: 'Invalid workspace key.' });
      projectMappings.push({ projectPath, workspaceKey });
    }
    const instance = instancesDb.createRemote({
      id: `instance_${crypto.randomUUID()}`,
      ownerUserId: req.user.id,
      name,
      endpoint,
    });
    if (req.body?.apiKey) instancesDb.setSecret(instance.id, encryptInstanceSecret(req.body.apiKey));
    for (const mapping of projectMappings) {
      instancesDb.setProjectBinding(instance.id, mapping.projectPath, mapping.workspaceKey);
    }
    recordAudit(req, { eventType: 'instance.registered', targetType: 'pilotdeck_instance', targetId: instance.id });
    return res.status(201).json({ instance: serializeInstance(instance) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.patch('/:instanceId', (req, res) => {
  try {
    const current = instancesDb.get(req.params.instanceId);
    if (!current || current.owner_user_id !== Number(req.user.id) || current.kind !== 'remote') {
      return res.status(404).json({ error: 'Instance not found.' });
    }
    const endpoint = req.body?.endpoint == null ? undefined : normalizeInstanceEndpoint(req.body.endpoint);
    const name = req.body?.name == null ? undefined : String(req.body.name).trim();
    const updated = instancesDb.updateRemote(current.id, req.user.id, { name, endpoint });
    if (req.body?.apiKey !== undefined) instancesDb.setSecret(current.id, encryptInstanceSecret(String(req.body.apiKey)));
    if (req.body?.apiKey !== undefined && endpoint === undefined) {
      instancesDb.setApproval(current.id, 'pending', null, {});
    }
    recordAudit(req, { eventType: 'instance.updated', targetType: 'pilotdeck_instance', targetId: current.id });
    return res.json({ instance: serializeInstance(instancesDb.get(current.id)) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.put('/:instanceId/project-mappings', (req, res) => {
  const instance = instancesDb.get(req.params.instanceId);
  if (!instance || instance.owner_user_id !== Number(req.user.id)) return res.status(404).json({ error: 'Instance not found.' });
  const projectPath = canonicalizeProjectPath(req.body?.projectPath);
  if (!getProjectRole(projectPath, req.user)) return res.status(404).json({ error: 'Project not found.' });
  const workspaceKey = String(req.body?.workspaceKey || '').trim();
  if (!workspaceKey || workspaceKey.length > 200) return res.status(400).json({ error: 'Invalid workspace key.' });
  instancesDb.setProjectBinding(instance.id, projectPath, workspaceKey);
  if (instance.kind === 'remote') instancesDb.setApproval(instance.id, 'pending', null, {});
  return res.json({ instance: serializeInstance(instancesDb.get(instance.id)) });
});

router.post('/:instanceId/default', (req, res) => {
  const instance = instancesDb.setDefault(req.params.instanceId, req.user.id);
  if (!instance) return res.status(404).json({ error: 'Approved instance not found.' });
  recordAudit(req, { eventType: 'instance.default_changed', targetType: 'pilotdeck_instance', targetId: instance.id });
  return res.json({ instance: serializeInstance(instance) });
});

router.delete('/:instanceId', (req, res) => {
  const removed = instancesDb.remove(req.params.instanceId, req.user.id);
  if (removed.changes === 0) return res.status(404).json({ error: 'Removable instance not found.' });
  recordAudit(req, { eventType: 'instance.removed', targetType: 'pilotdeck_instance', targetId: req.params.instanceId });
  return res.status(204).end();
});

export default router;
