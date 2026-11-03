import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { waitForManagedEvent } from './process-test-helpers.mjs';
import { spawnManaged, stopProcessTree, listProcesses } from '../../../ui/server/utils/processTree.js';
const require = createRequire(import.meta.url);
const { copyDesktopFixtureDependencies } = require('./desktop-fixture-dependencies.cjs');
const options = { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
test('Windows Job supervisor survives guardian termination and certifies descendant cleanup', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const child = spawnManaged(process.execPath, ['-e', 'process.send(process.pid);setInterval(()=>{},1000)'], options);
  child.stderr.on('data', data => process.stderr.write(data));
  const scope = child[Symbol.for('pilotdeck.processScope')];
  try {
    const [pid] = await waitForManagedEvent(child, child, 'message');
    const { job } = JSON.parse(readFileSync(scope.file, 'utf8'));
    assert.ok(job?.holderIdentity, 'supervisor identity established before launching the command');
    // The external holder must outlive an abruptly killed guardian. Without
    // detached spawning, libuv kills the holder along with its parent.
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    child.kill('SIGKILL');
    await exited;
    const deadline = Date.now() + 15000;
    while (!existsSync(job.stopped) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(job.stopped), 'surviving supervisor certifies the empty Job after guardian death');
    await stopProcessTree(child, { forceMs: 10000 });
    assert.equal((await listProcesses()).some(row => row.pid === pid), false, 'business process is gone');
    assert.equal(existsSync(scope.directory), false, 'certified cleanup removes the ownership registry');
  } finally { await stopProcessTree(child, { forceMs: 10000 }).catch(() => {}); child.stdout.destroy(); child.stderr.destroy(); }
});
test('supervised runtime forwards IPC and stops its managed group', { timeout: 120000 }, async () => {
  const child = spawnManaged(process.execPath, ['-e', `const {spawn}=require('node:child_process');const task=spawn(process.execPath,['-e','process.send(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe','ipc']});task.on('message',pid=>process.send(pid));setInterval(()=>{},1000)`], options);
  child.stderr.on('data', data => process.stderr.write(data));
  try {
    const [pid] = await waitForManagedEvent(child, child, 'message');
    assert.ok(Number.isInteger(pid));
    await stopProcessTree(child, { forceMs: 10000 });
    assert.equal((await listProcesses()).some(row => row.pid === pid && !row.zombie), false);
  } finally { await stopProcessTree(child, { forceMs: 10000 }).catch(() => {}); child.stdout.destroy(); child.stderr.destroy(); }
});
test('command exit is reported before inherited-group cleanup', { timeout: 120000 }, async () => {
  const child = spawnManaged(process.execPath, ['-e', `const {spawn}=require('node:child_process');const task=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','pipe','inherit']});task.stdout.on('data',data=>{process.stdout.write(data);setTimeout(()=>process.exit(2),100)});task.unref()`], options);
  child.stderr.on('data', data => process.stderr.write(data));
  try {
    const [data] = await waitForManagedEvent(child, child.stdout, 'data');
    const pid = Number(data.toString().trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await waitForManagedEvent(child, child, 'managed-exit');
    await stopProcessTree(child, { forceMs: 10000 });
    assert.equal((await listProcesses()).some(row => row.pid === pid && !row.zombie), false);
  } finally { await stopProcessTree(child, { forceMs: 10000 }).catch(() => {}); child.stdout.destroy(); child.stderr.destroy(); }
});

test('business background launches and cancellation keep native command semantics', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const runnerUrl = new URL('../../../src/tool/builtin/bash/commandRunner.ts', import.meta.url).href;
  const script = `import {NodeShellCommandRunner} from ${JSON.stringify(runnerUrl)};
    const runner=new NodeShellCommandRunner();
    const background=await runner.run('sleep 2 >/dev/null 2>&1 & echo launched',{cwd:process.cwd(),timeoutMs:500});
    const cancel=new AbortController();
    const first=runner.run('sleep 10',{cwd:process.cwd(),timeoutMs:5000,signal:cancel.signal});
    const second=runner.run('sleep 0.3; echo sibling',{cwd:process.cwd(),timeoutMs:5000});
    setTimeout(()=>cancel.abort(),50);
    await first; console.log(JSON.stringify({background,sibling:await second}));`;
  const child=spawnManaged(process.execPath,['--import','tsx','--input-type=module','-e',script],options);
  child.stderr.on('data',data=>process.stderr.write(data));
  try {
    const [data]=await waitForManagedEvent(child, child.stdout, 'data');
    const result=JSON.parse(data.toString());
    assert.equal(result.background.timedOut,false);
    assert.equal(result.background.exitCode,0);
    assert.equal(result.background.stdout.trim(),'launched');
    assert.ok(result.background.durationMs<500);
    assert.equal(result.sibling.stdout.trim(),'sibling');
    assert.equal(result.sibling.exitCode,0);
  } finally { await stopProcessTree(child,{forceMs:10000});child.stdout.destroy();child.stderr.destroy(); }
});

