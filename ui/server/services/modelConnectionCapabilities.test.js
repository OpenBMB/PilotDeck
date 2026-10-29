import { describe, expect, it } from 'vitest';
import { resolveCatalogImageSupport } from './modelConnectionCapabilities.js';

const official = { providerId: 'deepseek', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1', modelId: 'deepseek-v4-pro' };

describe('connection-test catalog capability scope', () => {
  it.each([
    ['root', 'https://api.deepseek.com'],
    ['versioned', 'https://api.deepseek.com/v1/'],
    ['full endpoint', 'https://api.deepseek.com/v1/chat/completions'],
    ['URL normalization', 'https://API.DEEPSEEK.COM:443/v1'],
  ])('recognizes the official %s endpoint', (_label, endpoint) => {
    expect(resolveCatalogImageSupport({ ...official, endpoint })).toBe(false);
  });

  it.each([
    { providerId: 'my-provider' },
    { providerId: 'openai', endpoint: 'https://api.openai.com/v1' },
    { endpoint: 'https://proxy.example/v1' },
    { endpoint: 'https://api.deepseek.com/proxy/v1' },
    { endpoint: 'http://api.deepseek.com/v1' },
    { endpoint: 'https://api.deepseek.com:8443/v1' },
    { endpoint: 'https://api.deepseek.com/v1?deployment=other' },
    { endpoint: 'https://user@api.deepseek.com/v1' },
    { endpoint: 'invalid' },
    { protocol: 'anthropic' },
    { modelId: 'unknown-model' },
    { modelId: 'openai/gpt-4.1' },
  ])('leaves capabilities unknown outside the official scope: %j', (override) => {
    expect(resolveCatalogImageSupport({ ...official, ...override })).toBeNull();
  });

  it('recognizes catalog aliases within the same provider', () => {
    expect(resolveCatalogImageSupport({ ...official, providerId: ' DeepSeek ', modelId: 'deepseek-v3' })).toBe(false);
    expect(resolveCatalogImageSupport({ providerId: 'bailian', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-turbo-latest' })).toBe(false);
  });

  it('returns known vision support and leaves models without catalog entries unknown', () => {
    expect(resolveCatalogImageSupport({ providerId: 'openai', protocol: 'openai', endpoint: 'https://api.openai.com/v1', modelId: 'gpt-4.1' })).toBe(true);
    expect(resolveCatalogImageSupport({ providerId: 'openrouter', protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1', modelId: 'deepseek/deepseek-v4-pro' })).toBeNull();
  });
});
