import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { writeIcns } from './lib/app-icons.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
export const driverPin = JSON.parse(readFileSync(join(scripts, 'computer-use/cua-driver.json'), 'utf8'));
export function selectDriverAsset(platform, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Cua Driver architecture: ${arch}`);
  const asset = driverPin.assets[platform === 'darwin' ? 'darwin' : `${platform}-${arch}`];
  if (!asset) throw new Error(`Unsupported Cua Driver target: ${platform}/${arch}`);
  return asset;
}
export function verifyDriverArchive(bytes, asset) {
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Cua Driver checksum mismatch: ${asset.name}`);
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed`);
};

// A native GUI host gives Web deployments the same direct-parent permission
// contract as Electron, without using a user's separately installed Driver.
async function stageMacApp(directory) {
  const app = join(directory, 'PilotDeck Computer Use.app');
  const contents = join(app, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  renameSync(join(directory, 'cua-driver'), join(contents, 'MacOS/cua-driver'));
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>pilotdeck-computer-use</string>
<key>CFBundleIdentifier</key><string>cn.pilotdeck.computer-use</string>
<key>CFBundleName</key><string>PilotDeck Computer Use</string>
<key>CFBundleDisplayName</key><string>PilotDeck Computer Use</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleIconFile</key><string>computer-use.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${driverPin.version}</string>
<key>CFBundleVersion</key><string>${driverPin.version}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>PilotDeck captures the screen to perform computer tasks you request.</string>
<key>NSAppleEventsUsageDescription</key><string>PilotDeck communicates with applications to perform computer tasks you request.</string>
</dict></plist>\n`);
  mkdirSync(join(contents, 'Resources'));
  cpSync(join(directory, 'LICENSE.txt'), join(contents, 'Resources/LICENSE.txt'));
  await writeIcns(join(scripts, 'computer-use/icon.png'), join(contents, 'Resources/computer-use.icns'));
  const source = join(scripts, 'computer-use/macos-host.m');
  const host = join(contents, 'MacOS/pilotdeck-computer-use');
  // One universal host serves both existing macOS installer architectures.
  run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=13.0', '-arch', 'arm64', '-arch', 'x86_64',
    source, '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-o', host]);
  // Source deployments use a local signature; the desktop release pipeline
  // signs the nested app with its production identity during packaging.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', app]);
}

export async function prepareComputerUse({ destination = resolve(scripts, '../resources/cua-driver'),
  platform = process.platform, arch = process.env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch, env = process.env } = {}) {
  const asset = selectDriverAsset(platform, arch);
  const binaryName = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  const executable = platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver' : binaryName;
  const metadataPath = join(destination, 'manifest.json');
  if (existsSync(metadataPath) && existsSync(join(destination, executable))) {
    const installed = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (installed.layoutVersion === 6 && installed.version === driverPin.version && installed.platform === platform && installed.arch === arch
      && installed.archiveSha256 === asset.sha256 && installed.binarySha256 === sha256(join(destination, executable))
      && (platform !== 'darwin' || installed.hostSourceSha256 === sha256(join(scripts, 'computer-use/macos-host.m'))
        && installed.iconSourceSha256 === sha256(join(scripts, 'computer-use/icon.png'))
        && existsSync(join(destination, 'PilotDeck Computer Use.app/Contents/Resources/computer-use.icns'))
        && installed.iconSha256 === sha256(join(destination, 'PilotDeck Computer Use.app/Contents/Resources/computer-use.icns')))) return destination;
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), '.cua-driver-download-'));
  try {
    const local = env.PILOTDECK_CUA_ARCHIVE || env.PILOTDECK_DESKTOP_CUA_ARCHIVE;
    const archive = local ? resolve(local) : join(temporary, asset.name);
    if (!local) {
      const base = env.PILOTDECK_CUA_BASE_URL || env.PILOTDECK_DESKTOP_CUA_BASE_URL || `https://github.com/${driverPin.repository}/releases/download/${driverPin.tag}`;
      const url = `${base.replace(/\/$/, '')}/${asset.name}`;
      console.log(`[computer-use] downloading ${url}`);
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Driver download failed: HTTP ${response.status}`);
      await pipeline(response.body, createWriteStream(archive));
    }
    verifyDriverArchive(readFileSync(archive), asset);
    const extracted = join(temporary, 'extracted'); mkdirSync(extracted);
    if (platform === 'win32') run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:PILOTDECK_CUA_EXTRACT_ARCHIVE -DestinationPath $env:PILOTDECK_CUA_EXTRACT_DIRECTORY -Force'], {
      env: { ...env, PILOTDECK_CUA_EXTRACT_ARCHIVE: archive, PILOTDECK_CUA_EXTRACT_DIRECTORY: extracted },
    });
    else run('tar', ['-xzf', archive, '-C', extracted]);
    const findBinary = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isFile() && entry.name === binaryName) return file;
        if (entry.isDirectory()) { const found = findBinary(file); if (found) return found; }
      }
    };
    const binary = findBinary(extracted);
    if (!binary) throw new Error('Driver archive contains no executable');
    const staged = join(temporary, 'staged'); mkdirSync(staged);
    cpSync(binary, join(staged, binaryName));
    if (platform !== 'win32') chmodSync(join(staged, binaryName), 0o755);
    cpSync(join(scripts, 'computer-use/LICENSE.txt'), join(staged, 'LICENSE.txt'));
    if (platform === 'darwin') await stageMacApp(staged);
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify({ layoutVersion: 6, executable, version: driverPin.version, platform, arch,
      ...(platform === 'darwin' ? { hostSourceSha256: sha256(join(scripts, 'computer-use/macos-host.m')),
        iconSourceSha256: sha256(join(scripts, 'computer-use/icon.png')),
        iconSha256: sha256(join(staged, 'PilotDeck Computer Use.app/Contents/Resources/computer-use.icns')) } : {}),
      archive: asset.name, archiveSha256: asset.sha256, binarySha256: sha256(join(staged, executable)) }, null, 2));
    rmSync(destination, { recursive: true, force: true }); renameSync(staged, destination);
    console.log(`[computer-use] bundled Driver ${driverPin.version} (${platform}/${arch})`);
    return destination;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareComputerUse();
