import type { ModelConfig, MultimodalConstraints } from "../../model/index.js";
import type { RouterConfig } from "../../router/config/schema.js";

/** A configured model that can run a subagent tool loop. Contains no credentials. */
export type SubagentModel = {
  id: string;
  provider: string;
  model: string;
  description: string;
  modelMultimodal: MultimodalConstraints;
  maxContextTokens: number;
  maxOutputTokens: number;
};

export function listSubagentModels(modelConfig: ModelConfig, routerConfig?: RouterConfig): SubagentModel[] {
  const models: SubagentModel[] = [];
  const tiers = Object.values(routerConfig?.tokenSaver?.tiers ?? {});
  for (const [provider, config] of Object.entries(modelConfig.providers)) {
    if (!config.apiKey.trim()) continue;
    for (const [model, definition] of Object.entries(config.models)) {
      if (!definition.capabilities.supportsToolUse || !definition.capabilities.supportsStreaming) continue;
      const id = `${provider}/${model}`;
      const descriptions = tiers
        .filter(tier => tier.model.provider === provider && tier.model.model === model)
        .map(tier => tier.description || tier.label)
        .filter((value): value is string => Boolean(value));
      const label = [...new Set(descriptions)].join("; ") || definition.displayName || model;
      models.push({
        id, provider, model,
        description: `${label.replace(/\s+/g, " ").trim().slice(0, 160)}; input: ${definition.multimodal.input.join(", ")}`,
        modelMultimodal: definition.multimodal,
        maxContextTokens: definition.capabilities.maxContextTokens,
        maxOutputTokens: definition.capabilities.maxOutputTokens,
      });
    }
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}
