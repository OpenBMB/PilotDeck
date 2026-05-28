import path from 'path';
import { promises as fs, openSync } from 'fs';
import { mkdirSync } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

// Cron daemon entry point. The launcher script is discoverable on PATH
// or supplied via PILOTDECK_CRON_DAEMON_BIN. Returning `null` falls back
// to the in-tree fallback path that handles missing binaries gracefully.
function resolvePilotDeckMainRoot() {
    return null;
}

const DEFAULT_RETRY_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 250;
const START_LOCK_STALE_MS = 30000;
const CCR_SENTINEL = 'http://ccr.local';
const CCR_DAEMON_FETCH_INTERCEPTOR = 'CCR_DAEMON_FETCH_INTERCEPTOR';

function getPilotDeckConfigHomeDir() {
  return process.env.PILOTDECK_CONFIG_DIR || process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
}

function getCronDaemonStartLockPath() {
  return path.join(getPilotDeckConfigHomeDir(), 'cron-daemon', 'start.lock');
}

/**
 * Resolve a log file path for the detached cron daemon.
 *
 * Prior to this, the daemon spawned with `stdio: 'ignore'` so all of its
 * lifecycle output, errors, and discovery-scheduler trace was silently
 * discarded — making post-mortem debugging on the PilotDeck Desktop install
 * basically impossible (`~/.pilotdeck/desktop.server.log` only captured the
 * UI server's own output, not its detached children).
 *
 * We honour an explicit override via `PILOTDECK_CRON_DAEMON_LOG`; otherwise we
 * default to `~/.pilotdeck/cron-daemon.log` (parallel to `desktop.server.log`).
 * The directory is created on demand so this works pre-onboarding too.
 */
function resolveCronDaemonLogPath() {
  const override = process.env.PILOTDECK_CRON_DAEMON_LOG?.trim();
  if (override) return override;
  return path.join(process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'), 'cron-daemon.log');
}

function openCronDaemonLogFd() {
  const logPath = resolveCronDaemonLogPath();
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    return { fd, logPath };
  } catch (err) {
    // Fall back to ignore — better to lose stdout than to fail to spawn.
    console.warn(`[WARN] Cron daemon log unavailable (${logPath}): ${err?.message ?? err}`);
    return { fd: null, logPath };
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isCronDaemonUnavailableError(error) {
  return Boolean(
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
  );
}

export function buildCronDaemonEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  if (env.ANTHROPIC_BASE_URL === CCR_SENTINEL) {
    env[CCR_DAEMON_FETCH_INTERCEPTOR] = '1';
  }
  return env;
}

export function buildCronDaemonSpawnCommand({
  resolvePilotDeckMainRootFn = resolvePilotDeckMainRoot,
  cliPath = process.env.PILOTDECK_CLI_PATH
} = {}) {
  const localMainRoot = resolvePilotDeckMainRootFn();
  if (localMainRoot) {
    const preloadPath = path.join(localMainRoot, 'preload.ts');
    const daemonMainPath = path.join(localMainRoot, 'src', 'daemon', 'main.ts');
    return {
      command: 'bun',
      args: [
        '--preload',
        preloadPath,
        '-e',
        `const { daemonMain } = await import(${JSON.stringify(daemonMainPath)}); await daemonMain(['serve'])`
      ]
    };
  }

  return {
    command: typeof cliPath === 'string' && cliPath.trim().length > 0 ? cliPath.trim() : 'pilotdeck',
    args: ['daemon', 'serve']
  };
}

async function acquireStartLock() {
  const lockPath = getCronDaemonStartLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
    return async () => {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const ageMs = await fs.stat(lockPath)
    .then((stats) => Date.now() - stats.mtimeMs)
    .catch(() => 0);
  if (ageMs > START_LOCK_STALE_MS) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return await acquireStartLock();
  }
  return null;
}

export async function pingCronDaemon({
  sendCronDaemonRequestFn = sendCronDaemonRequest
} = {}) {
  const response = await sendCronDaemonRequestFn({ type: 'ping' });
  if (!response?.ok || response.data?.type !== 'pong') {
    throw new Error('Unexpected Cron daemon ping response');
  }
  return response;
}

export function startCronDaemonDetached({
  spawnFn = spawn,
  buildCronDaemonSpawnCommandFn = buildCronDaemonSpawnCommand,
  openLogFdFn = openCronDaemonLogFd
} = {}) {
  const { command, args } = buildCronDaemonSpawnCommandFn();
  const { fd, logPath } = openLogFdFn();
  // Detach so multiple ui servers (e.g. dev + PilotDeck Desktop side-by-side)
  // can share state through ~/.pilotdeck/cron-daemon.sock, but pipe stdout/stderr
  // into a real log file instead of /dev/null so the daemon is debuggable
  // post-mortem. Stdin stays 'ignore' (the daemon never reads input).
  const stdio = fd === null ? 'ignore' : ['ignore', fd, fd];
  let child;
  try {
    child = spawnFn(command, args, {
      cwd: process.cwd(),
      env: buildCronDaemonEnv(),
      detached: true,
      stdio
    });
  } catch (err) {
    console.warn(`[WARN] Cron daemon spawn failed: ${err.message}`);
    return null;
  }
  child.on('error', (err) => {
    console.warn(`[WARN] Cron daemon process error: ${err.message}`);
  });
  if (typeof child?.unref === 'function') {
    child.unref();
  }
  if (fd !== null) {
    console.log(`[INFO] Cron daemon spawned, output → ${logPath}`);
  }
  return child;
}

export async function ensureCronDaemonForUiStartup({
  sendCronDaemonRequestFn = sendCronDaemonRequest,
  spawnFn = spawn,
  buildCronDaemonSpawnCommandFn = buildCronDaemonSpawnCommand,
  openLogFdFn = openCronDaemonLogFd,
  sleepFn = sleep,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
} = {}) {
  try {
    return await pingCronDaemon({ sendCronDaemonRequestFn });
  } catch (error) {
    if (!isCronDaemonUnavailableError(error)) {
      throw error;
    }
  }

  const releaseStartLock = await acquireStartLock();
  if (releaseStartLock) {
    try {
      try {
        return await pingCronDaemon({ sendCronDaemonRequestFn });
      } catch {
        // We own startup now; any unhealthy ping means this process should spawn.
      }

      startCronDaemonDetached({
        spawnFn,
        buildCronDaemonSpawnCommandFn,
        openLogFdFn
      });

      let lastError = null;
      for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
        try {
          return await pingCronDaemon({ sendCronDaemonRequestFn });
        } catch (error) {
          lastError = error;
          if (attempt < retryAttempts - 1) {
            await sleepFn(retryDelayMs);
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Cron daemon failed to start');
    } finally {
      await releaseStartLock();
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    try {
      return await pingCronDaemon({ sendCronDaemonRequestFn });
    } catch (error) {
      lastError = error;
      if (attempt < retryAttempts - 1) {
        await sleepFn(retryDelayMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cron daemon failed to start');
}
