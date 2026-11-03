import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { inlineJson } from './inline-json.mjs';

test('inline JSON preserves paths and blocks mixed-case closing script payloads', () => {
  const value = 'C:\\logs\\</ScRiPt><script>throw new Error("injected")</script>\\runtime.log';
  const serialized = inlineJson(value);
  assert.equal(serialized.includes('<'), false);
  assert.equal(runInNewContext(`(${serialized})`), value);
});
