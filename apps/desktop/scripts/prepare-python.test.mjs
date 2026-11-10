import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pythonPin, selectPythonTarget, verifyPythonArchive, pythonBuildIdentity } from './prepare-python.mjs';

test('all supported native targets have fixed archives and hash-pinned Python 3.12 wheels', () => {
  assert.match(pythonPin.pythonVersion, /^3\.12\.\d+$/);
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const target = selectPythonTarget(platform, arch);
    for (const asset of [target.python, target.uv]) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(target.python.name.includes(pythonPin.pythonVersion));
    const lock = readFileSync(new URL(`../../../scripts/python/requirements-${platform}-${arch}.txt`, import.meta.url), 'utf8');
    assert.match(lock, /numpy==/);
    assert.match(lock, /mcp==/);
    assert.match(lock, /--hash=sha256:/);
    assert.notEqual(pythonBuildIdentity(target, lock), pythonBuildIdentity(target, lock + '\n'));
  }
  assert.throws(() => selectPythonTarget('win32', 'ia32'), /Unsupported/);
});

test('archive integrity rejects tampering before extraction', () => {
  const bytes = Buffer.from('synthetic archive');
  const asset = { name: 'python.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') };
  verifyPythonArchive(bytes, asset);
  assert.throws(() => verifyPythonArchive(Buffer.from('tampered'), asset), /checksum mismatch/);
});
