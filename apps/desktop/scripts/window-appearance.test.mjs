import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
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
const { windowPalette, windowChromeOptions } = load('windowChrome');
test('Windows and Linux use a compact caption without changing macOS geometry', () => {
  for (const platform of ['win32', 'linux']) assert.equal(windowChromeOptions(platform, false).titleBarOverlay.height, 32);
  assert.equal(load('windowChrome').MAC_CAPTION_HEIGHT, 48);
  assert.equal(windowChromeOptions('darwin', false).titleBarStyle, 'hiddenInset');
});
test('original light and dark window palettes remain unchanged on all desktop platforms', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(windowPalette(false, platform), { background: '#ffffff', caption: platform === 'darwin' ? '#fbfaff' : '#f4f4f5', symbol: '#262626' });
    const dark = { background: '#0a0a0a', caption: platform === 'darwin' ? '#0a0a0a' : '#171717', symbol: '#e5e5e5' };
    for (const preset of ['default', 'blue', 'mint', 'apricot', 'lavender', 'rose', 'custom']) assert.deepEqual(windowPalette(true, platform, { preset }), dark);
  }
});
test('startup overlay and published palette share colors for presets and customized default backgrounds', () => {
  for (const appearance of [
    { preset: 'mint' }, { preset: 'blue' }, { preset: 'apricot' }, { preset: 'lavender' }, { preset: 'rose' },
    { preset: 'custom', custom: { accent: '#126d71', background: '#b9dfce' } },
    { background: { type: 'image', imageId: '12345678-1234-1234-1234-123456789012.png' } },
  ]) {
    const palette = windowPalette(false, 'win32', appearance);
    const options = windowChromeOptions('win32', false, appearance);
    assert.equal(options.titleBarOverlay.color, palette.caption);
    assert.equal(options.titleBarOverlay.symbolColor, palette.symbol);
    assert.equal(options.backgroundColor, palette.background);
    assert.notEqual(palette.caption, '#f4f4f5');
    assert.match(palette.caption, /^#[a-f0-9]{6}$/);
    assert.equal(windowPalette(false, 'linux', appearance).caption, palette.caption);
  }
});
test('the removed gradient option keeps the original default window palette', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(windowPalette(false, platform, { background: { type: 'gradient', gradientEnd: '#f1d0e5' } }), windowPalette(false, platform));
  }
});
