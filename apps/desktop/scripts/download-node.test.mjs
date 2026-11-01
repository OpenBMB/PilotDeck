import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const arch of ['x64', 'arm64']) {
  test(`Linux cached Node ${arch} must match requested x64`, { skip: process.platform !== 'linux' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'pilotdeck-node-cache-'));
    try {
      const scripts = join(root, 'scripts');
      const bin = join(root, 'resources/node/bin');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(bin, { recursive: true });
      for (const file of ['download-node.mjs', 'download-sources.mjs', 'windows-architecture.cjs']) {
        cpSync(new URL(file, import.meta.url), join(scripts, file));
      }
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo v22.23.1; else echo ${arch}; fi\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [join(scripts, 'download-node.mjs')], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: '', PILOTDECK_DESKTOP_NODE_ARCH: 'x64',
          PILOTDECK_DESKTOP_NODE_VERSION: '22.23.1', PILOTDECK_DESKTOP_NODE_ARCHIVE: join(root, 'missing.tar.gz') },
      });
      assert.ifError(result.error);
      if (arch === 'x64') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /already present/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /archive not found/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
