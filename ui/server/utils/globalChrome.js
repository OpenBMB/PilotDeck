import { join } from 'path';
import { homedir } from 'os';
import { createConnection } from 'net';
import { spawn, execSync } from 'child_process';
import fs from 'fs';

const CDP_PORT = 9222;
const CDP_HOST = '127.0.0.1';
const CDP_HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_FAIL_THRESHOLD = 3;

let chromeProcess = null;
let _consecutiveHealthFailures = 0;

function _ts() {
  return new Date().toISOString();
}

function _caller() {
  const stack = new Error().stack;
  const frames = stack?.split('\n').slice(2, 4).map(l => l.trim()).join(' <- ') ?? '';
  return frames;
}

const LOCK_FILE_NAME = 'chrome-cdp.lock';

function getUserDataDir() {
  const configDir = process.env.PILOTDECK_CONFIG_DIR ?? join(homedir(), '.pilotdeck');
  return join(configDir, 'browser-use-profile');
}

function getLockFilePath() {
  return join(getUserDataDir(), LOCK_FILE_NAME);
}

function writeLock() {
  try {
    const dir = getUserDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getLockFilePath(), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch { /* ignore */ }
}

function removeLock() {
  try {
    const lockPath = getLockFilePath();
    if (!fs.existsSync(lockPath)) return;
    const content = fs.readFileSync(lockPath, 'utf8').trim();
    const { pid } = JSON.parse(content);
    if (pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch { /* ignore */ }
}

function findChromePath() {
  const platform = process.platform;
  let candidates;
  if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  } else if (platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates = [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    ];
  } else {
    candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function isCDPPortOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: CDP_HOST, port: CDP_PORT });
    socket.setTimeout(1500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function isCDPHealthy() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CDP_HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function cleanSingletonLocks(dir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(dir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
}

function launchChrome(executablePath, userDataDir) {
  cleanSingletonLocks(userDataDir);
  const proc = spawn(executablePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ProfilePicker',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  proc.on('exit', () => {
    if (chromeProcess === proc) chromeProcess = null;
  });
  return proc;
}

async function waitForCDP(maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isCDPHealthy()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const CHROME_STOP_TIMEOUT_MS = 2500;
const CHROME_STOP_POLL_MS = 100;

async function killCDPPort() {
  const caller = _caller();
  let pidList = [];
  try {
    if (process.platform === 'win32') {
      const raw = execSync(
        `netstat -ano | findstr "LISTENING" | findstr ":${CDP_PORT} "`,
        { encoding: 'utf8' }
      ).trim();
      for (const line of raw.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid && !pidList.includes(pid)) pidList.push(pid);
      }
    } else {
      const raw = execSync(`lsof -ti :${CDP_PORT} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (raw) pidList = raw.split('\n').map(Number).filter(Boolean);
    }
  } catch { /* ignore */ }

  if (pidList.length === 0) {
    chromeProcess = null;
    return;
  }

  console.warn(`[BROWSER ${_ts()}] killCDPPort: sending SIGTERM to pids=${JSON.stringify(pidList)} | caller: ${caller}`);

  if (process.platform === 'win32') {
    for (const pid of pidList) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  } else {
    for (const pid of pidList) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
  }

  const deadline = Date.now() + CHROME_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isCDPHealthy())) {
      chromeProcess = null;
      return;
    }
    await new Promise((r) => setTimeout(r, CHROME_STOP_POLL_MS));
  }

  if (process.platform !== 'win32') {
    console.warn(`[BROWSER ${_ts()}] killCDPPort: SIGTERM timeout, sending SIGKILL to pids=${JSON.stringify(pidList)}`);
    for (const pid of pidList) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  chromeProcess = null;
}

export async function ensureGlobalChrome() {
  if (await isCDPHealthy()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }

  if (await isCDPPortOpen()) {
    console.warn(`[BROWSER ${_ts()}] ensureGlobalChrome: port open but unhealthy, killing stale Chrome`);
    await killCDPPort();
  }

  const executablePath = findChromePath();
  if (!executablePath) return null;

  const userDataDir = getUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  chromeProcess = launchChrome(executablePath, userDataDir);
  console.log(`[BROWSER ${_ts()}] ensureGlobalChrome: launched Chrome pid=${chromeProcess.pid}`);
  writeLock();

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }
  removeLock();
  return null;
}

export async function restartGlobalChrome() {
  console.warn(`[BROWSER ${_ts()}] restartGlobalChrome: killing and relaunching | caller: ${_caller()}`);
  await killCDPPort();

  const executablePath = findChromePath();
  if (!executablePath) return null;

  const userDataDir = getUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  chromeProcess = launchChrome(executablePath, userDataDir);
  console.log(`[BROWSER ${_ts()}] restartGlobalChrome: launched Chrome pid=${chromeProcess.pid}`);
  writeLock();

  if (await waitForCDP()) {
    return `http://${CDP_HOST}:${CDP_PORT}`;
  }
  removeLock();
  return null;
}

let healthCheckTimer = null;

export function startChromeHealthCheck(intervalMs = HEALTH_CHECK_INTERVAL_MS) {
  stopChromeHealthCheck();
  _consecutiveHealthFailures = 0;
  healthCheckTimer = setInterval(async () => {
    if (!(await isCDPHealthy())) {
      _consecutiveHealthFailures++;
      console.warn(`[BROWSER ${_ts()}] Health check failed (${_consecutiveHealthFailures}/${HEALTH_CHECK_FAIL_THRESHOLD})`);
      if (_consecutiveHealthFailures >= HEALTH_CHECK_FAIL_THRESHOLD) {
        console.warn(`[BROWSER ${_ts()}] ${HEALTH_CHECK_FAIL_THRESHOLD} consecutive failures, restarting Chrome...`);
        _consecutiveHealthFailures = 0;
        const url = await restartGlobalChrome();
        if (url) {
          process.env.CDP_URL = url;
          console.log(`[BROWSER ${_ts()}] Chrome restarted at ${url}`);
        } else {
          console.error(`[BROWSER ${_ts()}] Chrome restart failed`);
        }
      }
    } else {
      if (_consecutiveHealthFailures > 0) {
        console.log(`[BROWSER ${_ts()}] Health check recovered after ${_consecutiveHealthFailures} failures`);
      }
      _consecutiveHealthFailures = 0;
    }
  }, intervalMs);
  healthCheckTimer.unref();
}

export function stopChromeHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export function shutdownGlobalChrome() {
  console.warn(`[BROWSER ${_ts()}] shutdownGlobalChrome called | caller: ${_caller()}`);
  stopChromeHealthCheck();
  if (chromeProcess) {
    console.warn(`[BROWSER ${_ts()}] shutdownGlobalChrome: sending SIGTERM to pid=${chromeProcess.pid}`);
    try { chromeProcess.kill('SIGTERM'); } catch { /* ignore */ }
    chromeProcess = null;
  }
  removeLock();
}

let _cdpInitPromise = null;

// Chrome 147+ breaks Playwright's connectOverCDP (setDownloadBehavior protocol
// change).  When the agent's session.ts detects this, it skips CDP and uses
// chromium.launch() directly.  We still start Chrome here so the health-check
// infrastructure keeps working, but we tag the env so callers know CDP is
// connect-incompatible.
const CDP_INCOMPATIBLE_CHROME_MAJOR = 147;

async function getChromeMajorFromCDP() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return 0;
    const data = await res.json();
    const match = data.Browser?.match(/Chrome\/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Lazy CDP initializer — starts Chrome only on first call, then caches the URL.
 * Subsequent calls return immediately if Chrome is already healthy.
 * Serializes concurrent callers so Chrome is launched at most once.
 *
 * On Chrome 147+, CDP_URL is intentionally NOT set so that the Agent's
 * browser-use session.ts falls through to Playwright-managed launch instead
 * of attempting connectOverCDP (which hangs on 147+).
 */
export async function ensureCDPUrl() {
  if (process.env.CDP_URL && await isCDPHealthy()) {
    return process.env.CDP_URL;
  }

  if (_cdpInitPromise) return _cdpInitPromise;

  _cdpInitPromise = (async () => {
    try {
      const cdpUrl = await ensureGlobalChrome();
      if (!cdpUrl) return null;

      const major = await getChromeMajorFromCDP();
      if (major >= CDP_INCOMPATIBLE_CHROME_MAJOR) {
        console.log(
          `[BROWSER ${_ts()}] Chrome ${major} detected — skipping CDP_URL ` +
          `(connectOverCDP incompatible). Agent will use Playwright-managed launch.`
        );
        return null;
      }

      process.env.CDP_URL = cdpUrl;
      startChromeHealthCheck(HEALTH_CHECK_INTERVAL_MS);
      console.log(`[BROWSER ${_ts()}] Global Chrome ready (lazy) at ${cdpUrl}`);
      return cdpUrl;
    } finally {
      _cdpInitPromise = null;
    }
  })();

  return _cdpInitPromise;
}
