import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentEvent, AgentSession } from '../../src/agent/index.js';
import { InProcessGateway, type InProcessGatewayOptions } from '../../src/gateway/client/InProcessGateway.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import type { GatewayEvent } from '../../src/gateway/protocol/types.js';
import { GatewayWsConnection } from '../../src/gateway/server/GatewayWsConnection.js';
import type { TextWebSocketConnection } from '../../src/gateway/server/websocket.js';
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from '../../src/gateway/protocol/version.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const input = (runId: string) => ({ sessionKey: 'synthetic-session', channelKey: 'web', message: 'Synthetic request', runId });
async function collect(events: AsyncIterable<GatewayEvent>) {
  const result: GatewayEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function fixture(t: TestContext, createSession: () => AgentSession | Promise<AgentSession>, options: InProcessGatewayOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-turn-ownership-'));
  const previous = process.env.PILOT_HOME;
  process.env.PILOT_HOME = home;
  const router = new SessionRouter({ createSession, idleSweepIntervalMs: 0 });
  t.after(async () => { router.shutdown(); if (previous === undefined) delete process.env.PILOT_HOME; else process.env.PILOT_HOME = previous; await rm(home, { recursive: true, force: true }); });
  return { router, gateway: new InProcessGateway(router, options) };
}

async function socketConnection(gateway: InProcessGateway) {
  let receive!: (message: string) => void, close!: () => void;
  const sent: any[] = [];
  const socket = { onMessage(handler: typeof receive) { receive = handler; }, onClose(handler: () => void) { close = handler; }, sendText(text: string) { sent.push(JSON.parse(text)); }, close() { close(); } };
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, { gateway, token: 'synthetic', serverVersion: 'test' });
  receive(JSON.stringify({ type: 'hello', protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, token: 'synthetic', clientName: 'test', clientVersion: 'test' }));
  await tick();
  return { close, sent, send: (frame: unknown) => receive(JSON.stringify(frame)) };
}

for (const disconnectOwner of [false, true]) test(`disconnect ${disconnectOwner ? 'owns' : 'cannot steal'} cancellation during initialization, even when another connection reused the run id`, { timeout: 5000 }, async t => {
  const entered = deferred(), initialized = deferred(), done = deferred(); let starts = 0, aborts = 0;
  const session = { dispose: async () => {}, abort() { aborts++; done.resolve(); }, submit: async function* () {
    starts++; yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'same-id' } as AgentEvent; await done.promise;
  } } as unknown as AgentSession;
  const { gateway, router } = await fixture(t, async () => { entered.resolve(); await initialized.promise; return session; });
  const owner = await socketConnection(gateway), rejected = await socketConnection(gateway);
  owner.send({ type: 'request', id: 'owner', method: 'submit_turn', params: input('same-id') }); await entered.promise;
  rejected.send({ type: 'request', id: 'retry', method: 'submit_turn', params: input('same-id') });
  // Disconnect immediately, before the rejected generator has finished emitting.
  rejected.close(); if (disconnectOwner) owner.close();
  initialized.resolve(); await tick();
  try {
    assert.equal(starts, disconnectOwner ? 0 : 1);
    assert.equal(aborts, 0);
    assert.equal(router.hasActiveTurn('synthetic-session'), !disconnectOwner);
    if (!disconnectOwner) { owner.close(); await tick(); assert.equal(aborts, 1); assert.equal(router.hasActiveTurn('synthetic-session'), false); }
  } finally { initialized.resolve(); done.resolve(); await tick(); }
});

