import type { CatalogModelEntry, ProviderCatalog } from "./types.js";
import { THINKING_EFFORTS, parseThinkingSettings } from "../thinking/settings.js";

export const CATALOG_SOURCES = {
  modelsDev: "https://models.dev/api.json",
  openrouter: "https://openrouter.ai/api/v1/models",
} as const;
export type CatalogSource = keyof typeof CATALOG_SOURCES;
export type CatalogOverlay = Record<string, Record<string, CatalogModelEntry>>;

const PROVIDER_SOURCES: Record<string, string> = {
  anthropic: "anthropic", openai: "openai", "openai-responses": "openai",
  google: "google", dashscope: "alibaba-cn", deepseek: "deepseek",
  minimax: "minimax", moonshot: "moonshotai-cn", volc_ark: "volcengine", zhipu: "zai",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function price(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Normalize public metadata; endpoints and credentials remain application-owned. */
export function normalizeCatalogSource(source: CatalogSource, raw: unknown, baseline: ProviderCatalog): CatalogOverlay {
  const result: CatalogOverlay = {};
  if (source === "modelsDev") {
    const data = record(raw);
    for (const [providerId, sourceId] of Object.entries(PROVIDER_SOURCES)) {
      const provider = baseline[providerId];
      if (!provider) continue;
      const models = record(record(data[sourceId]).models);
      if (!Object.keys(models).length) throw new Error(`Missing model catalog: ${sourceId}`);
      const entries: Record<string, CatalogModelEntry> = {};
      for (const [id, value] of Object.entries(models)) {
        const m = record(value);
        if (m.tool_call !== true || (m.type && m.type !== "chat")) continue;
        const limits = record(m.limit);
        if (!positive(limits.context) || !positive(limits.output)) continue;
        const previous = provider.models[id];
        const input = record(m.modalities).input;
        const image = Array.isArray(input) && input.includes("image");
        const cost = record(m.cost);
        const options: unknown[] = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
        const effortOption = options.map(record).find(option => option.type === "effort");
        const efforts = THINKING_EFFORTS.filter(e => Array.isArray(effortOption?.values) && effortOption.values.includes(e));
        entries[id] = {
          ...previous,
          displayName: typeof m.name === "string" ? m.name : id,
          protocol: provider.protocol,
          capabilities: {
            ...previous?.capabilities,
            supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: previous?.capabilities.supportsParallelToolCalls ?? provider.protocol !== "anthropic",
            supportsJsonSchema: m.structured_output === true,
            supportsSystemPrompt: true, supportsPromptCache: price(cost.cache_read) !== undefined,
            supportsThinking: m.reasoning === true,
            maxContextTokens: limits.context, maxOutputTokens: limits.output,
          },
          multimodal: {
            ...previous?.multimodal,
            input: ["text", ...(image ? ["image" as const] : []),
              ...(provider.protocol === "anthropic" || provider.protocol === "google" ? ["pdf" as const] : []),
              ...(provider.protocol === "google" ? ["audio" as const] : [])],
          },
          thinking: { state: "default", format: "provider", efforts },
          status: m.status === "deprecated" ? "deprecated" : "active",
          source: CATALOG_SOURCES[source],
          ...(typeof m.last_updated === "string" ? { updatedAt: m.last_updated } : {}),
          ...(typeof m.release_date === "string" ? { releaseDate: m.release_date } : {}),
          ...(price(cost.input) !== undefined && price(cost.output) !== undefined ? {
            cost: { input: price(cost.input)!, output: price(cost.output)!, cacheRead: price(cost.cache_read), cacheWrite: price(cost.cache_write) },
          } : {}),
        };
      }
      if (!Object.keys(entries).length) throw new Error(`No usable models in catalog: ${sourceId}`);
      result[providerId] = entries;
    }
  } else {
    const data = record(raw).data;
    if (!Array.isArray(data)) throw new Error("Invalid OpenRouter model catalog");
    const entries: Record<string, CatalogModelEntry> = {};
    for (const value of data) {
      const m = record(value);
      const parameters = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      const output = record(m.top_provider).max_completion_tokens;
      if (typeof m.id !== "string" || !parameters.includes("tools") || !positive(m.context_length) || !positive(output)) continue;
      const input = record(m.architecture).input_modalities;
      const pricing = record(m.pricing);
      entries[m.id] = {
        displayName: typeof m.name === "string" ? m.name : m.id,
        protocol: "openai",
        capabilities: {
          supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
          supportsThinking: parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
          supportsJsonSchema: parameters.includes("structured_outputs"), supportsSystemPrompt: true,
          supportsPromptCache: price(pricing.input_cache_read) !== undefined,
          maxContextTokens: m.context_length, maxOutputTokens: output,
        },
        multimodal: { input: Array.isArray(input) && input.includes("image") ? ["text", "image"] : ["text"] },
        status: "active", source: CATALOG_SOURCES[source],
        ...(typeof m.created === "number" && Number.isFinite(m.created) && m.created > 0 && m.created < 1e11 ? { releaseDate: new Date(m.created * 1000).toISOString().slice(0, 10) } : {}),
        ...(price(pricing.prompt) !== undefined && price(pricing.completion) !== undefined ? {
          cost: { input: price(pricing.prompt)! * 1e6, output: price(pricing.completion)! * 1e6 },
        } : {}),
      };
    }
    if (!Object.keys(entries).length) throw new Error("No usable models in OpenRouter catalog");
    result.openrouter = entries;
  }
  return result;
}

/** Missing upstream entries retain their last known capabilities for saved configs. */
export function mergeCatalog(baseline: ProviderCatalog, overlay: CatalogOverlay): ProviderCatalog {
  const result = { ...baseline };
  for (const [providerId, models] of Object.entries(overlay)) {
    const provider = baseline[providerId];
    if (!provider) continue;
    const retained = Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id,
      models[id] ? model : { ...model, status: "legacy" as const },
    ]));
    result[providerId] = { ...provider, models: { ...retained, ...models } };
  }
  return result;
}

