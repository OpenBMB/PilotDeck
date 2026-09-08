import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForManagedEvent } from './process-test-helpers.mjs';
import { spawnManaged, stopProcessTree, listProcesses } from '../../../ui/server/utils/processTree.js';
const options = { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
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
  } finally { await stopProcessTree(child, { forceMs: 10000 }); child.stdout.destroy(); child.stderr.destroy(); }
});
