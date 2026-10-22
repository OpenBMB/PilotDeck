import type { ModelProtocol } from "../protocol/canonical.js";
import type { ModelCapabilities } from "../protocol/capabilities.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";

export type CatalogModelEntry = {
  displayName: string;
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  aliases?: string[];
  status?: "active" | "deprecated" | "legacy";
  source?: string;
  updatedAt?: string;
  releaseDate?: string;
  protocol?: ModelProtocol;
  thinking?: import("../thinking/settings.js").ModelThinkingSettings;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
};

export type CatalogProviderEntry = {
  displayName: string;
  protocol: ModelProtocol;
  defaultUrl: string;
  apiKeyEnvVar?: string;
  requiresApiKey?: boolean;
  modelListUrl?: string;
  modelListRequiresApiKey?: boolean;
  models: Record<string, CatalogModelEntry>;
};

export type ProviderCatalog = Record<string, CatalogProviderEntry>;
