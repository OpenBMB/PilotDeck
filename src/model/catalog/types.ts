import type { ModelProtocol } from "../protocol/canonical.js";
import type { ModelCapabilities } from "../protocol/capabilities.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";

export type CatalogModelEntry = {
  displayName: string;
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  aliases?: string[];
};

export type CatalogProviderEntry = {
  displayName: string;
  protocol: ModelProtocol;
  defaultUrl: string;
  apiKeyEnvVar?: string;
  models: Record<string, CatalogModelEntry>;
};

export type ProviderCatalog = Record<string, CatalogProviderEntry>;
