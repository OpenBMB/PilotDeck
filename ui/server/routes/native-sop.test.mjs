// @vitest-environment node
import express from 'express';
import { expect, it, vi } from 'vitest';
vi.mock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), getPilotDeckHostCapabilities: vi.fn(), continueSopViaGateway: vi.fn() }));
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeSopRouter } from './native-sop.mjs';

it('native routes enforce owner and session scope and replay persisted SSE events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-sop-route-'));
  let userId = 'owner', runs = 0, resumes = 0;
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  const service = { recover: async () => {}, call: async operation => operation === 'job_events'
    ? { data: [{ sequence: 2, event: 'complete', data: { result: { content: { name: 'Persisted' } } } }] } : {} };
  const router = createNativeSopRouter({ config: () => ({ hostAdapter: 'pilotdeck' }), readOwner: () => 'owner', service,
    continuationPath: join(root, 'outbox.json'), authorization: () => 'Bearer authenticated-owner',
    getGateway: async () => ({ sopStatus: async input => {
      if (input.sessionKey !== 'owned') throw Object.assign(new Error('Session forbidden'), { status: 403 }); return {};
    }, resumeSop: async input => { resumes++; return { accepted: true, sessionId: input.sessionKey, requestId: input.requestId, revision: 4 }; }, runGet: async () => runs ? {} : undefined }),
    continueRun: async (_input, accepted) => { runs++; await accepted(); },
  });
  app.use('/api/sop', router);
  const server = app.listen(0); const origin = `http://127.0.0.1:${server.address().port}/api/sop`;
  const post = async (path, body) => { const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const command = { sessionKey: 'owned', source: 'human', waitId: 'wait', requestId: 'request', expectedRevision: 3, message: 'Approved' };
  try {
    userId = 'other'; expect((await post('/resume', command)).status).toBe(403); userId = 'owner';
    expect((await post('/resume', { ...command, subject: { userId: 'owner' } })).status).toBe(400);
    expect((await post('/resume', { ...command, sessionKey: 'foreign' })).status).toBe(403);
    expect((await post('/resume', command)).body.accepted).toBe(true);
    expect((await post('/resume', command)).body.duplicate).toBe(true);
    expect(resumes).toBe(1);
    expect(await (await fetch(origin + '/native/jobs/job/events?after_seq=1')).text()).toContain('"saved_draft"');
  } finally { await new Promise(resolve => server.close(resolve)); await router.dispose(); await rm(root, { recursive: true, force: true }); }
});

it.each([[false, false], [false, true], [true, false], [true, true]])('shares knowledge=%s versions=%s with the editor and generation worker', async (knowledge, versionManagement) => {
  const root = await mkdtemp(join(tmpdir(), 'sop-features-route-'));
  const features = { knowledge, versionManagement };
  const bindings = [{ kind: 'tool', capabilityId: 'tool', toolName: 'read_file' }, { kind: 'knowledge', capabilityId: 'kb', toolName: 'knowledge_query' }];
  let generated;
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'owner' }; next(); });
  const service = { recover: async () => {}, call: async operation => operation === 'features' ? features : { data: [] },
    generate: async input => { generated = input; return { id: 'job' }; } };
  const router = createNativeSopRouter({ config: () => ({ hostAdapter: 'pilotdeck', capabilityBindings: bindings }),
    readOwner: () => 'owner', service, continuationPath: join(root, 'queue.json'), getHost: async () => ({ call: async () => ({ body: { data: [] } }) }) });
  app.use('/api/sop', router); const server = app.listen(0); const origin = `http://127.0.0.1:${server.address().port}/api/sop/native`;
  try {
    const editor = await (await fetch(origin + '/capabilities')).json();
    expect(editor.features).toEqual(features);
    const job = await fetch(origin + '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Make workflow' }) });
    expect(job.status).toBe(202);
    expect(generated.capabilities).toEqual(editor.bindings);
    expect(editor.bindings.map(value => value.kind)).toEqual(knowledge ? ['tool', 'knowledge'] : ['tool']);
  } finally { await new Promise(resolve => server.close(resolve)); await router.dispose(); await rm(root, { recursive: true, force: true }); }
});
