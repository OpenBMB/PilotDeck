import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import verifier from './verify-python-runtime.cjs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { downloadDriverArchive as downloadArchive } from '../../../scripts/prepare-computer-use.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = resolve(desktop, '../../scripts/python');
export const pythonPin = JSON.parse(readFileSync(join(inputs, 'runtime.json'), 'utf8'));
const packages = JSON.parse(readFileSync(join(inputs, 'packages.json'), 'utf8'));
export function selectPythonTarget(platform, arch) {
  const target = pythonPin.targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported Python target: ${platform}/${arch}`);
  return target;
}
export function verifyPythonArchive(bytes, asset) {
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Python runtime checksum mismatch: ${asset.name}`);
}
function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, { env, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout?.trim();
}
function removeOwned(root, target) {
  const inside = relative(resolve(root), resolve(target));
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(root)) throw new Error('Refusing to remove outside the Python staging directory');
  rmSync(target, { recursive: true, force: true });
}
export function pythonBuildIdentity(target, lock) {
  return createHash('sha256').update(JSON.stringify({ layout: 1, python: pythonPin.pythonVersion, uv: pythonPin.uvVersion, target, packages })).update(lock).digest('hex');
}
export async function preparePython({ platform = process.platform, arch = process.env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch,
  destination = join(desktop, 'resources/python-runtime'), env = process.env, bootstrapOnly = false } = {}) {
  const target = selectPythonTarget(platform, arch);
  if (platform !== process.platform || arch !== process.arch) throw new Error('Build bundled Python on a matching native host');
  const lock = bootstrapOnly ? Buffer.alloc(0) : readFileSync(join(inputs, `requirements-${platform}-${arch}.txt`));
  const id = pythonBuildIdentity(target, lock);
  const pythonRelative = platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
  const uvRelative = platform === 'win32' ? 'uv/uv.exe' : 'uv/uv';
  const metadata = join(destination, 'manifest.json');
  if (!bootstrapOnly && existsSync(metadata)) {
    const previous = JSON.parse(readFileSync(metadata, 'utf8'));
    if (previous.id === id) {
      verifier.verifyPythonRuntime(destination, platform, arch);
      return destination;
    }
  }
  const parent = dirname(resolve(destination));
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(join(parent, '.python-download-'));
  try {
    const stage = join(temp, 'stage'); mkdirSync(stage);
    for (const kind of ['python', 'uv']) {
      const asset = target[kind];
      const local = env[`PILOTDECK_${kind.toUpperCase()}_ARCHIVE`];
      const archive = local ? resolve(local) : join(temp, asset.name);
      if (!local) {
        const base = env[`PILOTDECK_${kind.toUpperCase()}_BASE_URL`] || (kind === 'python'
          ? `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonPin.pythonRelease}`
          : `https://github.com/astral-sh/uv/releases/download/${pythonPin.uvVersion}`);
        await downloadArchive(`${base.replace(/\/$/, '')}/${encodeURIComponent(asset.name)}`, archive);
      }
      verifyPythonArchive(readFileSync(archive), asset);
      const extracted = kind === 'python' ? stage : join(temp, 'uv-extracted');
      mkdirSync(extracted, { recursive: true });
      run(platform === 'win32' ? join(env.SystemRoot || env.SYSTEMROOT, 'System32/tar.exe') : 'tar', ['-xf', archive, '-C', extracted], env);
      if (kind === 'uv') {
        const from = platform === 'win32' ? extracted : join(extracted, `uv-${target.triple}`);
        mkdirSync(join(stage, 'uv'));
        for (const name of platform === 'win32' ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx']) {
          copyFileSync(join(from, name), join(stage, 'uv', name));
          if (platform !== 'win32') chmodSync(join(stage, 'uv', name), 0o755);
        }
      }
    }
    const buildEnv = { ...env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never' };
    for (const key of Object.keys(buildEnv)) if (['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'UV_PYTHON', 'UV_SYSTEM_PYTHON'].includes(key.toUpperCase())) delete buildEnv[key];
    const python = join(stage, pythonRelative), uv = join(stage, uvRelative);
    const identity = JSON.parse(run(python, ['-I', '-B', '-c', 'import sys,platform,json; print(json.dumps({"version":platform.python_version(),"arch":platform.machine(),"platform":sys.platform}))'], buildEnv, true));
    if (identity.version !== pythonPin.pythonVersion || identity.platform !== platform
      || !(arch === 'arm64' ? /^(arm64|aarch64)$/i : /^(amd64|x86_64)$/i).test(identity.arch)) throw new Error('Bundled Python version or architecture mismatch');
    run(uv, ['--version'], buildEnv);
    for (const file of ['LICENSE-uv-MIT.txt', 'LICENSE-uv-APACHE.txt']) copyFileSync(join(inputs, file), join(stage, file));
    if (!bootstrapOnly) {
      const requirements = join(stage, 'requirements.txt'); writeFileSync(requirements, lock);
      run(uv, ['pip', 'install', '--python', python, '--system', '--require-hashes', '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple', '-r', requirements], buildEnv);
      const versions = JSON.parse(run(python, ['-I', '-B', '-c',
        `import json,importlib,ssl,sqlite3; from importlib.metadata import version; packages=json.loads(${JSON.stringify(JSON.stringify(packages))}); [importlib.import_module(m) for m in packages.values()]; print(json.dumps({p:version(p) for p in packages}))`], buildEnv, true));
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, platform, arch,
        version: pythonPin.pythonVersion, uvVersion: pythonPin.uvVersion, python: pythonRelative, uv: uvRelative,
        packages: versions, modules: Object.values(packages) }, null, 2) + '\n');
    }
    // All replacements are confined to the explicitly resolved build output.
    removeOwned(parent, destination); renameSync(stage, destination);
    console.log(`[desktop] prepared Python ${pythonPin.pythonVersion} (${platform}/${arch})${bootstrapOnly ? ' bootstrap' : ''}`);
    return destination;
  } finally { removeOwned(parent, temp); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePython({ bootstrapOnly: process.argv.includes('--bootstrap'), ...(process.env.PILOTDECK_PYTHON_DESTINATION ? { destination: resolve(process.env.PILOTDECK_PYTHON_DESTINATION) } : {}) });
}
