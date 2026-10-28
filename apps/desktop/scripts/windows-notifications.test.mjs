import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/windowsNotifications.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
test('packaged EXE identity registers the PNG asset, stable activator and shortcut even under Unicode paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-notification-图标 '));
  try {
    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(resources, 'icons'), { recursive: true });
    fs.copyFileSync(new URL('../resources/icons/icon.png', import.meta.url), path.join(resources, 'icons/icon.png'));
    const registry = new Map(); let shortcut;
    const module = { exports: {} };
    const mockedRequire = name => name === 'electron' ? { app: { isPackaged: true, getPath: () => root }, shell: { writeShortcutLink: (...args) => { shortcut = args; return true; } } }
      : name === 'node:child_process' ? { execFile: (exe, args, options, callback) => {
        assert.equal(options.windowsHide, true); registry.set(args[3], { type: args[5], value: args[7] }); callback(null, '', '');
      } } : require(name);
    new Function('module', 'exports', 'require', 'process', '__dirname', compiled)(module, module.exports, mockedRequire, { ...process, execPath: path.join(root, 'PilotDeck.exe'), resourcesPath: resources }, root);
    await module.exports.registerWindowsNotifications('test.pilotdeck');
    assert.deepEqual(registry.get('IconUri'), { type: 'REG_EXPAND_SZ', value: path.join(resources, 'icons/icon.png') });
    assert.equal(registry.get('CustomActivator').value, module.exports.TOAST_ACTIVATOR_CLSID);
    assert.equal(shortcut[2].appUserModelId, 'test.pilotdeck');
    assert.equal(shortcut[2].icon, path.join(root, 'PilotDeck.exe'));
    fs.unlinkSync(path.join(resources, 'icons/icon.png'));
    await assert.rejects(module.exports.registerWindowsNotifications('test.pilotdeck'), /icon is missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
