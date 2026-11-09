import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function permissionResult(value, bundleId) {
  if (value.host_bundle_id !== bundleId || typeof value.accessibility !== 'boolean' || typeof value.screen_recording !== 'boolean') {
    throw new Error('The permission check did not return a valid result from the expected native component.');
  }
  return { accessibility: value.accessibility, screenRecording: value.screen_recording };
}

export async function probeMacPermissions({ runtime, execute, env }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-probe-'));
  fs.chmodSync(directory, 0o700);
  let fd, pid;
  const socket = path.join(directory, 'driver.sock');
  const command = args => execute(runtime.binary, [...args, '--socket', socket], { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
  try {
    if (runtime.probeSupported) {
      const result = path.join(directory, `pilotdeck-permissions-${randomUUID()}.json`);
      fs.writeFileSync(result, '', { mode: 0o600, flag: 'wx' });
      // The helper publishes its result and exits immediately. open -W can
      // lose that process before installing its kevent exit watcher. Wait on
      // the private result-file protocol instead of the launcher's exit watch.
      const deadline = Date.now() + 10_000;
      await execute('/usr/bin/open', ['-n', '-g', '-a', runtime.app, '--args', 'probe', '--result-file', result], { env, timeout: 10_000 });
      while (Date.now() < deadline) {
        const value = fs.readFileSync(result, 'utf8');
        if (value.trim()) return permissionResult(JSON.parse(value), runtime.bundleId);
        await delay(50);
      }
      throw new Error('Native permission check timed out waiting for its result.');
    }
    // Older signed releases have no probe entrypoint. Use an isolated, short-
    // lived host/driver solely for the read-only check; never publish its socket.
    const fifo = path.join(directory, 'liveness');
    await execute('/usr/bin/mkfifo', ['-m', '600', fifo], { timeout: 10_000 });
    fd = fs.openSync(fifo, 'r+');
    await execute('/usr/bin/open', ['-n', '-g', '-a', runtime.app, '--stdin', fifo, '--stderr', path.join(directory, 'probe.log'),
      '--args', 'serve', '--socket', socket], { env, timeout: 10_000 });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(socket) && Date.now() < deadline) await delay(50);
    if (!fs.existsSync(socket)) throw new Error('Native permission check timed out.');
    const result = JSON.parse((await command(['call', 'check_permissions', '{"prompt":false}'])).stdout);
    if (result.source?.executable !== runtime.binary || result.source?.host_bundle_id !== runtime.bundleId || !Number.isInteger(result.source?.pid)) {
      throw new Error('The permission probe connected to a different component.');
    }
    pid = result.source.pid;
    return permissionResult({ ...result, host_bundle_id: result.source.host_bundle_id }, runtime.bundleId);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      const deadline = Date.now() + 5000;
      while (fs.existsSync(socket) && Date.now() < deadline) await delay(50);
      if (fs.existsSync(socket)) {
        if (!pid) throw new Error('Cannot confirm ownership of the permission probe for shutdown.');
        await command(['stop', '--expected-pid', String(pid)]);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
