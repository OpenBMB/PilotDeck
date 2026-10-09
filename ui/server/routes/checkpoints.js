import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { extractProjectDirectory } from '../projects.js';

const router = express.Router();

export function createCheckpointHandler({ getGateway = getPilotDeckGateway, resolveProject = extractProjectDirectory } = {}) {
  return async (req, res) => {
    try {
      const input = req.body ?? {};
      if (typeof input.project !== 'string' || typeof input.sessionId !== 'string' || !input.sessionId.trim()) return res.status(400).json({ error: 'Project and conversation are required.' });
      if (!['list', 'diff', 'preview', 'restore', 'undo'].includes(input.action)) return res.status(400).json({ error: 'Invalid checkpoint action.' });
      if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.every(item => typeof item === 'string'))) return res.status(400).json({ error: 'Invalid file selection.' });
      const gateway = await getGateway();
      if (!gateway.manageCheckpoints) return res.status(503).json({ error: 'This Gateway does not support file checkpoints.' });
      const result = await gateway.manageCheckpoints({
        projectKey: await resolveProject(input.project), sessionKey: input.sessionId, action: input.action,
        checkpointId: input.checkpointId, planId: input.planId, operationId: input.operationId,
        filePath: input.filePath, paths: input.paths, scope: input.scope, mode: input.mode,
      });
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /busy|being modified|changed after|changed during|expired/i.test(message) ? 409 : /unavailable|restarting|connect/i.test(message) ? 503 : 400;
      return res.status(status).json({ error: message, code: error.code });
    }
  };
}

router.post('/', createCheckpointHandler());
export default router;
