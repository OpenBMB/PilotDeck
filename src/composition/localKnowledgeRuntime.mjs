import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const absolute = value => typeof value === 'string' && isAbsolute(value);
export function validateLocalKnowledgeRuntime(value, endpoint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('localRuntime must be an object');
  const keys = ['python', 'dataDirectory', 'configFile', 'modelConfig', 'identityFile', 'capabilitiesFile', 'startupTimeoutMs'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw Error('Unknown localRuntime field');
  if (!absolute(value.python)) throw Error('localRuntime.python must be an absolute Python executable path');
  for (const key of ['dataDirectory', 'configFile', 'modelConfig', 'identityFile', 'capabilitiesFile']) {
    if (value[key] !== undefined && !absolute(value[key])) throw Error(`localRuntime.${key} must be an absolute path`);
  }
  if (value.startupTimeoutMs !== undefined && (!Number.isSafeInteger(value.startupTimeoutMs) || value.startupTimeoutMs < 1))
    throw Error('localRuntime.startupTimeoutMs must be a positive integer');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw Error('localRuntime endpoint must be http://127.0.0.1:<port>');
  return { ...value };
}

function portOccupied(port) {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolveProbe(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

/** Own only the child started here; never adopt or stop an external KM service. */
export async function startLocalKnowledgeRuntime(binding, { env = process.env, log = console.log, onExit, signal } = {}) {
  if (binding?.enabled !== true || !binding.localRuntime) return { stop: async () => {} };
  if (binding.contract !== 'knowledge-core/v1') throw Error('localRuntime requires knowledge-core/v1');
  const config = validateLocalKnowledgeRuntime(binding.localRuntime, binding.endpoint);
  const directory = config.dataDirectory ?? resolve(env.PILOT_HOME || join(homedir(), '.pilotdeck'), 'knowledge');
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.runtime-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // An incomplete lock is kept rather than racing another startup.
    let owner;
    try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch {}
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw Error(`KM startup lock exists: ${lock}`);
    try { process.kill(owner.pid, 0); throw Error(`KM is already managed by PID ${owner.pid}`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  let child, logFile, closing = false, stopPromise;
  let failure;
  let exited = false;
  let exitPromise;
  const stop = () => stopPromise ??= (async () => {
    closing = true;
    try {
      if (child && !exited) {
        child.kill('SIGTERM');
        let timer;
        await Promise.race([exitPromise, new Promise(resolveStop => {
          timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolveStop(); }, 15_000);
        })]);
        clearTimeout(timer);
        await exitPromise;
      }
    } finally {
      await logFile?.close();
      await rm(lock, { recursive: true, force: true });
    }
  })();
  try {
    const owner = await open(join(lock, 'owner.json'), 'wx');
    try { await owner.writeFile(JSON.stringify({ pid: process.pid })); } finally { await owner.close(); }
    const url = new URL(binding.endpoint);
    if (await portOccupied(Number(url.port))) throw Error(`KM port ${url.port} is occupied; no existing process was stopped`);
    const args = ['-m', 'knowledge_core.cli', '--database-url', 'sqlite:///' + join(directory, 'knowledge.sqlite').replaceAll('\\', '/'), '--host', '127.0.0.1', '--port', url.port];
    for (const [key, flag] of Object.entries({ configFile: '--config', modelConfig: '--model-config', identityFile: '--identity-file', capabilitiesFile: '--capabilities-file' }))
      if (config[key]) args.push(flag, config[key]);
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'PYTHONPATH' && !key.startsWith('KM_') && !key.startsWith('STAFFDECK_')));
    logFile = await open(join(directory, 'service.log'), 'a');
    child = spawn(config.python, args, { cwd: directory, env: childEnv, stdio: ['ignore', logFile.fd, logFile.fd], windowsHide: true });
    exitPromise = new Promise(resolveExit => {
      child.once('error', error => { failure = error; });
      child.once('close', (code, signal) => {
        exited = true;
        failure ??= Error(`KM exited code=${code} signal=${signal}; see ${join(directory, 'service.log')}`);
        resolveExit();
        if (!closing) onExit?.(failure);
      });
    });
    const deadline = Date.now() + (config.startupTimeoutMs ?? 60_000);
    while (true) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      try {
        const response = await fetch(new URL('/health/ready', url), { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) {
          const catalog = await fetch(new URL('/api/km/config', url), { signal: AbortSignal.timeout(1000) });
          if (catalog.ok && (await catalog.json()).api_protocol === 'knowledge-core/v1') break;
        }
      } catch {}
      if (Date.now() >= deadline) throw Error(`KM readiness timed out; see ${join(directory, 'service.log')}`);
      await delay(100);
    }
    signal?.throwIfAborted();
    if (failure) throw failure;
    log(`[knowledge] Local KM ready at ${url.origin}; data: ${directory}`);
    return { stop, pid: child.pid, directory };
  } catch (error) {
    await stop();
    throw error;
  }
}
