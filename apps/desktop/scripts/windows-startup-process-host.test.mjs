import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { copyDesktopFixtureDependencies } = require('./desktop-fixture-dependencies.cjs');

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
