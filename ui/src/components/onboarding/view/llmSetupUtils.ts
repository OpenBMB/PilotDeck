import type { CatalogProvider } from '../../../shared/catalogProviders';
import { MASKED_SECRET, PLACEHOLDER_API_KEY } from './constants';

export function defaultModelForProvider(provider: CatalogProvider | null) {
  if (!provider) return '';
  return provider.models.find((model) => model.id === 'deepseek/deepseek-v4-flash')?.id
    ?? provider.models[0]?.id
    ?? '';
}

export function hasUsableApiKey(value: unknown) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return Boolean(key) && key !== PLACEHOLDER_API_KEY && key !== MASKED_SECRET && !key.startsWith('PLACEHOLDER_');
}

export function requiresApiKey(provider: CatalogProvider | null) {
  return provider?.requiresApiKey !== false;
}
