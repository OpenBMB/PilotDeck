#!/usr/bin/env node
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeLinuxX64Artifact(directory) {
  const candidates = readdirSync(directory).filter(name => name.endsWith('-linux-amd64.deb'));
  if (candidates.length !== 1) throw new Error(`Expected one Linux x64 DEB, found ${candidates.length}`);
  const oldName = candidates[0];
  const newName = oldName.replace(/-linux-amd64\.deb$/, '-linux-x64.deb');
  const feedPath = join(directory, 'latest-linux.yml');
  const feed = readFileSync(feedPath, 'utf8');
  if (!feed.includes(oldName)) throw new Error(`Linux update feed does not reference ${oldName}`);
  renameSync(join(directory, oldName), join(directory, newName));
  writeFileSync(feedPath, feed.replaceAll(oldName, newName));
  return newName;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(normalizeLinuxX64Artifact(resolve(process.argv[2] || 'dist-electron')));
}
