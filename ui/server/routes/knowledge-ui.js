import express from 'express';

/** Public packaged assets contain no API identity; the parent bridge owns requests. */
export function createKnowledgeUiRouter({ loadConfig, fetchImpl = fetch }) {
  const router = express.Router();
  router.get(/.*/, async (req, res) => {
    const binding = loadConfig()?.modules?.knowledge;
    if (binding?.enabled !== true || binding.contract !== 'knowledge-core/v1' || !binding.endpoint) return res.status(503).send('Knowledge UI unavailable');
    const path = req.path;
    if (path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return res.status(400).end();
    if (!/^\/ui\/v1\/(?:index\.html|version\.json|assets\/[A-Za-z0-9_.-]+)$/.test(path)) return res.status(404).end();
    try {
      const response = await fetchImpl(new URL(path, binding.endpoint), { signal: AbortSignal.timeout(30000) });
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    } catch { res.status(503).send('Knowledge UI unavailable'); }
  });
  return router;
}
