import { normalizeModelListItem, type ProviderModelMetadata, type ResolvedTokenLimits } from "../../../src/model/metadata/tokenLimits.js";
import { authenticatedFetch } from '../utils/api';
import { findCatalogProviderById, type CatalogProviderProtocol } from './catalogProviders';

export type ApiModelListItem = ProviderModelMetadata;

function normalizeModelList(models: unknown[]): ApiModelListItem[] {
  const seen = new Set<string>();
  const normalized: ApiModelListItem[] = [];
  for (const model of models) {
    const item = normalizeModelListItem(model);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalized.push(item);
  }
  return normalized;
}

export async function fetchRemoteDefaultModels(providerId: string): Promise<ApiModelListItem[]> {
  const provider = findCatalogProviderById(providerId);
  if (!provider?.defaultUrl) return [];
  return fetchProviderModels({
    protocol: provider.protocol,
    baseUrl: provider.modelListUrl ?? provider.defaultUrl,
    apiKey: '',
    providerId,
  });
}

export async function fetchProviderModels({
  protocol,
  baseUrl,
  apiKey,
  providerId,
}: {
  protocol: CatalogProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}): Promise<ApiModelListItem[]> {
  const res = await authenticatedFetch('/api/config/models', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({
      providerType: protocol,
      baseUrl,
      apiKey,
      providerId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || 'Failed to fetch model list.');
  }
  const models = Array.isArray(data?.models) ? data.models : [];
  return normalizeModelList(models);
}

export async function fetchModelTokenLimits(input: {
  protocol: CatalogProviderProtocol; baseUrl: string; apiKey?: string; providerId: string; modelId: string;
}, signal?: AbortSignal): Promise<ResolvedTokenLimits & { warning?: string }> {
  const response = await authenticatedFetch('/api/config/model-limits', {
    method: 'POST', suppressServerErrorToast: true, signal,
    body: JSON.stringify({ ...input, providerType: input.protocol }),
  });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Failed to resolve model limits.');
  return { ...data.limits, ...(data.warning ? { warning: data.warning } : {}) };
}
