import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/appearance.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
const lightSource = fs.readFileSync(new URL('../src/lightAppearance.ts', import.meta.url), 'utf8');
const lightMod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(lightSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(lightMod, lightMod.exports);
const preferencesMod = { exports: {} };
const startupMod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(new URL('../src/startupPresentation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(startupMod, startupMod.exports);
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(new URL('../src/interfacePreferences.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(preferencesMod, preferencesMod.exports);
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => id === './startupPresentation' ? startupMod.exports : id === './lightAppearance' ? lightMod.exports : id === './interfacePreferences' ? preferencesMod.exports : require(id));
const { normalizeAppearance, renderLoadingHtml, startupText } = mod.exports;

test('missing and malformed appearance uses system theme and OS language', () => {
  assert.deepEqual(normalizeAppearance(null, 'zh-Hans-CN'), { language: 'zh-CN', themeMode: 'system' });
  assert.deepEqual(normalizeAppearance({ language: '<script>', themeMode: 'bad' }, 'en-US'), { language: 'en', themeMode: 'system' });
  assert.deepEqual(normalizeAppearance({ language: 'en', themeMode: 'light' }, 'zh-CN'), { language: 'en', themeMode: 'light' });
});
test('startup UI translates controls without exposing technical details while loading', () => {
  const html = renderLoadingHtml({ language: 'zh-CN', themeMode: 'dark' });
  assert.match(html, /lang="zh-CN" data-theme="dark"/);
  assert.match(html, />重新启动<\/button>/);
  assert.match(html, />保存运行日志<\/button>/);
  assert.equal(startupText('Checking local configuration...', 'zh-CN'), '正在检查本地配置…');
  assert.equal(startupText('EACCES: /custom/path', 'zh-CN'), 'EACCES: /custom/path');
  const light = renderLoadingHtml({ language: 'en', themeMode: 'light' });
  assert.match(light, /data-theme="light"/);
  assert.match(light, />Restart<\/button>/);
  assert.match(light, /prefers-color-scheme:\s*dark/);
});
test('custom startup canvas is validated and dark palette retains its original values', () => {
  const appearance = normalizeAppearance({ language: 'en', themeMode: 'light', lightAppearance: { preset: 'rose' } });
  assert.equal(appearance.lightAppearance.version, 2);
  assert.match(renderLoadingHtml(appearance), /--bg:\s*#faedf2/);
  assert.match(renderLoadingHtml(appearance), /--bg:\s*#0a0a0a/);
});

test('legacy solid panels migrate without losing desktop background assets or custom colors', () => {
  const appearance = normalizeAppearance({ themeMode: 'light', lightAppearance: {
    panelOpacity: 100, preset: 'custom', custom: { accent: '#126d71', background: '#b9dfce' },
    background: { type: 'image', imageId: '12345678-1234-1234-1234-123456789012.png' },
  } });
  assert.equal(appearance.lightAppearance.transparency, 15);
  assert.equal('panelOpacity' in appearance.lightAppearance, false);
  assert.equal(appearance.lightAppearance.background.imageId, '12345678-1234-1234-1234-123456789012.png');
  assert.deepEqual(appearance.lightAppearance.custom, { accent: '#126d71', background: '#b9dfce' });
  assert.deepEqual(normalizeAppearance(appearance), appearance);
});

test('native startup script preserves progress and presents the classified cause instead of a stack', () => {
  const html = renderLoadingHtml({ language: 'zh-CN', themeMode: 'light' });
  assert.doesNotMatch(html, /\x08/);
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, classList: { toggle() {} }, parentElement: { setAttribute() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  let update;
  const desktop = { onRuntimeStatus(callback) { update = callback; }, getRuntimeStatus() { return { phase: 'gateway', progress: 78 }; } };
  new Function('window', 'document', html.match(/<script>([\s\S]*?)<\/script>/)[1])({ pilotdeckDesktop: desktop }, { getElementById: get });
  assert.equal(get('bar').style.width, '78%');
  update({ phase: 'server', progress: 45 }); assert.equal(get('bar').style.width, '78%');
  update({ phase: 'error', error: 'Error code: PD_RUNTIME_OUT_OF_MEMORY\nnative-private-stack', logPath: 'C:/logs/runtime.log' });
  assert.equal(get('code').textContent, 'PD_RUNTIME_OUT_OF_MEMORY');
  assert.match(get('reason').textContent, /内存不足/);
  assert.equal(get('log').textContent, '运行日志: C:/logs/runtime.log');
  assert.ok([...nodes.values()].every(node => !node.textContent.includes('native-private-stack')));
});
