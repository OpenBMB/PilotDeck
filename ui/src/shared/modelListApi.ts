import { authenticatedFetch } from '../utils/api';
import { findCatalogProviderById, type CatalogModel, type CatalogProviderProtocol } from './catalogProviders';
import { refreshModelCatalog } from './useModelCatalog';

export type ApiModelListItem = CatalogModel;

function normalizeModelListItem(model: unknown): ApiModelListItem | null {
  if (!model || typeof model !== 'object') return null;
  const record = model as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim()
    : typeof record.name === 'string' ? record.name.replace(/^models\//, '').trim() : '';
  if (!id) return null;
  const displayName = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim() : typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name.trim() : id;
  return { id, displayName };
}

function normalizeModelList(models: unknown[]): ApiModelListItem[] {
  const seen = new Set<string>();
  return models.flatMap(model => {
    const item = normalizeModelListItem(model);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
}

export async function fetchRemoteDefaultModels(providerId: string): Promise<ApiModelListItem[]> {
  await refreshModelCatalog();
  return findCatalogProviderById(providerId)?.models ?? [];
}

export async function fetchProviderModels({ protocol, baseUrl, apiKey, providerId }: {
  protocol: CatalogProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}): Promise<ApiModelListItem[]> {
  const res = await authenticatedFetch('/api/config/models', {
    method: 'POST', suppressServerErrorToast: true,
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ providerType: protocol, baseUrl, apiKey, providerId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || 'Failed to fetch model list.');
  const models = normalizeModelList(Array.isArray(data?.models) ? data.models : []);
  const provider = providerId ? findCatalogProviderById(providerId) : undefined;
  const endpoint = baseUrl.replace(/\/+$/, '');
  const official = provider && (endpoint === provider.defaultUrl.replace(/\/+$/, '')
    || endpoint === provider.modelListUrl?.replace(/\/+$/, ''));
  if (!official) return models;
  return models.flatMap(model => {
    const known = provider.models.find(m => m.id === model.id || m.aliases?.includes(model.id));
    const retired = provider.legacyModels?.some(m => m.id === model.id || m.aliases?.includes(model.id));
    if (retired && !known) return [];
    return [{ ...known, ...model, displayName: known?.displayName ?? model.displayName }];
  });
}
