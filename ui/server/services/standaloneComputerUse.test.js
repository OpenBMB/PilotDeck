// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StandaloneComputerUseController, findDriver } from './standaloneComputerUse.js';
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup({ platform = 'darwin', running = true, grants = true, owner = 'com.trycua.driver', version = '0.34.1', binaryMissing = false, managed = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cua-web-test-')); directories.push(home);
  const binary = path.join(home, managed && platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver' : 'cua-driver');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture');
  const env = { PILOT_HOME: home, HOME: os.homedir(), DISPLAY: ':0', OPENAI_API_KEY: 'never-inherit', CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1' };
  const execute = vi.fn(async (_binary, args, options) => {
    expect(options.env?.OPENAI_API_KEY).toBeUndefined(); expect(options.env?.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS).toBeUndefined();
    let value;
    if (args[0] === '--version') value = `cua-driver ${version}`;
    else if (args[0] === 'status') {
      if (managed && platform === 'darwin' && controller.ownedPid && controller.livenessFd === null) running = false;
      value = running ? 'Cua Driver daemon is running' : 'Cua Driver daemon is not running';
      if (!running) throw Object.assign(new Error('Driver status exit 1'), { code: 1, stderr: value });
    }
    else if (args[0] === 'permissions' || args[1] === 'check_permissions') value = JSON.stringify({ accessibility: grants, screen_recording: grants, source: { attribution: managed ? 'host' : 'driver-daemon', bundle_id: owner, host_bundle_id: managed ? 'cn.pilotdeck.computer-use' : undefined, pid: 2147483647, executable: fs.realpathSync(binary) } });
    else if (_binary === '/usr/bin/mkfifo') { fs.writeFileSync(args.at(-1), ''); value = ''; }
    else if (_binary === 'open') {
      if (args.includes('permissions')) {
        fs.writeFileSync(args[args.indexOf('--result-file') + 1], JSON.stringify({ accessibility: grants, screen_recording: grants, host_bundle_id: 'cn.pilotdeck.computer-use' }));
      } else running = true;
      value = '';
    } else value = JSON.stringify({ checks: [{ name: 'bundle_identity', status: 'pass', data: { bundle_identifier: managed ? 'cn.pilotdeck.computer-use' : owner, identity_source: 'parent_application', executable_path: fs.realpathSync(binary) } }] });
    return { stdout: value };
  });
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  child.stdin = { on: vi.fn(), end: vi.fn(() => { queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); }) };
  child.stderr = new EventEmitter(); child.kill = vi.fn();
  const spawn = vi.fn(() => { running = true; return child; });
  const controller = new StandaloneComputerUseController({ env, platform, execute, spawnImpl: spawn, managed, binary: binaryMissing ? null : binary, version: '0.34.1', log: vi.fn() });
  const descriptor = () => JSON.parse(fs.readFileSync(controller.mcpConfigPath, 'utf8')).mcpServers;
  return { home, binary, execute, child, spawn, controller, descriptor, loseDaemon: () => { running = false; controller.checkedAt = 0; } };
}
describe('standalone web computer use', () => {
  it('exposes and reveals its actual permission app without starting a Driver or requesting grants', async () => {
    const { controller, execute, binary, descriptor } = setup({ managed: true, running: false, grants: false });
    const app = fs.realpathSync(binary).split('/Contents/')[0];
    expect(await controller.initialize()).toMatchObject({ permissionAppPath: app });
    execute.mockClear();
    expect(await controller.revealPermissionApp()).toMatchObject({ permissionAppPath: app, enabled: false });
    expect(execute).toHaveBeenCalledExactlyOnceWith('/usr/bin/open', ['-R', app], { timeout: 10_000 });
    expect(descriptor()).toEqual({}); await controller.stop();
  });
  it.each([{platform: 'linux', managed: true}, {platform: 'darwin', managed: true, binaryMissing: true}])('does not reveal an unavailable permission app: %j', async options => {
    const { controller, execute } = setup(options); execute.mockClear();
    await expect(controller.revealPermissionApp()).rejects.toThrow('unavailable');
    expect(execute).not.toHaveBeenCalled(); await controller.stop();
  });
  it('finds the bundled runtime dependency without falling back to PATH or external applications', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cua-resource-test-')); directories.push(home);
    expect(findDriver({ PATH: '/Applications/CuaDriver.app/Contents/MacOS' }, 'darwin', home)).toBeUndefined();
    const resources = path.join(home, 'resources/cua-driver'); fs.mkdirSync(resources, { recursive: true });
    const binary = path.join(resources, 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver');
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture');
    expect(findDriver({}, 'darwin', home)).toBe(binary);
  });
  it('starts the bundled Linux dependency on a private endpoint and prevents MCP from launching another daemon', async () => {
    const { controller, spawn, descriptor } = setup({ platform: 'linux', managed: true, running: false });
    await controller.initialize(); expect(spawn).not.toHaveBeenCalled();
    expect((await controller.setEnabled(true)).phase).toBe('ready');
    expect(spawn.mock.calls[0][1]).toContain(controller.endpoint);
    expect(descriptor()['pilotdeck-computer-use']).toMatchObject({ args: ['mcp', '--embedded', '--socket', controller.endpoint], env: { CUA_DRIVER_EMBEDDED: '1' } });
    const endpoint = controller.endpoint;
    await controller.refresh(); expect(controller.endpoint).not.toEqual(endpoint);
    expect(fs.existsSync(path.dirname(endpoint))).toBe(false);
    await controller.stop(); expect(fs.existsSync(controller.instanceDirectory)).toBe(false);
  });
  it('launches its bundled macOS app with a private socket and liveness FIFO, and closes only that daemon', async () => {
    const { controller, execute, binary, descriptor } = setup({ managed: true, running: false, grants: false });
    expect(await controller.initialize()).toMatchObject({ enabled: false, available: true });
    expect(await controller.setEnabled(true)).toMatchObject({ phase: 'needs-permissions', permissionOwner: 'PilotDeck Computer Use' });
    const open = execute.mock.calls.find(([command, args]) => command === 'open' && args.includes('serve'));
    expect(open[1]).toContain(fs.realpathSync(binary).split('/Contents/')[0]);
    expect(open[1]).toContain('--stdin'); expect(open[1]).toContain(controller.endpoint);
    expect(descriptor()).toEqual({}); await controller.stop(); expect(controller.livenessFd).toBeNull();
    expect(execute.mock.calls.some(([, args]) => args[0] === 'stop' && !args.includes(controller.endpoint))).toBe(false);
  });
  it('requests permissions from the exact bundled app rather than the public CLI’s hard-coded Applications path', async () => {
    const { controller, execute, binary } = setup({ managed: true, running: false, grants: false });
    await controller.requestPermission('screenRecording');
    const request = execute.mock.calls.find(([command, args]) => command === 'open' && args.includes('permissions'));
    expect(request[1]).toContain(fs.realpathSync(binary).split('/Contents/')[0]); expect(request[1]).toContain('screenRecording');
    expect(request[1]).not.toContain('-W');
    expect(request[1]).toContain('--stdin'); expect(request[1]).toContain('--parent-liveness-stdio');
    const fifo = request[1][request[1].indexOf('--stdin') + 1];
    const fd = controller.permissionRequests[0].fd;
    expect(fs.existsSync(fifo)).toBe(true); expect(() => fs.fstatSync(fd)).not.toThrow();
    expect(execute.mock.calls.some(([, args]) => args.includes('grant'))).toBe(false);
    await controller.stop();
    expect(fs.existsSync(fifo)).toBe(false); expect(() => fs.fstatSync(fd)).toThrow();
  });
  it('is off by default and reading status does not start a daemon or request grants', async () => {
    const { controller, execute, spawn, descriptor } = setup();
    expect(await controller.initialize()).toMatchObject({ enabled: false, phase: 'disabled', permissionOwner: 'CuaDriver' });
    await controller.status(); expect(descriptor()).toEqual({}); expect(spawn).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([, args]) => args[0] === 'open' || args.includes('grant'))).toBe(false);
    await controller.stop();
  });
  it('ends the permission owner’s lifetime pipe on recheck or disable', async () => {
    const { controller } = setup({ managed: true, running: false, grants: false });
    await controller.requestPermission('accessibility');
    const first = controller.permissionRequests[0];
    await controller.refresh();
    expect(() => fs.fstatSync(first.fd)).toThrow(); expect(fs.existsSync(first.directory)).toBe(false);
    await controller.requestPermission('screenRecording');
    const second = controller.permissionRequests[0];
    await controller.setEnabled(false);
    expect(() => fs.fstatSync(second.fd)).toThrow(); expect(fs.existsSync(second.directory)).toBe(false);
    await controller.stop();
  });
  it('exposes and revokes MCP access to a borrowed macOS daemon without stopping that daemon', async () => {
    const { controller, descriptor, spawn, execute } = setup(); await controller.initialize();
    expect(await controller.setEnabled(true)).toMatchObject({ phase: 'ready', enabled: true });
    expect(descriptor()['pilotdeck-computer-use']).toMatchObject({ args: ['mcp'], concurrencySafe: false });
    expect(await controller.setEnabled(false)).toMatchObject({ phase: 'disabled', enabled: false });
    expect(descriptor()).toEqual({}); await controller.stop(); expect(spawn).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([, args]) => args[0] === 'stop')).toBe(false);
  });
  it.each([{ grants: false, phase: 'needs-permissions' }, { owner: 'com.github.Electron', phase: 'error' }, { version: '0.35.0', phase: 'error' }])('withholds tools when native grants or pinned identity do not match: %j', async ({ phase, ...options }) => {
    const { controller, descriptor } = setup(options); await controller.initialize();
    expect((await controller.setEnabled(true)).phase).toBe(phase); expect(descriptor()).toEqual({}); await controller.stop();
  });
  it('revokes the descriptor when a previously connected daemon disappears without restarting on GET', async () => {
    const { controller, descriptor, loseDaemon, spawn } = setup(); await controller.setEnabled(true); loseDaemon();
    expect((await controller.status()).phase).toBe('error'); expect(descriptor()).toEqual({}); expect(spawn).not.toHaveBeenCalled(); await controller.stop();
  });
  it('backs up and adopts the exact old local MCP entry while retaining other user servers', async () => {
    const { controller, home, binary, descriptor } = setup();
    const config = { mcpServers: { 'cua-driver': { command: binary, args: ['mcp'], callTimeoutMs: 60000 }, other: { command: 'custom', args: [] } } };
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify(config)); await controller.initialize();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'computer-use/legacy-mcp.backup.json'), 'utf8'))).toEqual(config);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')).mcpServers).toEqual({ other: config.mcpServers.other });
    expect(descriptor()['pilotdeck-computer-use']).toBeTruthy(); await controller.stop();
  });
  it('leaves custom external MCP endpoints alone', async () => {
    const { controller, home, binary } = setup();
    const config = { mcpServers: { 'cua-driver': { command: binary, args: ['mcp', '--socket', '/custom'] } } };
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify(config)); await controller.initialize();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8'))).toEqual(config); await controller.stop();
  });
  it('starts and awaits exit of an owned Linux daemon, preserving enabled preferences on shutdown', async () => {
    const { controller, child, spawn, descriptor, home } = setup({ platform: 'linux', running: false });
    await controller.initialize(); expect(spawn).not.toHaveBeenCalled();
    expect((await controller.setEnabled(true)).phase).toBe('ready'); expect(spawn).toHaveBeenCalledTimes(1);
    await controller.stop(); expect(child.exitCode).toBe(0); expect(descriptor()).toEqual({});
    expect(JSON.parse(fs.readFileSync(path.join(home, 'computer-use/settings.json'), 'utf8')).enabled).toBe(true);
  });
  it('keeps permission controls and reports a missing macOS Driver', async () => {
    const { controller } = setup({ binaryMissing: true });
    expect(await controller.initialize()).toMatchObject({ available: false, permissions: { accessibility: false, screenRecording: false } });
    await controller.stop();
  });
});
