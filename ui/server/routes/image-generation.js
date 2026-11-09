import express from 'express';
import path from 'node:path';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { ImageStore } from '../../../src/tool/builtin/images/ImageStore.js';
import { imageApiBaseUrl } from '../../../src/pilot/config/imageGenerationConfig.js';
import { resolveApiKey } from '../../../src/model/config/resolveCredentials.js';
import { requestOpenAIImage } from '../../../src/tool/builtin/images/openaiImages.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';

export function createImageGenerationRouter({ store = new ImageStore(path.join(resolvePilotHome(process.env), 'generated-images')),
  readConfig = () => readPilotDeckConfigFile().config, fetchImpl } = {}) {
  const router = express.Router();
  router.post('/test', async (req, res) => {
    let apiKey = '';
    const startedAt = Date.now();
    try {
      const submitted = req.body || {};
      if (typeof submitted.model !== 'string' || !submitted.model.trim()) return res.status(400).json({ ok: false, error: 'An image model is required.' });
      const baseUrl = imageApiBaseUrl(submitted.baseUrl);
      let requestedKey = submitted.apiKey;
      if (requestedKey === '********') {
        const saved = readConfig().tools?.imageGeneration;
        if (!saved || imageApiBaseUrl(saved.baseUrl) !== baseUrl) return res.status(400).json({ ok: false, error: 'Enter a new API key when changing the API address.' });
        requestedKey = saved.apiKey;
      }
      apiKey = resolveApiKey(requestedKey);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        // An explicit probe works while the feature is off, without changing
        // the saved opt-in or creating a project/session attachment.
        const bytes = await requestOpenAIImage({ enabled: true, apiKey, baseUrl, model: submitted.model.trim() },
          { prompt: 'A simple blue circle on a plain white background, no text.' },
          { signal: controller.signal, fetchImpl });
        const { default: sharp } = await import("sharp");
        const image = sharp(bytes, { limitInputPixels: 100_000_000 });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('The image service returned unsupported or invalid image data.');
        await image.stats(); // Decode pixels as well as checking the file header.
        if (controller.signal.aborted) return;
        return res.json({ ok: true, latencyMs: Date.now() - startedAt, width: metadata.width, height: metadata.height });
      } finally { res.off('close', abort); }
    } catch (error) {
      if (res.destroyed) return;
      const detail = error instanceof Error ? error.message : 'Image connection test failed.';
      return res.status(400).json({ ok: false, error: (apiKey ? detail.split(apiKey).join('[REDACTED]') : detail).slice(0, 1200) });
    }
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
