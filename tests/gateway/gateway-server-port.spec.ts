import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test from 'node:test';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import type { Gateway } from '../../src/gateway/protocol/types.js';

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
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
  } finally { await server.close(); }
});
