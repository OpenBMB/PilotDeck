import assert from 'node:assert/strict';
import test from 'node:test';
import { extractText, grade } from './grade.js';

test('grader executes legal named plus default ESM exports', () => {
  const result=grade({id:'code-merge',output:'merge.mjs'}, {'merge.mjs':'export function mergeIntervals(xs){return xs;} export default mergeIntervals;'},'');
  assert.equal(result.checks.empty,true);
  assert.equal(result.checks.immutable,true);
  assert.equal(result.checks.merge,false); // execution works; incorrect business behavior still fails
  assert.equal(result.usable,false);
});
test('grader extracts the business result from legacy reporting wrappers', () => {
  assert.equal(extractText('Scope: support\nResult:\nHello, here is the reply.\nKey files: policy.md\nIssues: none'),'Hello, here is the reply.');
});
test('consecutive minutes is accepted without weakening other runbook requirements', () => {
  const result=grade({id:'text-runbook',output:'runbook.md'},{'runbook.md':'1. Check impact.\n2. Check deployment.\n3. Roll back with incident commander approval.\n4. Suspected data loss: stop recovery, preserve evidence, escalate to storage. Verify <0.5% for 10 consecutive minutes.\n5. Document follow-up.'},'');
  assert.equal(result.usable,true);
  assert.equal(grade({id:'text-runbook',output:'runbook.md'},{'runbook.md':'0.5% for 10 consecutive minutes'},'').usable,false);
});
