import type { CatalogProvider } from '../../../shared/catalogProviders';
import { MASKED_SECRET, PLACEHOLDER_API_KEY } from './constants';

export function modelIdsForProvider(provider: CatalogProvider | null) {
  const ids = provider?.models.map((model) => model.id).filter(Boolean) ?? [];
  return ids.length > 0 ? ids : [''];
}

export function uniqueModelIds(modelIds: string[]) {
  return [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
}

export function catalogKnowsModel(provider: CatalogProvider | null, modelId: string) {
  const id = modelId.trim();
  if (!provider || !id) return false;
  return provider.models.some((model) => model.id === id || model.aliases?.includes(id));
}

export function unknownImageProbeCount(provider: CatalogProvider | null, modelIds: string[]) {
  return uniqueModelIds(modelIds).filter((id) => !catalogKnowsModel(provider, id)).length;
}

export function hasUsableApiKey(value: unknown) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return Boolean(key) && key !== PLACEHOLDER_API_KEY && key !== MASKED_SECRET && !key.startsWith('PLACEHOLDER_');
}

export function requiresApiKey(provider: CatalogProvider | null) {
  return provider?.requiresApiKey !== false;
}

export function providerIdFromEndpoint(url: string) {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug && slug !== 'custom') return slug.slice(0, 64);
  } catch {
    /* ignore invalid URL */
  }
  return 'custom-provider';
}
