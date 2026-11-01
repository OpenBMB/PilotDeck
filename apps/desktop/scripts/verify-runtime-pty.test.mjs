import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('runtime staging probes PTY only on Linux', () => {
  const source = readFileSync(new URL('./build-runtime.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  verifyRuntimeNativeModule("better-sqlite3", label, runtimeArch);');
  const end = source.indexOf('  verifyRuntimeModuleImport(', start);
  assert.ok(start >= 0 && end > start);
  for (const platform of ['linux', 'darwin', 'win32']) {
    let probes = 0;
    runInNewContext(source.slice(start, end), {
      process: { platform }, label: 'runtime', runtimeArch: 'arm64', runtimeRoot: '/runtime', desktopRoot: '/desktop',
      resolve: join, verifyRuntimeNativeModule() {}, withBundledNodeEnv: () => ({}),
      spawnRuntimeNodeSync() { probes++; return { status: 0 }; },
    });
    assert.equal(probes, platform === 'linux' ? 1 : 0, platform);
  }
});

const probe = fileURLToPath(new URL('./verify-runtime-pty.cjs', import.meta.url));
for (const scenario of ['success', 'missing-native', 'spawn-failure', 'wrong-output']) {
  test(`runtime PTY probe: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'pilotdeck-pty-'));
    try {
      const moduleRoot = join(root, 'node_modules', 'node-pty');
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(moduleRoot, 'index.js'), scenario === 'missing-native'
        ? "require('./prebuilds/linux-arm64/pty.node');"
        : `exports.spawn = () => {
          ${scenario === 'spawn-failure' ? "throw new Error('spawn failed');" : ''}
          return {
            onData(cb) { setImmediate(() => cb(${JSON.stringify(scenario === 'wrong-output' ? 'unexpected' : 'pilotdeck-pty-ok')})); },
            onExit(cb) { setImmediate(() => cb({ exitCode: 0 })); },
            kill() {},
          };
        };`);
      const result = spawnSync(process.execPath, [probe, root], {
        encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' },
      });
      assert.ifError(result.error);
      if (scenario === 'success') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PASS/);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, scenario === 'missing-native' ? /pty\.node/ : scenario === 'spawn-failure' ? /spawn failed/ : /AssertionError/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
