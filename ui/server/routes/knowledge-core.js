import express from 'express';
import { moduleUpstreamSignal } from '../module-request-abort.js';
import { knowledgeCoreRestRequest, knowledgeCoreCapabilities } from '../../../src/composition/knowledgeCoreOperations.mjs';

/** A KM binding owns its spaces and credentials; browser input never selects identity. */
export function createKnowledgeCoreRouter({ loadConfig, fetchImpl = fetch }) {
  const router = express.Router();
  router.use(async (req, res) => {
    try {
      const binding = loadConfig()?.modules?.knowledge;
      const bearer = binding?.credentialEnv ? process.env[binding.credentialEnv]?.trim() : binding?.bearer;
      if (binding?.enabled !== true || binding.contract !== 'knowledge-core/v1' || !binding.endpoint) {
        return res.status(501).json({ detail: 'Independent knowledge service is not configured' });
      }
      if (!binding.pilotDeckUserId || String(req.user?.id ?? '') !== String(binding.pilotDeckUserId)) {
        return res.status(403).json({ detail: 'Knowledge host user is not bound' });
      }
      if (binding.credentialEnv && !bearer) return res.status(503).json({ detail: 'Knowledge credential is unavailable' });
      const spaces = Array.isArray(binding.spaces) ? binding.spaces : [];
      const allowed = new Set(spaces.map(row => row.id).filter(id => typeof id === 'string' && id));
      const capabilities = await knowledgeCoreCapabilities(binding, fetchImpl, moduleUpstreamSignal(req.moduleRequestSignal, Number(binding.timeoutMs) || 120_000));
      if (req.method === 'GET' && req.path === '/configuration') return res.json(capabilities);
      if (capabilities.modules.spaces && !allowed.size) return res.status(503).json({ detail: 'Knowledge spaces are not configured' });
      const body = !['GET', 'HEAD'].includes(req.method) && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : undefined;
      const query = new URLSearchParams(req.url.split('?')[1] || '');
      if (query.get('space_id') && body?.space_id && query.get('space_id') !== body.space_id) {
        return res.status(403).json({ detail: 'Conflicting knowledge spaces' });
      }
      const request = knowledgeCoreRestRequest(req.method, req.path,
        { ...Object.fromEntries(query), ...body }, {
          ...binding, methods: binding.methods || ['query', 'resolve_citation'],
          readOnly: binding.readOnly === true || process.env.PILOTDECK_MODULE_ADMIN === '0',
        }, capabilities);
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: moduleUpstreamSignal(req.moduleRequestSignal, Number(binding.timeoutMs) || 120_000),
      });
      if (request.operation === 'list_spaces' && response.ok) {
        const rows = await response.json();
        return res.json(rows.filter(row => allowed.has(row.id)).map(row => ({
          ...row, name: spaces.find(space => space.id === row.id)?.name || row.name,
          can_write: row.can_write === true && binding.readOnly !== true && process.env.PILOTDECK_MODULE_ADMIN !== '0',
        })));
      }
      if (request.operation === 'identity' && response.ok) {
        const identity = await response.json();
        if (binding.readOnly === true || process.env.PILOTDECK_MODULE_ADMIN === '0')
          identity.permissions = identity.permissions.filter(permission => permission !== 'write');
        return res.json(identity);
      }
      for (const name of ['content-type', 'content-disposition']) {
        if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
      }
      return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (res.destroyed || req.moduleRequestSignal?.aborted) return;
      return res.status(error.status || 503).json({ detail: error.status ? error.message : 'Knowledge service unavailable' });
    }
  });
  return router;
}
