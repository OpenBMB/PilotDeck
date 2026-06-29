/**
 * Evo HTTP shim — translates `/api/evo/*` REST calls from
 * `ui/src/components/main-content-v2/SkillsV2.tsx` into the gateway's `evo_*`
 * RPCs. The gateway owns the Evo workspace under `~/.pilotdeck/evo/`
 * (see `src/evo/EvoManager.ts`), so the UI and the agent share the same Evo
 * runs and per-project policy.
 *
 * Endpoints:
 *   POST /api/evo/start    → evoStart   { projectKey, target, policy?, ... }
 *   POST /api/evo/status   → evoStatus  { runId? | projectKey? }
 *   POST /api/evo/report   → evoReport  { runId }
 *   POST /api/evo/apply    → evoApply   { runId }
 *   POST /api/evo/discard  → evoDiscard { runId }
 */

import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

const GENERAL_CWD_MARKERS = new Set(['general', '', null, undefined]);

function isGeneralCwd(projectPath) {
  if (projectPath == null) return true;
  return GENERAL_CWD_MARKERS.has(projectPath);
}

function effectiveProject(projectPath) {
  return isGeneralCwd(projectPath) ? null : projectPath;
}

function sendGatewayError(res, err) {
  const code = err?.code;
  const message = err?.message || (err instanceof Error ? err.message : String(err));
  switch (code) {
    case 'not_configured':
      return res.status(503).json({ error: message, code });
    case 'invalid_input':
      return res.status(400).json({ error: message, code });
    case 'not_found':
      return res.status(404).json({ error: message, code });
    default:
      console.error('[evo-bridge]', err);
      return res.status(500).json({ error: message, code: code || 'gateway_request_failed' });
  }
}

async function callGateway(method, params) {
  const gw = await getPilotDeckGateway();
  return gw[method](params);
}

router.post('/start', async (req, res) => {
  try {
    const body = req.body || {};
    const projectKey = effectiveProject(body.projectKey);
    const result = await callGateway('evoStart', { ...body, projectKey });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/status', async (req, res) => {
  try {
    const body = req.body || {};
    const params = body.runId
      ? { runId: body.runId }
      : { projectKey: effectiveProject(body.projectKey) };
    const result = await callGateway('evoStatus', params);
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/report', async (req, res) => {
  try {
    const result = await callGateway('evoReport', { runId: req.body?.runId });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/apply', async (req, res) => {
  try {
    const result = await callGateway('evoApply', { runId: req.body?.runId });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/discard', async (req, res) => {
  try {
    const result = await callGateway('evoDiscard', { runId: req.body?.runId });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

export default router;
