import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import identities from '../../../ui/server/utils/processIdentity.cjs';
import { waitForManagedEvent } from './process-test-helpers.mjs';

test('Windows startup queries only requested PIDs without CIM enumeration', () => {
  const result = identities.windowsProcesses([123,456,123], (_command,args,options) => {
    assert.match(args.at(-1), /@\(123,456\)/);
    assert.match(args.at(-1), /GetProcessById/);
    assert.doesNotMatch(args.at(-1), /Get-CimInstance|GetProcesses\(\)/);
    assert.equal(options.timeout, 15000);
    return '[{"ProcessId":123,"Birth":"2026-09-07T12:34:56.1234567Z"}]';
  });
  assert.deepEqual(result,[{pid:123,birth:'2026-09-07T12:34:56.1234567Z'}]);
});
test('Windows query timeout is explicit and never fabricates ownership', () => {
  assert.throws(()=>identities.windowsProcesses([123],()=>{throw Object.assign(new Error('spawn timed out'),{code:'ETIMEDOUT'});}), {code:'ETIMEDOUT',message:'Windows process identity query timed out after 15000 ms'});
});
test('invalid PID and missing creation time fail closed', () => {
  assert.throws(()=>identities.windowsProcesses(['1;exit']),/Invalid process identity PID/);
  assert.throws(()=>identities.windowsProcesses([123],()=>'{"ProcessId":123}'),/Missing process creation identity/);
});
test('Windows absence is distinct from an unidentifiable process', () => {
  assert.deepEqual(identities.windowsProcesses([123],()=> '[]'),[]);
  assert.deepEqual(identities.windowsProcesses([],()=>{throw new Error('must not start PowerShell');}),[]);
});
test('waiting for IPC rejects on bootstrap failure and removes listeners', async () => {
  const child=new EventEmitter();child.exitCode=null;child.stderr=new EventEmitter();
  const result=waitForManagedEvent(child,child,'message',1000);
  child.emit('managed-exit',1,null,'Managed process startup failed: identity query timed out');
  await assert.rejects(result,/identity query timed out/);
  assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('message'),0);
});
test('unexpected guardian exit fails an IPC wait without event-loop cancellation', async () => {
  const child=new EventEmitter();child.exitCode=null;child.stderr=new EventEmitter();
  const result=waitForManagedEvent(child,child,'message',1000);
  child.stderr.emit('data',Buffer.from('PowerShell could not start'));
  child.emit('exit',1,null);
  await assert.rejects(result,/PowerShell could not start/);
});
