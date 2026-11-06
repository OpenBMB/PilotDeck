const { readFileSync, existsSync } = require('node:fs');
const { resolve, relative, isAbsolute, join } = require('node:path');
const { execFileSync } = require('node:child_process');

/** Runs against the copied payload as well as the build tree. No network or host Python. */
function verifyPythonRuntime(root, platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch
      || !/^3\.12\.\d+$/.test(manifest.version) || !Array.isArray(manifest.modules) || !manifest.modules.length) {
    throw new Error('Invalid bundled Python manifest');
  }
  const child = (name) => {
    if (typeof name !== 'string') throw new Error('Missing Python runtime executable');
    const path = resolve(root, name), rel = relative(resolve(root), path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(path)) throw new Error('Invalid Python runtime executable');
    return path;
  };
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' };
  const result = JSON.parse(execFileSync(child(manifest.python), ['-I', '-B', '-c',
    `import sys,json,platform,importlib,ssl,sqlite3,venv,ensurepip,pip; from importlib.metadata import version; modules=json.loads(${JSON.stringify(JSON.stringify(manifest.modules))}); [importlib.import_module(m) for m in modules]; packages=json.loads(${JSON.stringify(JSON.stringify(Object.keys(manifest.packages)))}); print(json.dumps({"version":platform.python_version(),"platform":sys.platform,"arch":platform.machine(),"packages":{p:version(p) for p in packages}}))`],
  { env, encoding: 'utf8', windowsHide: true, timeout: 60000 }));
  if (result.version !== manifest.version || result.platform !== platform
      || !(arch === 'arm64' ? /^(arm64|aarch64)$/i : /^(amd64|x86_64)$/i).test(result.arch)
      || Object.entries(manifest.packages).some(([name, version]) => result.packages[name] !== version)) {
    throw new Error('Bundled Python payload does not match its manifest');
  }
  const uv = execFileSync(child(manifest.uv), ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (!uv.startsWith(`uv ${manifest.uvVersion} `) && uv.trim() !== `uv ${manifest.uvVersion}`) throw new Error('Bundled uv version mismatch');
  return manifest;
}
module.exports = { verifyPythonRuntime };
if (require.main === module) {
  const result = verifyPythonRuntime(resolve(process.argv[2]));
  console.log(`Verified Python ${result.version} and ${Object.keys(result.packages).length} bundled libraries`);
}
