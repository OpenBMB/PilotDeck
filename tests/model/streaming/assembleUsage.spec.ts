import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelEventToAssembler, assembleAssistantMessage, createModelMessageAssemblerState } from '../../../src/model/streaming/assembleModelMessage.js';

test('usage snapshots preserve omitted and undefined fields and replace explicit zeroes', () => {
  const state = createModelMessageAssemblerState();
  assert.equal(assembleAssistantMessage(state).usage, undefined);
  applyModelEventToAssembler(state, { type: 'usage', usage: {
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135,
  } });
  applyModelEventToAssembler(state, { type: 'usage', usage: {
    inputTokens: 0, outputTokens: undefined, cacheReadTokens: 0, totalTokens: 0,
  } });
  assert.deepEqual(assembleAssistantMessage(state).usage, {
    inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5, totalTokens: 0,
  });
  applyModelEventToAssembler(state, { type: 'usage', usage: { outputTokens: 0, cacheWriteTokens: 0 } });
  assert.deepEqual(assembleAssistantMessage(state).usage, {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
  });
});

test('request boundaries retain prior totals and do not leak fields into a new snapshot', () => {
  const state = createModelMessageAssemblerState();
  // Streams without a request_started event still form one usage snapshot.
  applyModelEventToAssembler(state, { type: 'usage', usage: {
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135,
  } });
  applyModelEventToAssembler(state, { type: 'request_started', provider: 'test', model: 'model' });
  applyModelEventToAssembler(state, { type: 'request_started', provider: 'test', model: 'model' });
  applyModelEventToAssembler(state, { type: 'usage', usage: { outputTokens: 3 } });
  applyModelEventToAssembler(state, { type: 'usage', usage: { outputTokens: 0, cacheReadTokens: 2 } });
  const expected = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 22, cacheWriteTokens: 5, totalTokens: 135 };
  assert.deepEqual(assembleAssistantMessage(state).usage, expected);
  assert.deepEqual(assembleAssistantMessage(state).usage, expected);
  applyModelEventToAssembler(state, { type: 'request_started', provider: 'test', model: 'model' });
  assert.deepEqual(assembleAssistantMessage(state).usage, expected);
});
