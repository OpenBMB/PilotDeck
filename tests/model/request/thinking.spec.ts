import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelConfig } from '../../../src/model/config/parseModelConfig.js';
import { buildModelRequest } from '../../../src/model/request/buildModelRequest.js';
import type { CanonicalThinkingConfig, ModelProtocol } from '../../../src/model/protocol/canonical.js';
import { THINKING_EFFORTS, type ModelThinkingSettings } from '../../../src/model/thinking/settings.js';

function body(protocol: ModelProtocol, state: ModelThinkingSettings['state'] | undefined, format: ModelThinkingSettings['format'] = 'provider', effort?: CanonicalThinkingConfig['mode'], provider = 'custom', model = 'test-model', efforts: readonly string[] = THINKING_EFFORTS) {
  const config = parseModelConfig({ providers: { [provider]: { protocol, url: 'https://example.test/v1', apiKey: 'test', models: {
    [model]: state ? { thinking: { state, format, efforts } } : {},
  } } } });
  return JSON.parse(JSON.stringify(buildModelRequest({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], thinking: { enabled: true, mode: effort } }, config)));
}
const controls = ['thinking', 'reasoning', 'reasoning_effort', 'enable_thinking', 'chat_template_kwargs', 'output_config', 'thinking_budget', 'budget_tokens'];
for (const protocol of ['openai', 'openai-responses', 'anthropic', 'google'] as const) {
  test(`${protocol}: missing/default state ignores legacy request effort and emits no controls`, () => {
    for (const state of [undefined, 'default'] as const) {
      const actual = body(protocol, state, 'provider', 'high');
      for (const field of controls) assert.equal(actual[field], undefined, field);
      assert.equal(actual.config?.thinkingConfig, undefined);
    }
  });
}
test('OpenAI custom GPT/Claude proxies use top-level effort and preserve max exactly', () => {
  for (const model of ['gpt-5.6-sol', 'claude-opus-5', 'qwen3.8-27b']) {
    const actual = body('openai', 'enabled', 'provider', 'max', 'aicore', model);
    assert.equal(actual.reasoning_effort, 'max');
    assert.equal(actual.reasoning, undefined);
    assert.equal(actual.enable_thinking, undefined);
    assert.equal(actual.thinking_budget, undefined);
  }
  assert.equal(body('openai', 'enabled').reasoning_effort, undefined);
  assert.equal(body('openai', 'disabled', 'openai', 'high').reasoning_effort, 'none');
});
test('Responses uses nested effort including off, with no fallback budget', () => {
  assert.deepEqual(body('openai-responses', 'enabled', 'provider', 'max').reasoning, { effort: 'max' });
  assert.deepEqual(body('openai-responses', 'disabled', 'provider', 'high').reasoning, { effort: 'none' });
  assert.equal(body('openai-responses', 'enabled').reasoning, undefined);
});
for (const [format, expectedOn, expectedOff] of [
  ['qwen-cloud', { enable_thinking: true }, { enable_thinking: false }],
  ['qwen-local', { chat_template_kwargs: { enable_thinking: true } }, { chat_template_kwargs: { enable_thinking: false } }],
  ['thinking-type', { thinking: { type: 'enabled' } }, { thinking: { type: 'disabled' } }],
] as const) {
  test(`${format}: separates on/default, effort and off without budget conversion`, () => {
    for (const [state, patch] of [['enabled', expectedOn], ['disabled', expectedOff]] as const) {
      const actual = body('openai', state, format, 'xhigh');
      for (const [key, value] of Object.entries(patch)) assert.deepEqual(actual[key], value);
      assert.equal(actual.reasoning_effort, state === 'enabled' ? 'xhigh' : undefined);
      assert.equal(actual.thinking_budget, undefined);
    }
    assert.equal(body('openai', 'enabled', format).reasoning_effort, undefined);
  });
}
test('official endpoint presets and mixed custom models stay separate', () => {
  assert.equal(body('openai', 'enabled', 'provider', 'low', 'dashscope').enable_thinking, true);
  for (const provider of ['deepseek', 'moonshot', 'zhipu']) assert.deepEqual(body('openai', 'enabled', 'provider', 'low', provider).thinking, { type: 'enabled' });
  assert.deepEqual(body('openai', 'enabled', 'provider', 'low', 'openrouter').reasoning, { enabled: true, effort: 'low' });
  assert.deepEqual(body('openai', 'disabled', 'provider', 'high', 'openrouter').reasoning, { enabled: false });
  for (const provider of ['ollama', 'minimax', 'volc_ark']) assert.equal(body('openai', 'enabled', 'provider', undefined, provider).reasoning_effort, undefined);
});
test('Claude adaptive uses output effort; disabling explicitly sends disabled', () => {
  const actual = body('anthropic', 'enabled', 'provider', 'max', 'anthropic', 'claude-opus-5');
  assert.deepEqual(actual.thinking, { type: 'adaptive' });
  assert.deepEqual(actual.output_config, { effort: 'max' });
  assert.deepEqual(body('anthropic', 'disabled', 'provider', 'high').thinking, { type: 'disabled' });
  assert.equal(body('anthropic', 'disabled', 'provider', 'high').output_config, undefined);
  assert.equal(body('anthropic', 'enabled', 'provider', undefined, 'anthropic', 'claude-sonnet-4-20250514').thinking, undefined);
  assert.throws(() => body('anthropic', 'enabled', 'provider', 'high', 'anthropic', 'claude-sonnet-4-20250514'), /budget/);
});
test('Gemini 3 sends thinkingLevel exactly; budget-only and off requests are explicit', () => {
  const actual = body('google', 'enabled', 'provider', 'high', 'google', 'gemini-3.1-pro-preview');
  assert.deepEqual(actual.config.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
  assert.equal(body('google', 'enabled', 'provider', undefined, 'google', 'gemini-2.5-flash').config.thinkingConfig, undefined);
  assert.throws(() => body('google', 'enabled', 'provider', 'xhigh', 'google', 'gemini-3.1-pro-preview'), /xhigh/);
  assert.throws(() => body('google', 'disabled'), /Turning off thinking/);
});
test('always-thinking native models reject off locally and send effort without a switch', () => {
  for (const [provider, model] of [['moonshot', 'kimi-k3'], ['zhipu', 'glm-5.3']]) {
    assert.throws(() => body('openai', 'disabled', 'provider', undefined, provider, model), /cannot disable/);
    const actual = body('openai', 'enabled', 'provider', 'max', provider, model);
    assert.equal(actual.reasoning_effort, 'max');
    assert.equal(actual.thinking, undefined);
  }
});
test('unconfigured efforts are rejected; legacy off/minimal cannot override model state', () => {
  assert.throws(() => body('openai', 'enabled', 'openai', 'high', 'custom', 'test', ['low']), /not configured/);
  for (const mode of ['off', 'minimal'] as const) assert.equal(body('openai', 'enabled', 'qwen-cloud', mode).enable_thinking, true);
});
test('config rejects invalid states, levels and mismatched native formats', () => {
  for (const thinking of [{ state: 'invalid' }, { efforts: ['ultra'] }, { efforts: 'high' }, { format: 'google' }]) {
    assert.throws(() => parseModelConfig({ providers: { custom: { protocol: 'openai', url: 'https://example.test', apiKey: 'test', models: { test: { thinking } } } } }));
  }
});