for (const stage of ['config', 'session', 'attachments', 'selection'] as const) {
  test(`Stop during ${stage} preparation prevents agent execution and permits a later turn`, { timeout: 5000 }, async t => {
    const entered = deferred(), release = deferred();
    let block = true, starts = 0;
    const prepare = async () => { if (block) { entered.resolve(); await release.promise; } };
    const session = { abort() {}, dispose: async () => {}, submit: async function* () {
      starts++; yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'run' } as AgentEvent;
    } } as unknown as AgentSession;
    const options: InProcessGatewayOptions = {
      ...(stage === 'config' ? { refreshConfigBeforeTurn: prepare } : {}),
      ...(stage === 'attachments' ? { resolveUploadedAttachments: async () => { await prepare(); return []; } } : {}),
      ...(stage === 'selection' ? { resolveTurnModelSelection: async () => { await prepare(); return { source: 'default' }; } } : {}),
    };
    const { gateway, router } = await fixture(t, async () => { if (stage === 'session') await prepare(); return session; }, options);
    const submitted = collect(gateway.submitTurn({ ...input('run'), projectKey: '/synthetic',
      ...(stage === 'attachments' ? { uploadedAttachments: [{ uploadId: 'synthetic', attachmentIds: ['file'] }] } : {}) }));
    await entered.promise;
    const stopped = gateway.abortTurn({ sessionKey: 'synthetic-session', runId: 'run' });
    await tick(); block = false; release.resolve();
    const events = await submitted; await stopped;
    assert.equal(starts, 0, 'a cancelled preparation must never invoke the agent');
    assert.equal(events.some(e => e.type === 'input_accepted'), false);
    assert.ok(events.some(e => e.type === 'turn_completed' && e.finishReason === 'aborted'));
    assert.equal(router.hasActiveTurn('synthetic-session'), false);
    await collect(gateway.submitTurn(input('next')));
    assert.equal(starts, 1);
  });
}

test('a stale Stop cannot cancel the active run; matching Stop drains it', { timeout: 5000 }, async t => {
  const release = deferred(); let aborts = 0;
  const session = { abort() { aborts++; release.resolve(); }, dispose: async () => {}, submit: async function* () {
    yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'current' } as AgentEvent;
    await release.promise;
  } } as unknown as AgentSession;
  const { gateway, router } = await fixture(t, () => session, { abortTurnTimeoutMs: 20 });
  const iterator = gateway.submitTurn(input('current'))[Symbol.asyncIterator]();
  await iterator.next();
  const drained = collect({ [Symbol.asyncIterator]: () => iterator });
  try {
    await gateway.abortTurn({ sessionKey: 'synthetic-session', runId: 'old' });
    assert.equal(aborts, 0);
    assert.equal(router.activeTurnRunId('synthetic-session'), 'current');
    await gateway.abortTurn({ sessionKey: 'synthetic-session', runId: 'current' });
    assert.equal(aborts, 1);
    assert.equal(router.hasActiveTurn('synthetic-session'), false);
  } finally { release.resolve(); await drained; }
});

test('returning the event iterator cancels execution without releasing its session before drain', { timeout: 5000 }, async t => {
  const release = deferred(); let aborts = 0, starts = 0;
  const session = { abort() { aborts++; }, dispose: async () => {}, submit: async function* () {
    starts++; yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'run' } as AgentEvent;
    await release.promise;
  } } as unknown as AgentSession;
  const { gateway } = await fixture(t, () => session);
  const first = gateway.submitTurn(input('first'))[Symbol.asyncIterator]();
  await first.next(); const returning = first.return!(); await tick();
  try {
    assert.equal(aborts, 1);
    const next = gateway.submitTurn(input('second'))[Symbol.asyncIterator]();
    const event = await next.next();
    assert.equal(event.value?.type === 'agent_status' ? event.value.event : '', 'session_busy');
    await next.return!();
    assert.equal(starts, 1);
  } finally { release.resolve(); await returning; }
  await collect(gateway.submitTurn(input('third')));
  assert.equal(starts, 2);
});

test('execution completion releases ownership even when a consumer pauses after its first event', { timeout: 5000 }, async t => {
  let aborts = 0;
  const session = { abort() { aborts++; }, dispose: async () => {}, submit: async function* () {
    yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'run' } as AgentEvent;
  } } as unknown as AgentSession;
  const { gateway, router } = await fixture(t, () => session);
  const first = gateway.submitTurn(input('first'))[Symbol.asyncIterator]();
  await first.next(); await tick();
  try { assert.equal(router.hasActiveTurn('synthetic-session'), false); }
  finally { await first.return!(); }
  await collect(gateway.submitTurn(input('next')));
  assert.equal(aborts, 0, 'closing a completed consumer must not abort a reusable session');
});

test('closing a session during initialization disposes the late result instead of caching it', async () => {
  const entered = deferred(), release = deferred(); let disposed = 0;
  const session = { dispose: async () => { disposed++; } } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: async () => { entered.resolve(); await release.promise; return session; } });
  const pending = router.getOrCreate({ sessionKey: 'late', channelKey: 'web' });
  await entered.promise; await router.close('late'); release.resolve();
  try { await assert.rejects(pending, /closed/i); assert.equal(disposed, 1); assert.equal(router.cachedSessionCount(), 0); }
  finally { router.shutdown(); }
});

