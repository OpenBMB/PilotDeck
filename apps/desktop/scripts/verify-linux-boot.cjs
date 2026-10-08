// Launch the installed Linux package under an isolated X11 or Wayland compositor.
// This checks the real Electron executable and bundled UI server without
// touching the runner's home directory or contacting a model provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const display = process.argv[2];
assert.ok(['x11', 'wayland'].includes(display), 'Specify x11 or wayland');
assert.equal(process.platform, 'linux');
assert.ok(display === 'x11' ? process.env.DISPLAY : process.env.WAYLAND_DISPLAY,
  `Missing ${display} display socket`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), `pilotdeck-${display}-smoke-`));
const configHome = path.join(root, 'config');
const runtimeLog = path.join(configHome, 'pilotdeck-desktop', 'logs', 'runtime.log');
const child = spawn('/usr/bin/pilotdeck-desktop', [
  `--ozone-platform=${display}`, '--disable-gpu', '--no-sandbox',
], {
  env: { ...process.env, XDG_CONFIG_HOME: configHome, PILOT_HOME: path.join(root, 'pilot-home') },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let output = '';
let exited = false;
child.on('exit', () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => { output = (output + chunk.toString()).slice(-12_000); });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Electron exited before startup:\n${output}`);
    if (fs.existsSync(runtimeLog)) {
      const log = fs.readFileSync(runtimeLog, 'utf8');
      const url = log.match(/PilotDeck Web UI ready: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) {
        const response = await fetch(url).catch(() => null);
        if (response?.ok) return url;
      }
      if (log.includes('PilotDeck failed to start')) throw new Error(log.slice(-6000));
    }
    await pause(250);
  }
  throw new Error(`Timed out waiting for PilotDeck UI:\n${output}\n${fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8').slice(-6000) : 'No runtime log'}`);
}

async function stop() {
  if (!exited && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    const deadline = Date.now() + 5_000;
    while (!exited && Date.now() < deadline) await pause(100);
    if (!exited) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  // Managed Node processes intentionally live in separate process groups.
  // Match only this smoke run's private PILOT_HOME before terminating them.
  const marker = Buffer.from(`\0PILOT_HOME=${path.join(root, 'pilot-home')}\0`);
  const ownedPids = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))
    .map(Number).filter(pid => {
      if (pid === process.pid) return false;
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`);
        return Buffer.concat([Buffer.from([0]), env]).includes(marker);
      } catch { return false; }
    });
  for (const pid of ownedPids()) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  const deadline = Date.now() + 5_000;
  while (ownedPids().length && Date.now() < deadline) await pause(100);
  for (const pid of ownedPids()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

async function main() {
  try {
    const url = await waitForReady();
    await pause(2_000);
    assert.equal(exited, false, `Electron exited after readiness:\n${output}`);
    if (display === 'x11') {
      const { execFileSync } = require('node:child_process');
      const windows = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' });
      assert.match(windows, /PilotDeck/, 'X11 window was not created');
    }
    console.log(`PASS: installed Linux package started on ${display} and served ${url}`);
  } finally {
    await stop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
