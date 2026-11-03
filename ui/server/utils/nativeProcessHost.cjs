const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { resolveConfigHome } = require('@pilotdeck/config');
let resolved;

function windowsPowerShellPath() {
  return path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function nativeProcessHost() {
  if (process.platform !== 'win32' || process.env.PILOTDECK_NATIVE_PROCESS_HOST === '0') return null;
  if (resolved !== undefined) return resolved;
  const source = path.join(__dirname, 'processHost.cs');
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 20);
  const name = `process-host-${hash}.exe`, bundled = path.join(__dirname, name);
  if (fs.existsSync(bundled)) return resolved = bundled;
  const directory = path.join(resolveConfigHome(), 'cache', 'native', `${process.platform}-${process.arch}`);
  const target = path.join(directory, name);
  if (fs.existsSync(target)) return resolved = target;
  // Desktop packages compile this at build time. Source deployments compile once
  // into PilotHome, then reuse it across launches and upgrades of identical code.
  const framework = process.arch === 'ia32' ? 'Framework' : 'Framework64';
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(compiler)) {
    console.warn('[PD_PROCESS_HOST_FALLBACK] Native process host is not bundled and the compiler is unavailable; using PowerShell.');
    return resolved = null;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${randomUUID()}.exe`);
  try {
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${temporary}`, source], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    try { fs.renameSync(temporary, target); } catch (error) { if (!fs.existsSync(target)) throw error; }
    resolved = target;
  } catch (error) {
    console.warn(`[PD_PROCESS_HOST_FALLBACK] Native process host unavailable (${error.code || 'compile'}); using PowerShell.`);
    resolved = null;
  } finally { fs.rmSync(temporary, { force: true }); }
  return resolved;
}
module.exports = { nativeProcessHost, windowsPowerShellPath };