export function validateCatalog(catalog: ProviderCatalog): void {
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider || !["openai", "openai-responses", "anthropic", "google"].includes(provider.protocol)) throw new Error(`Invalid provider: ${providerId}`);
    for (const [id, m] of Object.entries(provider.models)) {
      if (!id.trim() || !m || typeof m.displayName !== "string" || !positive(m.capabilities?.maxContextTokens) || !positive(m.capabilities?.maxOutputTokens)) throw new Error(`Invalid model: ${providerId}/${id}`);
      for (const [key, value] of Object.entries(m.capabilities)) {
        if (key.startsWith("supports") && typeof value !== "boolean") throw new Error(`Invalid capability: ${providerId}/${id}/${key}`);
      }
      if (!Array.isArray(m.multimodal?.input) || !m.multimodal.input.includes("text") || m.multimodal.input.some(v => !["text", "image", "audio", "pdf"].includes(v))) throw new Error(`Invalid modalities: ${providerId}/${id}`);
      if (m.aliases && (!Array.isArray(m.aliases) || m.aliases.some(v => typeof v !== "string"))) throw new Error(`Invalid aliases: ${providerId}/${id}`);
      if (m.status && !["active", "deprecated", "legacy"].includes(m.status)) throw new Error(`Invalid status: ${providerId}/${id}`);
      if (m.protocol && !["openai", "openai-responses", "anthropic", "google"].includes(m.protocol)) throw new Error(`Invalid model protocol: ${providerId}/${id}`);
      parseThinkingSettings(m.thinking, m.protocol ?? provider.protocol);
      if (m.releaseDate !== undefined && typeof m.releaseDate !== "string") throw new Error(`Invalid release date: ${providerId}/${id}`);
      if (m.cost && Object.values(m.cost).some(value => value !== undefined && price(value) === undefined)) throw new Error(`Invalid pricing: ${providerId}/${id}`);
    }
  }
}
