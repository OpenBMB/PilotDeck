const { readFileSync } = require('node:fs');

function peArchitecture(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid PE executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550) throw new Error('Invalid PE header');
  const arch = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[bytes.readUInt16LE(offset + 4)];
  if (!arch) throw new Error('Unsupported PE architecture');
  return arch;
}

function executableArchitecture(file) {
  return peArchitecture(readFileSync(file));
}

function portableGitArchive(version, arch) {
  const suffix = { x64: '64-bit', arm64: 'arm64' }[arch];
  if (!suffix) throw new Error(`Unsupported Windows architecture: ${arch}`);
  return `PortableGit-${version}-${suffix}.7z.exe`;
}

module.exports = { peArchitecture, executableArchitecture, portableGitArchive };
