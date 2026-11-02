import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ComputerUsePermission, ComputerUseStatus } from '../../../ui/shared/computerUse';

const execute = promisify(execFile);
export const COMPUTER_USE_SERVER_ID = 'pilotdeck-computer-use';
type Options = {
  directory: string;
  resources: string;
  bundleId: string;
  permissions: () => { accessibility: boolean; screenRecording: boolean } | undefined;
  requestPermission: (permission: ComputerUsePermission) => Promise<void>;
  permissionAppPath?: string;
  revealPermissionApp?: () => void | Promise<void>;
  log: (message: string) => void;
};

/** App-owned sidecar: never use the gateway's process guardian or a shared Cua service.
 * In particular, macOS TCC follows the GUI host's direct responsibility chain.
 */
export class ComputerUseController {
  readonly mcpConfigPath: string;
  private readonly settingsPath: string;
  private readonly binary: string;
  private child: ChildProcess | null = null;
  private endpointDirectory: string | null = null;
  private endpoint: string | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private state: ComputerUseStatus;
  private shuttingDown = false;

  constructor(private readonly options: Options) {
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.mcpConfigPath = path.join(options.directory, 'mcp.json');
    this.settingsPath = path.join(options.directory, 'settings.json');
    this.binary = path.join(options.resources, process.platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver'
      : process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
    let enabled = false;
    let version = 'unknown';
    try { enabled = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')).enabled === true; } catch { /* off by default */ }
    try { version = JSON.parse(fs.readFileSync(path.join(options.resources, 'manifest.json'), 'utf8')).version; } catch { /* build not prepared */ }
    this.state = { enabled, phase: 'disabled', available: fs.existsSync(this.binary), version, platform: process.platform };
    if (process.platform === 'darwin') {
      this.state.permissionOwner = options.bundleId === 'com.github.Electron' ? 'Electron' : 'PilotDeck';
      this.state.permissionAppPath = options.permissionAppPath;
    }
    if (process.platform === 'linux') this.state.desktopSession = process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY
      ? 'wayland' : process.env.DISPLAY ? 'x11' : 'unknown';
    this.publishConnection(false);
  }

  status(): ComputerUseStatus {
    return { ...this.state, permissions: this.options.permissions() };
  }

  initialize(): Promise<ComputerUseStatus> { return this.refresh(); }

  setEnabled(enabled: unknown): Promise<ComputerUseStatus> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('enabled must be a boolean'));
    return this.enqueue(async () => {
      this.writeJson(this.settingsPath, { enabled });
      this.state.enabled = enabled;
      await this.reconcile();
      return this.status();
    });
  }

  refresh(): Promise<ComputerUseStatus> {
    return this.enqueue(async () => { await this.reconcile(); return this.status(); });
  }

  requestPermission(permission: unknown): Promise<ComputerUseStatus> {
    if (permission !== 'accessibility' && permission !== 'screenRecording') return Promise.reject(new Error('Invalid permission'));
    return this.enqueue(async () => {
      await this.options.requestPermission(permission);
      // A new process and connection must observe changed macOS grants.
      await this.stopChild();
      await this.reconcile();
      return this.status();
    });
  }

