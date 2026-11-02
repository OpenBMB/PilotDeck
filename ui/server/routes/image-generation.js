import express from 'express';
import path from 'node:path';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { ImageStore } from '../../../src/tool/builtin/images/ImageStore.js';
import { imageApiBaseUrl } from '../../../src/pilot/config/imageGenerationConfig.js';
import { resolveApiKey } from '../../../src/model/config/resolveCredentials.js';
import { networkFetch } from '../../../src/network/fetch.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';

export function createImageGenerationRouter({ store = new ImageStore(path.join(resolvePilotHome(process.env), 'generated-images')),
  readConfig = () => readPilotDeckConfigFile().config, fetchImpl } = {}) {
  const router = express.Router();
  router.post('/test', async (req, res) => {
    try {
      const submitted = req.body || {};
      const baseUrl = imageApiBaseUrl(submitted.baseUrl);
      let requestedKey = submitted.apiKey;
      if (requestedKey === '********') {
        const saved = readConfig().tools?.imageGeneration;
        if (!saved || imageApiBaseUrl(saved.baseUrl) !== baseUrl) return res.status(400).json({ error: 'Enter a new API key when changing the API address.' });
        requestedKey = saved.apiKey;
      }
      const apiKey = resolveApiKey(requestedKey);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const response = await networkFetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error' },
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), fetchImpl });
        if (!response.ok) { await response.body?.cancel(); return res.status(400).json({ error: `Connection check returned HTTP ${response.status}.` }); }
        // A connection check does not generate an image or claim model capability.
        await response.body?.cancel();
        return res.json({ ok: true });
      } finally { res.off('close', abort); }
    } catch { return res.status(400).json({ error: 'Connection check failed. Verify the API address and key.' }); }
  });
  router.get('/:sessionId/:imageId', async (req, res) => {
    try {
      const image = await store.get(req.params.sessionId, req.params.imageId);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type(image.mimeType);
      if (req.query.download === '1') res.attachment(`image-${image.imageId}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.split('/')[1]}`);
      return res.sendFile(image.path);
    } catch { return res.status(404).json({ error: 'Image attachment not found in this session.' }); }
  });
  return router;
}

export default createImageGenerationRouter();
