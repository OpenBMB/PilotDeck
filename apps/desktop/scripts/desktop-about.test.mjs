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
const { desktopAboutInfo, desktopAboutInformation, presentDesktopAbout } = load('desktopAbout');
const { buildApplicationMenu } = load('applicationMenu');
const context = { language: 'en', appVersion: '1.0.0', metadata: { version: '2026.930.0', buildTime: '2026-09-30T04:00:00Z', commitSha: 'a'.repeat(40) },
  platform: 'win32', arch: 'x64', osRelease: '10.0.test', versions: { electron: '42', chrome: '142', node: '22' } };
test('about information is localized and identifies the running build and license', () => {
  for (const language of ['en', 'zh-CN']) {
    const { dialog, versionInformation } = desktopAboutInformation({ ...context, language });
    assert.match(dialog.detail, /2026\.930\.0/);
    assert.match(dialog.detail, /AGPL-3\.0-only/);
    assert.match(dialog.detail, /Windows 10\.0\.test \(x64\)/);
    assert.ok(dialog.detail.includes('a'.repeat(12)));
    assert.ok(versionInformation.includes('a'.repeat(40)));
    assert.match(versionInformation, /electron: 42/);
    assert.match(dialog.title, language === 'en' ? /About/ : /关于/);
    assert.equal(dialog.buttons.length, 3);
  }
  const fallback = desktopAboutInformation({ ...context, metadata: { buildTime: 'invalid' }, platform: 'linux' });
  assert.match(fallback.dialog.detail, /Version: 1\.0\.0/);
  assert.match(fallback.dialog.detail, /Linux/);
  assert.doesNotMatch(fallback.dialog.detail, /Invalid|undefined|Built:/);
});
test('about only copies or opens the project when the corresponding button is selected', async () => {
  for (const response of [0, 1, 2]) {
    const copies = [], websites = [];
    await presentDesktopAbout(context, { showDialog: async options => { assert.equal(options.cancelId, 0); return { response }; },
      copy: text => copies.push(text), openWebsite: async url => websites.push(url) });
    assert.equal(copies.length, response === 1 ? 1 : 0);
    assert.equal(websites.length, response === 2 ? 1 : 0);
    if (response === 1) assert.match(copies[0], /chrome: 142/);
    if (response === 2) assert.equal(websites[0], 'https://github.com/OpenBMB/PilotDeck');
  }
});
test('Windows and Linux Help route to the rich dialog while macOS keeps its native about role', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const requests = [];
    const items = buildApplicationMenu(platform, 'en', undefined, { help: action => requests.push(action) }).flatMap(menu => menu.submenu);
    const about = items.find(item => item.label === 'About PilotDeck');
    if (platform === 'darwin') assert.equal(about.role, 'about');
    else { assert.equal(about.id, 'help-about'); about.click(); assert.deepEqual(requests, ['about']); }
  }
});

test('settings build information stays local, complete and independent of update checks', () => {
  for (const [platform, label] of [['darwin', 'macOS'], ['linux', 'Linux'], ['win32', 'Windows']]) {
    const info = desktopAboutInfo({ ...context, platform });
    assert.equal(info.platform, label); assert.equal(info.version, context.metadata.version);
    assert.deepEqual(info.versions, context.versions); assert.equal(info.commitSha, context.metadata.commitSha);
    assert.equal(info.license, 'AGPL-3.0-only'); assert.match(info.versionInformation, /electron: 42/);
    assert.doesNotMatch(JSON.stringify(info), /runtimeRoot|userData|apiKey/);
  }
});
