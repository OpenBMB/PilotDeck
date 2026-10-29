import { lookupCatalogModel, lookupCatalogProvider } from '../../../src/model/catalog/index.js';
import { buildProviderChatEndpoint } from '../../../src/model/providerEndpoint.js';

const ALIASES = { gemini: 'google', kimi: 'moonshot', volcengine: 'volc_ark', bailian: 'dashscope' };

function canonicalEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Returns null unless the model, provider, protocol and endpoint share a catalog scope. */
export function resolveCatalogImageSupport({ providerId, protocol, endpoint, modelId }) {
  const id = String(providerId || '').trim().toLowerCase();
  const catalogId = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id;
  const provider = lookupCatalogProvider(catalogId);
  if (!provider || provider.protocol !== protocol) return null;
  const baseUrl = canonicalEndpoint(endpoint);
  const officialUrl = canonicalEndpoint(provider.defaultUrl);
  if (!baseUrl || !officialUrl) return null;
  // Compare actual request endpoints so root, versioned and full endpoint forms
  // work, without trusting another host or another path on the same origin.
  const requested = buildProviderChatEndpoint({ protocol, baseUrl, model: modelId });
  const official = buildProviderChatEndpoint({ protocol, baseUrl: officialUrl, model: modelId });
  if (requested !== official) return null;
  const result = lookupCatalogModel(catalogId, String(modelId || '').trim());
  if (result.matchType !== 'exact' && result.matchType !== 'alias') return null;
  const input = result.model?.multimodal?.input;
  return Array.isArray(input) ? input.includes('image') : null;
}
