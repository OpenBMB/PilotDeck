import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => id.startsWith('./') ? load(id.slice(2)) : require(id));
  cache.set(name, mod.exports);
  return mod.exports;
}
const { WindowsCaptionMenu } = load('windowsCaptionMenu');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const sent = [], menus = [];
  let destroyed = false, nativeClosing = false;
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, isFullScreen: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => destroyed,
      getZoomFactor: () => 1, send: (channel, id) => sent.push([channel, id]) }),
  });
  const controller = new WindowsCaptionMenu(owner, () => [
    { id: 'menu-file', submenu: [{ label: 'File action' }] },
    { id: 'menu-edit', submenu: [{ label: 'Edit action' }] },
  ], () => {
    assert.equal(nativeClosing, false, 'a replacement menu must not enter the native close stack');
    const menu = { closes: 0, popup: options => { menu.callback = options.callback; },
      closePopup: () => { menu.closes++; },
      finish: async () => {
        nativeClosing = true;
        try { menu.callback(); await Promise.resolve(); }
        finally { nativeClosing = false; }
      },
    };
    menus.push(menu);
    return menu;
  }, () => ({ x: 0, y: 0 }));
  const destroy = () => { destroyed = true; owner.emit('closed'); };
  t.after(destroy);
  return { controller, menus, sent, destroy };
}

test('natural native close settles IPC and caption state only after the close stack exits', async t => {
  const { controller, menus, sent } = fixture(t);
  let settled = false;
  const session = controller.show({ id: 'menu-file' }).then(() => { settled = true; });
  await menus[0].finish();
  assert.equal(settled, false);
  assert.deepEqual(sent.map(([, id]) => id), ['menu-file']);
  await tick();
  await session;
  assert.equal(sent.at(-1)[1], null);
});

test('a next IPC request after awaiting close cannot reenter native menu teardown', async t => {
  const { controller, menus } = fixture(t);
  const first = controller.show({ id: 'menu-file' });
  const next = first.then(() => controller.show({ id: 'menu-edit' }));
  await menus[0].finish();
  assert.equal(menus.length, 1);
  await tick();
  assert.equal(menus.length, 2);
  controller.close();
  await menus[1].finish();
  await tick();
  await next;
});

test('repeated close during native completion cannot cancel deferred settlement or close twice', async t => {
  const { controller, menus, sent } = fixture(t);
  let settled = false;
  const session = controller.show({ id: 'menu-file' }).then(() => { settled = true; });
  const closings = [controller.close(), controller.close()];
  assert.equal(menus[0].closes, 1);
  await menus[0].finish();
  controller.close();
  assert.equal(settled, false);
  await tick();
  await Promise.all([session, ...closings]);
  assert.deepEqual(sent.map(([, id]) => id), ['menu-file', null]);
});

test('close cancels a queued switch while preserving the native settlement callback', async t => {
  const { controller, menus, sent } = fixture(t);
  const first = controller.show({ id: 'menu-file' });
  const second = controller.show({ id: 'menu-edit' });
  await menus[0].finish();
  controller.close();
  await tick();
  await Promise.all([first, second]);
  assert.equal(menus.length, 1);
  assert.deepEqual(sent.map(([, id]) => id), ['menu-file', null]);
});

test('queued switches open only the latest request after native completion', async t => {
  const { controller, menus, sent } = fixture(t);
  const sessions = [controller.show({ id: 'menu-file' }), controller.show({ id: 'menu-edit' })];
  await menus[0].finish();
  sessions.push(controller.show({ id: 'menu-file' }));
  await tick();
  assert.equal(menus.length, 2);
  assert.deepEqual(sent.map(([, id]) => id), ['menu-file', 'menu-file']);
  controller.close();
  await menus[1].finish();
  await tick();
  await Promise.all(sessions);
});

test('destroying the owner cancels a queued replacement and settles all requests', async t => {
  const { controller, menus, sent, destroy } = fixture(t);
  const sessions = [controller.show({ id: 'menu-file' }), controller.show({ id: 'menu-edit' })];
  await menus[0].finish();
  destroy();
  await tick();
  await Promise.all(sessions);
  assert.equal(menus.length, 1);
  assert.deepEqual(sent.map(([, id]) => id), ['menu-file']);
});

test('closing an idle controller acknowledges immediately without opening a popup', async t => {
  const { controller, menus } = fixture(t);
  await controller.close();
  assert.equal(menus.length, 0);
});