// This must fail promptly on the real failure, including on Windows bootstrap.
test('a failed command reports its failure instead of waiting indefinitely for IPC', { timeout: 120000 }, async () => {
  const child = spawnManaged('pilotdeck-nonexistent-test-command', [], options);
  try {
    await assert.rejects(waitForManagedEvent(child, child, 'message'), /exited before message|startup failed/);
  } finally {
    try { await stopProcessTree(child, { forceMs: 10000 }); }
    catch (error) {
      const scope = child[Symbol.for('pilotdeck.processScope')];
      if (existsSync(scope.file)) console.error('Failed-command ownership record:', readFileSync(scope.file, 'utf8'));
      throw error;
    } finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
});

for (const native of [false, true]) test(`packaged process startup with PowerShell denied (native=${native})`, {
  skip: process.platform !== 'win32', timeout: 60_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-no-powershell-'));
  try {
    const runtime = path.join(root, 'desktop runtime');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
    copyDesktopFixtureDependencies(root, runtime);
    if (native) {
      const prepare = spawnSync(process.execPath, ['-e',
        "process.stdout.write(require('./ui/server/utils/nativeProcessHost.cjs').nativeProcessHost() || '')"], {
        cwd: runtime, windowsHide: true, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PILOT_HOME: path.join(root, 'build-profile'), PILOTDECK_NATIVE_PROCESS_HOST: '1' },
      });
      assert.equal(prepare.status, 0, prepare.error?.message || prepare.stderr);
      const helper = prepare.stdout.trim();
      assert.ok(helper, 'prepare the native payload before blocking the compiler');
      fs.copyFileSync(helper, path.join(runtime, 'ui/server/utils', path.basename(helper)));
    }
    const events = path.join(root, 'denied-launches.log');
    const guard = path.join(root, 'deny-powershell.cjs');
    fs.writeFileSync(guard, `
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
for(const name of ['spawn','spawnSync','execFile','execFileSync']) {
  const original=cp[name];
  cp[name]=function(command,...args) {
    if(/^(?:powershell|pwsh|csc)(?:\\.exe)?$/i.test(path.basename(String(command)))) {
      fs.appendFileSync(${JSON.stringify(events)},name+' '+path.basename(String(command))+'\\n');
      throw Object.assign(new Error('spawn '+command+' EPERM'),{code:'EPERM',syscall:'spawn'});
    }
    return Reflect.apply(original,this,[command,...args]);
  };
}
`);
    const driver = path.join(runtime, 'smoke.mjs');
    const waitHelper = fileURLToPath(new URL('./process-test-helpers.mjs', import.meta.url));
    fs.copyFileSync(waitHelper, path.join(runtime, 'wait.mjs'));
    const marker = path.join(root, 'business-command-ran');
    fs.writeFileSync(driver, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnManaged,stopProcessTree,listProcesses} from './ui/server/utils/processTree.js';
import {waitForManagedEvent} from './wait.mjs';
const script=${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'started');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({pid:process.pid,descendant:child.pid});setInterval(()=>{},1000);`)};
const child=spawnManaged(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe','ipc']});
const scope=child[Symbol.for('pilotdeck.processScope')];
child.stderr.on('data',data=>process.stderr.write(data));
try {
  if(${native}) {
    const [message]=await waitForManagedEvent(child,child,'message',15000);
    assert.equal(fs.existsSync(${JSON.stringify(marker)}),true);
    const before=await listProcesses();
    for(const pid of [message.pid,message.descendant]) assert.ok(before.some(row=>row.pid===pid));
    await stopProcessTree(child,{graceMs:1000,forceMs:5000});
    const after=await listProcesses();
    for(const pid of [message.pid,message.descendant]) assert.ok(!after.some(row=>row.pid===pid));
  } else {
    await assert.rejects(waitForManagedEvent(child,child,'message',15000),/PowerShell fallback.*EPERM/);
    assert.equal(fs.existsSync(${JSON.stringify(marker)}),false,'identity failure cannot start the business command');
    await stopProcessTree(child,{graceMs:1000,forceMs:5000});
  }
  assert.equal(fs.existsSync(scope.directory),false,'all owned startup state is cleaned up');
} finally {
  await stopProcessTree(child,{graceMs:1000,forceMs:5000}).catch(()=>{});
  child.stdout.destroy();child.stderr.destroy();
}
`);
    const result = spawnSync(process.execPath, [driver], {
      cwd: runtime, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PILOT_HOME: path.join(root, 'profile'), PILOTDECK_NATIVE_PROCESS_HOST: native ? '1' : '0',
        NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    if (native) {
      assert.equal(fs.existsSync(events), false, 'packaged startup and cleanup never launch PowerShell or a compiler');
      assert.equal(fs.existsSync(path.join(root, 'profile/cache/native')), false, 'the packaged helper is used directly');
    } else {
      assert.match(fs.readFileSync(events, 'utf8'), /execFileSync powershell\.exe/i, 'the positive control reproduces the reported failure');
    }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
