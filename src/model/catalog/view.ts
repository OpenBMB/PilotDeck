import type { ModelProtocol } from "../protocol/canonical.js";
import type { CatalogModelEntry, ProviderCatalog } from "./types.js";

export type CatalogModel = {
  id: string;
  displayName: string;
  aliases?: string[];
  supportsImage?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  status?: CatalogModelEntry["status"];
  thinking?: CatalogModelEntry["thinking"];
  cost?: CatalogModelEntry["cost"];
  protocol?: ModelProtocol;
};
export type CatalogProvider = {
  id: string;
  displayName: string;
  protocol: ModelProtocol;
  defaultUrl: string;
  apiKeyEnvVar?: string;
  modelListUrl?: string;
  modelListRequiresApiKey?: boolean;
  requiresApiKey?: boolean;
  models: CatalogModel[];
  legacyModels?: CatalogModel[];
};

/** Selection lists exclude retired entries; the full catalog still resolves saved IDs. */
export function catalogProviders(catalog: ProviderCatalog): CatalogProvider[] {
  return Object.entries(catalog).map(([id, provider]) => ({
    ...provider, id,
    legacyModels: Object.entries(provider.models).filter(([, m]) => m.status === "legacy" || m.status === "deprecated").map(([modelId, m]) => ({
      id: modelId, displayName: m.displayName, aliases: m.aliases, status: m.status,
      supportsImage: m.multimodal.input.includes("image") || undefined,
      maxContextTokens: m.capabilities.maxContextTokens, maxOutputTokens: m.capabilities.maxOutputTokens,
      thinking: m.thinking, protocol: m.protocol ?? provider.protocol,
    })),
    models: Object.entries(provider.models)
      .filter(([, m]) => m.status !== "legacy" && m.status !== "deprecated" && (m.capabilities.supportsToolUse || id === "ollama"))
      .sort(([a, x], [b, y]) => (y.releaseDate ?? "").localeCompare(x.releaseDate ?? "") || a.localeCompare(b))
      .map(([modelId, m]) => ({
        id: modelId, displayName: m.displayName, aliases: m.aliases,
        supportsImage: m.multimodal.input.includes("image") || undefined,
        maxContextTokens: m.capabilities.maxContextTokens, maxOutputTokens: m.capabilities.maxOutputTokens,
        status: m.status, thinking: m.thinking, cost: m.cost, protocol: m.protocol ?? provider.protocol,
      })),
  }));
}
