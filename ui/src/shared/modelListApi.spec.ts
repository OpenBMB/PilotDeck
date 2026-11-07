// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { fetchProviderModels } from './modelListApi';
import { CATALOG_PROVIDERS } from './catalogProviders';
import { lookupCatalogModel } from '../../../src/model/catalog/lookup.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
afterEach(() => vi.clearAllMocks());

it('preserves normalized and raw provider token metadata in the browser', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [
    { id: 'deepseek-flash', maxContextTokens: 1048576, maxOutputTokens: 393216 },
    { name: 'models/gemini', inputTokenLimit: 200000, outputTokenLimit: 64000 },
    { id: 'no-metadata' },
  ] }) });
  expect(await fetchProviderModels({ protocol: 'openai', baseUrl: 'https://example.test/v1' })).toEqual([
    { id: 'deepseek-flash', displayName: 'deepseek-flash', maxContextTokens: 1048576, maxOutputTokens: 393216 },
    { id: 'gemini', displayName: 'gemini', maxContextTokens: 200000, maxOutputTokens: 64000 },
    { id: 'no-metadata', displayName: 'no-metadata' },
  ]);
});

it('uses engine capabilities and aliases throughout the UI catalog', () => {
  for (const provider of CATALOG_PROVIDERS) {
    for (const model of provider.models) {
      const engine = lookupCatalogModel(provider.id, model.id).model!;
      expect(model.maxContextTokens).toBe(engine.capabilities.maxContextTokens);
      expect(model.maxOutputTokens).toBe(engine.capabilities.maxOutputTokens);
      expect(model.aliases).toEqual(engine.aliases);
    }
  }
  const deepseek = CATALOG_PROVIDERS.find(p => p.id === 'deepseek') as { models: Array<{ id: string }>; legacyModels?: Array<{ id: string }> } | undefined;
  expect([...(deepseek?.models ?? []), ...(deepseek?.legacyModels ?? [])].some(m => m.id === 'deepseek-chat')).toBe(true);
});
