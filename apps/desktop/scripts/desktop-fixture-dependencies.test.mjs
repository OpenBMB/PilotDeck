import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { copyDesktopFixtureDependencies } = require('./desktop-fixture-dependencies.cjs');

test('temporary Electron app resolves diagnostic, YAML, process and uninstall dependencies in isolation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-fixture-dependencies-'));
  try {
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
    copyDesktopFixtureDependencies(root, runtime);
    const appRequire = createRequire(path.join(root, 'dist', 'main.js'));
    const runtimeRequire = createRequire(path.join(runtime, 'ui', 'package.json'));
    assert.ok(appRequire.resolve('@pilotdeck/config').startsWith(root + path.sep));
    assert.equal(appRequire('@pilotdeck/config').classifyRuntimeError({ code: 'ENOENT' }), 'PD_RESOURCE_NOT_FOUND');
    assert.ok(runtimeRequire.resolve('yaml').startsWith(runtime + path.sep));
    assert.equal(runtimeRequire('yaml').parse('webui:\n  runtime:\n    logRetentionDays: 3').webui.runtime.logRetentionDays, 3);
    const tree = await import(pathToFileURL(path.join(runtime, 'ui/server/utils/processTree.js')));
    assert.equal(typeof tree.spawnManaged, 'function');
    assert.equal(typeof appRequire(path.join(root, 'resources', 'uninstall-data.cjs')).cleanupPersonalData, 'function');
    assert.ok(fs.statSync(path.join(runtime, 'ui/server/utils/processHost.cs')).size > 0);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
