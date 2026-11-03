import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const mod = { exports: {} };
new Function('module', 'exports', 'require', ts.transpileModule(fs.readFileSync(new URL('../src/startupNetwork.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText)(mod, mod.exports, createRequire(import.meta.url));
const { findFreePort } = mod.exports;

test('an occupied preferred port falls back to an OS-assigned loopback port', async t => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const preferred = occupied.address().port;
  const selected = await findFreePort(preferred);
  assert.ok(selected > 0 && selected <= 65535);
  assert.notEqual(selected, preferred);
});

for (const code of ['EADDRINUSE', 'EACCES', 'EPERM']) test(`${code} on the preferred port retries with an ephemeral port`, async () => {
  const requests = [];
  const selected = await findFreePort(3001, [], async port => {
    requests.push(port);
    if (port !== 0) throw Object.assign(new Error(code), { code });
    return 49152;
  });
  assert.equal(selected, 49152);
  assert.deepEqual(requests, [3001, 0]);
});

test('persistent access denial ends startup with its cause instead of retrying forever', async () => {
  let attempts = 0;
  await assert.rejects(findFreePort(3001, [], async () => { attempts++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }),
    error => error.code === 'EACCES' && error.cause?.message === 'denied');
  assert.equal(attempts, 3);
});

test('Web and Gateway cannot select the same port, and unexpected failures do not loop', async () => {
  let attempts = 0;
  assert.equal(await findFreePort(18789, [3001], async () => ++attempts === 1 ? 3001 : 49153), 49153);
  attempts = 0;
  await assert.rejects(findFreePort(3001, [], async () => { attempts++; throw new Error('unexpected'); }), /UNKNOWN/);
  assert.equal(attempts, 1);
});
