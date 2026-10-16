import express from 'express';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNativeSopService, nativeSopError, readInstallationOwner, readSopConfig } from '../native-sop-service.mjs';
import { createSopContinuationQueue } from '../sop-continuations.mjs';
import { getPilotDeckGateway, getPilotDeckHostCapabilities, continueSopViaGateway } from '../pilotdeck-bridge.js';

const MANAGEMENT_OPERATIONS = new Set(['list', 'create', 'import', 'get_draft', 'replace_draft', 'validate', 'publish', 'list_versions', 'get_version', 'rollback', 'archive', 'delete']);
const home = () => process.env.PILOT_HOME || join(homedir(), '.pilotdeck');

function ownerAuthorization(ownerId) {
  if (readInstallationOwner() !== ownerId) throw nativeSopError('APPROVAL_SUBJECT_MISMATCH', 'Owner changed', 403);
  const db = new DatabaseSync(process.env.DATABASE_PATH || join(home(), 'auth.db'), { readOnly: true });
  try {
    const secret = process.env.JWT_SECRET || db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get()?.value;
    return `Bearer ${jwt.sign({ userId: ownerId }, secret, { expiresIn: '5m' })}`;
  } finally { db.close(); }
}

export function createNativeSopRouter({ config = readSopConfig, readOwner = readInstallationOwner,
  getGateway = getPilotDeckGateway, getHost = () => getPilotDeckHostCapabilities({ principal: {
    hostAdapter: 'pilotdeck', pilotDeckUserId: readOwner(), actorUserId: readOwner(), tenantId: 'pilotdeck', agentId: 'runtime-sop',
  } }),
  continueRun = continueSopViaGateway, service = createNativeSopService({ config, modelPort: getHost }),
  continuationPath = join(home(), 'sop', 'continuations.json'), authorization = ownerAuthorization } = {}) {
  const router = express.Router();
  const queue = createSopContinuationQueue({ path: continuationPath,
    resume: async row => (await getGateway()).resumeSop({ ...row.input, approverAuthorization: authorization(row.ownerId) }),
    accepted: async row => Boolean(await (await getGateway()).runGet({ sessionKey: row.input.sessionKey, projectKey: row.input.projectKey, runId: row.runId })),
    run: (row, onInputAccepted) => continueRun({ ...row.input, runId: row.runId,
      message: `人工处理结果：${row.input.message}\n请根据已恢复的 SOP 继续执行，直到下一次等待或完成。` }, onInputAccepted),
  });
  const timer = setInterval(() => { if (config()?.hostAdapter === 'pilotdeck') {
    void service.recover().catch(() => {}); void queue.drain().catch(() => {});
  } }, 1000);
  timer.unref();
  router.dispose = async () => { clearInterval(timer); await queue.idle(); };
  router.use((req, res, next) => {
    if (config()?.hostAdapter !== 'pilotdeck') return next('router');
    try {
      if (!readOwner() || String(req.user?.id ?? '') !== readOwner()) throw nativeSopError('SOP_APPROVAL_SESSION_FORBIDDEN', 'Current installation owner required', 403);
      if (['subject', 'authority'].some(key => Object.hasOwn(req.body ?? {}, key) || Object.hasOwn(req.query, key))) throw nativeSopError('APPROVAL_AUTHORITY_OVERRIDE', 'Identity comes from server authentication', 400);
      next();
    } catch (error) { fail(res, error); }
  });
  const route = (method, path, handler) => router[method](path, (req, res) => Promise.resolve(handler(req, res)).catch(error => fail(res, error)));
  route('get', '/native/capabilities', async (_req, res) => {
    const port = await getHost();
    const models = await port.call('list_model_catalog', {});
    const features = await service.call('features');
    res.json({ features, models: models.body?.data ?? models.body?.items ?? [], bindings: (config().capabilityBindings ?? []).filter(binding => features.knowledge !== false || binding.kind !== 'knowledge'), owner: { id: 'pilotdeck:owner', username: '当前登录 owner' } });
  });
  route('post', '/native/management', async (req, res) => {
    if (!MANAGEMENT_OPERATIONS.has(req.body?.operation)) throw nativeSopError('SOP_MANAGEMENT_OPERATION_UNSUPPORTED', 'Unsupported operation', 400);
    res.json(await service.call(req.body.operation, req.body.input ?? {}));
  });
  route('post', '/native/jobs', async (req, res) => {
    const features = await service.call('features');
    const input = { prompt: req.body?.prompt, instruction: req.body?.instruction, modelId: req.body?.modelId,
      capabilities: (config().capabilityBindings ?? []).filter(binding => features.knowledge !== false || binding.kind !== 'knowledge'), published: (await service.call('list')).data.filter(row => row.status === 'published').map(row => ({ sopId: row.sop_id, version: row.published_version })) };
    const kind = req.body?.kind === 'rewrite' ? 'rewrite' : 'generate';
    if (kind === 'rewrite') {
      const draft = await service.call('get_draft', { sopId: req.body.sopId, draftId: req.body.draftId });
      if (String(req.body.etag) !== draft.etag) throw nativeSopError('SOP_DRAFT_REVISION_CONFLICT', 'Reload the edited draft', 409);
      Object.assign(input, { sopId: draft.sop_id, draftId: draft.id, etag: draft.etag, current: draft.content });
    }
    res.status(202).json(await service.generate(input, kind));
  });
  route('post', '/native/jobs/:id/cancel', async (req, res) => res.json(await service.cancel(req.params.id)));
  route('get', '/native/jobs/:id/events', async (req, res) => {
    await service.recover();
    await service.call('job_get', { jobId: req.params.id });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    let after = Number(req.query.after_seq || req.headers['last-event-id'] || 0), closed = false;
    res.on('close', () => { closed = true; });
    while (!closed) {
      const job = await service.call('job_get', { jobId: req.params.id });
      const events = await service.call('job_events', { jobId: req.params.id, afterSequence: after });
      for (const item of events.data) {
        after = item.sequence;
        const failed = ['failed', 'cancelled', 'interrupted'].includes(item.data?.status);
        const event = failed ? 'error' : item.event;
        const data = { ...item.data, job_id: req.params.id, seq: item.sequence,
          ...(item.event === 'complete' ? { draft_skill: item.data.result.content, saved_draft: item.data.result, warnings: [], tool_suggestions: [] } : {}),
          ...(failed ? { message: item.data.error || item.data.status } : {}) };
        res.write(`id: ${after}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (failed || item.event === 'complete') { res.end(); return; }
      }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) { res.end(); return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  });
  route('get', '/status', async (req, res) => {
    const status = await (await getGateway()).sopStatus({ sessionKey: req.query.sessionKey,
      ...(req.query.projectKey ? { projectKey: req.query.projectKey } : {}), approverAuthorization: req.headers.authorization });
    res.json({ status });
  });
  route('post', '/resume', async (req, res) => {
    const body = req.body ?? {};
    if (body.source !== 'human' || ![body.sessionKey, body.waitId, body.requestId, body.message].every(value => typeof value === 'string' && value.trim())
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw nativeSopError('APPROVAL_INPUT_INVALID', 'Original wait, request and revision required', 400);
    if (body.slotUpdates !== undefined && (!body.slotUpdates || typeof body.slotUpdates !== 'object' || Array.isArray(body.slotUpdates))) throw nativeSopError('APPROVAL_INPUT_INVALID', 'Slot updates must be an object', 400);
    const input = { sessionKey: body.sessionKey, waitId: body.waitId, requestId: body.requestId, message: body.message,
      source: 'human', expectedRevision: body.expectedRevision, ...(body.projectKey ? { projectKey: body.projectKey } : {}),
      ...(body.slotUpdates ? { slotUpdates: body.slotUpdates } : {}) };
    // Authenticate session access before persisting any delivery intent (including duplicates).
    await (await getGateway()).sopStatus({ sessionKey: input.sessionKey, projectKey: input.projectKey, approverAuthorization: req.headers.authorization });
    const row = await queue.enqueue(input, String(req.user.id));
    // Only the queue calls resume; retries recover the exact command after a crash.
    const current = await queue.resumePending(row.key);
    void queue.drain().catch(() => {});
    if (!current.receipt) throw nativeSopError(current.error?.code || 'SOP_RESUME_PENDING', current.error?.message || 'Resume pending', 409);
    res.json({ ...current.receipt, duplicate: Boolean(row.receipt), continuationRunId: row.runId });
  });
  return router;
}

function fail(res, error) {
  if (res.headersSent) return res.end();
  res.status(error.status || error.details?.httpStatus || 500).json({ error: { code: error.code || 'SOP_NATIVE_FAILED', message: error.message } });
}
