import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function readLocalSopConfig(env = process.env, cwd = process.cwd()) {
  const home = resolve(env.PILOT_HOME || join(homedir(), '.pilotdeck'));
  const configPath = resolve(cwd, env.PILOTDECK_CONFIG_PATH || join(home, 'pilotdeck.yaml'));
  if (!existsSync(configPath)) return null;
  const sop = parse(readFileSync(configPath, 'utf8'))?.modules?.sop;
  const local = sop?.localRuntime;
  if (sop?.enabled !== true || local?.enabled !== true) return null;
  if (sop.hostAdapter !== 'pilotdeck' || sop.contract !== 'sop.lifecycle/v3'
    || sop.implementationId !== 'portable-sop' || sop.transport !== 'sop-http-v3') {
    throw new Error('localRuntime requires the pilotdeck host and portable-sop lifecycle/v3 binding');
  }
  const endpoint = new URL(sop.endpoint || 'http://127.0.0.1:8091');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('localRuntime endpoint must be a loopback HTTP origin');
  }
  for (const key of ['knowledgeEnabled', 'versionManagementEnabled']) {
    if (local[key] !== undefined && typeof local[key] !== 'boolean') throw new Error(`localRuntime.${key} must be boolean`);
  }
  if (local.python !== undefined && (typeof local.python !== 'string' || !local.python.trim())) {
    throw new Error('localRuntime.python must name a Python 3.11+ executable');
  }
  return { home, endpoint: endpoint.origin, host: endpoint.hostname, port: Number(endpoint.port || 80),
    python: local.python || 'python3', knowledge: local.knowledgeEnabled ?? true,
    versions: local.versionManagementEnabled ?? true };
}

function sourceRevision(directory) {
  return readdirSync(directory, { withFileTypes: true }).map(entry => {
    const file = join(directory, entry.name);
    if (entry.name === '__pycache__' || entry.name.endsWith('.egg-info')) return '';
    return entry.isDirectory() ? sourceRevision(file) : `${file}:${statSync(file).mtimeMs}`;
  }).join('\n');
}

export async function waitForSopHealth(endpoint, { timeoutMs = 90000, signal, request = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await request(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.status === 'ok' && health.contract === 'sop.lifecycle/v3'
        && health.state?.ownership === 'runtime') return health;
    } catch { /* Retry while the Python server starts. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`SOP Runtime health check timed out: ${endpoint}`);
}

export async function runLocalSopRuntime({ env = process.env, onReady = value => process.send?.(value) } = {}) {
  const config = readLocalSopConfig(env);
  if (!config) throw new Error('Local SOP Runtime is not enabled');
  const root = join(config.home, 'sop-runtime');
  const source = join(repoRoot, 'packages/sop-runtime');
  const python = join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  mkdirSync(root, { recursive: true });
  let child;
  let stopping = false;
  let forceStop;
  const abort = new AbortController();
  const stop = () => {
    stopping = true; abort.abort();
    if (child?.exitCode == null && child?.signalCode == null) {
      child?.kill('SIGTERM');
      forceStop ??= setTimeout(() => child?.kill('SIGKILL'), 2000);
      forceStop.unref();
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
    if (stopping) return reject(new Error('SOP startup cancelled'));
    child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(forceStop);
      code === 0 ? resolveRun() : reject(new Error(`SOP process exited (${code ?? signal})`));
    });
  });
  try {
    // A managed service must never silently attach to another database's process.
    try {
      await fetch(`${config.endpoint}/healthz`, { signal: AbortSignal.timeout(1000) });
      throw new Error(`SOP endpoint already in use: ${config.endpoint}; disable localRuntime to use an external service`);
    } catch (error) {
      if (error.message.startsWith('SOP endpoint already')) throw error;
    }
    if (!existsSync(python)) {
      await run(config.python, ['-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"']);
      await run(config.python, ['-m', 'venv', join(root, 'venv')]);
    }
    const stamp = join(root, 'installed-source.txt');
    const revision = sourceRevision(source);
    if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== revision) {
      console.log('[sop-runtime] Installing standalone Python package (first start or package update)...');
      await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-e', source]);
      writeFileSync(stamp, revision);
    }
    const tokenFile = join(root, 'publish-token');
    let token = env.SOP_RUNTIME_PUBLISH_TOKEN || env.SOP_PUBLISH_TOKEN;
    if (!token) {
      if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      token = readFileSync(tokenFile, 'utf8').trim();
    }
    const runtime = run(python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.api:app', '--host', config.host, '--port', String(config.port)], {
      cwd: root, env: { ...env, SOP_RUNTIME_DB: env.SOP_RUNTIME_DB || join(root, 'runtime.sqlite'),
        SOP_PUBLISH_TOKEN: token, SOP_KNOWLEDGE_ENABLED: String(config.knowledge),
        SOP_VERSION_MANAGEMENT_ENABLED: String(config.versions) },
    });
    const health = await Promise.race([waitForSopHealth(config.endpoint, { signal: abort.signal }), runtime.then(() => { throw new Error('SOP exited before readiness'); })]);
    if (health.implementationId !== 'portable-sop') throw new Error('Unexpected SOP implementation');
    console.log(`[sop-runtime] Ready: ${config.endpoint}`);
    onReady({ type: 'pilotdeck:sop-ready', publishToken: token });
    await runtime;
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('disconnect', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalSopRuntime().catch(error => { console.error(`[sop-runtime] ${error.message}`); process.exitCode = 1; });
}
