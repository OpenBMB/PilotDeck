import express from 'express';
import { createGlobalSearch } from '../services/globalSearch.js';
import { validateInput } from '../services/search/searchCommon.js';

export function createSearchRouter(search = createGlobalSearch()) {
  const router = express.Router();
  router.post('/global', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const input = validateInput(req.body || {});
      const streaming = input.stream === true;
      if (streaming) {
        res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
      }
      const write = (event, data) => { if (!controller.signal.aborted) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
      const result = await search(input, { signal: controller.signal, userKey: String(req.user?.id || req.user?.username || 'local'),
        onUpdate: streaming ? result => write('snapshot', result) : undefined });
      if (!controller.signal.aborted) {
        if (streaming) { write('done', result); res.end(); }
        else res.json(result);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error.status === 400 ? error.message : 'Search failed. Please try again.';
      if (res.headersSent) res.end('event: error\ndata: ' + JSON.stringify({ error: message }) + '\n\n');
      else res.status(error.status || 500).json({ error: message });
    }
  });
  router.warm = () => search.warm?.();
  router.close = () => search.close?.();
  return router;
}

export default createSearchRouter();