  revealPermissionApp(): Promise<ComputerUseStatus> {
    return this.enqueue(async () => {
      if (process.platform !== 'darwin' || !this.options.permissionAppPath || !fs.existsSync(this.options.permissionAppPath)
        || !this.options.revealPermissionApp) throw new Error('The permission application is unavailable.');
      await this.options.revealPermissionApp();
      return this.status();
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    await this.serial.catch(() => undefined);
    await this.stopChild();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.catch(() => undefined).then(() => {
      if (this.shuttingDown) throw new Error('Desktop is stopping');
      return operation();
    });
    this.serial = result;
    return result;
  }

  private async reconcile(): Promise<void> {
    if (!this.state.enabled) { await this.stopChild(); this.state.phase = 'disabled'; delete this.state.error; return; }
    const permissions = this.options.permissions();
    if (permissions && (!permissions.accessibility || !permissions.screenRecording)) {
      await this.stopChild(); this.state.phase = 'needs-permissions'; delete this.state.error; return;
    }
    if (!this.state.available) { this.state.phase = 'error'; this.state.error = 'Bundled Driver is missing. Reinstall PilotDeck.'; return; }
    if (process.platform === 'linux' && this.state.desktopSession === 'unknown') {
      this.state.phase = 'error'; this.state.error = 'No interactive desktop session was found.'; return;
    }
    try {
      if (!this.child) await this.startChild();
      if (process.platform === 'darwin') {
        const health = await this.call('health_report', { include: ['bundle_identity'] });
        const checks = health.checks as Array<{ name: string; status: string; data?: Record<string, unknown> }> | undefined;
        const identity = checks?.find(check => check.name === 'bundle_identity');
        if (identity?.status !== 'pass' || identity.data?.bundle_identifier !== this.options.bundleId
          || identity.data.identity_source !== 'parent_application' || identity.data.parent_process_id !== process.pid) {
          throw new Error('Driver is not directly hosted by PilotDeck.');
        }
        const permissionsResult = await this.call('check_permissions');
        const source = permissionsResult.source as Record<string, unknown> | undefined;
        if (source?.attribution !== 'host' || source.host_bundle_id !== this.options.bundleId || source.pid !== this.child?.pid) {
          throw new Error('Driver permission identity does not match PilotDeck.');
        }
        if (permissionsResult.accessibility !== true || permissionsResult.screen_recording !== true) {
          await this.stopChild(); this.state.phase = 'needs-permissions'; return;
        }
      }
      // Wayland support depends on the compositor and portal grants; do not
      // turn daemon availability into a claim of full desktop-control support.
      this.state.phase = this.state.desktopSession === 'wayland' ? 'partial' : 'ready';
      delete this.state.error;
      this.publishConnection(true);
    } catch (error) {
      await this.stopChild();
      this.state.phase = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.options.log(`Computer use: ${this.state.error}`);
    }
  }

  private environment(): NodeJS.ProcessEnv {
    // Inherit desktop/session paths, not provider credentials, injected runtimes,
    // or ambient Cua approval policies. Match the upstream embedded SDK contract.
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
      'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
      'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']);
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (allowed.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_')) env[name] = value;
    }
    Object.assign(env, { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: this.options.bundleId,
      CUA_DRIVER_PERMISSION_MODE: 'standard', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY_ENABLED: 'false' });
    if (process.platform === 'linux' && this.state.desktopSession === 'wayland') env.CUA_DRIVER_RS_ENABLE_WAYLAND = '1';
    return env;
  }

  private async startChild(): Promise<void> {
    this.state.phase = 'starting';
    const version = await execute(this.binary, ['--version'], { env: this.environment(), timeout: 10_000, windowsHide: true });
    if (version.stdout.trim().split(/\s+/)[1] !== this.state.version) throw new Error('Bundled Driver version does not match its manifest.');
    this.endpointDirectory = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cua-'));
    this.endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pilotdeck-cua-${process.pid}-${randomUUID()}`
      : path.join(this.endpointDirectory!, 'driver.sock');
    const child = spawn(this.binary, ['serve', '--embedded', '--parent-liveness-stdio', '--no-permissions-gate',
      '--socket', this.endpoint, '--host-bundle-id', this.options.bundleId, '--permission-mode', 'standard'], {
      env: this.environment(), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
    });
    this.child = child;
    let failure: Error | undefined;
    child.on('error', error => { failure = error; });
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', chunk => this.options.log(`[computer-use] ${String(chunk).trimEnd()}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.publishConnection(false);
      this.cleanupEndpoint();
      this.state.phase = 'error';
      this.state.error = `Driver exited (${code ?? signal ?? 'unknown'}). Recheck to reconnect.`;
      // Never replay an action after a crash or reconnect.
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (this.child !== child || child.exitCode !== null) throw new Error(this.state.error || 'Driver exited during startup');
      if (await endpointReady(this.endpoint)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Driver startup timed out.');
  }

  private async call(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { stdout } = await execute(this.binary, ['--embedded', '--socket', this.endpoint!, 'call', tool, JSON.stringify(args)], {
      env: this.environment(), timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  }

  private async stopChild(): Promise<void> {
    this.publishConnection(false);
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      // Parent-liveness stdin is the same shutdown contract used by Cua's SDK.
      child.stdin?.end();
      const wait = (ms: number) => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
        const timer = setTimeout(done, ms);
        child.once('exit', done);
      });
      await wait(2000);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await wait(2000); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await wait(2000); }
      if (child.exitCode === null && child.signalCode === null) { this.child = child; throw new Error('Driver did not stop'); }
    }
    this.cleanupEndpoint();
  }

  private cleanupEndpoint(): void {
    if (this.endpointDirectory) fs.rmSync(this.endpointDirectory, { recursive: true, force: true });
    this.endpointDirectory = null; this.endpoint = null;
  }

  private publishConnection(ready: boolean): void {
    const servers = ready && this.endpoint ? { [COMPUTER_USE_SERVER_ID]: {
      command: this.binary, args: ['mcp', '--embedded', '--socket', this.endpoint, '--host-bundle-id', this.options.bundleId],
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' }, callTimeoutMs: 60_000, concurrencySafe: false,
    } } : {};
    this.writeJson(this.mcpConfigPath, { mcpServers: servers });
  }

  private writeJson(file: string, value: unknown): void {
    const content = JSON.stringify(value, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

function endpointReady(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}
