import express from 'express';
import { instancesDb } from '../database/db.js';
import { recordAudit } from '../services/auth-service.js';
import { serializeInstance, testAndApproveInstance } from '../services/instance-service.js';

const router = express.Router();

router.get('/instances', (_req, res) => {
  return res.json({ instances: instancesDb.listRemote().map(serializeInstance) });
});

router.post('/instances/:instanceId/test-and-approve', async (req, res) => {
  try {
    const instance = await testAndApproveInstance(req.params.instanceId, req.user.id);
    recordAudit(req, { eventType: 'instance.approved', targetType: 'pilotdeck_instance', targetId: instance.id });
    return res.json({ instance: serializeInstance(instance) });
  } catch (error) {
    recordAudit(req, { eventType: 'instance.approval_failed', targetType: 'pilotdeck_instance', targetId: req.params.instanceId, outcome: 'failure', metadata: { error: error.message } });
    return res.status(400).json({ error: error.message });
  }
});

router.post('/instances/:instanceId/reject', (req, res) => {
  const instance = instancesDb.setApproval(req.params.instanceId, 'rejected', req.user.id, {});
  if (!instance) return res.status(404).json({ error: 'Instance not found.' });
  recordAudit(req, { eventType: 'instance.rejected', targetType: 'pilotdeck_instance', targetId: instance.id });
  return res.json({ instance: serializeInstance(instance) });
});

export default router;
