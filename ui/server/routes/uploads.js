import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { UploadStore } from '../../../src/gateway/dialog/UploadStore.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';

const router = express.Router();

async function listProjectRoots() {
  const gateway = await getPilotDeckGateway();
  const result = await gateway.listProjects();
  // Browser attachments are stored in the controlled UploadStore and do not
  // grant project-file browsing. Keep them available for General even though
  // PILOT_HOME is intentionally absent from gateway.listProjects().
  return [resolvePilotHome(process.env), ...result.projects.map((project) => project.projectKey)];
}

const store = new UploadStore({
  async resolveProject(projectKey) {
    const projects = await listProjectRoots();
    const match = projects.find((candidate) => path.resolve(candidate) === path.resolve(projectKey || ''));
    if (!match) {
      const error = new Error(`Unknown projectKey: ${projectKey}`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    return match;
  },
  listProjects: listProjectRoots,
  maxFileBytes: envNumber('PILOTDECK_UPLOAD_MAX_FILE_BYTES'),
  maxTaskBytes: envNumber('PILOTDECK_UPLOAD_MAX_TASK_BYTES'),
  maxFiles: envNumber('PILOTDECK_UPLOAD_MAX_FILES'),
  maxConcurrentPerProject: envNumber('PILOTDECK_UPLOAD_MAX_CONCURRENT'),
  retentionMs: envNumber('PILOTDECK_UPLOAD_RETENTION_MS'),
});

const cleanupTimer = setInterval(() => void store.cleanupExpired().catch((error) => {
  console.warn('[uploads] cleanup failed:', error);
}), 15 * 60 * 1000);
cleanupTimer.unref?.();

const storage = {
  _handleFile(req, file, callback) {
    const match = /^files\[([A-Za-z0-9._-]+)\]$/.exec(file.fieldname);
    if (!match) {
      const error = new Error(`Invalid multipart field: ${file.fieldname}`);
      error.code = 'UPLOAD_MANIFEST_MISMATCH';
      callback(error);
      return;
    }
    store.writePart(req.params.uploadId, match[1], file.stream)
      .then((attachment) => callback(null, attachment))
      .catch(callback);
  },
  _removeFile(_req, _file, callback) { callback(null); },
};
const uploadContent = multer({ storage, limits: { files: 500, fields: 20 } }).any();

router.post('/', async (req, res) => {
  try {
    const record = await store.create(
      req.body?.projectKey,
      req.body?.files,
      typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key') : undefined,
    );
    return res.status(201).json({
      ...publicRecord(record),
      contentUrl: `/api/uploads/${record.uploadId}/content`,
      eventsUrl: `/api/uploads/${record.uploadId}/events`,
    });
  } catch (error) {
    return sendError(res, error, req.id);
  }
});

router.post('/:uploadId/content', (req, res) => {
  uploadContent(req, res, async (error) => {
    if (error) {
      try {
        await store.fail(req.params.uploadId, error.code || 'UPLOAD_STREAM_INTERRUPTED', error.message);
      } catch {}
      return sendError(res, error, req.id);
    }
    try {
      return res.json(publicRecord(await store.complete(req.params.uploadId)));
    } catch (completeError) {
      return sendError(res, completeError, req.id);
    }
  });
});

router.get('/:uploadId/events', async (req, res) => {
  let pendingRecord;
  let ready = false;
  let unsubscribe = () => {};
  try {
    unsubscribe = store.subscribe(req.params.uploadId, (record) => {
      if (!ready) {
        pendingRecord = record;
        return;
      }
      sendEvent(res, eventName(record), record);
      if (isTerminal(record.status)) { unsubscribe(); res.end(); }
    });
    const snapshot = await store.get(req.params.uploadId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    ready = true;
    const current = pendingRecord ?? snapshot;
    sendEvent(res, eventName(current), current);
    if (isTerminal(current.status)) { unsubscribe(); return res.end(); }
    req.on('close', unsubscribe);
  } catch (error) {
    unsubscribe();
    return sendError(res, error, req.id);
  }
});

router.get('/:uploadId', async (req, res) => {
  try { return res.json(publicRecord(await store.get(req.params.uploadId))); }
  catch (error) { return sendError(res, error, req.id); }
});

router.delete('/:uploadId', async (req, res) => {
  try { await store.cancel(req.params.uploadId); return res.status(204).end(); }
  catch (error) { return sendError(res, error, req.id); }
});

function publicRecord(record) {
  return {
    uploadId: record.uploadId,
    status: record.status,
    totalBytes: record.totalBytes,
    uploadedBytes: record.uploadedBytes,
    percent: record.totalBytes === 0 ? 100 : Math.min(100, Math.round((record.uploadedBytes / record.totalBytes) * 10000) / 100),
    expiresAt: record.expiresAt,
    ...(record.attachments ? { attachments: record.attachments.map(({ path: _path, ...item }) => item) } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
}

function sendEvent(res, event, record) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(publicRecord(record))}\n\n`);
}
function eventName(record) {
  if (record.status === 'created') return 'upload_started';
  if (record.status === 'completed') return 'upload_completed';
  if (record.status === 'failed') return 'upload_failed';
  return 'upload_progress';
}
function isTerminal(status) { return ['completed', 'failed', 'cancelled', 'expired'].includes(status); }
function envNumber(name) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : undefined; }
function sendError(res, error, requestId) {
  const code = typeof error?.code === 'string' ? error.code : 'gateway_request_failed';
  const statuses = {
    PROJECT_NOT_FOUND: 404, UPLOAD_NOT_FOUND: 404, UPLOAD_CONCURRENCY_LIMIT: 429,
    UPLOAD_MANIFEST_INVALID: 400, UPLOAD_MANIFEST_MISMATCH: 400,
    UPLOAD_FILE_TOO_LARGE: 413, UPLOAD_TASK_TOO_LARGE: 413,
    UPLOAD_INTEGRITY_MISMATCH: 422, UPLOAD_INVALID_STATE: 409, UPLOAD_ALREADY_COMPLETED: 409,
    UPLOAD_NOT_COMPLETED: 409, ATTACHMENT_EXPIRED: 410, PROJECT_PATH_FORBIDDEN: 403,
    ATTACHMENT_NOT_FOUND: 404, ATTACHMENT_TAMPERED: 422,
  };
  return res.status(statuses[code] || 500).json({ error: {
    code, message: error instanceof Error ? error.message : String(error),
    ...(error?.details ? { details: error.details } : {}),
    ...(requestId ? { requestId } : {}),
  } });
}

export { store as uploadStore };
export default router;
