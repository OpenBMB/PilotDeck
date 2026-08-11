import { describe, expect, it } from 'vitest';
import { findCatalogProviderById } from './catalogProviders';

describe('catalogProviders maxOutputTokens', () => {
  it('exposes model output caps for settings placeholders', () => {
    const deepseek = findCatalogProviderById('deepseek');
    const openai = findCatalogProviderById('openai');

    expect(deepseek?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-v4-pro')?.maxOutputTokens).toBe(384 * 1024);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-v4-flash')?.maxOutputTokens).toBe(384 * 1024);
    expect(openai?.models.find((model) => model.id === 'gpt-4.1-mini')?.maxOutputTokens).toBe(32_768);
    expect(openai?.models.find((model) => model.id === 'o3-mini')?.maxOutputTokens).toBe(100_000);
  });

  it('exposes DashScope and Zhipu providers for settings', () => {
    const dashscope = findCatalogProviderById('dashscope');
    const zhipu = findCatalogProviderById('zhipu');

    expect(dashscope?.protocol).toBe('openai');
    expect(dashscope?.defaultUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(dashscope?.models.find((model) => model.id === 'qwen3.7-plus')?.supportsImage).toBe(true);
    expect(dashscope?.models.find((model) => model.id === 'qwen3.7-max')?.maxContextTokens).toBe(1_000_000);
    expect(dashscope?.models.find((model) => model.id === 'qwen3.6-flash')?.maxOutputTokens).toBe(65_536);
    expect(dashscope?.models.find((model) => model.id === 'qwen-max')?.maxOutputTokens).toBe(2_000);
    expect(dashscope?.models.find((model) => model.id === 'qwen-plus')?.maxContextTokens).toBe(131_072);
    expect(dashscope?.models.find((model) => model.id === 'qwen-turbo')?.maxOutputTokens).toBe(1_500);

    expect(zhipu?.protocol).toBe('openai');
    expect(zhipu?.defaultUrl).toBe('https://api.z.ai/api/paas/v4');
    expect(zhipu?.models.find((model) => model.id === 'glm-5.2')?.maxOutputTokens).toBe(131_072);
    expect(zhipu?.models.find((model) => model.id === 'glm-4.6')?.maxContextTokens).toBe(131_072);
    expect(zhipu?.models.find((model) => model.id === 'glm-4.7')?.maxContextTokens).toBe(200_000);
    expect(zhipu?.models.find((model) => model.id === 'glm-4-plus')?.maxOutputTokens).toBe(8_192);
    expect(zhipu?.models.find((model) => model.id === 'glm-4-flash-250414')?.maxContextTokens).toBe(128_000);
  });

  it('exposes Atlas Cloud as an OpenAI-compatible provider', () => {
    const atlasCloud = findCatalogProviderById('atlas_cloud');
    const qwen = atlasCloud?.models.find((model) => model.id === 'qwen/qwen3.8-max');

    expect(atlasCloud?.protocol).toBe('openai');
    expect(atlasCloud?.defaultUrl).toBe('https://api.atlascloud.ai/v1');
    expect(qwen?.supportsImage).toBe(true);
    expect(qwen?.maxContextTokens).toBe(1_000_000);
    expect(qwen?.maxOutputTokens).toBe(131_072);
  });

  it('exposes the current Kimi model catalog', () => {
    const moonshot = findCatalogProviderById('moonshot');

    expect(moonshot?.models.map((model) => model.id)).toEqual([
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k3',
    ]);
    expect(moonshot?.models[0]?.maxOutputTokens).toBe(8_192);
  });

  it('exposes Ollama as a no-api-key local provider', () => {
    const ollama = findCatalogProviderById('ollama');

    expect(ollama?.protocol).toBe('openai');
    expect(ollama?.defaultUrl).toBe('http://localhost:11434/v1');
    expect(ollama?.requiresApiKey).toBe(false);
    expect(ollama?.models.find((model) => model.id === 'qwen3:0.6b')?.maxContextTokens).toBe(40_960);
    expect(ollama?.models.find((model) => model.id === 'llama3.1:8b')?.maxOutputTokens).toBe(8_192);
  });
});
