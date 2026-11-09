import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/runtimeReadiness.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function load(overrides = {}) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, name => overrides[name] ?? require(name));
  return mod.exports.waitForPortOrProcessExit;
}

function fixture() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const sockets = [];
  const child = new EventEmitter();
  const abort = new AbortController();
  const wait = load({
    'node:timers': {
      setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    'node:net': { createConnection() {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; };
      sockets.push(socket);
      return socket;
    } },
  });
  return {
    child, abort, sockets, timers,
    start: () => wait(child, 'server', 12345, '127.0.0.1', 1000, 'synthetic.log', { signal: abort.signal }),
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
    clean() {
      assert.equal(timers.size, 0);
      assert.equal(child.listenerCount('managed-exit'), 0);
      assert.equal(child.listenerCount('error'), 0);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
      for (const socket of sockets) {
        assert.equal(socket.destroyed, true);
        assert.equal(socket.listenerCount('connect'), 0);
        assert.equal(socket.listenerCount('error'), 0);
      }
    },
  };
}

test('connection refusal retries at the existing interval and success releases every probe', async () => {
  const f = fixture();
  const pending = f.start();
  f.sockets[0].emit('error', new Error('refused'));
  f.advance(249);
  assert.equal(f.sockets.length, 1);
  f.advance(1);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].emit('connect');
  await pending;
  f.clean();
  f.advance(10_000);
  assert.equal(f.sockets.length, 2);
});

for (const waitingForRetry of [false, true]) {
  test(`process exit cancels readiness while ${waitingForRetry ? 'waiting to retry' : 'connecting'}`, async () => {
    const f = fixture();
    const pending = f.start();
    if (waitingForRetry) f.sockets[0].emit('error', new Error('refused'));
    f.child.emit('managed-exit', 1, null);
    await assert.rejects(pending, /server exited before it was ready.*code=1.*synthetic.log/);
    f.clean();
    f.advance(10_000);
    assert.equal(f.sockets.length, 1, 'A failed process must not leave a poll running');
  });

  test(`abort cancels readiness while ${waitingForRetry ? 'waiting to retry' : 'connecting'}`, async () => {
    const f = fixture();
    const pending = f.start();
    if (waitingForRetry) f.sockets[0].emit('error', new Error('refused'));
    const reason = new Error('synthetic cancellation');
    f.abort.abort(reason);
    await assert.rejects(pending, error => error === reason);
    f.clean();
    f.advance(10_000);
    assert.equal(f.sockets.length, 1);
  });
}

test('process startup errors preserve their original diagnostic and release resources', async () => {
  const f = fixture();
  const pending = f.start();
  const error = new Error('synthetic executable unavailable');
  f.child.emit('error', error);
  await assert.rejects(pending, actual => actual === error);
  f.clean();
});

test('managed startup diagnostics remain available after cleanup', async () => {
  const f = fixture();
  const pending = f.start();
  f.child.emit('managed-exit', 1, null, 'synthetic managed launch failure');
  await assert.rejects(pending, { message: 'synthetic managed launch failure' });
  f.clean();
});

for (const waitingForRetry of [false, true]) {
  test(`deadline bounds readiness while ${waitingForRetry ? 'waiting to retry' : 'a socket stalls'}`, async () => {
    const f = fixture();
    const pending = f.start();
    f.advance(900);
    if (waitingForRetry) f.sockets[0].emit('error', new Error('refused'));
    f.advance(100);
    await assert.rejects(pending, /Timed out waiting for 127.0.0.1:12345/);
    f.clean();
    f.advance(10_000);
    assert.equal(f.sockets.length, 1);
  });
}

test('an already aborted or exited process allocates no readiness resources', async () => {
  const aborted = fixture();
  aborted.abort.abort(new Error('already canceled'));
  await assert.rejects(aborted.start(), /already canceled/);
  aborted.clean();
  assert.equal(aborted.sockets.length, 0);
  const exited = fixture();
  exited.child.exitCode = 2;
  await assert.rejects(exited.start(), /code=2/);
  exited.clean();
  assert.equal(exited.sockets.length, 0);
});

test('a replacement readiness attempt does not inherit the failed attempt polls', async () => {
  const f = fixture();
  const first = f.start();
  f.sockets[0].emit('error', new Error('refused'));
  f.child.emit('managed-exit', 1, null);
  await assert.rejects(first, /exited before/);
  const replacement = f.start();
  f.advance(250);
  assert.equal(f.sockets.length, 2, 'The prior retry timer must not create a third socket');
  f.sockets[1].emit('connect');
  await replacement;
  f.clean();
});

test('socket construction failure cleans up process and timeout listeners', async () => {
  const child = new EventEmitter();
  const error = new Error('synthetic socket failure');
  const wait = load({ 'node:net': { createConnection() { throw error; } } });
  await assert.rejects(wait(child, 'server', 12345, '127.0.0.1', 1000, 'synthetic.log'), actual => actual === error);
  assert.equal(child.listenerCount('managed-exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('a real loopback server becomes ready without leaving the probe socket open', { timeout: 3000 }, async t => {
  const accepted = new Set();
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = net.createServer(socket => {
    accepted.add(socket);
    socket.once('close', () => { accepted.delete(socket); disconnected(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of accepted) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const child = new EventEmitter();
  await load()(child, 'server', server.address().port, '127.0.0.1', 1000, 'synthetic.log');
  await closed;
  assert.equal(accepted.size, 0);
  assert.equal(child.listenerCount('managed-exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

for (const reason of ['abort', 'process exit']) {
  test(`real refused-port probes survive immediate ${reason} without late socket errors`, { timeout: 5000 }, async () => {
    const reserve = net.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const sockets = [];
    const closed = [];
    const wait = load({ 'node:net': { createConnection(options) {
      const socket = net.createConnection(options);
      sockets.push(socket);
      closed.push(new Promise(resolve => socket.once('close', resolve)));
      // Do not attach an error listener: it would conceal uncaught late errors.
      return socket;
    } } });
    for (let attempt = 0; attempt < 32; attempt++) {
      const child = new EventEmitter();
      const abort = new AbortController();
      const pending = wait(child, 'server', port, '127.0.0.1', 1000, 'synthetic.log', { signal: abort.signal });
      const rejected = assert.rejects(pending, reason === 'abort' ? /synthetic cancellation/ : /exited before/);
      if (reason === 'abort') abort.abort(new Error('synthetic cancellation'));
      else child.emit('managed-exit', 1, null);
      await rejected;
      assert.equal(child.listenerCount('managed-exit'), 0);
      assert.equal(child.listenerCount('error'), 0);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    }
    await Promise.all(closed);
    assert.equal(sockets.length, 32);
    assert.ok(sockets.every(socket => socket.destroyed));
  });
}
