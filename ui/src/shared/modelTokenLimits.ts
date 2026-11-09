import { lookupCatalogModel } from '../../../src/model/catalog/lookup.js';
import { DEFAULT_MODEL_TOKEN_LIMITS, type CatalogModel, type CatalogProviderProtocol, type ModelTokenLimits } from './catalogProviders';

// Reuse the engine's exact/alias/cross-provider/vendor-prefix resolution. The
// picker is only a subset of that catalog, so it cannot identify every model
// offered by a custom proxy. This lookup intentionally supplies token hints
// only; cross-provider matches must not opt a model into image input.
export function resolveModelTokenLimits(
  providerId: string,
  modelId: string,
  protocol: CatalogProviderProtocol,
  pickerModel?: CatalogModel,
): ModelTokenLimits {
  const known = lookupCatalogModel(providerId, modelId).model?.capabilities;
  const fallback = DEFAULT_MODEL_TOKEN_LIMITS[protocol];
  return {
    maxContextTokens: known?.maxContextTokens ?? pickerModel?.maxContextTokens ?? fallback.maxContextTokens,
    maxOutputTokens: known?.maxOutputTokens ?? pickerModel?.maxOutputTokens ?? fallback.maxOutputTokens,
  };
}
