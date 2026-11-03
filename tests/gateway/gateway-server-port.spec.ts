import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test from 'node:test';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import type { Gateway } from '../../src/gateway/protocol/types.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import type { SessionRouter } from '../../src/gateway/SessionRouter.js';

test('exposes port 80 even though URL normalization omits the default HTTP port', async context => {
  // Simulate a successful bind without requiring a privileged or free port 80.
  context.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const onListening = args.at(-1);
    if (typeof onListening === 'function') queueMicrotask(() => onListening());
    return this;
  });
  context.mock.method(Server.prototype, 'address', () => ({ port: 80, address: '127.0.0.1', family: 'IPv4' }));
  const server = await startGatewayServer({ gateway: {} as Gateway, port: 80, token: 'test-only' });
  assert.equal(new URL(server.url).port, '');
  assert.equal(server.port, 80);
});

test('exposes the actual ephemeral port rather than the requested zero', async () => {
  const server = await startGatewayServer({ gateway: {} as Gateway, port: 0, token: 'test-only' });
  try {
    assert.ok(server.port > 0);
    assert.equal(server.port, Number(new URL(server.url).port));
    const health = await fetch(`${server.url}/health`, { headers: { 'x-pilotdeck-request-id': 'test-request' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-pilotdeck-request-id'), 'test-request');
    assert.ok(health.headers.get('x-pilotdeck-version'));
  } finally { await server.close(); }
});

test('runtime activity is authenticated and distinguishes idle, active and unavailable counts', async () => {
  let count: number | undefined = 0;
  let failure = false;
  const gateway = { describeServer: async () => {
    if (failure) throw new Error('private runtime stack and filesystem details');
    return { mode: 'in_process', activeTaskCount: count };
  } } as Gateway;
  const server = await startGatewayServer({ gateway, port: 0, token: 'activity-test' });
  try {
    const url = `${server.url}/api/web/runtime/activity`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: 'Bearer activity-test' };
    for (const value of [0, 3, undefined]) {
      count = value;
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { activeTaskCount: value ?? null });
    }
    failure = true;
    const response = await fetch(url, { headers });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'activity_unavailable', message: 'Runtime activity is temporarily unavailable.' } });
  } finally { await server.close(); }
});

test('detached background tasks keep quit confirmation active even between agent turns', async () => {
  let backgroundTasks = 2;
  const gateway = new InProcessGateway({ sessionCount: () => 0 } as SessionRouter, {
    activeBackgroundTaskCount: () => backgroundTasks,
  });
  assert.equal((await gateway.describeServer()).activeTurnCount, 0);
  assert.equal((await gateway.describeServer()).activeTaskCount, 2);
  backgroundTasks = 0;
  assert.equal((await gateway.describeServer()).activeTaskCount, 0);
});
