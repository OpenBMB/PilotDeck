// @vitest-environment node
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { listProcesses, spawnManaged, stopProcessTree, runManagedCommand } from './processTree.js';
const KEY = Symbol.for('pilotdeck.processScope');
const id = (pid, birth = 'original', group = pid, parent = 1) => ({ pid, birth, group, parent });
const simulation = (entries, inspect, extra = {}) => ({ scope: {}, records: () => entries, inspect,
  closeScope: vi.fn(), cleanup: vi.fn(), signal: vi.fn(), graceMs: 1, forceMs: 1, ...extra });
function command(script, ipc = false) {
  const child = spawnManaged(process.execPath, ['-e', script], { stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', () => {}); return child;
}
async function cleanup(child) { await stopProcessTree(child, { graceMs: 20, forceMs: 1500 }).catch(() => {}); child.stdout?.destroy(); child.stderr?.destroy(); }

describe('managed process identities', () => {
  it.each(['darwin', 'win32'])('never signals a reused root PID on %s', async platform => {
    const options = simulation([{ state: 'active', identity: id(123) }], async () => [id(123, 'replacement', 999), id(124, 'unrelated', 999, 123)], { platform, taskkill: vi.fn() });
    await expect(stopProcessTree({ pid: 123, exitCode: 1 }, options)).rejects.toMatchObject({ reason: 'processStopFailed' });
    expect(options.signal).not.toHaveBeenCalled(); expect(options.taskkill).not.toHaveBeenCalled(); expect(options.cleanup).not.toHaveBeenCalled();
  });
  it('does not expand a reused descendant PID into an unrelated subtree', async () => {
    let living = [id(123), id(124, 'replacement', 999), id(125, 'unrelated', 999, 124)];
    const options = simulation([{ state: 'active', identity: id(123), members: [id(124, 'old', 123, 123)] }], async () => living);
    options.signal.mockImplementation(() => { living = living.filter(row => row.pid !== 123); });
    await expect(stopProcessTree({}, options)).rejects.toMatchObject({ reason: 'processStopFailed' }); expect(options.signal.mock.calls).toEqual([[-123, 'SIGTERM']]);
  });
  it('rechecks identity immediately before signalling', async () => {
    let calls = 0;
    const options = simulation([{ state: 'active', identity: id(123) }], async () => [++calls < 3 ? id(123) : id(123, 'reused', 999)]);
    await expect(stopProcessTree({}, options)).rejects.toMatchObject({ reason: 'processStopFailed' }); expect(options.signal).not.toHaveBeenCalled();
  });
  it('refuses an unregistered ChildProcess', async () => {
    const signal = vi.fn();
    await expect(stopProcessTree({ pid: 123, exitCode: 0 }, { signal })).rejects.toMatchObject({ reason: 'processStopFailed' });
    expect(signal).not.toHaveBeenCalled();
  });
  it('bounds an interrupted launch and retains its registry', async () => {
    const options = simulation([{ state: 'pending' }], async () => []);
    await expect(stopProcessTree({}, options)).rejects.toMatchObject({ reason: 'processStopFailed' }); expect(options.cleanup).not.toHaveBeenCalled();
  });
  it('does not signal when process inspection fails', async () => {
    const options = simulation([], async () => { throw new Error('ps failed'); });
    await expect(stopProcessTree({}, options)).rejects.toMatchObject({ reason: 'processStopFailed' }); expect(options.signal).not.toHaveBeenCalled();
  });
  it('refuses Windows cleanup without an established Job', async () => {
    const original = { pid: 123, parent: 1, birth: 'original' };
    await expect(stopProcessTree({}, simulation([{ state: 'active', identity: original }], async () => [original], { platform: 'win32' })))
      .rejects.toMatchObject({ reason: 'processStopFailed' });
  });
  it('waits for the original Windows Job holder after native termination', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-job-test-'));
    try {
      const stopped = path.join(directory, 'stopped'); writeFileSync(stopped, 'stopped');
      const options = simulation([{ parent: null, state: 'active', identity: id(123), job: { stopped, holderIdentity: id(456) } }], async () => [id(456)], { platform: 'win32' });
      await expect(stopProcessTree({}, options)).rejects.toMatchObject({ reason: 'processStopFailed' });
      expect(options.signal).not.toHaveBeenCalled(); expect(options.cleanup).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('accepts native Job termination without touching a reused holder PID', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-job-test-'));
    try {
      const stopped = path.join(directory, 'stopped'); writeFileSync(stopped, 'stopped');
      const options = simulation([{ parent: null, state: 'active', identity: id(123), job: { stopped, holderIdentity: id(456) } }], async () => [id(456, 'replacement')], { platform: 'win32' });
      await stopProcessTree({}, options);
      expect(options.signal).not.toHaveBeenCalled(); expect(options.cleanup).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform === 'win32')('real supervised lifetimes', () => {
  it.each([0, 300])('cleans inherited-group orphans when the command exits after %s ms', async delay => {
    const child = command(`const c=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});c.unref();setTimeout(()=>process.exit(2),${delay})`);
    try {
      const exited = once(child, 'managed-exit'); const [data] = await once(child.stdout, 'data');
      const orphan = Number(data.toString().trim()); await exited;
      expect((await listProcesses()).some(row => row.pid === orphan)).toBe(true);
      await stopProcessTree(child, { graceMs: 50, forceMs: 1500 });
      expect((await listProcesses()).some(row => row.pid === orphan && !row.zombie)).toBe(false);
      expect(existsSync(child[KEY].directory)).toBe(false);
    } finally { await cleanup(child); }
  }, 10000);
  it('preserves IPC through the guardian', async () => {
    const child = command(`process.on('message', message=>process.send({echo:message}));`, true);
    try { const response = once(child, 'message'); child.send('hello'); expect((await response)[0]).toEqual({ echo: 'hello' }); }
    finally { await cleanup(child); }
  });
  it('cancels one child without stopping its sibling or parent', async () => {
    const child = command(`const {spawn}=require('node:child_process');const a=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);process.on('message',()=>{a.once('exit',()=>process.send({alive:b.exitCode===null}));a.kill()});process.send('ready');`, true);
    try { await once(child, 'message'); const result = once(child, 'message'); child.send('cancel'); expect((await result)[0]).toEqual({ alive: true }); expect(child.exitCode).toBeNull(); }
    finally { await cleanup(child); }
  }, 10000);
  it('times out even if tasks in its managed group hold stdout open', async () => {
    let orphan;
    await expect(runManagedCommand(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`], { timeoutMs: 1000, progress: value => { orphan = Number(value.trim()); } }))
      .rejects.toMatchObject({ reason: 'buildTimedOut' });
    expect(orphan).toBeGreaterThan(0); expect((await listProcesses()).some(row => row.pid === orphan && !row.zombie)).toBe(false);
  }, 10000);
  it('preserves successful command output and completion', async () => {
    let text = ''; await runManagedCommand(process.execPath, ['-e', 'console.log("done")'], { progress: chunk => { text += chunk; } }); expect(text.trim()).toBe('done');
  });
});
