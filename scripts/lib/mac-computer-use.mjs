import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MAC_HOST_ID = 'cn.pilotdeck.computer-use';
export const MAC_DEV_HOST_ID = `${MAC_HOST_ID}.dev`;
export const MAC_SIGNING_TEAM = '77Y5JFSH6H';
export const MAC_APP_NAME = 'PilotDeck Computer Use.app';
export const MAC_DEV_APP_NAME = 'PilotDeck Computer Use Dev.app';
const execute = promisify(execFile);
const requirement = `identifier "${MAC_HOST_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${MAC_SIGNING_TEAM}"`;
export const macRuntimeRoot = () => path.join(os.homedir(), 'Library/Application Support/PilotDeck/ComputerUse');

export function macAppForBinary(binary) {
  const executable = fs.realpathSync(binary);
  const end = executable.lastIndexOf('.app/Contents/MacOS/');
  if (end < 0) throw new Error('The native computer-use application is missing.');
  return executable.slice(0, end + 4);
}

// Validate the executable code, not a self-reported TeamIdentifier or manifest.
export async function inspectMacApp(app, expectedVersion, { allowDevelopment = false } = {}) {
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]);
  const info = JSON.parse(stdout);
  const production = info.CFBundleIdentifier === MAC_HOST_ID;
  if (!production && (!allowDevelopment || info.CFBundleIdentifier !== MAC_DEV_HOST_ID)) {
    throw new Error('Rebuild the development Computer Use component; it must use its own development identity.');
  }
  const args = ['--verify', '--deep', '--strict'];
  if (production) args.push('-R', `=${requirement}`);
  await execute('/usr/bin/codesign', [...args, app]);
  const binary = path.join(app, 'Contents/MacOS/cua-driver');
  const version = (await execute(binary, ['--version'], { timeout: 10_000 })).stdout.trim().split(/\s+/)[1];
  if (version !== expectedVersion) throw new Error(`Driver ${expectedVersion} is required; found ${version}.`);
  return { bundleId: info.CFBundleIdentifier, production, binary, version,
    // Layout 6 releases remain usable while the new signed helper rolls out.
    probeSupported: info.PilotDeckPermissionProbeVersion === 1 };
}

function payloadHash(app) {
  const hash = createHash('sha256');
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Unexpected symlink in Computer Use component.');
      hash.update(path.relative(app, file));
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) hash.update(fs.readFileSync(file));
      else throw new Error('Unexpected file in Computer Use component.');
    }
  };
  visit(app);
  return hash.digest('hex');
}

/** Install immutable, signed payloads outside the enclosing desktop .app.
 * Web and desktop share a signing identity, never settings or daemon ownership.
 * No replacement/GC of existing versions: another instance can still use them.
 */
export async function resolveMacRuntime({ binary, version, root = macRuntimeRoot(),
  installedApps = ['/Applications/PilotDeck.app', path.join(os.homedir(), 'Applications/PilotDeck.app')],
  inspect = inspectMacApp } = {}) {
  const bundled = binary && fs.existsSync(binary) ? macAppForBinary(binary) : null;
  const candidates = bundled ? [bundled] : [];
  for (const app of installedApps) candidates.push(path.join(app, 'Contents/Resources/runtime/resources/cua-driver', MAC_APP_NAME));
  const productionRoot = path.join(root, 'production');
  if (fs.existsSync(productionRoot)) {
    for (const entry of fs.readdirSync(productionRoot).sort()) {
      if (/^[a-f0-9]{64}$/.test(entry)) candidates.push(path.join(productionRoot, entry, MAC_APP_NAME));
    }
  }
  let selected, metadata, lastError;
  for (const app of [...new Set(candidates)]) {
    if (!fs.existsSync(app)) continue;
    try { metadata = await inspect(app, version); selected = app; break; }
    catch (error) { lastError = error; }
  }
  if (!selected && bundled) {
    metadata = await inspect(bundled, version, { allowDevelopment: true }); selected = bundled;
  }
  if (!selected) throw lastError || new Error('The bundled Computer Use component is missing.');
  const hash = payloadHash(selected);
  const channel = path.join(root, metadata.production ? 'production' : 'development');
  const directory = path.join(channel, hash);
  const appName = metadata.production ? MAC_APP_NAME : MAC_DEV_APP_NAME;
  const app = path.join(directory, appName);
  fs.mkdirSync(channel, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(directory)) {
    const stage = path.join(channel, `.stage-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      fs.cpSync(selected, path.join(stage, appName), { recursive: true, preserveTimestamps: true });
      await inspect(path.join(stage, appName), version, { allowDevelopment: !metadata.production });
      try { fs.renameSync(stage, directory); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  if (payloadHash(app) !== hash) throw new Error('Installed Computer Use component failed its integrity check.');
  metadata = await inspect(app, version, { allowDevelopment: !metadata.production });
  return { ...metadata, app, binary: fs.realpathSync(metadata.binary),
    permissionOwner: metadata.production ? 'PilotDeck Computer Use' : 'PilotDeck Computer Use Dev' };
}
