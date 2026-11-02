import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../../scripts/fixtures/benchmark-desktop.cjs', import.meta.url), 'utf8');

test('benchmark paths and titles are data, including quotes and script-like values', () => {
  const title = '\"; globalThis.injected=true; // </script>';
  const options = { userData: '/isolated/profile', mainEntry: '/isolated/quote\"/main.js', title };
  const handlers = new Map();
  let loaded, displayed;
  const context = {
    process: { env: { PILOTDECK_BENCHMARK_OPTIONS: JSON.stringify(options) } },
    setImmediate: callback => callback(),
    require(id) {
      if (id === 'electron') return { app: { setPath(key, value) { assert.equal(key, 'userData'); assert.equal(value, options.userData); }, on(name, handler) { handlers.set(name, handler); } } };
      loaded = id;
    },
  };
  runInNewContext(source, context);
  handlers.get('browser-window-created')(null, { isDestroyed: () => false, setTitle(value) { displayed = value; }, webContents: { on() {} } });
  assert.equal(loaded, options.mainEntry);
  assert.equal(displayed, title);
  assert.equal(context.injected, undefined);
});

test('OOM benchmark hook recognizes both native path separators and only changes Gateway arguments', () => {
  const options = { userData: '/isolated/profile', mainEntry: '/isolated/main.js', gatewayEntry: '/isolated/gateway.js', oom: true };
  const calls = [];
  const processTree = { spawnManaged(...args) { calls.push(args); } };
  const module = { _load: () => processTree };
  runInNewContext(source, {
    process: { env: { PILOTDECK_BENCHMARK_OPTIONS: JSON.stringify(options) } },
    require(id) {
      if (id === 'electron') return { app: { setPath() {} } };
      if (id === 'node:module') return module;
    },
  });
  for (const file of ['C:\\runtime\\ui\\server\\utils\\processTree.js', '/runtime/ui/server/utils/processTree.js']) {
    const wrapped = module._load(file);
    wrapped.spawnManaged('node', [options.gatewayEntry]);
    wrapped.spawnManaged('node', ['/isolated/web.js']);
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[0][1][0], '--max-old-space-size=16');
  assert.equal(calls[1][1][0], '/isolated/web.js');
  assert.equal(calls[2][1][0], '--max-old-space-size=16');
});