test('hard timeout covers session initialization and cannot let a late factory replace the next run', { timeout: 5000 }, async t => {
  const release = deferred(); let creations = 0, staleStarts = 0, disposed = 0;
  const stale = { dispose: async () => { disposed++; }, submit: async function* () { staleStarts++; } } as unknown as AgentSession;
  const current = { dispose: async () => {}, submit: async function* () {
    yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: 'next' } as AgentEvent;
  } } as unknown as AgentSession;
  const { gateway, router } = await fixture(t, async () => { if (++creations === 1) { await release.promise; return stale; } return current; });
  try {
    const events = await collect(gateway.submitTurn({ ...input('timeout'), timeoutMs: 20 }));
    assert.ok(events.some(e => e.type === 'error' && e.code === 'turn_timeout'));
    const next = await collect(gateway.submitTurn(input('next')));
    assert.ok(next.some(e => e.type === 'input_accepted'));
    release.resolve(); await tick();
    assert.equal(staleStarts, 0); assert.equal(disposed, 1);
    assert.equal(await router.getOrCreate({ sessionKey: 'synthetic-session', channelKey: 'web' }), current);
  } finally { release.resolve(); await tick(); }
});

test('hard timeout quarantines a non-cooperative active turn without its late cleanup affecting the next run', { timeout: 5000 }, async t => {
  const oldRelease = deferred(), nextRelease = deferred(); let creations = 0, aborts = 0, disposals = 0;
  const create = () => {
    const old = ++creations === 1;
    return { abort() { aborts++; }, dispose: async () => { disposals++; }, submit: async function* () {
      yield { type: 'input_accepted', sessionId: 'synthetic-session', turnId: old ? 'old' : 'next' } as AgentEvent;
      await (old ? oldRelease.promise : nextRelease.promise);
      if (old) yield { type: 'model_event', sessionId: 'synthetic-session', turnId: 'same', event: { type: 'text_delta', text: 'stale output' } } as AgentEvent;
    } } as unknown as AgentSession;
  };
  const { gateway, router } = await fixture(t, create);
  const events = await collect(gateway.submitTurn({ ...input('same'), timeoutMs: 20 }));
  assert.ok(events.some(e => e.type === 'error' && e.code === 'turn_timeout'));
  assert.equal(aborts, 1); assert.equal(disposals, 1);
  const next = gateway.submitTurn(input('same'))[Symbol.asyncIterator](); await next.next();
  let permissionRejected = false;
  gateway.getPermissionBus().register('synthetic-session', { requestId: 'new-permission', toolCallId: 'tool', toolName: 'synthetic', resolve() {}, reject() { permissionRejected = true; } });
  try {
    oldRelease.resolve(); await tick();
    assert.equal(router.activeTurnRunId('synthetic-session'), 'same');
    const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: 'synthetic-session' });
    assert.equal(snapshot.runId, 'same');
    assert.equal(JSON.stringify(snapshot.events).includes('stale output'), false);
    assert.equal(permissionRejected, false);
    assert.equal(gateway.getPermissionBus().hasPending('synthetic-session', 'new-permission'), true);
  } finally { oldRelease.resolve(); nextRelease.resolve(); await collect({ [Symbol.asyncIterator]: () => next }); }
});

test('ordinary idle eviction still permits transparent session recreation', async () => {
  let now = 0, creations = 0;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, idleSessionTimeoutMs: 10, now: () => new Date(now), createSession: () => {
    creations++; return { dispose: async () => {} } as unknown as AgentSession;
  } });
  try {
    const first = await router.getOrCreate({ sessionKey: 'idle', channelKey: 'web' }); now = 11;
    const second = await router.getOrCreate({ sessionKey: 'idle', channelKey: 'web' });
    assert.notEqual(first, second); assert.equal(creations, 2);
  } finally { router.shutdown(); }
});

test('shutdown disposes an initializing session and prevents new reservations', async () => {
  const release = deferred(); let disposed = 0;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: async () => {
    await release.promise; return { dispose: async () => { disposed++; } } as unknown as AgentSession;
  } });
  const pending = router.getOrCreate({ sessionKey: 'late', channelKey: 'web' }); router.shutdown(); release.resolve();
  await assert.rejects(pending, /closed/); assert.equal(disposed, 1);
  assert.equal(router.beginTurn('new', 'run'), false);
  await assert.rejects(router.getOrCreate({ sessionKey: 'new', channelKey: 'web' }), /closed/);
});
