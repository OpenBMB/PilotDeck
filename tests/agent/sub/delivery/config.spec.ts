import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryConfig } from '../../../../src/agent/sub/delivery/config.js';
test('SDK configuration rejects invalid modes and budgets before running', () => {
  for (const value of [{mode:'always'}, {maxRepairs:-1}, {maxTurns:0}, {reviewTimeoutMs:1}, {maxReviewInputTokens:255}, {maxReviewOutputTokens:Infinity}, {reviewerModel:{provider:'',model:'a'}}, {prompt:1}]) {
    assert.throws(() => deliveryConfig(value as never));
  }
  assert.equal(deliveryConfig().mode, 'auto');
  assert.equal(deliveryConfig({mode:'off',prompt:''}).prompt, '');
});
