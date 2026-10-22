import { describe, expect, it } from 'vitest';
import { findCatalogProviderById } from './catalogProviders';

describe('catalogProviders model lineups', () => {
  it('exposes the current Anthropic lineup without retired models', () => {
    const anthropic = findCatalogProviderById('anthropic');
    const ids = anthropic?.models.map((model) => model.id) ?? [];

    expect(ids).toContain('claude-fable-5-1');
    expect(ids).toContain('claude-opus-5-5');
    expect(ids).toContain('claude-sonnet-5-5');
    expect(ids).toContain('claude-haiku-5-5');
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-sonnet-4-5-20250929');
    expect(ids).not.toContain('claude-sonnet-4-20250514');
    expect(ids).not.toContain('claude-opus-4-20250514');
    expect(anthropic?.models.find((model) => model.id === 'claude-opus-5-5')?.maxContextTokens).toBe(1_000_000);
    expect(anthropic?.models.find((model) => model.id === 'claude-sonnet-4-5-20250929')?.maxOutputTokens).toBe(64_000);
    expect(anthropic?.models.find((model) => model.id === 'claude-haiku-4-5-20251001')?.maxOutputTokens).toBe(64_000);
  });

  it('exposes current OpenAI models and keeps Chat/Responses capabilities distinct', () => {
    const openai = findCatalogProviderById('openai');
    const responses = findCatalogProviderById('openai-responses');

    expect(openai?.models.find((model) => model.id === 'gpt-6-astra')?.maxOutputTokens).toBe(128_000);
    expect(openai?.models.find((model) => model.id === 'gpt-5.6-sol')?.maxContextTokens).toBe(1_050_000);
    expect(openai?.models.find((model) => model.id === 'gpt-4.1-mini')?.maxOutputTokens).toBe(32_768);
    expect(openai?.models.find((model) => model.id === 'o4-mini')?.maxOutputTokens).toBe(100_000);
    expect(openai?.models.some((model) => model.id === 'gpt-6.1-sol')).toBe(false);
    expect(openai?.models.some((model) => model.id === 'gpt-6-sol')).toBe(false);
    expect(responses?.models.find((model) => model.id === 'gpt-6.1-sol')?.maxOutputTokens).toBe(128_000);
    expect(responses?.models.some((model) => model.id === 'gpt-6-sol')).toBe(true);
    expect(responses?.models.some((model) => model.id === 'gpt-5.3-codex')).toBe(true);
  });

  it('exposes current Google models including Gemini 4', () => {
    const google = findCatalogProviderById('google');

    expect(google?.models[0]?.id).toBe('gemini-4-argon');
    expect(google?.models.find((model) => model.id === 'gemini-4-argon')?.maxContextTokens).toBe(1_048_576);
    expect(google?.models.some((model) => model.id === 'gemini-3.8-flash')).toBe(true);
    expect(google?.models.some((model) => model.id === 'gemini-3.1-flash-lite')).toBe(true);
    expect(google?.models.some((model) => model.id === 'gemini-2.0-flash')).toBe(false);
  });

  it('exposes current DeepSeek models and token limits', () => {
    const deepseek = findCatalogProviderById('deepseek');

    expect(deepseek?.models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-flash')?.maxOutputTokens).toBe(384 * 1024);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-flash')?.supportsImage).toBe(true);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-v4-pro')?.supportsImage).toBeUndefined();
  });

  it('exposes current DashScope, MiniMax, Kimi, Volc Ark and Zhipu lineups', () => {
    const dashscope = findCatalogProviderById('dashscope');
    const minimax = findCatalogProviderById('minimax');
    const moonshot = findCatalogProviderById('moonshot');
    const volc = findCatalogProviderById('volc_ark');
    const zhipu = findCatalogProviderById('zhipu');

    expect(dashscope?.models.map((model) => model.id)).toEqual([
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
    ]);
    expect(dashscope?.models.find((model) => model.id === 'qwen3.8-max')?.maxContextTokens).toBe(1_000_000);
    expect(dashscope?.models.find((model) => model.id === 'qwen3.8-flash')?.maxOutputTokens).toBe(131_072);

    expect(minimax?.models.map((model) => model.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    expect(minimax?.models[0]?.supportsImage).toBe(true);

    expect(moonshot?.models.map((model) => model.id)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);
    expect(moonshot?.models[0]?.maxOutputTokens).toBe(131_072);

    expect(volc?.models[0]?.id).toBe('doubao-seed-evolving');
    expect(volc?.models.some((model) => model.id === 'doubao-1.5-pro-256k')).toBe(false);

    expect(zhipu?.models.map((model) => model.id)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.2',
    ]);
    expect(zhipu?.models[0]?.maxContextTokens).toBe(1_048_576);
    expect(zhipu?.models[1]?.supportsImage).toBe(true);
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
