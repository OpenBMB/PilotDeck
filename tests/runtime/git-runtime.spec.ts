import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGitRuntimeStatus } from '../../src/runtime/gitRuntime.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-git with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === 'win32' ? 'git.exe' : 'git');
  await writeFile(binary, 'synthetic Git'); await chmod(binary, 0o755);
  return { root, binary };
}

test('reports bundled, configured and PATH Git from the executing host without leaking its environment', async t => {
  const f = await fixture(t);
  for (const [source, values] of [
    ['bundled', { PILOTDECK_GIT_PATH: f.binary, PILOTDECK_BUNDLED_GIT: '1' }],
    ['configured', { PILOTDECK_GIT_PATH: f.binary }], ['system', { [process.platform === 'win32' ? 'Path' : 'PATH']: f.root }],
  ] as const) {
    const env = { PATH: f.root, ...values, SECRET: 'never-publish' };
    const status = await getGitRuntimeStatus({ env, run: async (_file, args, options) => {
      assert.deepEqual(args, ['--version']); assert.equal(options.timeout, 5000);
      assert.equal(options.env, env); return { stdout: 'git version 2.51.2.windows.1\n', stderr: '' };
    } });
    assert.equal(status.state, 'ready'); assert.equal(status.source, source);
    assert.equal(status.version, '2.51.2.windows.1'); assert.equal(status.executable, await realpath(f.binary));
    assert.ok(!JSON.stringify(status).includes('never-publish'));
  }
});

test('Git lookup follows the host PATH casing rules', async t => {
  const f = await fixture(t);
  const status = await getGitRuntimeStatus({ env: process.platform === 'win32' ? { Path: '/missing', PATH: f.root } : { Path: f.root },
    run: async () => ({ stdout: 'git version 2.51.2' }) });
  assert.equal(status.state, process.platform === 'win32' ? 'ready' : 'unavailable');
});

test('reports the effective PATH Git rather than a stale declaration and does not expose process errors', async t => {
  const f = await fixture(t);
  const missing = await getGitRuntimeStatus({ env: { PILOTDECK_GIT_PATH: join(f.root, 'missing'), PILOTDECK_BUNDLED_GIT: '1', PATH: f.root },
    run: async () => ({ stdout: 'git version 2.51.2' }) });
  assert.equal(missing.source, 'system'); assert.equal(missing.state, 'ready');
  const failed = await getGitRuntimeStatus({ env: { PILOTDECK_GIT_PATH: f.binary, PATH: f.root }, run: async () => { throw new Error('private process output'); } });
  assert.deepEqual(failed, { state: 'unavailable', source: 'configured' });
});
