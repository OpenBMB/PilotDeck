import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import test from 'node:test';
import { GatewayWsClient, GatewayRequestError } from '../../src/gateway/client/GatewayWsClient.js';
import { GatewayWsConnection } from '../../src/gateway/server/GatewayWsConnection.js';
import { TextWebSocketConnection } from '../../src/gateway/server/websocket.js';
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from '../../src/gateway/protocol/version.js';
import type { Gateway, GatewayEvent } from '../../src/gateway/protocol/types.js';
import { RemoteGateway } from '../../src/gateway/client/RemoteGateway.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class SocketDouble extends EventEmitter { write() {} end() { this.emit('close'); } }
for (const cause of ['local', 'peer', 'abrupt'] as const) test(`${cause} WebSocket closure notifies every owner exactly once`, () => {
  const socket = new SocketDouble(); const ws = new TextWebSocketConnection(socket as unknown as Socket);
  let turnCleanup = 0, registryCleanup = 0;
  ws.onClose(() => { turnCleanup++; }); ws.onClose(() => { registryCleanup++; });
  if (cause === 'local') ws.close(); else if (cause === 'peer') socket.emit('data', Buffer.from([0x88, 0x80, 0, 0, 0, 0])); else socket.emit('close');
  socket.emit('close'); socket.emit('error', new Error('late socket error')); ws.close();
  assert.equal(turnCleanup, 1); assert.equal(registryCleanup, 1);
});

class TextSocketDouble {
  sent: any[] = [];
  message?: (text: string) => void;
  closed: Array<() => void> = [];
  onMessage(handler: (text: string) => void) { this.message = handler; }
  onClose(handler: () => void) { this.closed.push(handler); }
  sendText(text: string) { this.sent.push(JSON.parse(text)); }
  close() { for (const handler of this.closed) handler(); }
  dispatch(frame: unknown) { this.message!(JSON.stringify(frame)); }
}
async function connection(gateway: Partial<Gateway>) {
  const ws = new TextSocketDouble();
  new GatewayWsConnection(ws as unknown as TextWebSocketConnection, { token: 'synthetic', serverVersion: 'test',
    gateway: { describeServer: async () => ({ mode: 'in_process' }), ...gateway } as Gateway });
  ws.dispatch({ type: 'hello', protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION, token: 'synthetic', clientName: 'test', clientVersion: 'test' });
  await tick(); return ws;
}

test('runtime status preserves lightweight Python reads and executing-host Git across remote RPC', async () => {
  const inputs: unknown[] = [];
  const git = { state: 'ready' as const, source: 'bundled' as const, executable: '/executing-host/git', version: '2.51.2' };
  const ws = await connection({
    getPythonRuntimeStatus: async input => { inputs.push(input); return { enabled: true, state: input?.initialize === false ? 'available' : 'ready' }; },
    getGitRuntimeStatus: async () => git,
  });
  const client = new GatewayWsClient({ url: 'ws://synthetic.invalid', token: 'synthetic' });
  const internals = client as unknown as { ws: unknown; handleMessage(text: string): void; closePending(error: Error): void };
  internals.ws = { readyState: WebSocket.OPEN, send: (text: string) => {
    ws.dispatch(JSON.parse(text));
    void tick().then(() => {
      for (const frame of ws.sent.splice(0)) if (frame.type === 'response') internals.handleMessage(JSON.stringify(frame));
    });
  } };
  const remote = new RemoteGateway(client);
  try {
    assert.equal((await remote.getPythonRuntimeStatus({ initialize: false })).state, 'available');
    assert.equal((await remote.getPythonRuntimeStatus()).state, 'ready');
    assert.deepEqual(inputs, [{ initialize: false }, undefined]);
    assert.deepEqual(await remote.getGitRuntimeStatus(), git);
  } finally { internals.closePending(new Error('test cleanup')); ws.close(); }
});
test('a rejected duplicate cannot discard the original request disconnect ownership', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const aborted: unknown[] = []; let calls = 0;
  const ws = await connection({ submitTurn: async function* (input, options) {
    if (++calls === 1) {
      options?.signal?.addEventListener('abort', () => aborted.push({ sessionKey: input.sessionKey, runId: input.runId }), { once: true });
      yield { type: 'input_accepted', runId: input.runId! }; await gate;
    }
    else yield { type: 'error', code: 'session_busy', message: 'busy', recoverable: true };
  } });
  try {
    ws.dispatch({ type: 'request', id: 'first', method: 'submit_turn', params: { sessionKey: 's', runId: 'owner' } }); await tick();
    ws.dispatch({ type: 'request', id: 'second', method: 'submit_turn', params: { sessionKey: 's', runId: 'rejected' } }); await tick();
    ws.close(); await tick();
    assert.deepEqual(aborted, [{ sessionKey: 's', runId: 'owner' }]);
  } finally { release(); await tick(); }
});

