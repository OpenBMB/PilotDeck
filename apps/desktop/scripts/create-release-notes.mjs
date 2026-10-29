import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installerDownloads } from '../../../ui/shared/releaseArtifacts.js';

const manifest = JSON.parse(readFileSync(resolve(process.argv[2] || 'release-assets', 'release.json'), 'utf8'));
const base = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
console.log('## Downloads\n\n| System | Architecture | Installer |\n| --- | --- | --- |');
for (const asset of installerDownloads(manifest.assets)) {
  const platform = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[asset.platform];
  const arch = asset.platform === 'darwin' ? (asset.arch === 'arm64' ? 'Apple Silicon' : 'Intel') : asset.arch;
  console.log(`| ${platform} | ${arch} | [${asset.format.toUpperCase()}](${base}${encodeURIComponent(asset.name)}) |`);
}
console.log('\nAutomatic updates select the appropriate package for your installed application.\n');
