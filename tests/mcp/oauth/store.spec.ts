import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthStore } from '../../../src/mcp/oauth/store.js';

test('filesystem lock serializes independent processes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-lock-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new OAuthStore<{ value: number }>(home);
  await store.write('id', { value: 0 });
  const script = `import { OAuthStore } from ${JSON.stringify(new URL('../../../src/mcp/oauth/store.ts', import.meta.url).href)};
    const store = new OAuthStore(process.argv[1]);
    await store.locked('id', async () => {
      const current = await store.read('id');
      await new Promise(resolve => setTimeout(resolve, 60));
      await store.write('id', { value: current.value + 1 });
    });`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, home])));
  assert.equal((await store.read('id'))?.value, 4);
});
