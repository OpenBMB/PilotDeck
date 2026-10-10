import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computerUseDirectory, computerUseMcpConfigPath } from './computerUsePaths.js';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ID = 'pilotdeck-computer-use';
const MAC_HOST_ID = 'cn.pilotdeck.computer-use';

export function findDriver(env, platform, runtimeRoot = root) {
  const name = platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver' : platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  const candidates = env.PILOTDECK_CUA_DRIVER_PATH ? [env.PILOTDECK_CUA_DRIVER_PATH]
    : [path.join(runtimeRoot, 'resources/cua-driver', name)];
  return candidates.find(candidate => candidate && path.isAbsolute(candidate) && fs.existsSync(candidate));
}

/** Web and desktop use the same pinned native runtime dependency. A standalone
 * macOS server launches the bundled GUI app for correct TCC attribution. Its
 * private endpoint and liveness pipe are independent of external installations.
 * An explicitly configured external Driver remains a borrowed service.
 */
export class StandaloneComputerUseController {
  constructor({ env = process.env, platform = process.platform, execute = executeFile, spawnImpl = spawn, runtimeRoot = root,
    binary = findDriver(env, platform, runtimeRoot), managed = !env.PILOTDECK_CUA_DRIVER_PATH,
    version = JSON.parse(fs.readFileSync(path.join(root, 'scripts/computer-use/cua-driver.json'), 'utf8')).version,
    log = console.log } = {}) {
    this.env = env; this.platform = platform; this.execute = execute; this.spawn = spawnImpl; this.binary = binary;
    this.managed = managed; this.livenessFd = null; this.ownedPid = null; this.permissionRequests = [];
    if (managed && binary) this.renewEndpoint();
    this.expectedVersion = version; this.log = log;
    this.directory = computerUseDirectory(env);
    this.mcpConfigPath = computerUseMcpConfigPath(env);
    this.settingsPath = path.join(this.directory, 'settings.json');
    this.serial = Promise.resolve(); this.child = null; this.stopping = false; this.checkedAt = 0;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let enabled = false;
    try { enabled = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')).enabled === true; } catch { /* off by default */ }
    this.state = { enabled, phase: 'disabled', available: !!binary, version, platform };
    if (platform === 'darwin') {
      this.state.permissionOwner = managed ? 'PilotDeck Computer Use' : 'CuaDriver';
      this.state.permissions = { accessibility: false, screenRecording: false };
      if (binary) {
        const executable = fs.realpathSync(binary);
        const bundleEnd = executable.indexOf('.app/Contents/MacOS/');
        if (bundleEnd >= 0) this.state.permissionAppPath = executable.slice(0, bundleEnd + 4);
      }
    }
    if (platform === 'linux') this.state.desktopSession = env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland'
      ? 'wayland' : env.DISPLAY ? 'x11' : 'unknown';
    this.publish(false);
  }

  initialize() {
    return this.enqueue(async () => { this.adoptLegacyConfiguration(); return this.inspect(true); });
  }

  status() {
    return this.enqueue(async () => Date.now() - this.checkedAt < 1000 ? this.snapshot() : this.inspect(false));
  }

  refresh() { return this.enqueue(async () => {
    this.stopPermissionRequests();
    if (this.managed) { this.publish(false); await this.stopOwnedChild(); this.renewEndpoint(); }
    return this.inspect(true);
  }); }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('enabled must be a boolean'));
    return this.enqueue(async () => {
      this.writeJson(this.settingsPath, { enabled }); this.state.enabled = enabled;
      if (!enabled) { this.publish(false); this.stopPermissionRequests(); await this.stopOwnedChild(); if (this.managed) this.renewEndpoint(); }
      return this.inspect(true);
    });
  }

  requestPermission(permission) {
    if (!['accessibility', 'screenRecording'].includes(permission)) return Promise.reject(new Error('Invalid permission'));
    return this.enqueue(async () => {
      if (this.platform === 'darwin' && this.binary) {
        if (this.managed) {
          await this.requestBundledPermissions(permission);
          if (this.state.enabled) { this.publish(false); await this.stopOwnedChild(); this.renewEndpoint(); }
        }
        else await this.command(['permissions', 'grant']);
        const pane = permission === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
        await this.execute('open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`], { timeout: 10_000 });
      }
      return this.inspect(true);
    });
  }

  revealPermissionApp() {
    return this.enqueue(async () => {
      const application = this.state.permissionAppPath;
      if (this.platform !== 'darwin' || !application || !fs.existsSync(application)) throw new Error('The permission application is unavailable.');
      // This fixed host-owned path cannot be supplied by the browser or Agent.
      // Revealing it does not request permissions or start/restart the Driver.
      await this.execute('/usr/bin/open', ['-R', application], { timeout: 10_000 });
      return this.snapshot();
    });
  }

  async stop() {
    this.stopping = true; await this.serial.catch(() => undefined);
    this.publish(false); this.stopPermissionRequests(); await this.stopOwnedChild();
    if (this.instanceDirectory) fs.rmSync(this.instanceDirectory, { recursive: true, force: true });
  }

  enqueue(operation) {
    const result = this.serial.catch(() => undefined).then(() => {
      if (this.stopping) throw new Error('Computer use is stopping');
      return operation();
    });
    this.serial = result; return result;
  }

  snapshot() { return { ...this.state, ...(this.state.permissions ? { permissions: { ...this.state.permissions } } : {}) }; }

  renewEndpoint() {
    if (!this.binary) return;
    if (this.instanceDirectory) fs.rmSync(this.instanceDirectory, { recursive: true, force: true });
    this.instanceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-'));
    fs.chmodSync(this.instanceDirectory, 0o700);
    this.endpoint = this.platform === 'win32' ? `\\\\.\\pipe\\pilotdeck-cua-${randomUUID()}` : path.join(this.instanceDirectory, 'driver.sock');
  }

  environment() {
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
      'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
      'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']);
    const env = {};
    for (const [name, value] of Object.entries(this.env)) {
      if (allowed.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_')) env[name] = value;
    }
    Object.assign(env, { CUA_DRIVER_EMBEDDED: this.managed ? '1' : '0', CUA_DRIVER_PERMISSION_MODE: 'standard',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY_ENABLED: 'false' });
    if (this.managed && this.platform === 'darwin') env.CUA_DRIVER_HOST_BUNDLE_ID = MAC_HOST_ID;
    if (this.state.desktopSession === 'wayland') env.CUA_DRIVER_RS_ENABLE_WAYLAND = '1';
    return env;
  }

  command(args) {
    if (this.endpoint && ['status', 'call', 'stop'].includes(args[0])) args = [...args, '--socket', this.endpoint];
    return this.execute(this.binary, args, { env: this.environment(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  }

  async daemonIsRunning() {
    try { return /daemon is running/.test((await this.command(['status'])).stdout); }
    catch (error) {
      // The public CLI exits 1 for an absent daemon; this is expected before
      // first enable, not a startup failure. Preserve other execution errors.
      if (error.code === 1 && /daemon is not running/.test(`${error.stdout || ''}${error.stderr || ''}`)) return false;
      throw error;
    }
  }

  async inspect(allowStart) {
    try {
      delete this.state.error;
      if (!this.binary) {
        this.state.phase = this.state.enabled ? 'error' : 'disabled';
        this.publish(false); return this.snapshot();
      }
      const version = (await this.command(['--version'])).stdout.trim().split(/\s+/)[1];
      this.state.version = version;
      if (version !== this.expectedVersion) throw new Error(`Driver ${this.expectedVersion} is required; found ${version}.`);
      let running = await this.daemonIsRunning();
      if (!running && this.state.enabled && allowStart) {
        await this.startNativeService();
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          running = await this.daemonIsRunning();
          if (running) break;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (this.platform === 'darwin') {
        if (running || !this.managed) {
          const permissions = JSON.parse((await this.command(this.managed ? ['call', 'check_permissions', '{"prompt":false}'] : ['permissions', 'status', '--json'])).stdout);
          this.state.permissions = { accessibility: permissions.accessibility === true, screenRecording: permissions.screen_recording === true };
          if (running && (this.managed
            ? permissions.source?.attribution !== 'host' || permissions.source?.host_bundle_id !== MAC_HOST_ID
            : permissions.source?.attribution !== 'driver-daemon' || permissions.source?.bundle_id !== 'com.trycua.driver')) {
            throw new Error('The local Driver is not running with native app permission ownership.');
          }
          if (this.managed && running) {
            if (permissions.source?.executable !== fs.realpathSync(this.binary) || !Number.isInteger(permissions.source?.pid)) throw new Error('The connected Driver is not this instance’s bundled component.');
            if (this.ownedPid && this.ownedPid !== permissions.source.pid) throw new Error('The bundled Driver process has changed. Recheck to reconnect.');
            this.ownedPid = permissions.source.pid;
          }
        }
      }
      if (!this.state.enabled) this.state.phase = 'disabled';
      else if (!running) { this.state.phase = 'error'; this.state.error = 'The local Driver is not running. Recheck to reconnect.'; }
      else if (this.state.permissions && (!this.state.permissions.accessibility || !this.state.permissions.screenRecording)) this.state.phase = 'needs-permissions';
      else if (this.state.desktopSession === 'unknown') { this.state.phase = 'error'; this.state.error = 'No interactive desktop session was found.'; }
      else {
        this.state.phase = this.state.desktopSession === 'wayland' ? 'partial' : 'ready';
        if (allowStart && this.platform === 'darwin') {
          const health = JSON.parse((await this.command(['call', 'health_report', JSON.stringify({ include: ['bundle_identity'] })])).stdout);
          const identity = health.checks?.find(check => check.name === 'bundle_identity');
          if (identity?.status !== 'pass' || identity.data?.bundle_identifier !== (this.managed ? MAC_HOST_ID : 'com.trycua.driver')) throw new Error('The local Driver bundle identity does not match its permission owner.');
          if (this.managed && identity.data?.executable_path !== fs.realpathSync(this.binary)) throw new Error('The Driver health response came from another installation.');
          if (this.managed && identity.data?.identity_source !== 'parent_application') throw new Error('The bundled Driver has no native GUI parent.');
        }
      }
      this.publish(['ready', 'partial'].includes(this.state.phase));
    } catch (error) {
      this.publish(false); this.state.phase = this.state.enabled ? 'error' : 'disabled'; this.state.error = error.message;
    } finally { this.checkedAt = Date.now(); }
    return this.snapshot();
  }

  async startNativeService() {
    if (this.platform === 'darwin') {
      const executable = fs.realpathSync(this.binary);
      const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
      if (!bundle.endsWith('.app')) throw new Error('The runtime is missing its native computer-use app bundle. Rebuild or redeploy PilotDeck.');
      const args = ['-n', '-g', '-a', bundle];
      const serve = ['serve', '--no-permissions-gate', '--permission-mode', 'standard'];
      if (this.managed) {
        const fifo = path.join(this.instanceDirectory, 'liveness');
        if (!fs.existsSync(fifo)) await this.execute('/usr/bin/mkfifo', ['-m', '600', fifo], { timeout: 10_000 });
        this.livenessFd ??= fs.openSync(fifo, 'r+');
        args.push('--stdin', fifo, '--stderr', path.join(this.instanceDirectory, 'driver.log'));
        for (const [name, value] of Object.entries(this.environment())) args.push('--env', `${name}=${value}`);
        serve.push('--socket', this.endpoint);
      }
      await this.execute('open', [...args, '--args', ...serve], { env: this.environment(), timeout: 10_000 });
    } else {
      const args = ['serve', '--parent-liveness-stdio', '--no-permissions-gate', '--permission-mode', 'standard'];
      if (this.endpoint) args.push('--embedded', '--socket', this.endpoint);
      const child = this.spawn(this.binary, args,
        { env: this.environment(), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      this.child = child;
      child.stdin?.on('error', () => undefined);
      child.stderr?.on('data', data => this.log(`[computer-use] ${String(data).trimEnd()}`));
      child.on('error', error => { this.state.phase = 'error'; this.state.error = error.message; this.publish(false); });
      child.on('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        if (this.state.enabled && !this.stopping) { this.state.phase = 'error'; this.state.error = 'Driver exited. Recheck to reconnect.'; }
        this.publish(false);
      });
    }
  }

  async stopOwnedChild() {
    if (this.platform === 'darwin' && this.managed && (this.livenessFd !== null || this.ownedPid)) {
      if (this.livenessFd !== null) { fs.closeSync(this.livenessFd); this.livenessFd = null; }
      const deadline = Date.now() + 5000;
      let running = true;
      while (Date.now() < deadline) {
        running = await this.daemonIsRunning();
        if (!running) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (running) {
        if (!this.ownedPid) throw new Error('Cannot confirm ownership of the bundled Driver for shutdown.');
        await this.command(['stop', '--expected-pid', String(this.ownedPid)]);
        if (await this.daemonIsRunning()) throw new Error('The bundled Driver did not stop.');
      }
      if (this.ownedPid) {
        const exitDeadline = Date.now() + 5000;
        let alive = true;
        while (alive && Date.now() < exitDeadline) {
          try { process.kill(this.ownedPid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
          if (alive) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (alive) throw new Error('The bundled Driver process did not exit.');
      }
      this.ownedPid = null;
    }
    const child = this.child;
    if (!child) return;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) { this.child = null; return; }
    const wait = () => new Promise(resolve => {
      const done = () => { clearTimeout(timer); child.off('exit', done); resolve(exited()); };
      const timer = setTimeout(done, 2000);
      child.once('exit', done);
      if (exited()) done();
    });
    child.stdin?.end();
    if (!await wait()) { child.kill('SIGTERM'); if (!await wait()) { child.kill('SIGKILL'); if (!await wait()) throw new Error('Driver did not stop'); } }
    if (this.child === child) this.child = null;
  }

  async requestBundledPermissions(permission) {
    this.stopPermissionRequests();
    const executable = fs.realpathSync(this.binary);
    const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
    if (!bundle.endsWith('.app')) throw new Error('The native computer-use app bundle is missing.');
    const resultFile = path.join(fs.realpathSync(os.tmpdir()), `pilotdeck-permissions-${process.pid}-${randomUUID()}.json`);
    fs.writeFileSync(resultFile, '', { mode: 0o600, flag: 'wx' });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-permissions-'));
    fs.chmodSync(directory, 0o700);
    const fifo = path.join(directory, 'liveness');
    let request;
    try {
      // Requests run in our native GUI identity, never in Node or an external
      // CuaDriver installation. The host exposes no permission RPC to agents.
      await this.execute('/usr/bin/mkfifo', ['-m', '600', fifo], { timeout: 10_000 });
      request = { directory, fd: fs.openSync(fifo, 'r+') };
      this.permissionRequests.push(request);
      const args = ['-n', '-g', '-a', bundle, '--stdin', fifo, '--args', 'permissions', '--permission', permission,
        '--result-file', resultFile, '--parent-liveness-stdio'];
      await this.execute('open', args, { env: this.environment(), timeout: 10_000 });
      const deadline = Date.now() + 5_000;
      while (!fs.readFileSync(resultFile, 'utf8') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      if (result.host_bundle_id !== MAC_HOST_ID) throw new Error('Native permission setup returned a different host identity.');
      this.state.permissions = { accessibility: result.accessibility === true, screenRecording: result.screen_recording === true };
    } catch (error) { this.stopPermissionRequests(); throw error; }
    finally { fs.rmSync(resultFile, { force: true }); if (!request) fs.rmSync(directory, { recursive: true, force: true }); }
  }

  stopPermissionRequests() {
    for (const request of this.permissionRequests.splice(0)) {
      fs.closeSync(request.fd);
      fs.rmSync(request.directory, { recursive: true, force: true });
    }
  }

  adoptLegacyConfiguration() {
    if (!this.binary) return;
    const file = path.join(path.dirname(this.directory), 'mcp.json');
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const legacy = config.mcpServers?.['cua-driver'];
    if (!legacy || JSON.stringify(legacy.args || []) !== '["mcp"]' || legacy.env || legacy.perSession) return;
    try { if (fs.realpathSync(legacy.command) !== fs.realpathSync(this.binary)) return; } catch { return; }
    // Adopt only the exact local POC configuration. Keep a recoverable copy and
    // preserve every other custom MCP server so the switch cannot leave a duplicate.
    const backup = path.join(this.directory, 'legacy-mcp.backup.json');
    if (!fs.existsSync(backup)) this.writeJson(backup, config);
    if (!fs.existsSync(this.settingsPath)) {
      this.state.enabled = true; this.writeJson(this.settingsPath, { enabled: true });
    }
    delete config.mcpServers['cua-driver']; this.writeJson(file, config);
    this.log('[computer-use] Adopted the existing local cua-driver MCP configuration; backup saved.');
  }

  publish(ready) {
    this.writeJson(this.mcpConfigPath, { mcpServers: ready ? { [SERVER_ID]: {
      command: this.binary, args: this.endpoint ? ['mcp', '--embedded', '--socket', this.endpoint] : ['mcp'],
      env: { CUA_DRIVER_EMBEDDED: this.endpoint ? '1' : '0', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY_ENABLED: 'false' },
      callTimeoutMs: 60_000, concurrencySafe: false,
    } } : {} });
  }

  writeJson(file, value) {
    const content = JSON.stringify(value, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, file);
  }
}
