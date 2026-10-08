#!/usr/bin/env node
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeLinuxRpmArtifact(directory, arch) {
  const rpmArch = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!rpmArch) throw new Error(`Unsupported RPM architecture: ${arch}`);
  const suffix = `-linux-${rpmArch}.rpm`;
  const candidates = readdirSync(directory).filter(name => name.endsWith(suffix));
  if (candidates.length !== 1) throw new Error(`Expected one Linux ${arch} RPM, found ${candidates.length}`);
  const oldName = candidates[0];
  const newName = oldName.slice(0, -suffix.length) + `-linux-${arch}.rpm`;
  const feedPath = join(directory, `latest-rpm-linux${arch === 'arm64' ? '-arm64' : ''}.yml`);
  const feed = readFileSync(feedPath, 'utf8');
  if (!feed.includes(oldName)) throw new Error(`RPM update feed does not reference ${oldName}`);
  renameSync(join(directory, oldName), join(directory, newName));
  writeFileSync(feedPath, feed.replaceAll(oldName, newName));
  return newName;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(normalizeLinuxRpmArtifact(resolve(process.argv[3] || 'dist-electron'), process.argv[2]));
}
