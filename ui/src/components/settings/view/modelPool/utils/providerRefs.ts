import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import {
  hasUsableSecret,
  isMaskedSecret,
  secretDisplayValue,
} from "../../../shared/utils/secret";

export { hasUsableSecret, isMaskedSecret, secretDisplayValue };

export function providerDisplayName(
  providerId: string,
  catalogEntry?: CatalogProvider,
  emptyFallback = "Custom Provider",
): string {
  if (catalogEntry?.displayName) return catalogEntry.displayName;
  const normalized = providerId.trim();
  if (!normalized) return emptyFallback;
  return normalized;
}
