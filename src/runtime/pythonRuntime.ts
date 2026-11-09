import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PilotDeckMcpServerSpec } from '../mcp/protocol/types.js';

/** Public, secret-free capabilities of the executing Gateway host. */
export type PythonRuntimeStatus = {
  enabled: boolean;
  state: 'disabled' | 'ready' | 'unavailable' | 'external';
  reason?: 'not-installed' | 'initialization-failed' | 'active-virtualenv';
  version?: string;
  executable?: string;
  environment?: string;
  packages?: Readonly<Record<string, string>>;
};
export type PythonRuntimeSnapshot = { readonly env: NodeJS.ProcessEnv; readonly status: Readonly<PythonRuntimeStatus> };
type Manifest = { schemaVersion: number; id: string; platform: string; arch: string; version: string; python: string; uv: string; packages: Record<string, string>; modules: string[] };
type Run = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const exec = promisify(execFile);
const run: Run = async (command, args, env) => (await exec(command, args, { env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout;
const exists = async (path: string) => access(path).then(() => true, () => false);
const getEnv = (env: NodeJS.ProcessEnv, name: string) => env[Object.keys(env).find(key => key.toUpperCase() === name) ?? name];
function setEnv(env: NodeJS.ProcessEnv, name: string, value?: string) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
  if (value !== undefined) env[name] = value;
}
function child(root: string, path: string): string {
  if (typeof path !== 'string') throw new Error('Missing Python executable');
  const full = resolve(root, path), rel = relative(resolve(root), full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid Python runtime path');
  return full;
}
function snapshot(env: NodeJS.ProcessEnv, status: PythonRuntimeStatus): PythonRuntimeSnapshot {
  if (status.packages) Object.freeze(status.packages);
  return Object.freeze({ env: Object.freeze({ ...env }), status: Object.freeze(status) });
}

/** Owns only versioned user environments. Never modifies process.env or the application payload. */
export class PythonRuntimeManager {
  private ready?: Promise<PythonRuntimeSnapshot>;
  private baseFiles: string[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  constructor(private readonly options: { pilotHome: string; env: NodeJS.ProcessEnv; onError?: (error: unknown) => void; /** @internal Native process seam for regression tests. */ run?: Run }) {
    this.env = { ...options.env };
    this.home = resolve(options.pilotHome);
  }
  async resolve(enabled = true): Promise<PythonRuntimeSnapshot> {
    if (!enabled) return snapshot(this.env, { enabled: false, state: 'disabled' });
    // An explicitly activated environment belongs to the caller. Do not silently replace it.
    if (getEnv(this.env, 'VIRTUAL_ENV')) return snapshot(this.env, { enabled: true, state: 'external', reason: 'active-virtualenv' });
    if (!this.env.PILOTDECK_PYTHON_ROOT) return snapshot(this.env, { enabled: true, state: 'unavailable', reason: 'not-installed' });
    if (this.ready) {
      const cached = await this.ready;
      if (cached.status.executable && (await Promise.all([cached.status.executable, ...this.baseFiles].map(exists))).every(Boolean)) return cached;
      this.ready = undefined;
    }
    if (!this.ready) this.ready = this.prepare().catch(error => {
      this.ready = undefined; // Repair/reinstall can be retried without restarting the Gateway.
      this.options.onError?.(error);
      return snapshot(this.env, { enabled: true, state: 'unavailable', reason: 'initialization-failed' });
    });
    return this.ready;
  }
  private async prepare(): Promise<PythonRuntimeSnapshot> {
    const root = resolve(this.env.PILOTDECK_PYTHON_ROOT!);
    const manifest: Manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.id) || !/^3\.12\.\d+$/.test(manifest.version)
      || manifest.platform !== process.platform || manifest.arch !== process.arch || !Array.isArray(manifest.modules)
      || !manifest.modules.length || manifest.modules.some(m => typeof m !== 'string')
      || !manifest.packages || typeof manifest.packages !== 'object' || Array.isArray(manifest.packages)
      || !Object.keys(manifest.packages).length || Object.values(manifest.packages).some(v => typeof v !== 'string')) throw new Error('Invalid Python manifest');
    const basePython = child(root, manifest.python), uv = child(root, manifest.uv);
    await Promise.all([access(basePython), access(uv)]);
    this.baseFiles = [basePython, uv];
    // Relocatable activation scripts permit atomic publication without a persistent lock.
    const key = createHash('sha256').update('uv-relocatable-v1').update(root).update(manifest.id).digest('hex').slice(0, 24);
    const parent = join(this.home, 'runtimes', 'python');
    const environment = join(parent, key);
    const bin = join(environment, process.platform === 'win32' ? 'Scripts' : 'bin');
    const executable = join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
    const marker = join(environment, '.pilotdeck-ready');
    const env = { ...this.env };
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'UV_SYSTEM_PYTHON']) setEnv(env, key);
    setEnv(env, 'PATH', [bin, dirname(uv), getEnv(this.env, 'PATH')].filter(Boolean).join(delimiter));
    setEnv(env, 'VIRTUAL_ENV', environment);
    setEnv(env, 'UV_PYTHON', executable);
    setEnv(env, 'UV_PYTHON_DOWNLOADS', 'never');
    setEnv(env, 'UV_CACHE_DIR', join(this.home, 'cache', 'uv'));
    setEnv(env, 'PYTHONNOUSERSITE', '1');
    setEnv(env, 'PYTHONDONTWRITEBYTECODE', '1');
    setEnv(env, 'PYTHONUTF8', '1');
    if (!env.MPLCONFIGDIR) env.MPLCONFIGDIR = join(this.home, 'cache', 'matplotlib');
    if (!env.MPLBACKEND) env.MPLBACKEND = 'Agg';
    const execute = this.options.run ?? run;
    await mkdir(parent, { recursive: true });
    if (!(await exists(marker))) {
      const staging = await mkdtemp(join(parent, `${key}-staging-`));
      try {
        const creationEnv = { ...env };
        for (const key of Object.keys(creationEnv)) if (key.toUpperCase().startsWith('UV_VENV_')) delete creationEnv[key];
        await execute(uv, ['venv', '--no-config', '--offline', '--no-python-downloads', '--python', basePython,
          '--system-site-packages', '--relocatable', staging], creationEnv);
        const stagedBin = join(staging, process.platform === 'win32' ? 'Scripts' : 'bin');
        const stagedPython = join(stagedBin, process.platform === 'win32' ? 'python.exe' : 'python');
        if (process.platform === 'win32') await copyFile(stagedPython, join(stagedBin, 'python3.exe'));
        await this.probe(execute, stagedPython, env, manifest);
        await writeFile(join(staging, '.pilotdeck-ready'), manifest.id);
        try { await rename(staging, environment); }
        catch (error) {
          // A concurrent Gateway can win publication. Never replace a completed
          // environment: it may contain user packages or serve running tasks.
          if (await readFile(marker, 'utf8').catch(() => '') !== manifest.id) throw error;
        }
      } finally {
        await rm(child(parent, relative(parent, staging)), { recursive: true, force: true });
      }
    }
    await this.probe(execute, executable, env, manifest);
    return snapshot(env, { enabled: true, state: 'ready', version: manifest.version, executable, environment, packages: { ...manifest.packages } });
  }
  private async probe(execute: Run, executable: string, env: NodeJS.ProcessEnv, manifest: Manifest): Promise<void> {
    const identity = JSON.parse(await execute(executable, ['-I', '-B', '-c',
      `import json,sys,platform,importlib,ssl,sqlite3,pip; modules=json.loads(${JSON.stringify(JSON.stringify(manifest.modules))}); [importlib.import_module(m) for m in modules]; print(json.dumps({"version":platform.python_version(),"prefix":sys.prefix}))`], env));
    if (identity.version !== manifest.version || await realpath(identity.prefix) !== await realpath(dirname(dirname(executable)))) throw new Error('Python environment mismatch');
  }
}

