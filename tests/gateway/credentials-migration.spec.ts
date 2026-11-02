import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGatewayAuthToken, readGatewayAuthToken } from '../../src/gateway/server/authToken.js';
import { readWeixinCredentials, writeWeixinCredentials } from '../../src/adapters/channel/weixin/credentials.js';

test('gateway token migration is stable across restarts and concurrent creation', async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), 'pd-token-'));
  try {
    writeFileSync(join(pilotHome, 'server-token'), 'old-secret\n');
    const first = await ensureGatewayAuthToken({ pilotHome });
    assert.equal(first.token, 'old-secret');
    assert.match(first.tokenPath, /credentials[\\/]gateway.yaml$/);
    assert.equal(await readGatewayAuthToken({ pilotHome }), 'old-secret');
    assert.match(readFileSync(first.tokenPath, 'utf8'), /token: old-secret/);
    const clean = join(pilotHome, 'clean'); mkdirSync(clean);
    const created = await Promise.all(Array.from({ length: 5 }, () => ensureGatewayAuthToken({ pilotHome: clean })));
    assert.equal(new Set(created.map(value => value.token)).size, 1);
  } finally { rmSync(pilotHome, { recursive: true, force: true }); }
});
test('Weixin YAML credentials retain the token and cursor; explicit legacy JSON remains supported', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-weixin-'));
  try {
    for (const name of ['weixin.yaml', 'legacy.json']) {
      const file = join(directory, name), value = { baseUrl: 'https://example.test', botToken: 'secret', accountId: 'account', cursor: 'cursor' };
      writeWeixinCredentials(value, file);
      assert.deepEqual(readWeixinCredentials(file), value);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
