import type { CatalogModelEntry, CatalogProviderEntry } from "./types.js";
import { PROVIDER_CATALOG } from "./providers.js";

export type CatalogLookupResult = {
  provider?: CatalogProviderEntry;
  model?: CatalogModelEntry;
  matchType: "exact" | "alias" | "cross-provider" | "none";
};

/**
 * Look up a model in the built-in catalog. Resolution order:
 *
 *  1. Exact match:  catalog[providerId].models[modelId]
 *  2. Alias match:  catalog[providerId].models[*].aliases includes modelId
 *  3. Cross-provider exact:  any catalog provider's models[modelId]
 *  4. Cross-provider alias:  any catalog provider's alias list
 *  5. Strip vendor prefix:  "anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6"
 *     then repeat steps 3–4
 */
export function lookupCatalogModel(
  providerId: string,
  modelId: string,
): CatalogLookupResult {
  const provider = PROVIDER_CATALOG[providerId];

  // 1. Exact match on the declared provider
  if (provider?.models[modelId]) {
    return { provider, model: provider.models[modelId], matchType: "exact" };
  }

  // 2. Alias match on the declared provider
  if (provider) {
    for (const entry of Object.values(provider.models)) {
      if (entry.aliases?.includes(modelId)) {
        return { provider, model: entry, matchType: "alias" };
      }
    }
  }

  // 3–4. Cross-provider search (exact then alias)
  const crossResult = searchAllProviders(modelId);
  if (crossResult) {
    return { provider: provider ?? crossResult.provider, model: crossResult.model, matchType: "cross-provider" };
  }

  // 5. Strip vendor prefix for proxy-style IDs ("anthropic/claude-sonnet-4.6")
  const slashIndex = modelId.indexOf("/");
  if (slashIndex >= 0) {
    const stripped = modelId.slice(slashIndex + 1);
    const strippedResult = searchAllProviders(stripped);
    if (strippedResult) {
      return { provider: provider ?? strippedResult.provider, model: strippedResult.model, matchType: "cross-provider" };
    }
  }

  return { provider, matchType: "none" };
}

/**
 * Return the catalog provider entry (protocol, defaultUrl, etc.) without
 * looking up a specific model.
 */
export function lookupCatalogProvider(providerId: string): CatalogProviderEntry | undefined {
  return PROVIDER_CATALOG[providerId];
}

function searchAllProviders(
  modelId: string,
): { provider: CatalogProviderEntry; model: CatalogModelEntry } | undefined {
  for (const catalogProvider of Object.values(PROVIDER_CATALOG)) {
    if (catalogProvider.models[modelId]) {
      return { provider: catalogProvider, model: catalogProvider.models[modelId] };
    }
  }

  for (const catalogProvider of Object.values(PROVIDER_CATALOG)) {
    for (const entry of Object.values(catalogProvider.models)) {
      if (entry.aliases?.includes(modelId)) {
        return { provider: catalogProvider, model: entry };
      }
    }
  }

  return undefined;
}