test('remote iterator return cancels only its generated run and releases stream bookkeeping', async () => {
  const client = new GatewayWsClient({ url: 'ws://synthetic.invalid', token: 'synthetic' });
  const sent: any[] = [];
  const internals = client as unknown as { ws: unknown; handleMessage(text: string): void; streams: Map<string, unknown>; pending: Map<string, unknown> };
  internals.ws = { readyState: WebSocket.OPEN, send: (text: string) => {
    const frame = JSON.parse(text); sent.push(frame);
    if (frame.method === 'abort_turn') internals.handleMessage(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { ok: true } }));
  } };
  const iterator = client.stream('submit_turn', { sessionKey: 's', message: 'synthetic' })[Symbol.asyncIterator]();
  assert.equal(typeof sent[0].params.runId, 'string');
  await iterator.return!();
  assert.equal(sent[1].method, 'abort_turn');
  assert.equal(sent[1].params.runId, sent[0].params.runId);
  assert.equal(sent[1].params.requestId, sent[0].id);
  assert.equal(internals.streams.size, 0); assert.equal(internals.pending.size, 0);
});

test('a failed stream send leaves no retained queue', () => {
  const client = new GatewayWsClient({ url: 'ws://synthetic.invalid', token: 'synthetic' });
  assert.throws(() => client.stream('submit_turn', { sessionKey: 's' }), /not connected/);
  assert.equal((client as unknown as { streams: Map<string, unknown> }).streams.size, 0);
});

for (const partial of [false, true]) test(`a server stream exception ${partial ? 'after output' : 'before output'} rejects its client with structured details`, async () => {
  const ws = await connection({ submitTurn: async function* () {
    if (partial) yield { type: 'assistant_text_delta', text: 'partial' };
    throw Object.assign(new Error('Synthetic failure'), { code: 'fixture_failure', details: { stage: 'prepare' } });
  } });
  const client = new GatewayWsClient({ url: 'ws://synthetic.invalid', token: 'synthetic' });
  // Exercise both production protocol handlers without opening a network port.
  const internals = client as unknown as { ws: unknown; handleMessage(text: string): void; streams: Map<string, unknown>; closePending(error: Error): void };
  internals.ws = { readyState: WebSocket.OPEN, send: (text: string) => ws.dispatch(JSON.parse(text)) };
  const stream = client.stream('submit_turn', { sessionKey: 's' })[Symbol.asyncIterator]();
  let result: unknown;
  const pending = stream.next().then(value => { result = value; }, error => { result = error; });
  await tick();
  for (const frame of ws.sent.filter(frame => frame.type === 'event' || frame.type === 'response')) internals.handleMessage(JSON.stringify(frame));
  await tick();
  try {
    if (partial) {
      assert.equal((result as { value: GatewayEvent }).value.type, 'assistant_text_delta');
      result = undefined;
      void stream.next().then(value => { result = value; }, error => { result = error; });
      await tick();
    }
    assert.ok(result instanceof GatewayRequestError);
    assert.equal(result.code, 'fixture_failure'); assert.deepEqual(result.details, { stage: 'prepare' });
    assert.equal(internals.streams.size, 0);
  } finally { internals.closePending(new Error('test cleanup')); await pending; }
});