/** The MCP SDK intentionally inherits few variables; carry only the Python capability. */
export function withPythonMcpEnvironment(spec: PilotDeckMcpServerSpec, runtime: PythonRuntimeSnapshot): PilotDeckMcpServerSpec {
  if (spec.transport !== 'stdio' || runtime.status.state !== 'ready') return spec;
  // An explicit interpreter, PATH or activated venv remains authoritative.
  if (isAbsolute(spec.command) || /[\\/]/.test(spec.command)
    || Object.keys(spec.env ?? {}).some(key => ['PATH', 'VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH', 'UV_PYTHON'].includes(key.toUpperCase()))) return spec;
  const inherited: Record<string, string> = {};
  for (const name of ['PATH', 'VIRTUAL_ENV', 'UV_PYTHON', 'UV_PYTHON_DOWNLOADS', 'UV_CACHE_DIR', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUTF8', 'MPLCONFIGDIR', 'MPLBACKEND']) {
    const value = getEnv(runtime.env, name);
    if (value !== undefined) inherited[name] = value;
  }
  return { ...spec, env: { ...inherited, ...spec.env } };
}

export function pythonRuntimeContext(status?: PythonRuntimeStatus): string {
  if (!status) return '';
  if (status.state === 'disabled') return 'Bundled Python is disabled for this turn. Do not assume the bundled interpreter or libraries are available; explicitly selected project/system interpreters may still be used.';
  if (status.state === 'external') return 'An explicitly activated virtual environment is in use. Bundled Python does not override it. Inspect that environment before relying on Python libraries.';
  if (status.state !== 'ready') return 'Bundled Python is unavailable on the executing host. Inspect available project/system interpreters before running Python; do not claim bundled libraries are installed.';
  return [
    `Bundled Python ${status.version} is ready on the executing host for this turn.`,
    `Interpreter: ${JSON.stringify(status.executable)}. Managed writable environment: ${JSON.stringify(status.environment)}.`,
    'Use the bash tool to run Python. python and python3 resolve to this environment; uv and uvx are on PATH. Quote paths containing spaces.',
    `Bundled base libraries: ${Object.entries(status.packages ?? {}).map(([name, version]) => `${name}==${version}`).join(', ')}.`,
    'User-installed packages may override base versions; inspect importlib.metadata when an exact version matters. For headless plotting, save figures using a noninteractive backend such as Agg.',
    'For additional packages use python -m pip install or uv pip install in this managed environment. Do not modify the application base interpreter. Explicit project virtual environments take precedence when selected. Python does not imply external programs such as LibreOffice or Poppler are installed.',
    'This environment is fixed for the current turn and its tasks; a settings change applies to later turns.',
  ].join('\n');
}
