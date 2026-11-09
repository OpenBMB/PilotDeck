import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/openDirectory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => {
  if (id === 'node:fs/promises') return fs;
  if (id === 'node:path') return path;
  throw new Error(`Unexpected dependency: ${id}`);
});
const { openDesktopDirectory } = mod.exports;

test('opens only an existing directory and passes spaces and Unicode as one native path', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-open-directory-'));
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const directory = path.join(temporary, 'working folder 中文 & notes');
  await fs.mkdir(directory);
  const calls = [];
  const open = async value => { calls.push(value); return ''; };
  assert.equal(await openDesktopDirectory(directory, open), true);
  assert.deepEqual(calls, [directory]);
  calls.length = 0;
  const file = path.join(temporary, 'file.txt');
  await fs.writeFile(file, 'file');
  for (const invalid of [null, {}, true, '', 'relative/path', 'https://example.com', 'file:///folder', directory + '\0', file, path.join(temporary, 'missing')]) {
    assert.equal(await openDesktopDirectory(invalid, open), false);
  }
  assert.deepEqual(calls, []);
  assert.equal(await openDesktopDirectory(directory, async () => 'OS error'), false);
  assert.equal(await openDesktopDirectory(directory, async () => { throw new Error('OS unavailable'); }), false);
});
