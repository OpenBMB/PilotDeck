import { PROVIDER_CATALOG } from '../../../src/model/catalog/providers.js';
import { catalogProviders } from '../../../src/model/catalog/view.js';
import type { CatalogProvider } from '../../../src/model/catalog/view.js';
export type { CatalogModel, CatalogProvider } from '../../../src/model/catalog/view.js';
export type CatalogProviderProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'google';
export type ModelTokenLimits = { maxContextTokens: number; maxOutputTokens: number };

export const DEFAULT_MODEL_TOKEN_LIMITS: Record<CatalogProviderProtocol, ModelTokenLimits> = {
  anthropic: { maxContextTokens: 200_000, maxOutputTokens: 32_768 },
  openai: { maxContextTokens: 128_000, maxOutputTokens: 32_768 },
  'openai-responses': { maxContextTokens: 128_000, maxOutputTokens: 32_768 },
  google: { maxContextTokens: 1_048_576, maxOutputTokens: 32_768 },
};

export const CATALOG_PROVIDERS = catalogProviders(PROVIDER_CATALOG);
let snapshot = CATALOG_PROVIDERS;
const listeners = new Set<() => void>();
export function getCatalogProviders(): CatalogProvider[] { return snapshot; }
export function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function replaceCatalogProviders(providers: CatalogProvider[]): void {
  snapshot = providers;
  for (const listener of listeners) listener();
}
export function findCatalogProviderById(id: string): CatalogProvider | undefined {
  return snapshot.find(p => p.id === id);
}
export function findCatalogProviderByUrl(url: string, protocol?: CatalogProviderProtocol): CatalogProvider | undefined {
  return snapshot.find(p => p.defaultUrl.replace(/\/+$/, '') === url.replace(/\/+$/, '') && (!protocol || p.protocol === protocol));
}
