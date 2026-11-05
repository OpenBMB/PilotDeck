import express from 'express';
import { VideoJobManager, videoJobView } from '../../../src/tool/builtin/videos/VideoJobManager.js';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { VideoStore } from '../../../src/tool/builtin/videos/VideoStore.js';
import { videoApiBaseUrl } from '../../../src/pilot/config/videoGenerationConfig.js';
import { resolveApiKey } from '../../../src/model/config/resolveCredentials.js';
import { requestOpenAIVideo } from '../../../src/tool/builtin/videos/openaiVideos.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';

export function createVideoGenerationRouter({ store = new VideoStore(path.join(resolvePilotHome(process.env), 'generated-videos')),
  readConfig = () => readPilotDeckConfigFile().config, fetchImpl } = {}) {
  const router = express.Router();
  const manager = new VideoJobManager({ store, getConfig: () => readConfig().tools?.videoGeneration, fetchImpl });
  router.startRecovery = () => manager.startRecovery();
  router.get('/jobs/:sessionId/call/:toolCallId', async (req, res) => {
    try {
      const job = await manager.forCall(req.params.sessionId, req.params.toolCallId, typeof req.query.turnId === 'string' ? req.query.turnId : undefined);
      res.set('Cache-Control', 'private, no-store');
      return job ? res.json(videoJobView(job)) : res.status(404).json({ error: 'Video task not found.' });
    } catch { return res.status(500).json({ error: 'Cannot read video task.' }); }
  });
  router.post('/jobs/:sessionId/:jobId/resume', async (req, res) => {
    try { return res.json(videoJobView(await manager.resume(req.params.sessionId, req.params.jobId))); }
    catch { return res.status(404).json({ error: 'Video task not found.' }); }
  });
  router.post('/test', async (req, res) => {
    let apiKey = '';
    const startedAt = Date.now();
    try {
      const submitted = req.body || {};
      if (typeof submitted.model !== 'string' || !submitted.model.trim()) return res.status(400).json({ ok: false, error: 'A video model is required.' });
      const baseUrl = videoApiBaseUrl(submitted.baseUrl);
      const extraParams = submitted.extraParams;
      if (extraParams !== undefined && (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams) || JSON.stringify(extraParams).length > 8192)) return res.status(400).json({ ok: false, error: 'Model parameters must be a JSON object no larger than 8 KB.' });
      let requestedKey = submitted.apiKey;
      if (requestedKey === '********') {
        const saved = readConfig().tools?.videoGeneration;
        if (!saved || videoApiBaseUrl(saved.baseUrl) !== baseUrl) return res.status(400).json({ ok: false, error: 'Enter a new API key when changing the API address.' });
        requestedKey = saved.apiKey;
      }
      apiKey = resolveApiKey(requestedKey);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        // An explicit probe works while the feature is off, without changing
        // the saved opt-in or creating a project/session attachment.
        const temporary = await mkdtemp(path.join(tmpdir(), 'pilotdeck-video-probe-'));
        let bytes;
        try {
          const response = await requestOpenAIVideo({ enabled: true, apiKey, baseUrl, extraParams, model: submitted.model.trim() },
            { prompt: 'A blue ball rolls slowly on a plain white table, static camera.' },
            { signal: controller.signal, fetchImpl });
          const video = await new VideoStore(temporary).save('connection-test', response, controller.signal);
          bytes = video.bytes;
        } finally { await rm(temporary, { recursive: true, force: true }); }
        if (controller.signal.aborted) return;
        return res.json({ ok: true, latencyMs: Date.now() - startedAt, bytes });
      } finally { res.off('close', abort); }
    } catch (error) {
      if (res.destroyed) return;
      const detail = error instanceof Error ? error.message : 'Video connection test failed.';
      return res.status(400).json({ ok: false, error: (apiKey ? detail.split(apiKey).join('[REDACTED]') : detail).slice(0, 1200) });
    }
  });
  router.get('/:sessionId/:videoId', async (req, res) => {
    try {
      const video = await store.get(req.params.sessionId, req.params.videoId);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type(video.mimeType);
      if (req.query.download === '1') res.attachment(`video-${video.videoId}.mp4`);
      // Express sendFile supports Range/206, HEAD and seeking without buffering.
      return res.sendFile(video.path);
    } catch { return res.status(404).json({ error: 'Video attachment not found in this session.' }); }
  });
  return router;
}

export default createVideoGenerationRouter();
