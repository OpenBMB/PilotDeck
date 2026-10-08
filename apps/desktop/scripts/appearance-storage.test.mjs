import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => id.startsWith('./') ? load(id.slice(2)) : require(id));
  cache.set(name, mod.exports);
  return mod.exports;
}
const { saveAppearancePatch, appearanceImagePath, writeAppearanceImage } = load('appearanceStorage');
test('partial desktop updates retain light preferences and commit atomically', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-appearance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = saveAppearancePatch(directory, { language: 'en', themeMode: 'light' }, { lightAppearance: { preset: 'mint' } }, 'en');
  const second = saveAppearancePatch(directory, first, { themeMode: 'dark' }, 'en');
  assert.equal(second.lightAppearance.preset, 'mint');
  assert.equal(second.themeMode, 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'appearance.json'), 'utf8')), second);
  assert.equal(fs.existsSync(path.join(directory, 'appearance.json.tmp')), false);
  assert.throws(() => saveAppearancePatch(directory, second, null, 'en'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'appearance.json'), 'utf8')), second);
});
test('image store rejects path traversal, wrong formats and excessive dimensions', () => {
  assert.throws(() => appearanceImagePath('test', '../secrets'));
  assert.throws(() => writeAppearanceImage('test', new Uint8Array([1]), () => ({ width: 1, height: 1 })));
  assert.throws(() => writeAppearanceImage('test', Buffer.from('RIFF0000WEBP'), () => ({ width: 4000, height: 1 })));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.throws(() => writeAppearanceImage('test', png, () => ({ width: 3841, height: 1 })), /dimensions/);
  assert.throws(() => writeAppearanceImage('test', png, () => ({ width: NaN, height: 1 })), /dimensions/);
});

test('performance preference updates preserve saved light colors and mode', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-appearance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = saveAppearancePatch(directory, { language: 'en', themeMode: 'dark' }, { lightAppearance: { preset: 'rose' } }, 'en');
  const next = saveAppearancePatch(directory, first, { interfacePreferences: { hardwareAcceleration: false, reducedMotion: 'on' } }, 'en');
  assert.equal(next.lightAppearance.preset, 'rose');
  assert.equal(next.themeMode, 'dark');
  assert.deepEqual(next.interfacePreferences, { hardwareAcceleration: false, reducedMotion: 'on' });
});
