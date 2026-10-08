import assert from 'node:assert/strict';
import test from 'node:test';
import architecture from './windows-architecture.cjs';

for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64], ['ia32', 0x14c]]) {
  test(`identifies ${arch} executable headers instead of trusting filenames`, () => {
    const bytes = Buffer.alloc(128);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(80, 0x3c);
    bytes.writeUInt32LE(0x4550, 80);
    bytes.writeUInt16LE(machine, 84);
    assert.equal(architecture.peArchitecture(bytes), arch);
  });
}

test('rejects truncated, invalid and unsupported executable headers', () => {
  for (const length of [0, 10, 63, 64]) assert.throws(() => architecture.peArchitecture(Buffer.alloc(length)));
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => architecture.peArchitecture(bytes), /Invalid PE header/);
  bytes.writeUInt32LE(80, 0x3c);
  bytes.writeUInt32LE(0x4550, 80);
  assert.throws(() => architecture.peArchitecture(bytes), /Unsupported PE architecture/);
});

test('uses the official Portable Git archive for each Windows architecture', () => {
  assert.equal(architecture.portableGitArchive('2.51.2', 'x64'), 'PortableGit-2.51.2-64-bit.7z.exe');
  assert.equal(architecture.portableGitArchive('2.51.2', 'arm64'), 'PortableGit-2.51.2-arm64.7z.exe');
  assert.throws(() => architecture.portableGitArchive('2.51.2', 'ia32'), /Unsupported Windows architecture/);
});
