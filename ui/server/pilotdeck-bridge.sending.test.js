import { afterAll, expect, it, vi } from 'vitest';
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-sending-'));
    process.env.PILOT_HOME = home;
    return { gateway: null, home, previousHome };
});
vi.mock('./services/gatewayConnectionCache.js', () => ({ createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }) }));
import { enqueueInputViaGateway, getInputQueueStateViaGateway, serializeQueuedInputForStorage, runChatViaGateway } from './pilotdeck-bridge.js';
import { rm } from 'node:fs/promises';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createRequestContextMiddleware, withAuthenticatedRequest } from './middleware/requestContext.js';
import { anonymousRequestId, withRequestContext } from '../../src/network/requestContext.js';
import { requestLimiters } from './middleware/rateLimits.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = id => ({ id, runId: id, command: 'fixture', displayText: id, options: { projectPath: '/tmp/sending-project' } });

it('serializes authenticated HTTP attribution before crossing the gateway boundary', async () => {
    const calls = [];
    const gateway = {
        async *submitTurn(input) {
            // JSON serialization models the separate gateway process: only explicit
            // wire fields survive, regardless of the caller's AsyncLocalStorage.
            calls.push(JSON.parse(JSON.stringify(input)));
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const app = express();
    app.use(requestLimiters.ingress);
    app.use(express.json());
    app.use(createRequestContextMiddleware());
    app.use((req, res, next) => {
        req.user = { id: req.headers['test-auth-user'] };
        return withAuthenticatedRequest(req, res, next);
    });
    app.post('/generate', async (req, res) => {
        await runChatViaGateway('Generate a commit message', { projectPath: '/tmp/http-project', runId: req.body.runId },
            { send() {} }, 'pilotdeck', { getGateway: async () => { await new Promise(r => setTimeout(r, 5)); return gateway; } });
        res.end();
    });
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const requests = ['alice', 'bob'].map(user => ({ user, runId: randomUUID(), requestId: randomUUID(), deviceId: randomUUID() }));
    try {
        await Promise.all(requests.map(async request => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/generate`, { method: 'POST', headers: {
                'content-type': 'application/json', 'test-auth-user': request.user,
                'x-pilotdeck-user-id': 'f'.repeat(32), 'x-pilotdeck-request-id': request.requestId,
                'x-pilotdeck-device-id': request.deviceId, 'x-pilotdeck-version': '2026.10.29',
            }, body: JSON.stringify({ runId: request.runId, requestContext: { userId: 'attacker' } }) });
            expect(response.status).toBe(200);
        }));
        for (const request of requests) expect(calls.find(call => call.runId === request.runId)?.requestContext).toEqual({
            userId: anonymousRequestId('user', request.user), deviceId: request.deviceId,
            clientVersion: '2026.10.29', parentRequestId: request.requestId,
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

it('preserves per-message attribution through delayed queue dispatch', async () => {
    const calls = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.requestContext);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const requestContext = { userId: 'a'.repeat(32), deviceId: 'device-a', parentRequestId: 'request-a' };
    const queued = item('context');
    queued.options.requestContext = requestContext;
    await withRequestContext({ userId: 'b'.repeat(32), parentRequestId: 'unrelated-request', clientVersion: 'unrelated-version' },
        () => enqueueInputViaGateway('web:context-queue', queued, { send() {} }));
    await vi.waitFor(() => expect(calls).toEqual([requestContext]));
});
afterAll(async () => {
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});
it('shows idle input as sending, preserves concurrent input order, and removes each send only on acceptance', async () => {
    const acceptance = deferred(), completion = deferred(); const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            if (calls.length === 1) await acceptance.promise;
            yield { type: 'input_accepted', runId: input.runId };
            if (calls.length === 1) await completion.promise;
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_sending', writer = { send: frame => frames.push(structuredClone(frame)) };
    const first = await enqueueInputViaGateway(sid, item('first'), writer);
    expect(first.state.items[0].status).toBe('submitting');
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('dispatching');
    const second = await enqueueInputViaGateway(sid, item('second'), writer);
    expect(second.state.items[1].status).toBe('queued');
    acceptance.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items.map(x => x.id)).toEqual(['second']));
    expect(calls).toEqual(['first']);
    completion.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toEqual([]));
    expect(calls).toEqual(['first', 'second']);
    expect(frames.filter(x => x.type === 'session-input-accepted').map(x => x.runId)).toEqual(['first', 'second']);
    expect(frames.filter(x => x.role === 'user').map(x => x.queueItemId)).toEqual(['first', 'second']);
});
it('converts a provisional send to a real queue item if the gateway discovers another active client', async () => {
    const snapshot = deferred();
    mock.gateway = { getActiveTurnSnapshot: () => snapshot.promise, submitTurn: vi.fn() };
    const sid = 'web:s_remote_busy';
    expect((await enqueueInputViaGateway(sid, item('remote'), { send() {} })).state.items[0].status).toBe('submitting');
    snapshot.resolve({ active: true, runId: 'other-client', events: [] });
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});
it('retains failed sends for recovery and treats only actually dispatched inputs as uncertain on restart', async () => {
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn() { yield { type: 'error', message: 'Rejected before acceptance' }; },
    };
    const sid = 'web:s_rejected';
    await enqueueInputViaGateway(sid, item('rejected'), { send() {} });
    await vi.waitFor(async () => expect(await getInputQueueStateViaGateway(sid)).toMatchObject({ paused: true, items: [{ id: 'rejected', status: 'failed' }] }));
    expect(serializeQueuedInputForStorage({ ...item('checking'), status: 'submitting' }).status).toBe('queued');
    expect(serializeQueuedInputForStorage({ ...item('sent'), status: 'dispatching' }).status).toBe('delivery_uncertain');
});

it.each([false, true])('acknowledges a retry after execution without dispatching again (restart=%s)', async restart => {
    const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = `web:s_retry_${restart}`, writer = {send: frame => frames.push(frame)};
    const first = item(`accepted-${restart}`);
    await enqueueInputViaGateway(sid, first, writer);
    await vi.waitFor(() => expect(frames.some(frame => frame.kind === 'complete')).toBe(true));
    let enqueue = enqueueInputViaGateway;
    if (restart) {
        vi.resetModules();
        enqueue = (await import('./pilotdeck-bridge.js')).enqueueInputViaGateway;
    }
    const retry = await enqueue(sid, first, writer);
    expect(retry).toMatchObject({ok: true, state: {items: []}});
    expect(calls).toEqual([first.id]);
    await enqueue(sid, {...first, id: first.id + '-new', runId: first.id + '-new'}, writer);
    await vi.waitFor(() => expect(calls).toEqual([first.id, first.id + '-new']));
});


it('assigns a real ID before startup failure without acknowledging the input', async () => {
    const frames = [];
    const result = await runChatViaGateway('fixture', { projectPath: '/tmp/sending-project', runId: 'failed-start' },
        { send: frame => frames.push(frame) }, 'pilotdeck', {
            getGateway: async () => { throw new Error('Gateway unavailable'); },
        });
    expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
    expect(frames.some(frame => frame.kind === 'error' && frame.terminal === true && frame.sessionId === result.sessionKey)).toBe(true);
    expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
});
